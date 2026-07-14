# VOICEVOX TTS for Claude Code

Claude Code の応答を [VOICEVOX](https://voicevox.hiroshiba.jp/) の合成音声で読み上げる VSCode 拡張機能。
あわせて、ファイル保存・Git 操作・デバッグ開始などのエディタイベントに短い効果音ボイスを付ける。

## できること

- **Claude Code 応答の読み上げ** — Claude Code の hooks が書き出す `~/.claude/hooks/tts_input.json` を監視し、
  最後のアシスタントメッセージを VOICEVOX で合成して再生する（Markdown 記法は除去して読み上げ）
- **エディタイベントの通知ボイス** — 保存 / タブ切替 / ファイル作成・削除・リネーム / ターミナル開閉 /
  デバッグ開始・終了 / タスク開始・終了 / ウィンドウフォーカス / Git ブランチ切替 に短い音声を再生
- **時間帯あいさつ** — 起動時に朝・昼・夜・深夜で異なるあいさつを再生
- **HTTP リレーサーバー** — ポート `50022` で待ち受け、Docker コンテナ内の Claude Code からも
  認証付きの `POST /speak` 等で読み上げをリクエストできる

## 前提条件

- **Windows**（音声再生に PowerShell の `Media.SoundPlayer` を使用しているため）
- **VOICEVOX エンジンがローカルで起動していること** — `127.0.0.1:50021` で HTTP API に接続する。
  VOICEVOX アプリを起動しておくか、エンジン単体を起動しておく
- VSCode 1.85 以上
- 読み上げ連携には Claude Code 側の hooks 設定が必要（後述）

## インストール

Marketplace には公開していない。`.vsix` を手元でパッケージしてインストールする。

```bash
cd extensions/voicevox-tts
npm ci
npm run package
code --install-extension voicevox-tts-2.2.1.vsix
```

## セットアップ

初回起動時（`onStartupFinished`）にセットアップウィザードが自動で始まる。
スキップした場合はコマンドパレットから **`VOICEVOX: Setup Wizard`** を実行する。

ウィザードでは次を設定する。

1. 呼び名（音声があなたを呼ぶ名前）
2. 通知ボイスの話者（短いフレーズ用）
3. メイン読み上げの話者（応答の読み上げ用）
4. 読み上げ速度

完了すると、設定が `~/.claude/hooks/voice_config.json` に保存され、
通知用の WAV ファイル一式が `~/.claude/hooks/` に生成される。

## Claude Code hooks との連携

この拡張自体はファイルを「監視して再生する」だけで、`tts_input.json` への書き込みは
Claude Code の hooks（例: `Stop` フック）側で行う。フックスクリプトが
最後のアシスタントメッセージを次の形式で書き出すと、拡張が検知して読み上げる。

```json
{
  "last_assistant_message": "読み上げたいテキスト",
  "ts": "重複再生防止用のタイムスタンプなど任意の値"
}
```

直前に再生したものと同じ `last_assistant_message` + `ts` の組は再生されない（連続重複の抑止）。

## Docker コンテナ内の Claude Code との連携

コマンドパレットの **`VOICEVOX: Setup Docker Integration`** で設定できる
（ワークスペースに docker-compose ファイルがあると起動時に自動提案もされる）。

仕組み:

- 拡張がホスト側でリレーサーバー（ポート `50022`）を起動している
- コンテナ内の Claude Code フックが `http://host.docker.internal:50022/speak` に
  テキストを POST すると、ホスト側で VOICEVOX 合成・再生される
- セットアップコマンドは `docker-compose.override.yml` の生成
  （`~/.claude/hooks/` の read-only マウントと `extra_hosts` 追加）と、
  起動中コンテナへのリレースクリプト配置・`settings.json` への Stop フック追記を行う
- 拡張が生成する `voicevox_relay_token` をリレースクリプトが読み、各 POST リクエストを認証する

リレーサーバーのエンドポイント:

| メソッド | パス | 用途 |
|---|---|---|
| POST | `/speak` | `{"text": "..."}` を読み上げ |
| POST | `/play` | `{"wav": "ファイル名"}` で `~/.claude/hooks/` 内の WAV を再生 |
| POST | `/notify` | `{"message": "..."}` の最終行を抽出して読み上げ |
| GET | `/health` | 稼働確認 |

POST エンドポイントは `X-VOICEVOX-Relay-Token` ヘッダーが必須。通常は同梱の
`voicevox_tts_relay.py` がトークンを読み込むため、手動で指定する必要はない。

## コマンド一覧

| コマンド | 説明 |
|---|---|
| `VOICEVOX: Setup Wizard` | 話者・速度などの初期設定（再実行で再設定） |
| `VOICEVOX: Setup Docker Integration` | Docker コンテナ連携のセットアップ |

## 使用するファイル（`~/.claude/hooks/` 配下）

| ファイル | 役割 |
|---|---|
| `tts_input.json` | 読み上げ対象メッセージ（hooks が書き、拡張が読む） |
| `voice_config.json` | ウィザードで作る設定（呼び名・話者 ID・速度） |
| `voice_state.json` | 作業回数などの状態（励ましボイスのトリガー用） |
| `*.wav` | ウィザードが生成する通知ボイス |
| `voicevox_tts_relay.py` | 拡張が配置する、コンテナ内から `50022` へ中継するスクリプト |
| `voicevox_relay_token` | リレーサーバー認証用に拡張がランダム生成するトークン |

## 注意事項

- 音声合成はすべてローカルの VOICEVOX エンジン（`127.0.0.1:50021`）で行われ、外部にデータを送信しない
- リレーサーバーはコンテナから到達できるよう `0.0.0.0:50022` で待ち受ける。
  POST エンドポイントはランダムトークンで認証されるが、信頼できないネットワークでは引き続き
  ファイアウォールでポート `50022` への外部アクセスを遮断すること
- VOICEVOX の音声を利用する際は、各キャラクターの利用規約に従うこと
