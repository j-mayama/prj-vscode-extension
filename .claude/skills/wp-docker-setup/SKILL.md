---
name: wp-docker-setup
description: WordPress のローカル開発環境（.devcontainer）を半自動でセットアップするスキル。発動キーワード「Dockerセットアップ」。phpinfo()のコピペ、WPルートのパス、プロジェクト名等を対話で確定し、`.claude/skills/wp-docker-setup/templates/.devcontainer-wp/`または`.devcontainer-wp/`（Nodeも同様）をベースに変数置換した`.devcontainer/`を生成する。最後に、自動化できない手動ステップのチェックリストを出す。
version: "1.7.0"
---

# wp-docker-setup

## 役割

このスキルは、WordPress のローカル環境構築を**対話 + 決定論的スクリプト**で半自動化する。

- **対話・判断**: Claudeが担当（プロジェクト設定の聞き取り、phpinfo解析結果の妥当性確認、差分提示）
- **ファイル生成**: 同梱スクリプト `scripts/install_devcontainer.py` が決定論的にテンプレ展開（毎回同一フォーマット）

テンプレ展開と設定値の反映までを自動化する。Docker の起動・DBインポートなど、コンテナ外の操作が必要なステップは自動化せず、最後にチェックリストとして出力する。

## 発動キーワード

ユーザーのメッセージに以下のいずれかが含まれたら必ず発動：

- 「Dockerセットアップ」
- 「ローカル環境を構築」「ローカル環境構築」（明確に Docker / devcontainer 文脈の場合）
- 「.devcontainer を作成」「devcontainer 設定」

## 前提

このスキルは以下の順序でテンプレを探索する。

1. `.claude/skills/wp-docker-setup/templates/.devcontainer-wp/` または `.devcontainer-node/`
2. 案件リポジトリ直下の `.devcontainer-wp/` または `.devcontainer-node/`（後方互換）

テンプレ実体はスキルから直接書き換えない。テンプレ更新はリポジトリ管理者の責務。

## 実行フロー

### Step 1. 構築タイプの確認（AskUserQuestion）

最初に1つだけ質問する：

- **WP一式（PHP+MySQL+httpd+nginx+Mailpit+node）** — `templates/.devcontainer-wp/`（なければリポジトリ直下 `.devcontainer-wp/`）をベース
- **Node単独（フロントエンドのみ）** — `templates/.devcontainer-node/`（なければリポジトリ直下 `.devcontainer-node/`）をベース
- **両方（WPプロジェクト＋Storybook等）** — まずWP、続けてNodeの順で対話する

### Step 1.5. フロントビルド方針の確認（AskUserQuestion, 必須）

Docker構築の前に、フロント側のコンパイル運用を必ず確定する。対象プロジェクトで以下を確認する：

- SCSS/Sassファイルの有無（例: `css/sass/*.scss`, `common/css/*.scss`）
- Gulp設定の有無（`**/gulpfile.js` で配置場所を検出）
- Prepros設定の有無（例: `prepros.config`）

質問は次の3択で行う：

1. **Gulp運用**（推奨: SCSSがあり、Prepros非運用の案件）
2. **Prepros運用**（既存案件で明示運用されている場合のみ）
3. **コンパイル不要（CSS直編集）**

判定ルール：

- SCSSがあるのに運用が未確定のまま進めない
- ユーザーが「Preprosは使わない」と明示した場合は、必ずGulp運用を提案する
- Dockerを起動しない構築でも、このStepは同じく実施する（コンパイル運用はDocker依存ではないため）

### Step 2. 共通入力の収集（AskUserQuestion または通常の質問）

以下を順番に確定する。1つの質問で複数項目を聞かない（ユーザーが選択肢で答えづらくなる）。

1. **案件名（プロジェクト名）**: `devcontainer.json` の `"name"` に入る値。半角英小文字＋ハイフン推奨（例: `my-project`）
2. **出力先**: `.devcontainer/`（標準）/ `.devcontainer-{案件名}/`（共存する場合）
3. **既存`.devcontainer/`の上書き許可**: もし既にあれば、上書きするか確認

