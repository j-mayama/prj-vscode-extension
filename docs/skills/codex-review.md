# codex-review — 設計・調査記録

Claude が実装した変更を OpenAI Codex CLI に独立レビューさせ、P0/P1/P2を必須修正し、
P3を対象外として再レビューするスキル。離席中は判断待ちで止めず、未解決項目と判断を残す。

## 解決したい課題

1. 実装した本人（Claude）によるセルフレビューは同じ盲点を共有しやすい → 別モデルの独立レビュー
2. 軽微な好みまで自動修正すると差分が膨らむ → P0/P1/P2を必須修正し、P3は結果表示だけにする
3. モデル名は頻繁に変わるため、スキルにハードコードすると腐る → 設定とモデル一覧を外部化

## 調査・実測記録（2026-07-16、codex-cli 0.144.5 で確認）

### codex exec review サブコマンド

- スコープは `--uncommitted` / `--base <branch>` / `--commit <sha>` の 3 種類
- **スコープフラグとカスタムプロンプト `[PROMPT]` は排他**（実測:
  `error: the argument '--uncommitted' cannot be used with '[PROMPT]'`）。
  レビュー観点や除外リストを Codex に指示する手段はない
- **`--output-schema` は review モードでは無視される**（実測）。`-o` に書かれる最終
  メッセージは JSON ではなく、次のテキスト形式:

  ```
  <総評>

  Review comment:

  - [P1] <タイトル> — <パス>:<開始行>-<終了行>
    <本文>
  ```

- `--json`（JSONL イベント）も確認したが、イベントは `thread.started` /
  `command_execution` / `agent_message` などで、**指摘の構造化データは含まれない**。
  → テキストを Claude がパースする設計にした
- 出力言語は英語になることが多い → 完了報告では Claude が日本語化する

### サンドボックス

- レビュー実行時の既定は `approval: never` / `sandbox: workspace-write`（実測。
  利用者の `~/.codex/config.toml` に依存する可能性あり）
- `-c sandbox_mode="read-only"` を付けても review は正常完走する（実測）。
  不正な値は起動時に `unknown variant` エラーで拒否されるため、正常完走 = 適用済み
- → 「レビューは読み取り専用」を保証するため、スキルでは read-only を必須にした

### モデルとエフォートの永続化

- モデル・エフォートは `~/.claude/codex-review.config.json` に保存する（スキル外・リポジトリ外）
- 現行モデルの一覧は Codex 自身がCodex homeの`models_cache.json`にキャッシュしている
  （`CODEX_HOME`設定時はその配下、未設定なら`~/.codex`）
  （slug / display_name / supported_reasoning_levels / visibility / priority）。
  セットアップ時はここから実在モデルだけを選択肢として提示する
- モデル廃止時は `~/.codex/config.toml` の `[notice.model_migrations]` に
  旧 slug → 新 slug の対応が入ることがあり、再セットアップ時の推奨に使える
- Codex のプロファイル機能（`~/.codex/<name>.config.toml`、0.134.0+ の新方式）も検討したが、
  `exec review` のヘルプに `--profile` が現れず動作が確認できなかったため、
  `-m` / `-c model_reasoning_effort=...` の明示フラグ方式を採用した

### codex CLI 本体の解決

- スタンドアロン CLI（PATH 上の `codex`）と、VS Code 拡張
  `openai.chatgpt-<version>-<platform>` 同梱の `codex.exe` の 2 系統がある
- 拡張同梱のパスはバージョンを含み更新のたびに変わるため、「PATH → 拡張フォルダの
  最新版」の順に動的解決する。この処理は `scripts/run-review.js` が持つ
  （当初は `scripts/find-codex.ps1` に分けていたが、v1.5.0 でランナーに集約して廃止した）
- 認証（`~/.codex/auth.json`）は両系統で共有される

### Windows PowerShell 5.1 の文字コード

- BOM なし UTF-8 の `.ps1` は ANSI（日本語環境では CP932）として解釈され、
  日本語コメントが文字化けして構文エラーになる（実機で再現）
- 同梱スクリプトを PowerShell で書くならコメントも ASCII に限る必要がある。
  現在の同梱スクリプトは Node（`.js`）に統一しているため、この制約は回避している

## 自動レビューループ（Stop hook）の調査記録

### hook には判定だけさせる

Stop hook が Codex を直接叩く案も検討したが、次の理由でトリガーに徹させた。

- hook が最大 10 分ブロックし、その間セッションが止まる
- レビュー処理が hook とスキルの二重管理になる
- P3の除外とP0/P1/P2の修正はどのみち Claude 側でしかできない

