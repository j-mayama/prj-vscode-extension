# 自動レビューループ（Stop hook）

`/codex-review` を毎回手で打つ代わりに、**Claude が応答を終えようとしたタイミングで
未レビューの変更を検知し、自動でレビュー → P0/P1/P2の必須修正まで回す**ための設定。

このファイルは、利用者が自動ループを有効にしたいと言ったときだけ読めばいい。
スキルは hook なしでも `/codex-review` で普通に動く。

## 仕組み

```
Claude が応答を終えようとする
  → Stop hook（scripts/stop-hook.js）が発火
      ├ .codex-review-auto が無い          → 何もしない（通す）
      ├ 差分がない                          → 通す
      ├ 現在の差分がレビュー済み            → 通す
      ├ 現在の差分で既に一度ブロック済み    → 通す（ループ防止）
      └ それ以外                            → block してレビューを指示
  → Claude が codex-review スキルを実行 → P0/P1/P2を修正（P3は対象外）
  → Step 7 で `--finalize-pending`を実行し、持ち越しとレビュー済み記録を同時に確定
  → レビュー対象ファイルだけを自動コミット（pushはしない）
  → merge-reviewed.js で元のブランチへ merge
      └ REVIEW_REQUIRED → 専用worktreeで競合解消 → 再レビュー → 再コミット → merge再試行
  → Claude が応答を終える → hook は「レビュー済み」なので通す
```

hook 自身は Codex を呼ばない。**「このターンの差分はレビューが要るか」だけを判定する**
軽量な門番で、実際のレビュー・重要度判定・修正はすべてスキルが担当する。
そのためレビューのロジックは SKILL.md の 1 か所にまとまり、hook は数百 ms で終わる。

## セットアップ（推奨）

対象リポジトリのルートで次を実行する。

```bash
node .claude/skills/codex-review/scripts/setup-auto.js --enable-schedule
```

このスクリプトは次を行う。

- `.claude/settings.local.json`へ`UserPromptSubmit` / `PreToolUse` / `Stop`の3hookを登録
- `.codex-review-auto`を作成
- 上記ローカルファイルと`.claude/worktrees/`を`.gitignore`へ追加
- `.worktreeinclude`へフラグとローカル設定を追記（秘密情報は追記しない）
- `worktree.baseRef`を`"head"`に設定（未設定のときだけ）
- 時刻による自動モード判定を有効化
- 既存hook・`.gitignore`・`.worktreeinclude`・`worktree.baseRef`を保持し、
  再実行時も重複させない

### `worktree.baseRef` を `"head"` にする理由

**既定は `"fresh"` で、`origin/<default-branch>` から分岐する。** それだと
ローカルの未pushコミットや作業中のブランチ状態を持たない worktree ができ、
「今の続きを実装してほしい」という指示に対して、リモートの状態を実装して
レビューすることになる。現在のローカル HEAD を基準にするため `"head"` にする。

利用者が既に `baseRef` を設定している場合は**上書きしない**。その場合は
`origin` 基準のままであることをセットアップの出力で伝える。

`UserPromptSubmit`は指示時刻を記録する。これが無いと、17:50に指示して18:10に
実装が終わったケースを18:10基準で離席モードと誤判定する。
指示時刻はClaude CodeのセッションIDごとに分離するため、同じ作業ツリーを共有する
別セッションの時刻で離席判定が上書きされない。

旧版の手順で`~/.claude/settings.json`または`.claude/settings.json`へhookを登録済みの場合は、
新旧のStop hookが競合しないよう通常セットアップは停止する。他のリポジトリへの影響を
確認したうえで、次を明示的に実行すると旧方式のhookだけを削除して移行する。

```bash
node .claude/skills/codex-review/scripts/setup-auto.js --migrate-legacy-hooks --enable-schedule
```

無効化する場合:

```bash
node .claude/skills/codex-review/scripts/setup-auto.js --disable
```

hook登録は残り、フラグだけを削除する。

### 手動で登録する場合