### Step 3-WP. WP固有の入力収集

WPの場合のみ以下を収集する：

4. **WPルートディレクトリ名**: 既定 `wordpress`。プロジェクトによって `wp` / `cms` 等に変わる。`<project-root>/<wp_root>/wp-config.php` が存在することが期待される
5. **wp-contentフォルダ名**: 既定 `wp-content`。一部案件で別名（例: `wp-content_custom`）になっている
6. **テーブル接頭子（`$table_prefix`）**: 既定 `wp_`。本番が `wp_example_` などの独自接頭子の場合は必ずそれを指定

- ヒアリング時に既存の `<project-root>/<wp_root>/wp-config.php` がある場合は現在値を確認する
- 既存接頭子とヒアリング値が異なる場合は、適用前に必ず警告して確認を取る

7. **phpinfo()のコピペ**: 「本番のphpinfo()ページを全選択コピーしてここに貼って」と案内。**HTMLテキスト・プレーンテキスト両対応**（`scripts/parse_phpinfo.py`に渡す）
8. **WordPressバージョン**: 既定はテンプレの `WORDPRESS_VERSION=6.9.1`。本番に合わせる場合は `wp-includes/version.php` の値、または手動指定
9. **言語（ロケール）**: 既定は日本語（`ja`）。特に要望がなければ日本語版WordPressを使う

### Step 4-WP. phpinfo解析と差分提示

ユーザーから貼り付けられたphpinfoテキストは、リポジトリ配下に保存せず一時ファイルで処理する。例:

```bash
tmp_phpinfo="$(mktemp /tmp/phpinfo.XXXXXX.txt)"
cat > "$tmp_phpinfo" <<'EOF'
...phpinfo text...
EOF
python .claude/skills/wp-docker-setup/scripts/parse_phpinfo.py "$tmp_phpinfo"
rm -f "$tmp_phpinfo"
```

出力JSONから以下を抽出：

- PHPバージョン（メジャー.マイナー.パッチ）
- MySQLクライアント / サーバーバージョン（取得できれば）
- 主要拡張モジュール一覧
- DOCUMENT_ROOT / SERVER_SOFTWARE

**ユーザーに環境サマリを提示**し、これでテンプレ展開してよいか確認。差分（PHP上げたい、MySQL揃えたい等）があれば反映する。

### Step 3-Node. Node固有の入力収集（Nodeを選んだ場合）

4n. **Node.jsバージョン**: 既定 `24.11.0`（テンプレ通り）。プロジェクトの `.nvmrc` / `package.json#engines.node` があればそれを優先

### Step 5. テンプレ展開実行

確定した値を引数にして `scripts/install_devcontainer.py` を実行：

```bash
python .claude/skills/wp-docker-setup/scripts/install_devcontainer.py \
  --type wp \
  --project-root <プロジェクトルートの絶対パス> \
  --name <案件名> \
  --wp-root <wp-root-dir> \
  --wp-content <wp-content-dir> \
  --wp-table-prefix <table-prefix> \
  --php-version <x.y.z> \
  --wp-version <x.y.z> \
  --mysql-version <x.y.z> \
  --output .devcontainer
```

スクリプトは：

1. `<project-root>/.claude/skills/wp-docker-setup/templates/.devcontainer-wp/` または `.devcontainer-node/` を優先して読み込み（なければ `<project-root>/.devcontainer-wp/` または `.devcontainer-node/`）
2. 変数置換を適用（`name`、`wp-root`パス、PHPバージョン、WPバージョン、MySQLバージョン等）
3. `<project-root>/<output>/` に書き出し
4. `<project-root>/<wp_root>/wp-config.php` が無ければ仮想環境のDB情報と接頭子を記述して生成する。既存なら内容を保持して警告だけ返す
5. 生成時に `.sh` ファイルを LF 改行で保存し、`<project-root>/.gitattributes` に `*.sh text eol=lf` を自動追加（既存なら追記のみ）

