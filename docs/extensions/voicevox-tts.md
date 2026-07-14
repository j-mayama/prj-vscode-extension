# voicevox-tts（VOICEVOX TTS for Claude Code）

## 目的 / 解決する課題

Claude Code の応答テキストを VOICEVOX（ローカルの音声合成エンジン）で自動読み上げし、
画面を見続けなくても作業の進行が分かるようにする。あわせて保存・Git 操作などの
エディタイベントに短い通知ボイスを付け、長時間作業の休憩リマインドも行う。

## フェーズ1：事前調査の結論

- ローカル .vsix v2.2.0 を基にソースを復元し、その後 v2.2.1 で公開向けの
  セキュリティ修正、Docker中継スクリプト同梱、配布手順の再現性改善を行った。

## 仕様

### 監視ファイルの JSON 契約（`~/.claude/hooks/` 配下）

**`tts_input.json`**（hooks が書く → 拡張が読む）

```json
{
  "last_assistant_message": "読み上げるテキスト",
  "ts": "任意の値（タイムスタンプ等）"
}
```

- `last_assistant_message + "|" + ts` の連結文字列を直前 1 件だけ記憶し、**直前と同一なら再生しない**
  （連続重複の抑止。過去すべての履歴を持つわけではない）
- 読み上げ前に `cleanText()` で Markdown を除去：コードブロック / インラインコード / 見出し記号 /
  リンク（表示テキストのみ残す）/ 強調記号 / URL / HTML タグ / 連続改行（句点「。」に置換）
- 監視は `fs.watch` と **100ms 間隔の `mtime` ポーリング**の二重化（`fs.watch` の取りこぼし対策）

**`voice_config.json`**（セットアップウィザードが書く）

```json
{
  "userName": "呼び名",
  "notifSpeakerId": 3,
  "mainSpeakerId": 8,
  "notifSpeed": 1.5,
  "mainSpeed": 1.2,
  "setupComplete": true
}
```

**`voice_state.json`**（状態管理・会話メモリ）

```json
{
  "actionCount": 0,
  "lastDate": "YYYY-MM-DD",
  "errors": 0,
  "fixes": 0,
  "sessionStart": 1700000000000
}
```

- 日付が変わると `actionCount` / `errors` / `fixes` をリセット
- `actionCount` が 10 に達すると励ましボイス、セッション 2 時間超で 20 回ごとに労いボイス
- ※ `errors` / `fixes` はリセットのみでインクリメント処理が存在しない（未使用フィールド）

### 音声再生フロー

1. **読み上げ（動的合成）**: `POST /audio_query?text=...&speaker=...` → 返却クエリの
   `speedScale` を上書き → `POST /synthesis?speaker=...` で WAV 取得 →
   OS 一時ディレクトリに書き出し → PowerShell `Media.SoundPlayer.PlaySync()` で再生後、一時ファイル削除
2. **通知ボイス（事前生成 WAV）**: ウィザードが `~/.claude/hooks/` に 45 個の WAV を生成
   （VSCode イベント / Git / 時間帯あいさつ / 感情 / メモリ系）。`playWav()` は
   ファイルが存在しなければ何もしない
3. **HTTP リレー**: `0.0.0.0:50022` で待ち受け。POST要求はランダム生成したトークンを
   `X-VOICEVOX-Relay-Token` ヘッダーで検証する。`POST /speak`（テキスト読み上げ）/
   `POST /play`（既存 WAV 再生）/ `POST /notify`（メッセージ最終行を 120 文字まで抽出し、
   呼び名を先頭に付けて読み上げ）/ `GET /health` を提供する。リクエスト本文は64KiB、
   読み上げ文字列は10,000文字に制限する

### アクティベーション / 実行環境

- `activationEvents: ["onStartupFinished"]` — 起動完了後に遅延アクティベート
- `extensionKind: ["ui"]` — リモート開発（SSH / WSL / Dev Container）でも
  **必ずローカル UI 側で実行**される指定。ローカルの `~/.claude/hooks/` の監視と
  ローカルスピーカーでの再生が目的のため必須
- セットアップ未完了時はウィザードを起動し、スキップされた場合は
  `voicevox-tts.setup` コマンドだけ登録して終了（最小フットプリント）

### コマンド

| コマンド ID | 動作 |
|---|---|
| `voicevox-tts.setup` | セットアップウィザード。VOICEVOX の `/version` で疎通確認 → 呼び名・話者 2 種・速度を対話設定 → 通知 WAV 一式を生成 → `voice_config.json` 保存 |
| `voicevox-tts.setupDocker` | docker-compose ファイル検出（なければファイル選択ダイアログ）→ サービス選択 → `docker-compose.override.yml` 生成（hooks ディレクトリの ro マウント + `extra_hosts`）→ 起動中コンテナがあれば自動セットアップ（同梱リレースクリプトと認証トークンを配置、既存 `Stop` hooksを保持して追記、認証付き疎通テスト）→ 手順を Webview で表示 |

