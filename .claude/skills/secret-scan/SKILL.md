---
name: secret-scan
description: 公開リポジトリ／VS Code 拡張(.vsix)の公開・コミット前に、機密情報や個人情報の混入を検査して修正するための手順。API キー・トークン・パスワードなどのシークレット、氏名・ユーザー名・メール等の PII、ローカル絶対パス、内部固有名詞（社内ドメイン・別プロジェクト名）を、汎用スキャナ＋プロジェクト固有パターン＋git 履歴＋.vsix 梱包物の4層で検出する。「公開前チェック」「機密チェック」「secret scan」「コミット前確認」「vsce publish 前」などで使う。
---

# 公開前 機密情報スキャン

このリポジトリは **public**。コミット・`.vsix` 公開の前に、機密情報／個人情報が混入していないかを検査し、見つけたら修正する。

## 大原則（このスキル自体にも適用）

- **個人識別子をハードコードしない。** ユーザー名・氏名・メールは、この SKILL.md にも検出スクリプトにも直接書かない。
  実行時に `whoami` / `git config` / ホームディレクトリ名から**動的に取得**して検索語にする。
  （そうしないと「機密チェック用のスキル」が公開リポジトリで個人情報を漏らす本末転倒になる）
- **検査対象は「実際に公開されるもの」だけに絞る。** 作業ツリー全体ではなく、
  ①git で追跡される/されうるファイル（`.gitignore` 適用後）と ②`.vsix` に梱包されるファイル（`.vscodeignore` 適用後）。
- **シークレットを1つでも見つけたら、まず値を無効化（ローテート）する。** ファイルから消すだけでは、
  過去にプッシュ済みなら流出は取り消せない。「消す」より先に「revoke／再発行」。

## ツール選定（2026年時点のベストプラクティス調査より）

多層防御が業界標準：ローカル pre-commit（高速・オフライン）＋ CI 検証スキャン ＋ サーバー側 push protection。

| ツール | 役割 | 備考 |
|---|---|---|
| **secretlint**（採用・主軸） | 作業ツリーの汎用シークレット検出 | Node 製・`npx` でゼロインストール・`.gitignore` 準拠・MIT。**git 履歴は見ない** |
| **gitleaks**（採用・履歴担当） | **git 履歴**＋作業ツリー | 単一 Go バイナリで高速・完全オフライン・MIT。secretlint が見られない履歴を補完 |
| TruffleHog（任意・CI 向け） | 実在資格情報の**検証**（今も有効か API で確認） | 重い・ネットワーク必要。日常のコミット時には過剰。CI の定期スイープ用 |
| detect-secrets（不採用） | baseline でアラート洪水抑制 | 大規模レガシー向け。小規模repoには運用コスト過剰 |
| git-secrets（不採用） | AWS パターン中心 | 範囲が狭く gitleaks が上位互換 |

---

## 手順

### フェーズ0 — スキャン範囲と自分の識別子を確定する

```bash
# 実際にコミット対象になるテキストファイル（バイナリ・依存物は除外）
FILES=$(git ls-files -co --exclude-standard \
  | grep -vE '/(node_modules|out|dist)/' \
  | grep -vE '\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|vsix|wav|mp3)$')

# 自分の識別子を動的に取得（ハードコード禁止）
ME_USER=$(whoami 2>/dev/null | sed 's#.*[\\/]##')   # Windows の DOMAIN\user にも対応
ME_HOME=$(basename "${HOME:-$USERPROFILE}")
ME_GNAME=$(git config user.name 2>/dev/null)
ME_GMAIL=$(git config user.email 2>/dev/null)
echo "検索する個人識別子: user=$ME_USER home=$ME_HOME gitname=$ME_GNAME gitmail=$ME_GMAIL"
```

`.gitignore` が機密ファイル型（`.env*` / `*.pem` / `*.key` / `.vscode/settings.json`）を除外しているかも確認する。
除外されていなければ、それがまず最初の欠陥。

### フェーズ1 — 汎用シークレット検出（自動ツール）

インストール不要で即実行できる **secretlint** を主軸にする（Node プロジェクトと相性が良い）。

```bash
# 設定ファイルを用意（pre-commit でもそのまま使えるので作業ツリーに置いてよい）
cat > .secretlintrc.json <<'JSON'
{ "rules": [ { "id": "@secretlint/secretlint-rule-preset-recommend" } ] }
JSON

# 作業ツリーをスキャン（.git / node_modules / .gitignore 対象は自動除外。Node 22+ なら @scope 省略可）
npx --yes secretlint "**/*"        # 秘密なし=exit 0 / 検出=exit 1
```

`recommend` プリセットは AWS/GCP/Slack/GitHub/npm トークン・秘密鍵・高エントロピー文字列を検出する。
**secretlint は現在のファイルだけ**を見る（履歴は見ない）ので、履歴はフェーズ3の gitleaks で必ず補完する。

### フェーズ2 — プロジェクト固有パターン（汎用ツールが見逃す領域）

汎用スキャナは「氏名・社内固有名詞・ローカル絶対パス」を知らない。ここは自前で見る。