生成される `devcontainer.json` には `initializeCommand` を含め、リビルド前に host 側で現在のワークスペースに属する古い Compose コンテナとネットワークを自動削除する。
`devcontainer` と `<workspace-folder>_devcontainer` の2系統を候補にするが、`com.docker.compose.project.working_dir` が現在の `<workspace>/.devcontainer` と一致するリソースだけを削除する。

`wp-config.php` の扱い：

- ファイルが無ければ生成する（DB情報・接頭子含む全値を書き込む）
- **既存ファイルがある場合は一切書き換えない**（下記「アーキテクチャ」参照）
- 接頭子の更新・DB情報の再同期は `setup-wp-config` スキル（`/setup-wp-config`）が担当する
- 既存接頭子とヒアリング値が異なる場合は `warnings` として結果JSONに含める

### Step 5.5. フロントビルド初期化（Docker非依存）

Step 1.5で **Gulp運用** を選んだ場合は、Docker起動の有無に関係なく次を案内・実行する：

```bash
cd <project-root>/<gulpfile.jsがあるディレクトリ>
npm install
npx gulp --tasks-simple
```

確認ポイント：

- SCSS のビルド・監視に必要なタスクが存在すること
- `default` が意図した監視タスクを指していること

その後、ユーザーに監視起動コマンドを渡す：

```bash
cd <project-root>/<gulpfile.jsがあるディレクトリ>
npx gulp
```

補足：

- Prepros運用を選んだ場合はGulp初期化を強制しない
- CSS直編集運用を選んだ場合は監視プロセスの案内を省略する

### Step 6. ポストセットアップ案内

最後に、コンテナ外の操作が必要な手動ステップを**チェックリストとして出力**：

```
✅ 自動完了: テンプレ展開 / プロジェクト名の反映 / PHP・MySQL・WPバージョンの設定 / wp-config.php の新規生成（未作成時のみ）
👤 手動: 既存 wp-config.php のDB情報をローカル値へ同期する必要がある場合だけ、確認後に /setup-wp-config を実行
👤 手動: 表示確認後、必要なら httpd.conf を調整
👤 手動: VSCodeで「コンテナーで再度開く」
👤 手動: http://localhost:8083 (Adminer) / 8084 (phpMyAdmin) にログイン
👤 手動: 本番SQLダンプをインポート
👤 手動: wp_options の siteurl / home を書換（下記SQLをコピペ）
👤 手動: メール送信テスト・アクセスURLの確認
```

加えて、**Docker起動後のアクセス先URLをREADME.mdで必ず案内する**。

- `<project-root>/.devcontainer/README.md` が無ければ作成する
- 既に存在する場合はURL案内セクションを追記または更新する
- 最低限、以下を記載する
  - サイト本体: `https://localhost:8080`
  - WordPress管理画面: `https://localhost:8080/<wp-root>/wp-admin/`
  - phpMyAdmin: `http://localhost:8084`
  - Adminer: `http://localhost:8083`
  - Mailpit: `http://localhost:8081`

テンプレ `templates/.devcontainer-wp/README.md` を同梱し、展開後にURL案内が残る状態を既定とする。

フロントビルド方針ごとの案内も同時に出す：

- Gulp運用: `gulpfile.js` があるディレクトリで `npx gulp` を常駐実行してからSCSS編集
- Prepros運用: Prepros監視を開始してからSCSS編集
- CSS直編集: 監視不要（保存のみ）

### Step 6.5 よくあるハマりどころ（必ず案内）

- **Windowsパス誤記**: `<project-root>.devcontainer` ではなく `<project-root>\\.devcontainer`
- **composeファイル未指定**: プロジェクト直下で `docker compose` すると `no configuration file provided` になるので、必ず `-f .devcontainer/docker-compose.yml` を付ける
- **MySQL初期化値の残存**: 認証情報を変更した後は `docker compose down -v` でボリュームを消して再作成する
- **リビルド時の3306競合**: 旧 Dev Container が残っていると `127.0.0.1:3306` のポート競合で落ちる。生成済みテンプレートは `initializeCommand` で、Compose の作業ディレクトリが現在のワークスペースと一致するリソースだけを掃除する。手動削除でも同じラベル確認を行い、別プロジェクトのコンテナを削除しない
- **phpMyAdmin接続先エラー（getaddrinfo for sql）**: `sql` サービスが落ちている。`docker compose ps` と `docker compose logs sql --tail=80` で確認する
- **phpMyAdminポート競合**: 8084を既定にし、競合時は他の空きポートへ変更する
- **nodeコンテナが exited (2) で落ちる（set: Illegal option）**: `.devcontainer/scripts/init-certs.sh` や `pre-rebuild-cleanup.sh` など `.sh` が CRLF になっている可能性が高い。現行スキルは生成時に LF 固定 + `.gitattributes` 自動追記で予防する

