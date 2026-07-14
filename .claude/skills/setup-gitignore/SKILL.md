---
name: setup-gitignore
description: "Use when: /setup-gitignore を実行してプロジェクトの .gitignore を生成・最適化したいとき。WP インストールを自動検出し、wp-content ディレクトリ名・テーマ名を正しいパスで埋め込んだ .gitignore を生成する。WP + レンタルサーバー構成に特化したベストプラクティスを適用済み。"
version: "1.3.0"
---

# setup-gitignore

`/setup-gitignore` で実行する `.gitignore` 生成スキル。

## 役割

プロジェクト構造を自動解析し、以下を実現する：

1. WP インストール（複数可）を自動検出 → wp-content ディレクトリ名・テーマ名を特定
2. ベーステンプレートに正しいパスを埋め込んで `.gitignore` を生成 / 更新
3. WP + レンタルサーバー構成のベストプラクティスを適用済み

---

## 実行フロー概要

```
Step 1: 自動解析（並列）
  ├─ 1-a: AGENTS.md が存在すれば Read（WP 情報の先取り）
  ├─ 1-b: .gitignore が存在すれば Read
  ├─ 1-c: Glob "**/themes/*/functions.php" で WP インストール検出（主）
  │        Glob "**/wp-load.php" で補助検出（WP コアが存在する場合）
  └─ 1-d: Glob "**/gulpfile.js", "**/package.json" でビルドツール把握

Step 2: テーマ名の特定
  └─ AGENTS.md の記載と Glob 結果を照合 → 一致すれば確定

Step 3: ヒアリング（必要な場合のみ）
  ├─ テーマが複数 or 判別不能 → どれをトラッキングするか確認
  └─ .gitignore が既存 → 上書きか差分か確認

Step 4: .gitignore 生成
  └─ 既存あり → Read してから Write / 既存なし → Write で新規作成

Step 5: 完了報告
```

---

## 実行フロー

### Step 1. 自動解析

以下をすべて **並列** で実行する。

#### 1-a. AGENTS.md の先読み

```
Glob: AGENTS.md
```

存在すれば Read する。**WP インストールパス・wp-content ディレクトリ名・テーマ名** が記載されていれば抽出して Step 1-c の Glob を省略できる。

> AGENTS.md に WP 情報が揃っていても、Glob による実態確認は Step 2 で行う。

#### 1-b. 既存 .gitignore の確認

```
Glob: .gitignore
```

存在すれば Read して内容を把握する（上書き時の差分検討に使う）。

#### 1-c. WP インストールの検出

**主検出（WP コアが gitignore 除外されていても動く）:**

```
Glob: **/themes/*/functions.php
```

ヒットしたパス `[A]/[B]/themes/[C]/functions.php` からそれぞれ抽出する：

- `[WP_CONTENT]` = `[B]`（themes の親ディレクトリ = wp-content 系）
- `[WP_ROOT]` = `[A]`（wp-content の親ディレクトリ）
- `[THEME_NAME]` = `[C]`（functions.php の親ディレクトリ）

> **なぜ functions.php か**: このスキルを使うプロジェクトは WP コアを gitignore で除外しているため `wp-load.php` がほぼ存在しない。テーマファイル（`functions.php`）はトラッキング対象なので確実に存在する。

**補助検出（WP コアが存在する場合）:**

```
Glob: **/wp-load.php
```

ヒットした場合は wp-content ディレクトリを確認する補助として使う。

#### 1-d. ビルドツールの確認

```
Glob: **/gulpfile.js
Glob: **/package.json  （node_modules 除外）
```

node_modules が複数箇所にある場合（ツール用サブディレクトリ配下など）を把握する。

---

### Step 2. テーマ名の特定

各 WP インストールについて、テーマ候補を評価する：

| 状況                                   | 対応                                                |
| -------------------------------------- | --------------------------------------------------- |
| AGENTS.md の記載と Glob 結果が一致     | そのまま確定                                        |
| Glob 結果のみ（カスタムテーマが 1 つ） | `twenty*` / `index.php` 除外後の 1 つを採用         |
| カスタムテーマが複数                   | Step 3 でユーザーに確認                             |
| テーマが見つからない                   | `xxx_THEME_NAME_xxx` マーカーを入れて完了報告に記載 |

---

### Step 3. ヒアリング（必要な場合のみ）

自動解析で解決できた場合はスキップ。以下が残る場合のみ `AskUserQuestion` を使う：

- **テーマが複数**（どれをトラッキングするか選択）
- **既存 .gitignore がある**（上書き or 差分マージ）

> ヒアリングは **1 回・3 問まで** にまとめる。

---

### Step 4. .gitignore 生成

> **⚠️ Claude Code の制約 — Write 前に Read 必須**: 既存 `.gitignore` を上書きする場合は
> Write の前に必ず Read すること。Read なしで Write するとエラーになる。

**生成ルール**:

1. 下記「ベーステンプレート」を起点にする
2. WP インストールごとに「WP テーマ管理ブロック」を展開して追記する
3. 検出した WP インストールが複数あれば、ブロックを繰り返す

**WP テーマ管理ブロックのパターン**（1 インストール分）：