```bash
# 1) 個人識別子（フェーズ0で動的取得したもの）
PII=$(printf '%s\n' "$ME_USER" "$ME_HOME" "$ME_GNAME" "$ME_GMAIL" | grep -vE '^$' | paste -sd'|' -)
[ -n "$PII" ] && echo "$FILES" | xargs grep -niE "$PII" 2>/dev/null

# 2) ローカル絶対パス（他人の環境が透ける）
echo "$FILES" | xargs grep -niE 'C:\\\\Users\\\\[^\\\\]+|/home/[^/USER]+|/Users/[^/]+' 2>/dev/null

# 3) メールアドレス全般
echo "$FILES" | xargs grep -niE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' 2>/dev/null

# 4) 内部固有名詞（★社内ドメイン・別プロジェクト名を、コミットせず環境変数で渡して検索する。
#    SKILL.md には列挙しない ── 列挙した瞬間それ自体が公開リポジトリでの漏洩になる）
[ -n "$INTERNAL_TERMS" ] && echo "$FILES" | xargs grep -niE "$INTERNAL_TERMS" 2>/dev/null
```

ヒットしても即アウトではない。**「文脈を知らない初見の OSS 利用者が読んで、晒すべきでない情報か？」**で判断する。
例：公開 publisher 名・OSS の作者名・`127.0.0.1`・`/home/USER`（プレースホルダ）は問題なし。

### フェーズ3 — VS Code 拡張 固有チェック（★最重要の落とし穴）

**`vsce package` は `.gitignore` を見ない。** 梱包から外れるのは `.vscodeignore` に書いたものだけ。
つまり「`.gitignore` に入れたから安全」は誤りで、`.vscodeignore` に書き忘れた秘密は `.vsix` に入って公開される。
（実調査: 20,606 拡張中 99 個が Azure PAT を、80 個超が token/secret を含むファイルを梱包していた）

```bash
# 各拡張ディレクトリで、実際に .vsix へ入るファイル一覧を確認
( cd extensions/<name> && npx --yes @vscode/vsce ls )
```

- 生ソース（`src/`）・`.env`・テスト・`node_modules`・ログ（`*-error.log`）・`.git` が一覧に出たら `.vscodeignore` の不備。
- より安全側に倒すなら `package.json` の `files`（ホワイトリスト）で「入れるものだけ」を明示する。
- `@vscode/vsce` は publish 時に secretlint による検査・`.env` 混入防止も走らせる（それでも自前確認を省かない）。
- 秘密が **git 履歴** に一度でも入ったら作業ツリーを直すだけでは消えない。履歴もスキャンする：

```bash
gitleaks git . --redact -v        # git 履歴全体を検査（値はログに残さない）
gitleaks dir . --redact -v        # 作業ツリー/ファイルを検査
# 疑わしい断片を狙い撃ちで履歴検索: git log -p -S'<fragment>'
```

※ `gitleaks detect` / `gitleaks protect` は v8.19 で非推奨。現行は `gitleaks git` / `gitleaks dir`。

---

## 見つかったときの対処（深刻度別）

| 深刻度 | 例 | 対処 |
|---|---|---|
| **重大** | API キー / トークン / 秘密鍵 / パスワード | ①**まず値を revoke・再発行**（消す前に。露出した瞬間から侵害済みと見なす）→ ②ファイルから除去し `vscode.SecretStorage` 等の安全な保管へ → ③履歴に入っていれば下記で完全消去 → ④`.gitignore` と pre-commit フックで再発防止 |
| **中** | 氏名 / ユーザー名 / メール / ローカル絶対パス | 汎用プレースホルダに置換（`USER` / `~/` / `example@example.com`）。ただし OSS 作者名・公開 publisher 名は正当なので残す |
| **低** | 内部固有名詞・別プロジェクト名・「〜から流用」の痕跡 | 一般論として書き直す。意味が通るなら削除 |

### git 履歴からの完全消去（既にコミット済みの場合）

```bash
# git-filter-repo が現代の推奨（filter-branch の後継）。要インストール。
git filter-repo --path <漏洩ファイル> --invert-paths          # ファイルごと全履歴から削除
git filter-repo --replace-text <(echo '<secret>==>REDACTED')  # 値だけを全履歴で置換
# 巨大リポジトリなら BFG Repo-Cleaner が高速（オプションは少ない）
```

**重要な後始末：**
1. 露出した資格情報は**必ずローテート**（履歴を消しても、流出済みの値は無効化しない限り危険なまま）。
2. force-push が必要 → **共同作業者は全員 re-clone**（各自の手元クローンには旧履歴が残るため）。
3. 履歴書き換えは共有ブランチを壊す破壊的操作。単独作業でなければ影響範囲を確認してから。

---

## 再発防止（推奨）

コミット時に自動スキャンする pre-commit フックで、混入を根本から防ぐ。Node プロジェクトなので
**husky + lint-staged**（Python 依存を持ち込まない）でリポジトリに含めてチーム共有するのが素直。

```jsonc
// package.json（husky の pre-commit から lint-staged を起動する構成）
"lint-staged": { "*": ["secretlint --no-glob"] }
```

- サーバー側の最終防波堤として **GitHub Push Protection / Secret Scanning** を有効化する（public リポジトリは無料）。
- 単独作業の簡易版なら `.git/hooks/pre-commit` にステージ済みファイルを secretlint へ渡すだけでもよい。

---

## 判定チェックリスト（このスキルの完了条件）

- [ ] フェーズ1の secretlint が 0 件、または全ヒットを誤検出と確認した
- [ ] フェーズ2で個人識別子・絶対パス・メールの混入が無い（あれば置換・削除・正当性確認済み）
- [ ] フェーズ3で `vsce ls` の梱包物に生ソース・秘密・テスト・ログが含まれない（`.vscodeignore` 確認）
- [ ] gitleaks で git 履歴にも秘密が無い（あれば消去＋資格情報ローテート済み）
- [ ] 重大ヒットがあった場合、**値のローテート**まで完了している