### 日本語版WordPressの扱い

- テンプレ `Dockerfile.php` は `ja.wordpress.org` から日本語版アーカイブを優先取得する
- バージョン指定アーカイブが無い場合は `latest-ja.tar.gz` にフォールバックする
- 既に英語コアが展開済みの場合は `docker compose down -v` 後に再ビルドする

ユーザーが手動ステップをすぐ実行できるよう、以下のスニペットを必ず合わせて出力する：

**wp-config.php 確認用スニペット**（通常は直接編集せず `/setup-wp-config` を使う。値の対応確認が必要な場合のみ参照）:

```php
define('DB_NAME', '<MYSQL_DATABASE>');
define('DB_USER', '<MYSQL_USER>');
define('DB_PASSWORD', '<MYSQL_PASSWORD>');
define('DB_HOST', '<MYSQL_HOST>');
$table_prefix = '<WP_TABLE_PREFIX>';
```

**wp_options URL書換SQL**:

```sql
UPDATE wp_options SET option_value='https://localhost:8080' WHERE option_name IN ('siteurl','home');
```

### Step 7. 後始末（任意）

ユーザーから明示要望があれば、テンプレ元の `.devcontainer-wp/` `.devcontainer-node/` を削除する提案を出す。**デフォルトでは削除しない**（次回別環境を作る時に必要なため）。

### Step 8. 失敗時の復旧コマンド

`wp-config.php` のDB情報や接頭子だけを後から修正したい場合は、以下を実行する。

```bash
python .claude/skills/wp-docker-setup/scripts/install_devcontainer.py \
  --type wp \
  --project-root <絶対パス> \
  --name <案件名> \
  --output .devcontainer \
  --wp-root <wp-root-dir> \
  --repair-wp-config-only
```

ヒアリングした接頭子で強制上書きしたい場合は `--wp-table-prefix` を付与する。

```bash
python .claude/skills/wp-docker-setup/scripts/install_devcontainer.py \
  --type wp \
  --project-root <絶対パス> \
  --name <案件名> \
  --output .devcontainer \
  --wp-root <wp-root-dir> \
  --wp-table-prefix <table-prefix> \
  --repair-wp-config-only
```

---

## アーキテクチャ（設計判断の記録）

### wp-config.php の責務分担

wp-config.php の値管理は**2層**に分かれている。混同するとDB値が消えたり上書きされたりするので必ず守ること。

| 層                                              | 担当                                                        | 書き込む値                                                |
| ----------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| **Docker起動** (`init-wp-config.sh`)            | `cp -a -n` でWPコアを展開 + wp-config.phpが無いときだけ作成 | DB値・接頭子・WPLANG（新規作成時のみ）                    |
| **setup-wp-config スキル** (`/setup-wp-config`) | DB値と接頭子を docker-compose.yml の値に同期する            | DB_NAME / DB_USER / DB_PASSWORD / DB_HOST / $table_prefix |

**`init-wp-config.sh` は `wp-config.php` が既に存在する場合は一切変更しない。** DB値・`$table_prefix`・`WPLANG` の同期が必要な場合だけ、ユーザーの明示操作で `/setup-wp-config` を実行する。

### init-wp-config.sh

`scripts/init-wp-config.sh`（テンプレ: `templates/.devcontainer-wp/scripts/init-wp-config.sh`）は Docker の php サービス起動コマンドとして動く。

