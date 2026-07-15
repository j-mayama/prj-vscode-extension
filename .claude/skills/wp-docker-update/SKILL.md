---
name: wp-docker-update
version: "1.1.0"
description: wp-docker-setup で構築済みの既存 .devcontainer/ を、現在のテンプレと突き合わせて「足りない機能」を検出し、安全な差分だけを追加・更新するスキル。発動キーワード「Docker環境を更新」「devcontainer を最新化」。古いバージョンで作った環境に後付けされた機能（リビルド前クリーンアップ、ポートのlocalhost限定、wp-config非破壊化、.sh の LF 固定など）が入っているかを診断し、利用者が手で変更・削除したファイルは明示的に選ばれない限り上書きしない。新規構築は wp-docker-setup（Dockerセットアップ）の担当。
---

# wp-docker-update

## 役割

既に `.devcontainer/` がある案件に対して、**現在の wp-docker-setup テンプレとの差分**を出し、
安全な範囲だけを更新する。**新規構築はこのスキルの担当ではない**（→ `wp-docker-setup`）。

- **判定・ファイル操作**: `scripts/update_devcontainer.py` が決定論的に行う
- **提示・確認**: Claude が担当（逆算値の確認、conflict の判断をユーザーに仰ぐ）

## 発動キーワード

- 「Docker環境を更新」「devcontainer を最新化」「devcontainer を更新」
- 「古いバージョンで作った環境に新機能を入れたい」
- 「この .devcontainer に足りない機能ある？」（診断のみの依頼）

`.devcontainer/` が存在しない場合はこのスキルではなく `wp-docker-setup` を案内する。

## 前提

対象プロジェクトに **wp-docker-setup スキル 1.8.0 以降** が配置されていること。
このスキルは「今のテンプレでの理想形」を wp-docker-setup の `render_template_files()` を
呼んで得るため、テンプレ本体と展開ロジックを二重に持たない。

スクリプトは wp-docker-setup を次の順で探す。

1. 兄弟スキル `.claude/skills/wp-docker-setup/`
2. `<project-root>/.claude/skills/wp-docker-setup/`

見つからない・古い場合はエラー終了する。その場合は**最新のスキル一式を対象プロジェクトに
コピーしてから**再実行するようユーザーに案内する。

## 中核となる考え方（ここを外すと事故る）

生成された `.devcontainer/` は「テンプレ＋案件固有値」から作られた**派生物**だが、
利用者が後から手で直していることがある（httpd.conf のポート調整、compose のサービス追加など）。
そのため「テンプレが新しくなっただけのファイル」と「利用者が手で直したファイル」を
区別できないと、更新は手編集の破壊になる。

区別の基準が `.devcontainer/.wp-docker-setup.json`（マニフェスト）。生成時に
**ファイルごとの sha256** を記録してあるので、次の4分類ができる。

| 実物の状態                                     | 分類        | 動作                                       |
| ---------------------------------------------- | ----------- | ------------------------------------------ |
| ファイルが存在せず、マニフェストにも記録が無い | `added`     | 新規テンプレファイルとして追加する         |
| マニフェストに記録されたファイルが存在しない   | `conflict`  | **触らない**。意図的な削除か判断を仰ぐ     |
| 内容が最新テンプレと同一                       | `unchanged` | 何もしない                                 |
| マニフェスト記録と一致し、最新テンプレとは違う | `outdated`  | 更新する（利用者は触っていないと確定できる） |
| マニフェスト記録と一致しない                   | `conflict`  | **触らない**。差分を出してユーザーに判断を仰ぐ |

テンプレに無いファイルは `extra` として報告するだけで、**削除は一切しない**。

## 実行フロー

### Step 1. 診断（dry-run）

まず必ず dry-run で実行する。**この時点では1バイトも書き込まない。**

```bash
python .claude/skills/wp-docker-update/scripts/update_devcontainer.py \
  --project-root <プロジェクトルートの絶対パス> \
  --output .devcontainer
```

結果 JSON の `mode` を確認する。

- `"manifest"` … 新しいスキルで生成済み。そのまま Step 3 へ
- `"legacy"` … マニフェストが無い旧環境。Step 2 が必須

### Step 2. レガシー環境のパラメータ確認（`mode: "legacy"` のときのみ、必須）

マニフェストが無い場合、スクリプトは既存ファイルから生成パラメータを逆算する。

- `devcontainer.json` → プロジェクト名
- `docker-compose.yml` → WPルート名 / wp-content名 / テーブル接頭子 / MySQLバージョン
- `Dockerfile.php` → PHPバージョン / WordPressバージョン

**逆算値（`params`）と `inference_notes` を必ずユーザーに提示し、正しいか確認を取る。**
ここで誤った値のままマニフェストを作ると、次回以降の判定が丸ごと壊れる。

誤りがあれば CLI で上書きする（`--wp-root` / `--wp-content` / `--wp-table-prefix` /
`--php-version` / `--wp-version` / `--mysql-version` / `--name`）。

なお `version_notes` は「この案件の PHP/MySQL/WP バージョンがテンプレ既定と違う」ことを
知らせるだけの情報。**本番環境に合わせている可能性があるため自動では変更しない。**
上げたい場合は wp-docker-setup 側で明示的に指定する話になる、とユーザーに伝える。

`version_notes` に `[要確認]` が付いた項目があれば**必ずユーザーに確認を取る**。バージョンを
特定できていない状態で `--apply` すると、そのバージョンがテンプレ既定値に変わり得る
（特に MySQL のメジャー更新は既存データボリュームと非互換で環境が起動しなくなる）。

### Step 3. 結果の提示

ユーザーには JSON を貼らず、次の2つを人間が読める形で伝える。

