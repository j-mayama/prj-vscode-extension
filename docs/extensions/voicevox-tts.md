# voicevox-tts（VOICEVOX TTS for Claude Code）

## 目的 / 解決する課題

Claude Code の応答テキストを VOICEVOX（ローカルの音声合成エンジン）で自動読み上げし、
画面を見続けなくても作業の進行が分かるようにする。あわせて保存・Git 操作などの
エディタイベントに短い通知ボイスを付け、長時間作業の休憩リマインドも行う。

## フェーズ1：事前調査の結論

- **既存の自作拡張（ローカル .vsix、v2.2.0）の復元のため対象外。**
  インストール済みフォルダから `extension.js` / `package.json` をソースとして回収した
  （extension.js はハッシュ一致でバイト同一、package.json はインストーラが付与する
  `__metadata` キーのみ削除）。機能改良は今回行っていない。

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
2. **通知ボイス（事前生成 WAV）**: ウィザードが `~/.claude/hooks/` に 39 個の WAV を生成
   （VSCode イベント / Git / 時間帯あいさつ / 感情 / メモリ系）。`playWav()` は
   ファイルが存在しなければ何もしない
3. **HTTP リレー**: `0.0.0.0:50022` で待ち受け。`POST /speak`（テキスト読み上げ）/
   `POST /play`（既存 WAV 再生）/ `POST /notify`（メッセージ最終行を 120 文字まで抽出し、
   呼び名を先頭に付けて読み上げ）/ `GET /health` / `GET /setup`
   （コンテナ用セットアップ bash スクリプトを返す。リレースクリプトとホストの
   `~/.claude/CLAUDE.md` を base64 で同梱）

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
| `voicevox-tts.setupDocker` | docker-compose ファイル検出（なければファイル選択ダイアログ）→ サービス選択 → `docker-compose.override.yml` 生成（hooks ディレクトリの ro マウント + `extra_hosts`）→ 起動中コンテナがあれば自動セットアップ（リレースクリプト `docker cp`、`settings.json` へ Stop フックをマージ、疎通テスト）→ 手順を Webview で表示 |

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
  `child_process`（`execFile` で PowerShell 再生、`exec` で docker CLI）/ `os` / `path`

## ベストプラクティス（調査結果）

- 参照した公式ドキュメント URL：
  - `https://code.visualstudio.com/api/references/activation-events`（`onStartupFinished`）
  - `https://code.visualstudio.com/api/advanced-topics/extension-host`（`extensionKind` と UI 拡張）
- 推奨パターン：遅延アクティベーション（`onStartupFinished`）、イベント購読の
  `context.subscriptions` 登録、リレーサーバーの dispose 登録は実装済み
- 避けるべきこと（アンチパターン）：`setInterval` の未解放（後述 TODO）、
  同期 `fs.*Sync` の多用（拡張ホストをブロックし得る）
- パフォーマンス / アクティベーションの注意：100ms ポーリングは常駐コストになる。
  `fs.watch` が Windows で安定していれば間隔を伸ばす余地あり

## セキュリティ上の注意（この拡張固有）

- 扱うシークレット / 認証情報：**なし**（設定は呼び名と話者 ID・速度のみ）
- 外部送信するデータ：**なし**（実コードで確認済み）。HTTP クライアントの接続先は
  `127.0.0.1:50021`（VOICEVOX エンジン）のみにハードコードされており、
  読み上げテキストがマシン外に送信されるコードパスは存在しない
- Webview の有無と CSP 方針：Docker セットアップ手順表示に Webview を 1 つ使用。
  `enableScripts: false`（スクリプト無効）で静的 HTML のみ。ただし CSP メタタグは未設定で、
  セットアップ結果文字列を HTML エスケープせずに埋め込んでいる（改良候補）
- **リレーサーバーが `0.0.0.0:50022` で待ち受ける点に注意**：
  - Docker コンテナから `host.docker.internal` で到達させるための仕様だが、
    同一ネットワークの他ホストからも到達し得る
  - `GET /setup` はホストの `~/.claude/CLAUDE.md` の内容を base64 で応答に含める
    （ローカル情報の露出になり得る。ループバック + Docker ブリッジに限定する改良を推奨）
  - `POST /play` の `wav` はファイル名検証がなく、`path.join` の結果を PowerShell の
    引用符内に埋め込むため、パストラバーサル / 文字列インジェクションの余地がある
    （ローカルネットワーク前提だが要改善）
- 再生に PowerShell を使うため **Windows 専用**。`execFile` に渡すコマンド文字列へ
  一時ファイルパスを埋め込んでいる（パスは自前生成のため実害は限定的）

## 実装メモ

- 主要ファイル：
  - `extensions/voicevox-tts/extension.js` — 全実装（単一ファイル、素の JavaScript 864 行）
  - `extensions/voicevox-tts/package.json` — マニフェスト（`publisher` 未設定）
  - `extensions/voicevox-tts/README.md` — 利用者向け説明
  - `extensions/voicevox-tts/.vscodeignore` — `.vsix` 梱包対象の限定
- 復元時の検証：
  - `extension.js` はインストール済み実体と SHA-256 一致（バイト同一）
  - `package.json` はインストーラ付与の `__metadata` のみ削除、他は同一
  - `node --check extension.js` で構文エラーなし
- 未解決の課題 / TODO：
  - **`publisher` 未設定** — このままパッケージすると拡張 ID が
    `undefined_publisher.voicevox-tts` になる。Marketplace 公開はできないため、
    公開するなら publisher の取得・設定が必要（ローカル利用のみなら現状でも動く）
  - **リソース dispose の不足** — `fs.watch` は `deactivate()` で close されるが
    `context.subscriptions` 未登録。**3 つの `setInterval`（100ms ポーリング / 休憩リマインド /
    深夜チェック）と Docker 検出の `setTimeout` は一切解放されない**。
    `context.subscriptions` への登録に統一すべき
  - **存在しない WAV を参照** — 休憩リマインドの `break_1..3.wav`、深夜チェックの
    `latenight_1..3.wav` はウィザードの生成対象に含まれておらず、別途手動生成しない限り
    無音でスキップされる（`kangaechuu.wav` は生成されるが拡張内では未使用）
  - **TypeScript 化**（`strict: true` + esbuild、リポジトリ標準スタックへの移行）と
    **テスト追加**（`@vscode/test-cli`）は今後の改良候補
  - リレーサーバーの待ち受けをループバック + Docker ネットワークに限定する
  - `voice_state.json` の `errors` / `fixes` が未使用（実装するか削除する）
  - エラー通知の改善 — VOICEVOX 未起動時、読み上げ失敗が `console.error` のみで
    ユーザーに見えない（`window.showErrorMessage` か OutputChannel への出力を検討）