結果、hook は「この差分はレビューが要るか」だけを数百 ms で判定し、
レビュー・重要度判定・修正はすべてスキルが担当する構成にした。

### `stop_hook_active`だけでは足りない

現行のStopイベントには`stop_hook_active`があり、Stop hookから継続したターンかを
判定できる。ただし、同じ作業ツリーを使う別セッションとの排他や、レビュー中に変わった
差分をCodexが読んだかどうかまでは判定できない。

→ 次の安全性はスクリプトが自前で持つ:

- 差分のフィンガープリント（`git status` ＋ `git diff HEAD` ＋ 未追跡ファイルの
  `git hash-object` の SHA-256）を状態ファイルに記録する
- **同じ差分では最大 1 回しかブロックしない**。ブロック前に「試行済み」を記録するので、
  レビューが結果を返せなかった場合（CLI 未導入・未認証・クラッシュ）でも
  余計なターンは 1 回で済む
- 例外時は必ず通す（fail-open）

フィンガープリント計算はhookとスキルで**同じスクリプトの同じ関数**を使う
（`--print` / `--finalize-pending`サブコマンド）。別々に実装すると値がズレて
ループが収束しなくなる。

### settings.json の構造

`UserPromptSubmit`と`Stop`はmatcherをサポートせず、常に発火する。設定はイベント配列と
`hooks`配列の入れ子形式にし、matcherは省略する。`args`を使うexec形式はClaude Code
2.1.139で追加されたため、古いクライアントでも動く引用符付きshell形式を生成する。
Windowsパスはスラッシュ区切りにしてJSONのバックスラッシュ問題を避ける。

```json
"Stop": [ { "hooks": [ { "type": "command", "command": "node \".../stop-hook.js\"", "timeout": 30 } ] } ]
```

**`"async": true` を付けてはいけない。** 非同期 hook は撃ちっぱなしで、
block の判定結果を返せないためループが成立しない。

v1.15.0からは`scripts/setup-auto.js`が`.claude/settings.local.json`へ
`UserPromptSubmit`と`Stop`を登録する。前者が指示時刻を記録し、後者が未レビュー差分を
検出する。READMEの手順だけで両方が揃うことを完了条件にした。
`.claude`を含む書き込み先の祖先がシンボリックリンクなら、project-localという前提を
満たせないため変更せずエラー終了する。`doctor.js`はStop hookの`async: true`も競合として扱う。
`.claude/settings.local.json`がgit追跡済みなら、端末固有の絶対パスを共有ファイルへ
書く前に停止し、追跡解除は人間へ委ねる。
旧版のグローバル・project hookは新しいlocal hookと競合するため検出時に停止し、
影響を確認した利用者だけが`--migrate-legacy-hooks`で削除・移行する。

旧版の単一上限`max_rounds`が残っている場合は、明示済みの新設定を優先しつつ、
未設定の`rounds.work` / `rounds.away`へ同じ値を引き継ぐ。
`mode`導入前の設定にモデルが保存されていれば`explicit`へ移行する。`inherit`はモデルとeffortを
Codex本体から継承するため、effortの上書きは許可しない。完全にCodex本体へ戻す場合はeffortも空にする。
持ち越し状態はリポジトリだけでなくブランチ識別子でも分離し、別ブランチの指摘を混ぜない。
識別子は永続レジストリとリポジトリローカルの
`branch.<name>.codexReviewId`へ保存する。Gitはbranch configを名前変更時に移動し、
削除時に消すため、reflogの書き換えに影響されず、同名ブランチの作り直しも別状態にできる。
`git branch -c`で設定ごとコピーされた場合は、元ブランチが生きていることを確認して
コピー側へ新しい識別子を発行する。
状態ディレクトリは0700、持ち越しファイルは0600で作成する。
home共有設定の更新はロック内で最新値を読み直してから変更し、並行更新の消失を防ぐ。
レビュー済み・再試行・claimもrepository状態ロックで一括更新する。セットアップの再実行と
無効化は、中断したclaimとretryだけを回収し、reviewedの記録は保持する。

指示時刻はhook入力の`session_id`で分離する。CLI実行時はClaude Codeが
`CLAUDE_CODE_SESSION_ID`をBash / PowerShell subprocessへ渡すため、同じ作業ツリーを
共有する別セッションの時刻を参照しない。
持ち越し状態の追記は排他ロックで直列化し、有人時の置換は`--prepare-pending`が返す
`revision`とのcompare-and-swapにして、並行セッションの結果を消さない。
表示専用の`--pending`はブランチIDや`.git/config`を作らない読み取り専用とし、
レビュー開始時の初期化だけを`--prepare-pending`へ分離した。
旧形式のrepository単位pendingは由来ブランチを推測せず別枠表示し、
確認済みブランチでの`--adopt-legacy-pending`だけが移行・削除する。