## 使う VSCode API / Contribution Points

- **Contribution Points**: `commands`（2 件）のみ
- **API**:
  - `window`: `showInformationMessage` / `showErrorMessage` / `showWarningMessage` /
    `showInputBox` / `showQuickPick` / `showOpenDialog` / `withProgress` /
    `createOutputChannel` / `createWebviewPanel` / `onDidChangeActiveTextEditor` /
    `onDidOpenTerminal` / `onDidCloseTerminal` / `onDidChangeWindowState`
  - `workspace`: `workspaceFolders` / `onDidSaveTextDocument` / `onDidCreateFiles` /
    `onDidDeleteFiles` / `onDidRenameFiles`
  - `debug`: `onDidStartDebugSession` / `onDidTerminateDebugSession`
  - `tasks`: `onDidStartTask` / `onDidEndTask`
  - `commands.registerCommand` / `extensions.getExtension('vscode.git')`（Git 拡張 API v1 で
    ブランチ切替を検知）
- **Node.js**: `fs`（watch / 同期 I/O）/ `http`（クライアント + リレーサーバー）/
  `child_process.execFile`（PowerShell再生とdocker CLI。ホストシェルは使用しない）/ `crypto` / `os` / `path`

## ベストプラクティス（調査結果）

- 参照した公式ドキュメント URL：
  - `https://code.visualstudio.com/api/references/activation-events`（`onStartupFinished`）
  - `https://code.visualstudio.com/api/advanced-topics/extension-host`（`extensionKind` と UI 拡張）
- 推奨パターン：遅延アクティベーション（`onStartupFinished`）、イベント購読・タイマー・
  リレーサーバーの `context.subscriptions` 登録は実装済み
- 同期 `fs.*Sync` の多用は拡張ホストをブロックし得るため、将来の非同期化候補
- パフォーマンス / アクティベーションの注意：100ms ポーリングは常駐コストになる。
  `fs.watch` が Windows で安定していれば間隔を伸ばす余地あり

## セキュリティ上の注意（この拡張固有）

- 扱うシークレット / 認証情報：`~/.claude/hooks/voicevox_relay_token` にランダムな
  256-bit相当のローカル認証トークンを生成する。リポジトリやVSIXには実値を含めない
- 外部送信するデータ：**なし**（実コードで確認済み）。HTTP クライアントの接続先は
  `127.0.0.1:50021`（VOICEVOX エンジン）のみにハードコードされており、
  読み上げテキストがマシン外に送信されるコードパスは存在しない
- Webview の有無と CSP 方針：Docker セットアップ手順表示に Webview を 1 つ使用。
  `enableScripts: false`、`default-src 'none'` のCSPを設定し、動的文字列はHTMLエスケープする
- **リレーサーバーが `0.0.0.0:50022` で待ち受ける点に注意**：
  - Docker コンテナから `host.docker.internal` で到達させるための仕様だが、
    同一ネットワークの他ホストからも到達し得る
  - POSTは認証必須。`GET /health` 以外のGETエンドポイントは提供しない
  - `/play` は単純なWAVファイル名だけを許可し、解決後のパスがhooksディレクトリ内か検証する
- 再生に PowerShell を使うため **Windows 専用**。ファイルパスはPowerShellコードへ連結せず、
  子プロセスの環境変数で渡す

## 実装メモ

- 主要ファイル：
  - `extensions/voicevox-tts/extension.js` — VSCode拡張本体（素のJavaScript）
  - `extensions/voicevox-tts/voicevox_tts_relay.py` — Dockerコンテナ用の認証付き中継スクリプト
  - `extensions/voicevox-tts/package.json` — マニフェスト（`publisher` 未設定）
  - `extensions/voicevox-tts/README.md` — 利用者向け説明
  - `extensions/voicevox-tts/.vscodeignore` — `.vsix` 梱包対象の限定
- 検証：`node --check extension.js`、Python 3.12での中継スクリプト構文検査、
  `npm ci && npm run package` によるクリーンなVSIX作成を実施
- 未解決の課題 / TODO：
  - **`publisher` 未設定** — このままパッケージすると拡張 ID が
    `undefined_publisher.voicevox-tts` になる。Marketplace 公開はできないため、
    公開するなら publisher の取得・設定が必要（ローカル利用のみなら現状でも動く）
  - **ライセンス未指定** — 公開リポジトリとしての利用条件は権利者が決定し、LICENSEを追加する必要がある
  - **TypeScript 化**（`strict: true` + esbuild、リポジトリ標準スタックへの移行）と
    **テスト追加**（`@vscode/test-cli`）は今後の改良候補
  - `voice_state.json` の `errors` / `fixes` が未使用（実装するか削除する）
  - エラー通知の改善 — VOICEVOX 未起動時、読み上げ失敗が `console.error` のみで
    ユーザーに見えない（`window.showErrorMessage` か OutputChannel への出力を検討）
