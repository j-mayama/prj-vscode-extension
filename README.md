# prj-vscode-support

VSCode まわりの開発を助けるツールを置いているリポジトリ。成果物は 2 種類ある。

- **VSCode 拡張機能**（`extensions/<name>/`）— VSCode 本体の機能を増やす
- **Claude Code スキル**（`.claude/skills/<name>/`）— [Claude Code](https://code.claude.com/docs/en/skills) に定型作業の手順を持たせる

---

## VSCode 拡張機能

### Git Branch Diff Extractor（`extensions/git-branch-diff-extractor`）

サイドバーから Git ブランチを選択し、分岐元からの差分ファイルをディレクトリ構造ごと抽出する拡張。

- サイドバーにローカルブランチを一覧表示（直近コミット順）
- ブランチをクリックすると設定済みの出力先へ日時フォルダを作り、差分ファイルを一括コピー
- 文字コード・改行コードを一切変換しないバイナリコピー
- コミット範囲を指定した抽出にも対応

**インストール**: `extensions/git-branch-diff-extractor` で `npm ci && npm run package` を実行して
`.vsix` を作成し、VSCode の「Install from VSIX...」から導入する。

### VOICEVOX TTS for Claude Code（`extensions/voicevox-tts`）

Claude Code の hooks が書き出すメッセージを監視し、ローカルの [VOICEVOX](https://voicevox.hiroshiba.jp/) エンジンで読み上げる拡張。

- `~/.claude/hooks/tts_input.json` を監視して新着メッセージを音声合成・再生
- 音声合成はローカルの VOICEVOX エンジン（`127.0.0.1:50021`）のみを使用（外部送信なし）
- セットアップ用コマンド（`VOICEVOX: Setup Wizard` / `VOICEVOX: Setup Docker Integration`）付き

**前提**: VOICEVOX エンジンがローカルで起動していること。

**インストール**: `extensions/voicevox-tts` で `npm ci && npm run package` を実行して `.vsix` を作成し、
「Install from VSIX...」から導入する。Docker用HTTPリレーのPOST要求はランダムトークンで認証される。

---

## Claude Code スキル

各スキルは `.claude/skills/<name>/SKILL.md` に手順を持つ。Claude が関連する作業を検知すると自動で読み込み、
`/<name>` と打てば直接呼び出せる。

| スキル | できること |
| --- | --- |
| **`/codex-review`** | OpenAI Codex CLI（`codex exec review`）による独立コードレビュー＆修正ループ。P0/P1/P2は勤務中・休日とも必須修正し、P3は対象外として結果にだけ残し、完了後はレビュー対象を自動コミットする。`scripts/setup-auto.js`で未レビュー差分の自動検知をリポジトリ単位に有効化できる（要: Codex CLI と ChatGPT 認証） |
| **`/secret-scan`** | 公開・コミット前の機密情報チェック。シークレット・PII・ローカル絶対パス・内部固有名詞を、汎用スキャナ（secretlint / gitleaks）＋ 目視 ＋ git 履歴 ＋ `.vsix` 梱包物の4層で検査する |
| **`/structured-data`** | 構造化データ（JSON-LD / schema.org）の実装・レビュー・検証。型の対応状況を公式ドキュメントで検証してから実装するので、廃止済みのリッチリザルトを作らない |
| **`/set-md`** | サイト構造を解析して、AI エージェント向けのドキュメント（`AGENTS.md` / `agent_docs/*.md`）を生成する。WP / フォーム / 静的 HTML サイトの3パターンに対応 |
| **`/setup-gitignore`** | WordPress プロジェクトの `.gitignore` を生成する。WP インストールを自動検出し、wp-content 名・テーマ名を正しいパスで埋め込む |
| **`/wp-docker-setup`** | WordPress のローカル開発環境（`.devcontainer`）を半自動セットアップする。本番の `phpinfo()` を貼ると PHP / MySQL / WP のバージョンを揃えたテンプレートを展開する |
| **`/wp-docker-update`** | 古いバージョンで作った既存の `.devcontainer` に、後から増えた機能だけを足す。生成時に記録したファイルごとのハッシュを使って「テンプレが新しくなっただけ」と「自分で手直しした」を区別するので、手編集を勝手に潰さない |
| **`/setup-wp-config`** | `wp-config.php` の DB 情報とテーブル接頭子を、Docker 再ビルドなしで `.devcontainer` の値に同期する |

**使い方**: このリポジトリの `.claude/skills/<name>/` を、使いたいプロジェクトの `.claude/skills/` 配下に
コピーする（ユーザー全体で使うなら `~/.claude/skills/`）。スキルによっては Python スクリプトや
テンプレートを同梱しているので、ディレクトリごとコピーすること。

---

## 開発

リポジトリルートを VSCode で開き、「実行とデバッグ」（F5）から各拡張の起動構成を選ぶと
Extension Development Host で動作確認できる。各成果物の設計・実装記録は `docs/` を参照。