## セルフレビューで見つかった設計バグ（Codex 自身が検出）

このスキルを自分自身の差分にかけた（ドッグフーディング）ところ、Codex が設計バグを
検出した。いずれも修正済み。

実装中の暫定版に対して:

1. **base / commit モードでの不当な早期終了**: 「未コミット差分がなければ終了」の
   チェックを全モードに適用していたが、クリーンな作業ツリーはブランチ・コミット
   レビューでは正常な状態。→ 早期終了は `--uncommitted` モード限定にした
2. **commit モードの再レビューが修正を検証できない**: ループ 2 周目も
   `--commit <sha>` のままだと元のスナップショットを見続け、Claude の修正
   （未コミット）が永遠に検証されない。→ 2 ラウンド目以降は `--uncommitted` に
   切り替える設計にした

v1.0.0 完成後の正式なレビュー（gpt-5.6-sol / high）で:

3. **[P1] 指摘 1 件でダイアログが壊れる**: 「1 質問 = 最大 4 指摘」としか書いておらず、
   指摘がちょうど 1 件のとき選択肢 1 個の質問を作ってしまう。AskUserQuestion は
   選択肢 2〜4 個が必須なので呼び出しが拒否され、ループが止まる。
   **指摘 1 件は最も起きやすいケース**なので実害が大きかった。
   → 1 件のときは「対応する / 見送る」の 2 択にし、複数件でもバッチが 1 件に
   ならないよう割る（5 件 → 3+2）ルールにした
4. **[P1] commit 指定で無関係なコードを編集しうる**: `commit <sha>` の存在確認しか
   していないが、Step 5 の修正は現在の作業ツリーに当たる。古い／別ブランチの
   コミットを指定すると、レビュー対象と違うリビジョンを直してしまう。
   → HEAD と一致しない場合は修正まで進めず報告のみに留める
5. **[P2] P0 の指摘を取りこぼす**: パース対象を `[P1]`〜`[P3]` に限定していたため、
   Codex が `[P0]`（リリースブロッカー）を出した場合に最も重大な指摘が漏れる。
   → 抽出・並び順・提示のすべてに P0 を含めた

v1.1.0（hook 追加後）のラウンド 2 で:

6. **[P1] エフォート選択肢が上限を超えてセットアップが失敗する**: 「モデルが対応する
   effort を全部出す」としていたが、6 段階持つモデルが実在し、選択肢の上限 4 個を超える。
   **3 の修正と同じ「選択肢の個数」の穴がセットアップ側にも残っていた**
   （指摘のダイアログだけ直して、設定のダイアログを直し忘れていた）。
   → 5 個以上なら代表 3 個 ＋ Other に絞る
7. **[P2] オプトインしていないリポジトリでも毎ターン重い計算が走る**: hook が
   フラグ確認より先にフィンガープリント（`git diff` ＋ 全未追跡ファイルのハッシュ）を
   計算していた。当時はhookのグローバル登録を前提としていたため、自動レビューを使っていない
   全プロジェクトが毎ターンそのコストを払っていた。
   → フラグ確認をルート確定直後に移動。未追跡 400 ファイルの環境で実測 321ms → 112ms
8. **[P2] 初回コミット前にフィンガープリントが内容を取りこぼす**: HEAD が無い
   リポジトリでは `git diff HEAD` が失敗し、その結果を空差分として扱っていた。
   ステージ済みファイルは未追跡一覧にも入らないため内容がハッシュされず、
   `AM` のまま中身を書き換えても「レビュー済み」と誤判定された。
   → unborn branch では index（`ls-files -s`）と `git diff` をハッシュ対象にする
9. **[P2] `commit` モードが dirty な作業ツリーで対象外を巻き込む**: 未コミット変更が
   ある状態で `commit HEAD` を指定すると、HEAD 一致チェックは通るが、1 周目は
   コミットだけ・2 周目以降と `--mark` は作業ツリー全体が対象になる。
   依頼外の変更が修正候補になり、さらに**未レビュー内容がレビュー済みと記録される**。
   → 作業ツリーがクリーンでなければ報告のみに留め、`--mark` もしない

v1.3.0（多重セッション対策後）のラウンド 4 で:

10. **[P2] 差分が 1MiB を超えると hook が無言でレビューを飛ばす**: Node の
    `execFileSync` は既定で子プロセスの出力を 1MiB に打ち切り、超えると例外を投げる。
    hook の fail-open がそれを飲み込むため、**大きなリファクタリングほどレビューが
    必要なのに、そこだけ無言でスキップされていた**。1.6MB の差分で再現を確認。
    → `maxBuffer` を拡大。あわせて、fail-open するときは `systemMessage` で
    理由を伝えるようにした（黙って通すとレビュー済みと区別がつかない）