```
docker-compose.yml の php.command:
  sh /var/www/html/.devcontainer/scripts/init-wp-config.sh && exec php-fpm
```

**なぜ YAML インラインの sed をやめたか：**

当初 `x-copy-wp` に sed コマンドをインラインで書いていたが、以下の2つの問題があった：

1. **Docker Compose の変数展開問題**: YAML 内の `${WORDPRESS_DB_NAME}` はコンテナの環境変数ではなく**ホスト側の環境変数**で展開される。ホストに `WORDPRESS_DB_NAME` が未設定だと空文字に展開され、sed が「DB値を空にしろ」という命令として動いてしまう
2. **YAML エスケープ地獄**: `\\(`, `\\)` など二重エスケープが sh 実行時に正しく解釈されない場合がある

シェルスクリプトに切り出すことで、通常の変数参照（`${WORDPRESS_DB_NAME}`）がコンテナ内環境変数として正しく展開される。

### テンプレートの `{{WP_ROOT}}` プレースホルダ

テンプレート版の `init-wp-config.sh` は `WP_ROOT="/var/www/html/{{WP_ROOT}}"` というプレースホルダを含む。`install_devcontainer.py` がテンプレ展開時に実際のWPルート名（例: `wordpress`）に置換する。展開後のファイルにプレースホルダが残っていたらバグ。

### wp-config.php に DB値が空のまま残るときの対処

1. `/setup-wp-config` を実行（`setup-wp-config` スキル）
2. Docker を再起動しても DB値が消えないことを確認
3. もし消える場合は `init-wp-config.sh` の `WP_ROOT` パスが `wp-config.php` の実際のパスと一致しているか確認する

このとき、compose 内の `WORDPRESS_TABLE_PREFIX` と `--wp-table-prefix` が異なる場合は `warnings` で警告を返す。

## 重要な制約

- **ファイル生成はLLMに直接書かせず、必ず `install_devcontainer.py` を経由する**。「テンプレの特定行を書き換える」種の編集はLLMに任せると静かに崩れるため（スクリプトはマーカーベース置換で決定論的に行う）
- **テンプレ実体（`templates/.devcontainer-wp/` `templates/.devcontainer-node/` および後方互換の直下テンプレ）はこのスキルから書き換えない**。テンプレ更新はリポジトリ管理者の責務
- **phpinfoのコピペにパスワード等が混じった場合は警告**してから処理する（Apache環境変数や `$_SERVER` 表示にトークンが入っていることがある）

## 参考

- Dev Container 仕様: https://containers.dev/implementors/spec/
- Docker Compose ファイルリファレンス: https://docs.docker.com/reference/compose-file/
- 日本語版 WordPress アーカイブ: https://ja.wordpress.org/download/releases/

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

| バージョン | 日付       | 変更内容                                                                                                                         |
| ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1.7.0      | 2026-07-14 | 既存 wp-config.php の無断上書き、既存テーマの自動削除、他ワークスペースの Compose リソース削除を防止。公開ポートを localhost に限定し、非標準の既定パス・Gulp 固有例を一般化。カスタム wp-content のマウント、BrowserSync の URL 案内、テンプレート整合性を修正 |
| 1.6.0      | 2026-07-14 | 公開リポジトリ向けに汎用化。外部の手順書に依存した記述（丸数字のステップ参照・行番号指定）を、内容ベースの記述に書き直し。例示のプロジェクト名・テーブル接頭子をプレースホルダに置換。参考リンクを公式ドキュメントに差し替え |
| 1.3.0      | 2026-05-25 | CRLF 起因クラッシュ事例として `pre-rebuild-cleanup.sh` を明示し、DevContainer 起動失敗の診断導線を強化                           |
| 1.1.0      | 2026-05-21 | 生成時に `.sh` を LF 固定、`.gitattributes` へ `*.sh text eol=lf` を自動付与。`init-certs.sh` の CRLF 起因クラッシュ予防を明文化 |
| 1.0.0      | 2026-05-08 | 初回リリース                                                                                                                     |

> バージョン番号は連番を保証しない。履歴にない番号はリリースされていない。