**(a) 機能チェックリスト（`features`）** — 「何が足りないか」の答えそのもの。
`status` が `missing` のものを、`label` と `detail`（＝足りないと何が困るか）付きで挙げる。
`unknown` は「判定できなかった」であって「問題なし」ではない。そう伝える。

**(b) ファイルの変更計画（`files`）** — `added` / `outdated` は自動で入れられるもの。
`conflict` は**手編集または削除を検出したファイル**なので、`reason` と `diff` を見せて
1件ずつ判断を仰ぐ。
差分の意味（テンプレ側の改善なのか、この案件固有の調整なのか）を読んで説明する。

`mode: "legacy"` の場合、差分のあるファイルはすべて `conflict` になる。これは仕様であって
バグではない。基準が無い以上「手編集かどうか」を判別できないため、安全側に倒している。
そう説明したうえで、**新規ファイルの追加だけ先に適用する**のが現実的な落としどころ。

### Step 4. 適用

ユーザーの合意を得てから `--apply` を付けて実行する。レガシー環境では `--adopt` も必須
（＝ Step 2 の逆算値をユーザーが確認済み、という表明）。

```bash
python .claude/skills/wp-docker-update/scripts/update_devcontainer.py \
  --project-root <絶対パス> \
  --output .devcontainer \
  --apply --adopt
```

書き込み前に `.devcontainer/` を `<output>.bak-<日時>/` へ丸ごとコピーする（`apply_result.backup`）。
バックアップはリポジトリ内に残るので、**確認後に削除するようユーザーに案内する**。

`conflict` を上書きしてよいと**ユーザーが明示的に判断した場合のみ**、承認されたファイルごとに
`--force-conflict <相対パス>` を足す。複数承認された場合はオプションを繰り返す。

```bash
python .claude/skills/wp-docker-update/scripts/update_devcontainer.py \
  --project-root <絶対パス> --output .devcontainer --apply \
  --force-conflict scripts/pre-rebuild-cleanup.sh
```

Claude の判断で勝手に付けてはいけない。指定していない conflict は上書きされない。

### Step 5. 適用後の案内

- `.sh` を LF に直した場合や compose を更新した場合は **Dev Container のリビルドが必要**
- MySQL の認証情報が変わっても `docker compose down -v` は使わない。`sql_data` だけでなく
  `home_node` の Claude/Codex 認証情報や Mailpit データまで削除するため。既存DBでは
  `ALTER USER` / `GRANT` による更新を優先する。DBを初期化する必要がある場合は、先にDBを
  エクスポートし、対象がその案件の `sql_data` ボリュームだけであることを確認して、削除対象と
  失われるデータについてユーザーの明示的な同意を得る
- `wp-config.php` はこのスキルでは一切触らない。DB値・接頭子の同期が必要なら `/setup-wp-config`
- バックアップディレクトリの削除

## このスキルが絶対にしないこと

- `wp-config.php` の変更（`setup-wp-config` の責務）
- ファイル・ディレクトリの削除（`extra` は報告のみ）
- `certs/`（`init-certs.sh` の生成物）への書き込み
- テンプレ実体・wp-docker-setup スキルの書き換え
- `--apply` 無しでの書き込み

`.devcontainer/` の外に書き込むのは次の2つだけ。

- `<project-root>/.gitattributes` への `*.sh text eol=lf` 追記（既存行がある場合は追記もしない）
- `<project-root>/<output>.bak-<日時>/` へのバックアップ作成（既存のバックアップは上書きせず連番を振る）

## トラブルシューティング

| 症状                                              | 原因と対処                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `wp-docker-setup スキルが見つかりません`          | 対象プロジェクトに最新のスキル一式を配置する。`--setup-skill-dir` で明示指定も可               |
| `render_template_files() を持っていません`        | wp-docker-setup が 1.7.0 以前。1.8.0 以降へ更新する                                            |
| `最新テンプレの展開に失敗しました`                | テンプレと `install_devcontainer.py` の置換ルールが不一致。テンプレ側の変更を疑う              |
| 逆算した WP ルートに wp-config.php が無い         | `--wp-root` で正しい値を指定する                                                               |
| `conflict` だらけになる                           | `mode: "legacy"` なら仕様。`--adopt` 時点でテンプレと内容が一致していたファイルだけが基準を持つ。conflict だったファイルは基準を作れないため次回も conflict のまま（手編集を守るための意図的な挙動）|

## 参考

- Dev Container 仕様: https://containers.dev/implementors/spec/
- Docker Compose ファイルリファレンス: https://docs.docker.com/reference/compose-file/

---

## スキル更新ルール

1. frontmatter の `version` のマイナーバージョンを 1 つ上げる
2. `## 変更履歴` テーブルに日付と変更内容を追記する

wp-docker-setup 側でテンプレに機能を足したときは、**このスキルの `FEATURE_CHECKS` に
対応する判定を追加する**こと。ファイル差分だけでは「何の機能が足りないか」が人間に伝わらない。

---

## 変更履歴

| バージョン | 日付       | 変更内容                                                                                     |
| ---------- | ---------- | -------------------------------------------------------------------------------------------- |
| 1.1.0      | 2026-07-15 | 生成後に削除されたファイルを conflict 扱いに変更。上書きを `--force-conflict <path>` によるファイル単位の選択へ限定。適用後に機能チェックを再実行。全 Compose ボリュームを消す `down -v` の案内を廃止 |
| 1.0.0      | 2026-07-15 | 初回リリース。マニフェスト（sha256）による4分類判定、レガシー環境のパラメータ逆算、機能チェックリスト、dry-run 既定 + バックアップ付き適用 |