11. **[P2] 二重レビュー防止が実は効いていない**: `attempted` を「読んでから書く」形に
    していたため（TOCTOU）、同じツリーの複数セッションが同時に停止すると全部が
    check を通過して全部が Codex レビューを起動しうる。
    **`auto-loop.md` に書いた「二重にレビューが走らない」が実装と一致していなかった。**
    → 排他作成（`flag: 'wx'`）による原子的な予約に置き換え。
    4 セッション同時停止で block が 1 件になることを実測で確認

なお、ラウンド 4 は「大文字小文字による状態衝突」を P2 に格上げして再報告してきたが、
ラウンド 3 で利用者が見送り済みだったため、スキルの規定どおり除外した
（見送りリストの突き合わせが実際に機能した例）。

v1.15.0の休日運用追加後の最終レビューで:

12. **[P1] 離席モードだけpendingのpathを取得していない**: 手順は持ち越しJSONへ
    `path`を要求するのに、`--pending`を通常モードでしか実行していなかった。
    → モードに関係なくレビュー前にpendingを読み、離席時も保存先を固定する
13. **[P2] 中断claimが再有効化後も残る**: レビューが完了前に止まると、同じ差分は
    再セットアップしても予約済みとしてスキップされた。
    → 再有効化・無効化時にclaimとretryを回収し、セットアップ中のclaim作成も抑止する
14. **[P2] reviewed / retry更新の競合**: 別セッションの`--mark`と`--retry`、
    UserPromptSubmitの回収が同時に走ると、最後のrenameが他方の値を消し得た。
    → repository状態のread-modify-writeを共通ロックで直列化する
15. **[P1] 修正済みの持ち越しが次ラウンドで復活する**: Step 1のpendingスナップショットを
    毎回マージすると、Codexが修正を確認しても元項目が再表示される。
    → 未解決持ち越しリストをラウンド間で更新し、元スナップショットは再追加しない
16. **[P2] 追跡済みlocal settingsを変更後に警告していた**: 絶対hookパスを書いた後では
    `.gitignore`へ追加しても公開候補から外れない。
    → git追跡状態を変更前に確認し、追跡済みなら無変更で停止する
17. **[P2] 行移動後も古いlocatorを保持する**: 重複判定からlineを外しただけでは、
    先に保存された古い項目が残り、別行の同文面も1件へ潰れる。
    → 同じ安定identityの再報告は追加側の最新集合で置換し、集合内はline込みで重複除去する
18. **[P2] retryよりreviewedが優先される競合**: pending保存失敗後も同fingerprintの
    reviewedが残る、または別セッションが再設定すると、次のStopが回復レビューを飛ばす。
    → retry設定時に同じreviewedを解除し、retry予約中のmarkを拒否する
19. **[P1] 中断したsetup lockで以後の全レビューを黙って飛ばす**: Stop hookはlockの
    存在だけを見て通していたため、setupを強制終了すると恒久的に無効化される。
    → Stop側でも所有者・追跡状態・PID・経過時間を検証し、dead staleだけを回収する
20. **[P2] prompt hook失敗時に前回時刻を再利用する**: 同じsessionの古い時刻が残ると、
    現在とは違う通常/離席モードを選び得る。
    → 新しい時刻を書く前に旧記録を無効化し、失敗時は現在時刻へフォールバックさせる
21. **[P2] 旧pendingを最初に見たブランチへ誤移行する**: repository単位の旧状態には
    元ブランチ情報が無いのに、最初の`--pending`実行ブランチへ移して削除していた。
    → 読み取り時は`legacy`として保持し、元ブランチを確認した明示移行だけを許可する
22. **[P2] 表示専用pendingがrepositoryを変更する**: `--pending`がブランチIDを作り、
    `.git/config`とbranch registryを書き換えていた。
    → 表示は非変更lookup、レビュー初期化は`--prepare-pending`へ分離する
23. **[P2] 離席ラウンド途中のP2/P3が修正後も残る**: P2/P3を先にappendしてから
    P0/P1を直すと、同じ修正で解消して次ラウンドから消えた項目も週明けへ残っていた。
    → 離席未解決リストをラウンドごとに最新結果へ置き換え、最終時だけ追記する
24. **[P2] staleなレビューでpendingを先に更新する**: pending置換後に`--mark`が
    fingerprint不一致で失敗すると、レビュー済みにはならなくても持ち越しだけが
    古い結果で書き換わっていた。
    → `--finalize-pending`でpending更新とreviewed記録を同じfingerprintへ結びつけ、
    競合時はpendingを復元する