```
# ----------------------------------------
# [WP_ROOT]/ — WP コア除外、テーマのみ管理
# ----------------------------------------
[WP_ROOT]/*
![WP_ROOT]/[WP_CONTENT]
[WP_ROOT]/[WP_CONTENT]/*
![WP_ROOT]/[WP_CONTENT]/themes
[WP_ROOT]/[WP_CONTENT]/themes/*
![WP_ROOT]/[WP_CONTENT]/themes/[THEME_NAME]
```

- `[WP_ROOT]` = `**/themes/*/functions.php` のパスから2階層上（例: `wordpress`、`shop/wordpress`）
- `[WP_CONTENT]` = themes の親ディレクトリ名（例: `wp-content`、`wp-content-custom`）
- `[THEME_NAME]` = カスタムテーマ名（例: `my-site-theme`）

---

### Step 5. 完了報告

生成結果と手動確認が必要な箇所を報告する。

```
✅ 生成 / 更新:
  - .gitignore

📝 手動確認が必要な箇所:
  [ ] テーマ名が自動検出できなかった WP インストールがあれば、
      xxx_THEME_NAME_xxx をそのテーマ名に置き換えること
  [ ] .htaccess を管理したい場合は該当行をコメントアウトすること
  [ ] *.sql を意図的にコミットするユースケースがあれば除外ルール調整
```

---

## ベーステンプレート

このスキルが生成する `.gitignore` のベース。WP テーマ管理ブロックは Step 4 で動的に展開して追記する。

```gitignore
# ========================================
# WordPress コアファイル
# ========================================
wp-*.php
wp-admin/
wp-includes/
xmlrpc.php
readme.html
license.txt

# ========================================
# wp-content デフォルト除外（WP がルートに直接ある場合）
# ========================================
wp-content/*/
wp-content/index.php

# テーマ関連
!wp-content/themes/
# デフォルトテーマ（Twenty 系は全部無視）
/wp-content/themes/twenty*/
wp-content/themes/index.php

# ルート直下に置かれたアップロードディレクトリ
upload/
uploads/

# ========================================
# WP インストール別テーマ管理
# （**/themes/*/functions.php の検出結果をここに展開する）
# ========================================


# ========================================
# 開発用パッケージ
# ========================================
node_modules/
package-lock.json
prepros.config

# ========================================
# データベースダンプ・アーカイブ
# ※ レンタルサーバー移行時にルートに置きがちなので除外
# ========================================
*.sql
*.sql.gz
*.zip
*.tar.gz
*.tar

# ========================================
# ログファイル
# ========================================
error_log
*.log
npm-debug.log*
yarn-error.log*

# ========================================
# 環境依存・一時ファイル
# ========================================
.htaccess
.DS_Store
Thumbs.db
*.bak
*.bk
*_bk
*.tmp
*.orig
.env
.env.*
!.env.example
```

---

## 判断基準：.htaccess を除外するか否か

| 状況                                                                    | 推奨                       |
| ----------------------------------------------------------------------- | -------------------------- |
| レンタルサーバーで環境ごとに .htaccess が異なる（Basic 認証の有無など） | 除外する（デフォルト）     |
| .htaccess の設定をチームで共有・管理したい                              | コメントアウトして追跡する |

デフォルトでは除外。追跡したい場合は完了報告でユーザーに選択肢を提示する。

---

## 参考：生成される .gitignore 例（複数 WP インストール）

ルートに本体サイトの WP、サブディレクトリに別サイトの WP がある 2 インストール構成の場合：

```gitignore
# WP インストール別テーマ管理ブロック（2 インストール分展開）

# ----------------------------------------
# wordpress/ — WP コア除外、テーマのみ管理
# ----------------------------------------
wordpress/*
!wordpress/wp-content
wordpress/wp-content/*
!wordpress/wp-content/themes
wordpress/wp-content/themes/*
!wordpress/wp-content/themes/my-site-theme

# ----------------------------------------
# shop/wordpress/ — WP コア除外、テーマのみ管理
# ----------------------------------------
shop/wordpress/*
!shop/wordpress/wp-content
shop/wordpress/wp-content/*
!shop/wordpress/wp-content/themes
shop/wordpress/wp-content/themes/*
!shop/wordpress/wp-content/themes/shop-theme
```

wp-content 名・テーマ名・サブディレクトリ名は Step 1-c の検出結果で置き換わる。

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
| **メジャー** (**X**.y.z) | 破壊的変更                               | テンプレート構造の大幅刷新、フロー全面見直し |

---

## 変更履歴

| バージョン | 日付       | 変更内容                                                                                                               |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1.3.0      | 2026-07-14 | 非標準で説明のないディレクトリ名を除去し、複数 WP の例を WordPress 標準ディレクトリと明示的な汎用テーマ名に統一       |
| 1.2.0      | 2026-07-14 | 公開リポジトリ向けに例示を汎用化（wp-content 名・テーマ名・プロジェクト名をプレースホルダ相当に置換）                  |
| 1.1.0      | 2026-05-08 | WP 検出を `functions.php` ベースに変更 / AGENTS.md 先読みを Step 1-a に追加 / ディレクトリ Glob をファイルベースに修正 |
| 1.0.0      | 2026-05-08 | 初回リリース                                                                                                           |