対象リポジトリの`.claude/settings.local.json`の`hooks`へ、次の3イベントを登録する。
`UserPromptSubmit`と`Stop`はmatcherをサポートしないため省略する。
グローバル・project設定へ登録すると複数バージョンが競合しやすいため使用しない。

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/path/to/codex-review/scripts/mark-prompt.js\"",
            "timeout": 30
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/path/to/codex-review/scripts/worktree-guard.js\"",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/path/to/codex-review/scripts/stop-hook.js\"",
            "timeout": 30
          }
        ]
      }
    ]
  },
  "worktree": { "baseRef": "head" }
}
```

`PreToolUse`のmatcherは英字と`|`だけで書く。`.`や`*`を含めると正規表現として
評価され、意図しないツールにも一致する。

既存hookがある場合は配列へ追加し、置き換えない。`async: true`はblock結果を返せないため
使用しない。Windowsパスはスラッシュ区切りにする。Claude Code 2.1.139未満でも動くよう、
`args`を使うexec形式ではなく引用符付きのshell形式にする。

## 同じプロジェクトで複数セッションを動かすとき

**v1.18.0 から、セッションごとの worktree 分離をスキル自身が行う。** 手で
`git worktree add` する必要はない。

```
UserPromptSubmit（mark-prompt.js）
  → 指示時刻を記録
  → 共有作業ツリーにいる？ → additionalContext で EnterWorktree を指示
Claude が EnterWorktree を呼ぶ → セッションのcwdがworktreeへ移動
  ↑ 呼ばずに書き込もうとした場合
PreToolUse（worktree-guard.js）
  → 共有作業ツリーで Bash / Edit / Write / NotebookEdit を実行 → deny
  → 拒否理由に実行すべき EnterWorktree を入れて返す
実装 → Stop hook → レビュー → 修正 → 自動コミット（すべて worktree 内）
  → merge だけは共有チェックアウト側で実行（そこへ届けるのが目的のため）
```

Stop hook の判定はこの順に進む。**「差分が無い＝通す」ではない。**

```
Stop hook（stop-hook.js）
  → 未レビューの差分がある？
       → ある … レビューを要求して block（同じ差分につき1回）
       → 無い … ここで終わらない。統合先の状態を見る
            → 統合先へ入っていないコミットがある
                 → merge-reviewed.js が実行済み？
                      → まだ … block（実行されるまで毎回）
                      → 失敗が記録されている … 通す（人しか直せない状況で閉じ込めない）
                      → 5回通知しても動きが無い … 診断を出して通す
            → 統合先を確認できない（未記録 / 複数 / 不正 / 削除済み / detached）
                 → 復旧方法を添えて block
            → 統合先に入っている … 通す