## レート制限（429）と無人実行の調査記録

### Codex 内部のリトライは増やせない

- Codex は 429 を内部でリトライする（組み込みプロバイダの既定は HTTP 4 回 /
  ストリーム 5 回）。使い切ると
  `exceeded retry limit, last status: 429 Too Many Requests` で落ちる
- 設定キー `request_max_retries` / `stream_max_retries` は
  **`model_providers.<id>.*` の下にある**（トップレベルには存在しない）
- しかし組み込みの `openai` プロバイダは上書きできない — 実測で
  `model_providers contains reserved built-in provider IDs: 'openai'.
  Built-in providers cannot be overridden.` と拒否される
- → **内部リトライの回数は変更不可**。長い待機はスキル側の層に持たせるしかない

そのため `scripts/run-review.js` が「Codex の内部リトライが尽きた後」を担当する。
Codex 側の backoff は秒単位で、瞬間的な 429 は吸収できるが利用枠のリセットは待てない。
そこだけを外側で補う構成。

### 無人実行の限界

通常・離席ともP0/P1/P2を必須修正し、P3は修正・持ち越しの対象外にする。
`unattended`モードの違いは、修正方針に判断が必要でもダイアログを出さず、要件と既存設計に
最も近い案を選んで記録すること。スケジュールが指示時刻を勤務外と判定した場合、または
手動プリセットで明示した場合だけ動く。離席中もレビュー確定後に対象ファイルだけを
自動コミットし、未解決のP0/P1/P2、判断ログ、コミットハッシュを週明けまで残す。

v1.5.0（ランナー導入後）のラウンド 5 で:

12. **[P1] `run-review.js` のシェルインジェクション**: PATH 上の codex を
    `shell: true` で起動していたため、ブランチ名・モデル名・出力パスがシェルに
    再解釈される。メタ文字を含む値で別コマンドが実行されうるし、空白を含むパスでも壊れる。
    → 本物の実行ファイルを直接指して `shell: false` で起動。悪意あるブランチ名を
    渡す実機テストで、注入コマンドが実行されないことを確認
13. **[P2] 無人モードでレート制限を無駄食い**: `auto_fix` 対象外（P2/P3）しか
    出なかった場合、ツリーが変わらないのに `max_rounds` まで再レビューを繰り返す。
    土日に放置するほど効く。→ 自動修正対象が 0 件ならループを抜ける
14. **[P2] 予約作成の失敗を黙殺**: `EEXIST`（他セッションが取得済み）以外の
    権限エラー・ディスク満杯でも catch が飲み込み、`systemMessage` の通知経路を
    バイパスして無言で停止を許していた。→ `EEXIST` だけを競合扱いにした
15. **[P2] 無人モードの保存先が不定**: 状態ファイルを `<リポジトリのハッシュ>` の
    名前で書けと指示しながら、**ハッシュの求め方を渡していなかった**。
    → `--state-path` サブコマンドでパスを返す
16. **[P2] Insiders の新しい CLI を無視 / [P2] 非 Windows で同梱 CLI を探さない**:
    候補をフルパスでソートしていたため `.vscode` と `.vscode-insiders` の比較が
    バージョンより先に効いていた。→ バージョンを解析して比較。探索は全 OS 共通にした

### 実装中に自分の検証で見つけたもの（Codex の指摘ではない）

- **`codex exec review` は ref が解決できなくても終了コード 0 を返す。**
  存在しないブランチを渡すと、レビューを 1 行もせずに出力ファイルへ
  「そのブランチは無い」と書いて成功終了する。ランナーは「OK」と報告し、
  スキルはその出力を「指摘ゼロ＝クリーン」と読む。
  **誰も読んでいないコードがレビュー済みとして記録される**経路だった。
  → ref の検証をランナー側（決定論的な処理）に持たせて事前に弾く
- npm 版 codex の PATH 上の実体は `.cmd` シム（中身は `node codex.js`）で、
  本物の exe は `node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/
  vendor/x86_64-pc-windows-msvc/bin/codex.exe` に 7 階層下がって存在する。
  `.cmd` は Node から shell 無しでは起動できないため、シムではなく実体を指す必要がある

## worktree による分離（v1.18.0 でスキルへ組み込み）

複数セッションを同じプロジェクトで動かす場合の唯一の構造的解決。v1.17.1 までは
「利用者が手で `git worktree add` する」推奨に留めていたが、v1.18.0 でスキル自身が行う。

