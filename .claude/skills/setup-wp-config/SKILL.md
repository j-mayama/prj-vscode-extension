---
name: setup-wp-config
description: "Use when: /setup-wp-config を実行して wp-config.php のDB情報とテーブル接頭子を後から修復したいとき。Docker 再ビルドなしで .devcontainer の値を wp-config.php に同期する。"
version: "1.2.0"
---

# setup-wp-config

`/setup-wp-config` で実行する復旧用スキル。

## 役割とアーキテクチャ上の位置づけ

Docker の php サービス起動スクリプト（`init-wp-config.sh`）は、`wp-config.php` が**既に存在する場合はDB値を一切書き換えない**設計になっている。  
このスキルは「Docker再ビルドなしでDB情報だけを正しい値に同期する」ための専用コマンド。

**責務分担：**

- `init-wp-config.sh`（Docker起動時）→ WPコアファイルのコピーと wp-config.php の新規作成のみ。既存のDB値は保持する
- `setup-wp-config`（このスキル）→ `.devcontainer/docker-compose.yml` から DB情報を読み取り、wp-config.php に書き込む

## 目的・いつ実行するか

- Docker 初回起動後、wp-config.php の DB値が空になっていたとき
- DB情報を変更した後（`docker-compose.yml` の環境変数を修正した場合）
- `git pull` や別環境コピー後に wp-config.php の DB値が古くなっているとき
- **Docker を再起動しても DB値が消える場合は `init-wp-config.sh` のパスや中身を確認すること**（このスキルでは直らない）

1. 以下を実行する

```bash
python3 .claude/skills/setup-wp-config/scripts/setup_wp_config.py
```

2. 必要に応じてオプションを付ける

```bash
python3 .claude/skills/setup-wp-config/scripts/setup_wp_config.py \
  --wp-root wordpress \
  --wp-table-prefix wp_example_
```

## オプション

- `--project-root` 既定 `/workspace`
- `--output` 既定 `.devcontainer`
- `--wp-root` 既定 `wordpress`
- `--name` 未指定時は `.devcontainer/devcontainer.json` の `name` から自動取得
- `--wp-table-prefix` 任意。指定時は接頭子を上書きし、差分があれば `warnings` を返す

## 完了条件

- コマンドの終了コードが `0`
- 出力JSONに `mode: repair-wp-config-only` が含まれる
- `wordpress/wp-config.php` の `DB_NAME/DB_USER/DB_PASSWORD/DB_HOST/$table_prefix` が空でない

---

## スキル更新ルール

このスキル自体をフィードバックに基づいて更新する際は、必ず以下を守ること：

1. frontmatter の `version` のマイナーバージョンを 1 つ上げる（例: `1.1.0` → `1.2.0`）
2. `## 変更履歴` テーブルに新しい行を追加する（日付・変更内容）

バージョニング規則：

| 種別                     | 対象                                     | 例                                           |
| ------------------------ | ---------------------------------------- | -------------------------------------------- |
| **マイナー** (x.**Y**.z) | フィードバック反映・機能追加・フロー改善 | 検出ロジック変更、新セクション追加           |
| **パッチ** (x.y.**Z**)   | 誤字修正・説明文の微調整                 | 文言変更のみ                                 |
| **メジャー** (**X**.y.z) | 破壊的変更                               | フロー全面見直し、テンプレート構造の大幅刷新 |

---

## 変更履歴

| バージョン | 日付       | 変更内容                                                     |
| ---------- | ---------- | ------------------------------------------------------------ |
| 1.2.0      | 2026-07-14 | 非標準の既定 WP ルート名を `wordpress` に変更                |
| 1.1.0      | 2026-07-14 | 公開リポジトリ向けに、例示のテーブル接頭子を汎用値に置換     |
| 1.0.0      | 2026-05-08 | 初回リリース                                                 |