```

**未レビュー差分の検知は、コミットが成功した瞬間に必ず黙る**（作業ツリーがクリーンになる
＝fingerprint が null になるため）。そこから先に残る merge を見ているのが上の分岐で、
これが無いと「merge を忘れた」と「全部終わった」が同じ見た目になる。

**黙る条件を「通知したか」にしないのが要点。** 通知は無視できるので、無視されたら
何も変わっていない。`merge-reviewed.js` が source HEAD 単位で結果を状態ファイルへ記録し、
hook はそれを読む。「誰も試していない」と「試したが統合できない」は正反対の扱いが要る。

### なぜ hook が EnterWorktree を直接呼ばないのか

**呼べないため。** `EnterWorktree` はモデルが呼ぶツールで、hook から起動する
公式な手段は存在しない（公式ドキュメントにも記載がない）。
hook にできるのは「文脈を足す」ことと「ツール呼び出しを拒否する」ことだけ。

そこで二段構えにしてある。

1. **advisory**: `UserPromptSubmit` が `additionalContext` で分離手順を渡す。
   モデルが素直に従えば、拒否は 1 回も起きない
2. **enforcement**: `PreToolUse` が共有ツリーでのBashとファイル書き込みを決定論的に拒否する。
   モデルが従わなかった場合の最後の砦

### worktree の名前とパス

`session_id` の SHA-256 の先頭 16 桁から導出する。

- worktree名: `codex-<16桁>` / パス: `<repo>/.claude/worktrees/codex-<16桁>`
- ブランチ名は Claude Code が付ける（`worktree-<worktree名>`）
- **導出なのでレジストリを持たない。** 同じ session_id なら常に同じ worktree に
  なるため、セッション再開後も自分の worktree を見つけられる
- session_id をそのまま使わずハッシュするのは、**ブランチ名・パスとして不正な
  文字が来ても壊れないため**。異なる id が同じ worktree に落ちることもない

### merge 先の記録と、共有チェックアウトの排他

レビューと自動コミットが終わったら、`merge-reviewed.js` が worktree のブランチを
**元のブランチへ merge する**。ここで問題になることが 3 つある。

**1. 「元のブランチ」は観測できない。** merge の時点で共有チェックアウトが
checkout しているブランチは、「今なにが開いているか」であって
「この作業がどこから来たか」ではない。セッションは長く動くので、その間に利用者が
`git switch` することはある。現在のブランチを merge 先にすると、
**レビュー済みの変更が無関係なブランチへ入る**（再現確認済み）。

そこで、**分離を指示する時点**（＝共有チェックアウトが、まさに worktree を切り出す
ブランチにいる瞬間）に `mark-prompt.js` が記録する。

```bash
git config --local codexreview.<worktree名>.mergeInto <ブランチ名>
```

- キーは**ブランチ名ではなく worktree 名**。ブランチ名を付けるのは Claude Code なので、
  記録が必要な時点ではまだ分からない。worktree 名は session_id から導出できる
- 置き場所は**リポジトリの `.git/config`**。全 worktree で共有されるため、
  セッションを再開しても同じ値を読める
- **書くのは worktree がまだ無いときだけ。** 一度作られたら、以降は読むだけで書き換えない。
  これで記録は「切り出した時点のブランチ」に固定される
- merge 時は記録と現在のブランチが**一致するときだけ** merge する。違えば失敗して報告に回す。
  記録が無い・複数ある・ブランチ名として不正・対象ブランチが消えている場合も、
  推測せずに失敗する

**「今 worktree の中にいるか」で判定してはいけない。** セッションを再開すると cwd は
worktree の**外**（共有チェックアウト）に戻る — `mark-prompt.js` に
`EnterWorktree(path:)` の分岐があるのは、まさにその状態のためにある。
cwd で判定すると、再開のたびに記録が共有チェックアウトの現在ブランチへ書き換わり、
**記録と現在ブランチが揃って動くので merge 時の照合をすり抜ける**。
そのまま別ブランチへ merge して、しかも成功として報告される（再現確認済み）。
判定に使うのは cwd ではなく、**worktree が存在するかどうか**。

**2. 共有チェックアウトの index と作業ツリーは、リポジトリに 1 つしかない。**
worktree を分けても、merge 先はどのセッションから見ても同じ 1 つのツリーになる。
2 セッションが同時に merge すると `index.lock` / `update_ref` が失敗し、さらに
**失敗した側が相手の `MERGE_HEAD` を見て `git merge --abort` する**ため、
共有チェックアウトが half-merged のまま残る（20 回中 8 回で再現）。

そのため merge は、**リポジトリ共通 git ディレクトリ単位のロック**
（`lock-core.js`）の下で行う。

- worktree ごとのロックでは意味がない。**排他したい相手が別の worktree にいる**
- ロックを取ってから前提（統合先・進行中操作・dirty）を**取り直す**。
  ロックの外で見た値は、merge する頃には古い
- merge・必要な abort・HEAD と状態の最終確認まで**ロックを保持したまま**行う
- 取れなければ git 操作を一切始めずに失敗する。merge されないことは復旧できるが、
  half-merged な共有チェックアウトは復旧が難しい
- **自分が開始した merge しか abort しない**（`MERGE_HEAD` が自分の source と一致する場合だけ）。
  人が解決中の merge を巻き戻さない

**3. 後からmergeするセッションは、先行セッションと同じ行で衝突し得る。** ロックはGit操作を
直列化できても、内容の競合までは解決しない。`merge-reviewed.js`は共有側を変更する前に
`git merge-tree --write-tree`で競合を事前計算する。競合する場合は共有側へmergeせず、ロックを
解放してから、検査した統合先コミットを現在セッションのworktreeへ
`git merge --no-commit --no-ff`で取り込む。

- stdoutは`REVIEW_REQUIRED <target> <target-head> conflicts=<件数>`。終了コードは0だが完了ではない
- 競合を解消した統合結果は新しい差分なので、Codexレビューとfingerprint確定をやり直す
- `commit-reviewed.js --all`がmergeコミットを作り、専用worktreeがcleanになった後にmergeを再試行する
- その間に別セッションが先行した場合は、最新の確定targetを再び取り込んで同じ手順を繰り返す
- 共有チェックアウトには競合マーカーも`MERGE_HEAD`も残さない

記録は worktree を消しても残る（このスキルは何も自動削除しない方針のため）。
`.git/config` に使われないエントリが少しずつ増えるが、実害はない。気になる場合は
`git worktree remove` と一緒に `git config --local --unset-all codexreview.<worktree名>.mergeInto`
を手で実行する。**別セッションが記録直後で worktree 未作成の可能性があるため、
スクリプトからの自動削除はしない。**

### 何が保証され、何が保証されないか

| 経路 | 分離の保証 |
| --- | --- |
| `Edit` / `Write` / `NotebookEdit` | **保証される**（PreToolUse が deny する） |
| `Bash`（読み取り・書き込み） | **保証される**（共有ツリーではBash全体をdenyする） |
| `@` によるファイル参照 | PreToolUse が発火しない（読み取りのみなので影響なし） |

任意のシェル文字列が「書き込むかどうか」「どこへ書くか」を判定するのは決定論的にできない。
そのため共有ツリーではBash全体を拒否し、専用worktreeへ移動後に読み取り・書き込みの
どちらも許可する。これによりシェルが生成した未追跡ファイルも専用ブランチ側へ入る。

#### 共有チェックアウトのまま書けるパス

`Edit` / `Write` / `NotebookEdit` の例外は次の5ファイルと `.claude/worktrees/` 配下だけで、
**前方一致ではなく完全一致**で判定する。

| パス | 共有側でしか意味を持たない理由 |
| --- | --- |
| `.codex-review-auto` | 分離のON/OFFスイッチ。共有側のルートを見て判定している |
| `.codex-review-no-worktree` | 同上（オプトアウト） |
| `.gitignore` | `setup-auto.js` が worktree置き場の除外行を追記する |
| `.worktreeinclude` | 新しいworktreeが引き継ぐファイルの一覧 |
| `.claude/settings.local.json` | hookの登録先。worktreeへは複製されるだけなので、worktree内で編集しても共有側には戻らない |

v1.24.0までは `.claude/` 配下を丸ごと許可していた。「設定の置き場だから」という理由づけ
だったが、`.claude/skills/`・`.claude/agents/`・`.claude/commands/`・`.claude/settings.json`
はいずれも**普通の追跡ファイル**で、共有側で直接書けば並行セッションと上書き合戦になる。
**スキルそのものを開発するリポジトリでは、実際に編集するファイルだけガードが効いていない**
という逆転が起きていた。

### 分離しない場合

- **調査・質問だけのターン**: Bashを使わなければworktreeを作らない。Bashが必要なら、
  読み取り目的でも専用worktreeへ移動してから実行する
- **`.codex-review-no-worktree` がある**: そのリポジトリでは分離しない
- **共有作業ツリーに追跡済みの未コミット変更がある**: 分離すると変更が取り残されるため、**停止する**。
  `stash` / `reset` / `checkout` / コピーはしない。ユーザーが選ぶのは次の3つ。
  1. その変更を現在のブランチへコミットしてから分離する
     （`scripts/commit-shared-wip.js --plan` で対象の全件とfingerprintを出し、
     同意を得てから `--confirm <fingerprint>`。追跡ファイルだけをコミットし、
     取り消し用の `--undo` コマンドを出力する）
  2. ユーザー自身がコミットしてから指示し直す
  3. 上のファイルで分離を無効化する

  コミットを唯一の移送手段にしているのは、**履歴を足すだけで作業内容を失わない**ため。
  `stash`は競合時に復元できないことがあり、`reset` / `checkout`は書き戻しで内容を捨てる
- **未追跡ファイルだけがある**: 共有側へ保持したまま確認なしで分離する。専用worktreeで
  今回生成した未追跡ファイルとは混ぜない

### worktree 内で自動レビューが動く仕組み

`.worktreeinclude`（Claude Code の公式機能）が、gitignore 済みファイルのうち
指定したものを新しい worktree へ複製する。`setup-auto.js` は次の 2 つだけを追記する。

```text
.codex-review-auto
.claude/settings.local.json
```

- `.env` / 認証情報 / 秘密鍵は**複製しない**。公式ドキュメントは `.env` の複製を
  例示しているが、コードレビューを有効にした副作用として秘密情報を
  各 worktree へ撒くことはしない。必要なら利用者が明示的に追記する
- `WorktreeCreate` hook は登録しない。**登録すると `.worktreeinclude` が
  処理されなくなる**（公式仕様）
- 状態ファイルは `git rev-parse --show-toplevel` で分かれるため、worktree ごとに
  レビュー状態・持ち越し・フラグが独立する

### `.claude/worktrees/` を .gitignore に入れる理由

**入れないとレビューが黙って止まる。** git は入れ子の worktree を自動では無視せず、
未追跡ディレクトリとして `git status` に出す。fingerprint は未追跡一覧を
`git hash-object --stdin-paths` へ渡すが、hash-object はディレクトリで失敗する。
すると Stop hook が例外で fail-open し、**レビューが走らないのにクリーンに見える**。
再現確認済みのため、`setup-auto.js` が必ず追記する。

### それでも残る競合対策

分離していても、同じ worktree を触る経路（同一セッションの追加編集など）は残るため、
次の安全策は引き続き有効。

- **Codex が読んでいない変更をレビュー済みにせず、古いレビューで持ち越しも変えない。**
  `--finalize-pending`は「レビュー開始前に控えたfingerprint」と現在のツリーを
  pending更新の前後とreviewed記録の直前に照合し、一致しなければpendingを元へ戻して
  終了コード1を返す。
  レビュー中に別セッションが割り込んでも、その変更が未レビューのまま
  「レビュー済み」として埋もれることはない（次のターンで再レビューが促される）
- **状態ファイルはロック中に書いてから rename する。** 持ち越しの追記だけでなく、
  `reviewed` / `retry` / claimの更新もリポジトリ単位で直列化し、読み手が壊れたJSONを
  読むことや一方の更新が消えることを防ぐ。通常モードの置換は`revision`が一致するときだけ行う
- **同じ差分でレビューを起動するのは 1 セッションだけ。** ブロックする前に
  予約ファイルを排他作成（`flag: 'wx'`）するので、複数セッションが同時に停止しても
  勝つのは 1 つだけ。残りはそのターンを普通に終える。
  4 セッション同時停止で block が 1 件になることを実測で確認している
- `setup-auto.js`の再実行・`--disable`は中断したclaimとretry予約を回収する。
  セットアップ中はStop hookが新しいclaimを作らない
- **共有チェックアウトへのmergeは1セッションずつ。** リポジトリ共通gitディレクトリ単位の
  ロックを取ってから前提を取り直し、merge・abort・最終確認まで保持する。
  2 worktreeからの同時merge 20回で、共有チェックアウトがcleanなまま両方入ることを実測で確認している
- **同じ行を変えた3セッションも順番に統合する。** 後続2件をそれぞれ専用worktreeで解消・
  再コミットしてmergeを再試行し、3件すべての元コミットが最終ブランチの祖先になることを検証している
- **indexの読み書きはgit標準の`index.lock`で排他する。** スキル独自のロックは
  他セッションのスキルとしか排他できず、ターミナルの`git add`には何の効力もない。
  `commit-shared-wip.js` / `commit-reviewed.js` は、indexを観測する前にlockを取り、
  新しいindexを公開するまで保持する。競合したときに失敗するのは必ずどちらか一方だけで、
  相手がstageした内容が黙って未追跡へ戻ることはない
- **コミットは`git commit`を使わず組み立てる。** `pre-commit` hookはfingerprint検証を
  通った後にファイルを書き換えて`git add`できるため、`git commit`のままでは未レビュー内容が
  必ずコミットへ入りうる。`write-tree` ＋ `commit-tree` ＋ compare-and-swapの`update-ref`
  にすることで、確認したtreeと実際のcommit treeが一致することを構造的に保証している
  （その代わり、リポジトリ側のcommit hookはこの経路では動かない）

## テスト

同梱スクリプトには自動テストがある。一時ディレクトリの隔離gitリポジトリで動き、
`HOME` / `USERPROFILE` も一時ディレクトリへ差し替えるため、利用者の状態には触れない。

```bash
node --test ".claude/skills/codex-review/tests/*.test.js"
```

| ファイル | 対象 |
| --- | --- |
| `merge-reviewed.test.js` | merge・ロック・共有チェックアウトの保全 |
| `commit-reviewed.test.js` | レビュー済みコミット（hookに内容を差し替えさせない） |
| `commit-shared-wip.test.js` | WIPコミット（内容へ結び付いたfingerprint・index競合） |
| `worktree-guard.test.js` | 共有チェックアウトで書けるパスの範囲 |
| `stop-hook-unmerged.test.js` | 未mergeコミットの検知 |
| `worktree-core.test.js` | パス正規化とブランチ名解決 |

## ループが止まる仕組み

現在のStop入力には`stop_hook_active`があるが、これは「Stop hookから継続したターン」
であることだけを示す。複数セッションの同時実行や、Codexが実際に読んだ差分かどうかは
判定できないため、ガードは引き続きスクリプトが自前で持つ。

- **差分のフィンガープリント**を取り、状態ファイルに記録する
  （`git status` ＋ `git diff HEAD` ＋ 未追跡ファイルの `git hash-object` の SHA-256）
- **同じ差分では最大 1 回しかブロックしない。** ブロックする前に「試行済み」として
  記録するので、レビューが結果を返せなかった場合（CLI 未導入・未認証・クラッシュ）でも、
  余計なターンは 1 回で済みセッションが詰まらない
- 差分が無い場合だけ、**統合先ブランチへ入っていないコミット**を見る。こちらは
  `merge-reviewed.js` が実行された記録（状態ファイルの `merge`）が付くまで繰り返し、
  その記録が「失敗」なら通す。どちらも起きないまま 5 回通知したら診断を出して通す
- 例外が起きたら**必ず通す**（fail-open）。壊れた hook がセッションを人質にしない

状態ファイルの置き場所: `~/.claude/codex-review-state/<リポジトリのハッシュ>.json`
（リポジトリ内は汚さない）

## トラブルシューティング

| 症状 | 確認すること |
| --- | --- |
| hook が発火しない | フラグファイルがリポジトリのルートにあるか / `node` に PATH が通っているか / `settings.json` の JSON が壊れていないか（パスのバックスラッシュに注意） |
| 旧方式のhookがあると言われる | 他のリポジトリもプロジェクト単位へ移す準備をしてから`setup-auto.js --migrate-legacy-hooks`を実行する |
| 毎ターン発火し続ける | スキルのStep 7（`--finalize-pending`）が実行されているか。状態ファイルを見て`reviewed`が現在の差分と一致しているか |
| `--finalize-pending`が毎回拒否される | レビュー中に作業ツリー・ブランチ・pendingが変わっている。レビューの完了を待ってから編集する。別セッションが同じツリーを触っているならworktreeを分ける |
| ループを今すぐ止めたい | `.codex-review-auto` を削除する |
| 休日の持ち越しを見たい | `/codex-review pending` |
| 旧形式の持ち越しを元ブランチへ移したい | 元ブランチを確認して`/codex-review adopt-legacy` |
| 書き込みが毎回拒否される | 共有作業ツリーにいる。拒否メッセージのEnterWorktreeを実行する。分離自体を止めるならルートに`.codex-review-no-worktree`を作る |
| 未コミット変更があると言われて進まない | 追跡済みファイルの変更を、その場でコミットして進める（`node scripts/commit-shared-wip.js --plan` → 同意のうえ `--confirm <fingerprint>`）か、自分でコミットするか、`.codex-review-no-worktree`で分離を無効化する。未追跡ファイルだけなら停止しない。スキルはstash / resetをしない |
| WIPコミットを取り消したい | `node scripts/commit-shared-wip.js --undo <hash>`。そのコミットがブランチの先端である間だけ成功する（後続コミットがあると何もせず失敗する） |
| `git add -N` したファイルがあると進まない | intent-to-addは内容としては未追跡なのでコミット対象にしない。`git rm --cached <path>`で解除するか、利用者が内容を確認してコミットする |
| コミットしたのに共有側へ反映されない | mergeが残っている。worktree内で`node scripts/merge-reviewed.js`を実行する。実行するまでStop hookが毎回同じ指示を出す |
| worktreeが増えすぎた | `git worktree list`で確認し、統合済みのものを`git worktree remove`で消す（スキルは自動削除しない） |
| worktreeがorigin基準で作られる | `.claude/settings.local.json`の`worktree.baseRef`が`"fresh"`になっている。`"head"`にする |
| 「統合先は X です」と言われてmergeされない | 共有チェックアウトが別のブランチへ切り替わっている。`git switch X`で戻してから再実行する。別ブランチへのmergeはしない |
| 「統合先が記録されていない」と言われる | `mark-prompt.js`が記録する前に作られたworktree。エラーに出る`git config --local --replace-all codexreview.<worktree名>.mergeInto <ブランチ名>`を共有チェックアウトで実行する |
| mergeロックが取れないと言われる | 別セッションがmerge中。終わるまで待って再実行する。所有プロセスが停止していれば5分後に自動回収される。所有マーカーが壊れたロックだけは自動回収せず、パスをエラーに出して停止するので、内容を確認して手で消す |

手で試すには:

```bash
# 現在の差分の fingerprint（クリーンなら空行）
node scripts/stop-hook.js --print

# hook 本体（block するときだけ stdout に JSON を出し、通すときは無出力・終了コード 0）
echo '{"hook_event_name":"Stop","cwd":"<repo>","stop_reason":"end_turn"}' | node scripts/stop-hook.js
```