| 項目 | 結果 |
| --- | --- |
| チェックアウトの独立 | 完全に独立（元ツリー 4 件の未コミット変更に対し worktree は 0 件） |
| `.git` の実体 | `gitdir: <main>/.git/worktrees/<name>` を指すだけ。リポジトリは 1 つ |
| このスキルの状態ファイル | `git rev-parse --show-toplevel` が worktree ごとに違うため自動で分離される |
| gitignore 済みファイル | **持ち込まれない** — `node_modules` / `.env` / `wp-config.php` は worktree に無い |

### なぜ hook から EnterWorktree を呼ばないのか

要件は「UserPromptSubmit の時点で worktree へ移動する」だったが、**hook から
`EnterWorktree` を起動する公式手段は存在しない**（公式ドキュメントに記載がなく、
`EnterWorktree` はモデル向けツールとしてのみ定義されている）。
hook が worktree に関与できるのは `WorktreeCreate` / `WorktreeRemove` の 2 イベントだけで、
これらは「worktree が作られるとき」に走るもので、「作らせる」ことはできない。

さらに `WorktreeCreate` を登録すると **既定の git 動作を置き換え、`.worktreeinclude` が
処理されなくなる**（公式仕様）。フラグファイルの複製が止まるため採用しない。

そこで次の二段構えにした。

| 段 | 実装 | 性質 |
| --- | --- | --- |
| advisory | `UserPromptSubmit` → `additionalContext` で EnterWorktree を指示 | モデルが従えば拒否は 0 回 |
| enforcement | `PreToolUse` → 共有ツリーへの書き込みを `permissionDecision: "deny"` | 決定論的。モデルの協力に依存しない |

`PreToolUse` の deny は `hookSpecificOutput.permissionDecision` で返す
（トップレベルの `decision: "block"` はこのイベントでは非推奨）。
`permissionDecisionReason` は deny のときだけ Claude に見えるため、
そこへ実行すべき `EnterWorktree` を入れて自己回復させる。

### 書き込み経路の網羅性（意図的な限界）

| 経路 | 分離の保証 | 理由 |
| --- | --- | --- |
| `Edit` / `Write` / `NotebookEdit` | **保証** | 書き込み先が `tool_input.file_path` に宣言されるため、パス演算だけで判定できる |
| `Bash` | **非保証** | 任意のシェル文字列の書き込み先を決定論的に判定できない |
| `@` ファイル参照 | 対象外 | PreToolUse が発火しない（公式仕様）。読み取りのみのため影響なし |

Bash を正規表現で解析する案は採らなかった。`rm` / `>` / `sed -i` / `tee` /
ヒアドキュメント / 変数展開 / サブシェルを網羅する正規表現は書けず、
誤爆すれば `git status` すら止まり、漏れれば無警告で共有ツリーへ書き込む。
**間違ったガードは、無いガードより悪い**ため、対象を宣言型ツールに限定し、
穴を SKILL.md と auto-loop.md に明記する方針にした。

実運用上、worktree へ移動するとセッションの cwd も移動するため、相対パスのシェル
書き込みは worktree 内へ落ちる。残る穴は**共有ツリーを絶対パスで指す Bash 書き込み**のみ。

### worktree 名を session_id から導出する（レジストリを持たない）

`sessionSlug = sha256(session_id)[0..16]`、worktree名 `codex-<slug>`。

- **導出なので状態を持たない。** レジストリファイルが壊れても・消えても、同じ
  session_id なら同じ worktree に辿り着く。セッション再開時の再利用がこれで成立する
- **ハッシュするのはサニタイズより安全。** session_id の文字集合は保証されていない。
  ハッシュなら常にブランチ名・パスとして正当（`EnterWorktree` の name 制約
  「各セグメントは英数字・`.`・`_`・`-`、64文字以内」を必ず満たす。実測 22 文字）
- 異なる id が同じ worktree に正規化される事故も起きない
- ブランチ名は Claude Code が付ける（`worktree-<name>`）。**スキル側では決め打ちせず**、
  報告時は `git rev-parse --abbrev-ref HEAD` で実際の値を読む

### `.claude/worktrees/` の .gitignore は必須（再現確認済み）

**git は入れ子の worktree を自動では無視しない。** `.claude/worktrees/` に worktree を
作ると、元リポジトリの `git status` に `?? .claude/` として現れる。

これは表示の問題ではない。fingerprint は
`git -c core.quotePath=false ls-files --others --exclude-standard` の結果を
`git hash-object --stdin-paths` へ渡すが、git は worktree をディレクトリ 1 件に
畳むため、hash-object が

```
fatal: could not open '.claude/worktrees/codex-abc/' for reading: Permission denied
```

で失敗する → `fingerprint()` が例外 → Stop hook が fail-open →
**レビューが走らないのに「クリーン」と同じ見た目になる**。
v1.4.0 の 1MiB 問題と同じ「fail-open が握りつぶす」系のバグなので、
`setup-auto.js` が `.gitignore` へ必ず追記する。

