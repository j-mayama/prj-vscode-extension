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
        "matcher": "Edit|Write|NotebookEdit",
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
  → Edit / Write / NotebookEdit の書き込み先が共有作業ツリー内 → deny
  → 拒否理由に実行すべき EnterWorktree を入れて返す
実装 → Stop hook → レビュー → 修正 → 自動コミット（すべて worktree 内）
```

### なぜ hook が EnterWorktree を直接呼ばないのか

**呼べないため。** `EnterWorktree` はモデルが呼ぶツールで、hook から起動する
公式な手段は存在しない（公式ドキュメントにも記載がない）。
hook にできるのは「文脈を足す」ことと「ツール呼び出しを拒否する」ことだけ。

そこで二段構えにしてある。

1. **advisory**: `UserPromptSubmit` が `additionalContext` で分離手順を渡す。
   モデルが素直に従えば、拒否は 1 回も起きない
2. **enforcement**: `PreToolUse` が共有ツリーへの書き込みを決定論的に拒否する。
   モデルが従わなかった場合の最後の砦

### worktree の名前とパス

`session_id` の SHA-256 の先頭 16 桁から導出する。

- worktree名: `codex-<16桁>` / パス: `<repo>/.claude/worktrees/codex-<16桁>`
- ブランチ名は Claude Code が付ける（`worktree-<worktree名>`）
- **導出なのでレジストリを持たない。** 同じ session_id なら常に同じ worktree に
  なるため、セッション再開後も自分の worktree を見つけられる
- session_id をそのまま使わずハッシュするのは、**ブランチ名・パスとして不正な
  文字が来ても壊れないため**。異なる id が同じ worktree に落ちることもない

### 何が保証され、何が保証されないか

| 経路 | 分離の保証 |
| --- | --- |
| `Edit` / `Write` / `NotebookEdit` | **保証される**（PreToolUse が deny する） |
| `Bash` からの書き込み | **保証されない**（下記） |
| `@` によるファイル参照 | PreToolUse が発火しない（読み取りのみなので影響なし） |

**Bash は意図的に対象外。** 任意のシェル文字列が「書き込むかどうか」「どこへ書くか」を
正規表現で判定するのは決定論的にできない。誤って `git status` を止めるか、
`sed -i` を通すかのどちらかになる。**間違ったガードは、無いガードより悪い。**
そのため対象を「書き込み先を引数で宣言するツール」に限定し、
残った穴をここに明示している。

実際には、worktree へ移動するとセッションの cwd も移動するため、相対パスで動く
シェルの書き込みは worktree 内へ落ちる。穴が残るのは
**共有作業ツリーを絶対パスで指す Bash の書き込み**だけ。

### 分離しない場合

- **調査・質問だけのターン**: worktree を作らない。最初の書き込みまで遅延する設計のため、
  読み取りだけで終われば何も起きない
- **`.codex-review-no-worktree` がある**: そのリポジトリでは分離しない
- **共有作業ツリーが dirty**: 分離すると未コミット変更が取り残されるため、**停止する**。
  `stash` / `reset` / `checkout` / コピーはしない。コミットするか、上のファイルで
  無効化するかをユーザーが決める

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

## ループが止まる仕組み

現在のStop入力には`stop_hook_active`があるが、これは「Stop hookから継続したターン」
であることだけを示す。複数セッションの同時実行や、Codexが実際に読んだ差分かどうかは
判定できないため、ガードは引き続きスクリプトが自前で持つ。

- **差分のフィンガープリント**を取り、状態ファイルに記録する
  （`git status` ＋ `git diff HEAD` ＋ 未追跡ファイルの `git hash-object` の SHA-256）
- **同じ差分では最大 1 回しかブロックしない。** ブロックする前に「試行済み」として
  記録するので、レビューが結果を返せなかった場合（CLI 未導入・未認証・クラッシュ）でも、
  余計なターンは 1 回で済みセッションが詰まらない
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
| 未コミット変更があると言われて進まない | 共有作業ツリーの変更をコミットするか、`.codex-review-no-worktree`で分離を無効化する。スキルはstash / resetをしない |
| worktreeが増えすぎた | `git worktree list`で確認し、統合済みのものを`git worktree remove`で消す（スキルは自動削除しない） |
| worktreeがorigin基準で作られる | `.claude/settings.local.json`の`worktree.baseRef`が`"fresh"`になっている。`"head"`にする |

手で試すには:

```bash
# 現在の差分の fingerprint（クリーンなら空行）
node scripts/stop-hook.js --print

# hook 本体（block するときだけ stdout に JSON を出し、通すときは無出力・終了コード 0）
echo '{"hook_event_name":"Stop","cwd":"<repo>","stop_reason":"end_turn"}' | node scripts/stop-hook.js
```
