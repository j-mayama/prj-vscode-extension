# prj-vscode-extension

自作 VSCode 拡張機能を開発・管理するリポジトリ。各拡張は `extensions/<name>/` に独立したパッケージとして置いている。

## 拡張一覧

### Git Branch Diff Extractor（`extensions/git-branch-diff-extractor`）

サイドバーから Git ブランチを選択し、分岐元からの差分ファイルをディレクトリ構造ごと抽出する拡張。

- サイドバーにローカルブランチを一覧表示（直近コミット順）
- ブランチをクリックすると出力先フォルダを選択し、差分ファイルを一括コピー
- 文字コード・改行コードを一切変換しないバイナリコピー
- コミット範囲を指定した抽出にも対応

**インストール**: `extensions/git-branch-diff-extractor` で `npm install && npm run compile` のあと
`npx @vscode/vsce package` で `.vsix` を作成し、VSCode の「Install from VSIX...」から導入する。

### VOICEVOX TTS for Claude Code（`extensions/voicevox-tts`）

Claude Code の hooks が書き出すメッセージを監視し、ローカルの [VOICEVOX](https://voicevox.hiroshiba.jp/) エンジンで読み上げる拡張。

- `~/.claude/hooks/tts_input.json` を監視して新着メッセージを音声合成・再生
- 音声合成はローカルの VOICEVOX エンジン（`127.0.0.1:50021`）のみを使用（外部送信なし）
- セットアップ用コマンド（`VOICEVOX: Setup Wizard` / `VOICEVOX: Setup Docker Integration`）付き

**前提**: VOICEVOX エンジンがローカルで起動していること。

**インストール**: `extensions/voicevox-tts` で `npx @vscode/vsce package --no-dependencies` で `.vsix` を作成し、「Install from VSIX...」から導入する。

## 開発

リポジトリルートを VSCode で開き、「実行とデバッグ」（F5）から各拡張の起動構成を選ぶと Extension Development Host で動作確認できる。各拡張の設計・実装記録は `docs/extensions/` を参照。