### `worktree.baseRef` は `"head"` にする（既定は `"fresh"`）

公式ドキュメントの表は Example 列に `"head"` を載せているが、**既定は `"fresh"`**
（説明文が正）で、`origin/<default-branch>` から分岐する。この既定のままだと、
ローカルの未 push コミットを持たない worktree で「今の続き」を実装・レビューすることになる。
`setup-auto.js` は**未設定のときだけ** `"head"` を書く（利用者の明示設定は上書きしない）。

### `.worktreeinclude` に秘密情報を入れない

`.worktreeinclude`（project root / gitignore 構文）は、**gitignore 済みかつ
パターンに一致するファイルだけ**を新 worktree へ複製する。追記するのは 2 行だけ。

```text
.codex-review-auto
.claude/settings.local.json
```

公式ドキュメントは `.env` / `.env.local` / `config/secrets.json` の複製を例示しており、
**秘密情報の複製に対する警告は一切ない**（`worktrees.md` 全文を検索して確認）。
しかしコードレビューを有効にした副作用として各 worktree へ秘密情報を撒くのは、
このリポジトリの方針（秘密情報の伝播を増やさない）に反するため採用しない。
必要な利用者が自分で追記する。

### hook のルート解決を `event.cwd` 優先へ変更した

`CLAUDE_PROJECT_DIR` は公式には「the project root」としか定義されておらず、
**worktree 内での値が文書化されていない**。実際 `settings.local.json` は
「worktree を辿って main checkout へ解決」される一方、cwd と `CLAUDE.md` は worktree に
従う、と挙動が分かれている。

`stop-hook.js` / `mark-prompt.js` が `CLAUDE_PROJECT_DIR` を優先したままだと、
それが共有ルートを指す実装だった場合に

- 移動先の worktree ではなく**共有チェックアウトをレビューする**
- worktree の差分を**レビュー済みとして記録する**

が起きうる。`event.cwd`（「hook 起動時のカレントディレクトリ」と明記されている）を
優先すれば、セッションが実際にいるツリーを必ず見る。worktree の外では両者が同じ
リポジトリルートへ解決するため、既存挙動は変わらない。
隔離リポジトリで、`CLAUDE_PROJECT_DIR=共有ルート` / `cwd=worktree` の組み合わせでも
worktree 側がレビュー対象になることを実測した。

- `node_modules` は Claude Code の `worktree.symlinkDirectories` 設定で本体から
  symlink できる
- **WordPress は追加の手当てが必要**: `wp-config.php` が gitignore されていれば
  worktree に無く、DB の `siteurl` / `home` も元の URL を指すため、
  別パスに切っただけでは動かない
- 静的サイトをドキュメントルート配下に切る場合は、兄弟 URL でそのまま配信される

## 既知の未対応（意図的に見送り）

（設定 JSON の保存が LLM 任せだった件は、ラウンド 2 で [P2] として指摘され一度見送られたが、
エフォート切り替えの導線を作る過程で `scripts/config.js` に移して解消した。v1.10.0）
- **大文字小文字違いのリポジトリが同じ状態ファイルを共有する**: 状態キーを無条件に
  小文字化しているため、大文字小文字を区別する環境で `/work/Foo` と `/work/foo` が
  衝突する。Windows のみなら影響なし。ラウンド 3・4 で指摘されたが利用者判断で見送り。
  対応するなら、小文字化を case-insensitive なプラットフォームに限定するか、
  状態ファイルに保存済みの `root` を検証する（値自体は既に保存してある）

## 未検証

- **実際の `EnterWorktree` 実行**。このツールはモデルが呼ぶもので、スクリプトからは
  起動できない。検証は「`git worktree add` で同じ構造を作り、hook の入出力・
  レビュー・コミット・分離を確認する」形で行った。したがって次は**未確認**:
  - `EnterWorktree(name:)` が実際に `.claude/worktrees/<name>` へ
    `worktree-<name>` ブランチを作ること（公式ドキュメント記載に基づく想定）
  - `worktree.baseRef: "head"` が実際に現在の HEAD から分岐すること
  - `.worktreeinclude` が実際に `.codex-review-auto` を複製すること
    （テストでは手動コピーで代替した）
  - EnterWorktree 後の hook 入力 `cwd` が worktree を指すこと
- **`EnterWorktree` 非対応環境でのフォールバック**。ツールが無い環境では
  PreToolUse が拒否を返し続けるため、`.codex-review-no-worktree` での無効化が要る。
  この経路は隔離リポジトリでの拒否・許可の切り替えまでは確認したが、
  実際に EnterWorktree を持たないクライアントでは試していない
- **`session_id` がセッション再開（`--resume` / `--continue`）で不変かどうか**。
  公式ドキュメントに記載がない。**変わる場合、再開したセッションは別の worktree を
  作る**（既存の worktree は残るので破壊はしないが、再利用されない）。
  worktree 名を session_id から導出する設計の前提であり、要確認事項
- **`CLAUDE_PROJECT_DIR` の worktree 内での値**。文書化されていないため、
  `event.cwd` を優先する形で依存を外した
- **Bash 経由の書き込み**（上記「書き込み経路の網羅性」）。意図的な非保証
- **Stop hook の実発火**。Stop hook はターンの外で動くため、実装したセッション内では
  証明できない。発火しない場合は `/hooks` を一度開くか再起動が必要
- **実際の 429 に対する挙動**。リトライ経路は偽の codex（本物と同じ
  `exceeded retry limit, last status: 429` を返す）で検証したが、
  本物のレート制限に当てて確認してはいない
- **`base` / `commit` モードの実行**。ロジックは修正したが、実際に走らせたのは
  すべて `--uncommitted`
- **本物のClaude Codeセッションでの休日一周**。隔離リポジトリでhook出力・モード・
  持ち越し表示は検証したが、実際の休日セッションを翌営業日に確認する試験は未実施
- **エフォートが 5 段階以上あるモデルでのセットアップ**

## 主要な設計判断

| 判断 | 理由 |
| --- | --- |
| 実装セッションをworktreeへ分離 | 共有チェックアウトでの並行セッションは、このスキルの有無に関係なく互いのコードをレビュー・修正・上書きする。共有をやめる以外に解決手段がない |
| advisory（hook指示）＋ enforcement（PreToolUse deny）の二段 | `EnterWorktree`はモデルしか呼べずhookから起動できないため。指示だけでは保証にならず、denyだけでは毎回1回拒否される |
| ガード対象をEdit / Write / NotebookEditに限定 | 書き込み先が引数で宣言されるため決定論的に判定できる。Bashの正規表現解析は誤爆・見逃しの両方を生む |
| worktree名をsession_idのハッシュから導出 | レジストリを持たずに同一セッションの再利用と別セッションの分離が成立する。不正文字・衝突も構造的に起きない |
| worktreeを最初の書き込みまで作らない | 調査・質問だけのターンで無駄なworktreeとブランチを増やさないため。実装指示かの判定を推論に頼らずに済む |
| dirtyな共有ツリーでは停止する | worktreeはHEADから作られ未コミット変更を持ち込めない。stash / reset / コピーはいずれも利用者の変更を壊しうる |
| push / merge / worktree削除をしない | 統合はレビュー結果を人が見てから決める操作であり、後戻りできない |
| P0/P1/P2を必須修正 | 実害・信頼性・保守性に関わる指摘を通常時も休日も残さないため |
| P3を修正・持ち越し対象外 | コメント・命名・整形・任意リファクタリングによる不要な差分を増やさないため |
| スキル完了時にレビュー対象だけ自動コミット | 未追跡ファイルをセッション間で混在させず、週明けにセッション単位の結果を確認できるようにするため |
| P3除外は Claude 側フィルタ | スコープフラグとプロンプトが排他で、Codex に除外指示を渡せないため |
| テキスト出力を Claude がパース | `--output-schema` が review モードで無視されるため（上記実測） |
| `-c sandbox_mode="read-only"` 必須 | 既定が workspace-write のため。修正の責任は Claude 側に一元化 |
| 2 ラウンド目以降は `--uncommitted` | 修正（未コミット）を含む状態をレビューさせるため |
| 最大往復数（通常3 / 離席2） | レビューが収束しない場合の打ち切り。残指摘は報告に含める |
| hook はトリガーのみ | レビュー本体を hook に持たせると 10 分ブロック＋二重管理になるため |
| 自動ループはフラグファイルで opt-in | Stop hook は雑談・調査だけのターンでも毎回発火するため |
| ループ防止は差分ハッシュで自前実装 | `stop_hook_active`だけでは複数セッションと差分変更を判定できないため |

## 参考

- Codex CLI 設定リファレンス: `https://learn.chatgpt.com/docs/config-file/config-advanced`
  （`developers.openai.com/codex/config-advanced` からのリダイレクト先）
- Claude Code Hooks: `https://code.claude.com/docs/en/hooks`
- Claude Code Environment Variables: `https://code.claude.com/docs/en/env-vars`
- Claude Code Changelog（exec形式追加: 2.1.139）:
  `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21139`
- `codex exec review --help`（同梱 CLI で確認）
