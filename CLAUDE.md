# CLAUDE.md — VSCode 拡張機能 開発プロジェクト

VSCode 拡張機能を開発するためのリポジトリ（public）。
このファイルには **常に効かせる方針だけ** を薄く置く。コピペ用テンプレートや各拡張の詳細は
`docs/` に分離し、**必要なときだけ読む**（コンテキスト節約のため）。

---

## 大原則：public リポジトリとして書く

このリポジトリは公開されている。**コミットするすべてのファイル（コード / ドキュメント / コメント）は、
文脈を知らない第三者が読んでも意味が通る内容にする。**

- **内部固有名詞を持ち込まない** — 他プロジェクト名・社内の呼び名・人名・社内 URL・チケット番号など、
  外部の人に伝わらない・晒すべきでない情報は書かない（例：別リポジトリの名前をそのまま参照しない）
- **「〜から流用」の痕跡を残さない** — 由来を書く必要があるときは、汎用的な一般論として書き直す
- 迷ったら「初見の OSS 利用者が読んで理解できるか？」で判断する
- 秘密情報の扱いは後述の「セキュリティ」に従う

### ファイルの役割分担

- **README.md = 人間（利用者・第三者）向け** — Claude のコンテキストに載せる必要のない情報を置く。
  基本は **プロジェクト概要** と **各拡張機能の説明（何ができるか / インストール・使い方）** だけ。
  開発フローや作業方針・テンプレートは README に書かない
- **CLAUDE.md = Claude 向けの作業方針** — 開発の進め方・ルール。README の内容と重複させない
- 拡張が増えたら README には「拡張一覧＋概要」を並べ、詳細な設計・調査記録は `docs/extensions/<name>.md` に置く

---

## 開発フロー（この順序を必ず守る）

新しい拡張を作るときは 2 フェーズを順番に通す。**フェーズ1を飛ばさない。**

### フェーズ1：事前調査（作る前に必ず）
1. Marketplace（`https://marketplace.visualstudio.com/`）と Open VSX（`https://open-vsx.org/`）で近い拡張を検索。
   WebSearch で「VSCode extension + 目的（英語）」が速い
2. 調査結果を報告する（拡張名 / 作者 / インストール数 / 最終更新 / できること / 不足点）
3. 作るか検討 — 既存で足りるなら **作らない提案** をする。新規 / フォークする場合は
   **ユーザーの判断を仰いでから** フェーズ2へ進む（勝手に実装を始めない）
   - 報告フォーマットは `docs/extensions/_TEMPLATE.md`

### フェーズ2：実装（作ると決まってから）
1. 使う API / Contribution Point のベストプラクティスを公式ドキュメント（`https://code.visualstudio.com/api`）で調べる
   （バージョンで API が変わる。断言できないときは「確認できない」と言う）
2. 調べた内容を `docs/extensions/<name>.md`（テンプレートは `_TEMPLATE.md`）に記載してから実装する
3. 実装 → F5 デバッグ → テスト

---

## 標準スタック

特別な理由がない限りこの構成に統一する。

- TypeScript（`strict: true`）/ バンドラーは esbuild
- テスト：`@vscode/test-cli` + `@vscode/test-electron` / Lint：ESLint
- 公開：`@vscode/vsce`（Marketplace）・`ovsx`（Open VSX）
- `engines.vscode` と `@types/vscode` のバージョンを一致させる
- スキャフォールド：`npx --package yo --package generator-code -- yo code`

---

## 実装の基本方針

- **アクティベーションは遅延** — `activationEvents` は最小限（1.74+ は `onCommand` 等を contribution から自動生成）
- **Contribution Points 優先** — できることは `package.json` の宣言で。命令的コードは最後の手段
- **UX ガイドライン準拠** — `https://code.visualstudio.com/api/ux-guidelines/overview`
- **リソースは dispose** — `context.subscriptions.push(...)` に登録
- **設定は `configuration` contribution で** — ハードコードしない
- **エラーを握りつぶさない** — `window.showErrorMessage` 等でユーザーに見せる
- **困ったらまず Web で最新のベストプラクティスを調べる** — 手元の知識で書く前に公式・主流手法・既知の落とし穴を確認し、「採用案 / 不採用案 / 理由」を提示してから実装する

---

## セキュリティ（例外なく守る）

- **git の commit / push は必ず人間（開発者）が行う。AI は勝手に commit / push しない。**
  一度でも機密情報が混入すると履歴に残り、削除が困難になるため。AI は変更内容を提示するまでに留め、
  最終的にステージ・コミット・プッシュするのは人間。ユーザーが明示的に頼んだ場合のみ commit まで行い、**push は必ず人間が確認して実行する**
- シークレット（API キー / トークン / パスワード）を **平文でコミットしない**。`.gitignore` で
  `.env*` / `*.pem` / `*.key` / `.vscode/settings.json` を除外
- **値の生成・保管は開発者（人間）に依頼** — `.env.example` にはキー名だけ書く
- **ユーザー認証情報は `vscode.SecretStorage`** に保存（`settings.json` / `globalState` に平文で置かない）
- **公開前に `npx @vscode/vsce ls`** で `.vsix` 梱包内容を確認。`.vscodeignore` で `src/` 生ソース・`.env`・テストを除外。公開 PAT はローカルのみ（CI では暗号化 Secret）
- **Webview は CSP + `nonce` 必須**。`enableScripts` は必要時のみ、`localResourceRoots` で限定、外部データは必ずエスケープ（`innerHTML` 直挿し禁止）
- **依存追加時は `npm audit`**。ワークスペース内容の無断外部送信禁止（テレメトリはオプトイン）

---

## ディレクトリ構成（目安）

```
├── CLAUDE.md              ← 常に効かせる方針（薄く保つ）
├── docs/extensions/       ← _TEMPLATE.md ＋ 拡張ごとの調査・実装記録
├── src/extension.ts       ← エントリポイント（activate / deactivate）
├── package.json           ← マニフェスト（contributes / activationEvents）
├── esbuild.js / tsconfig.json
└── .vscode/               ← launch.json（F5）/ tasks.json
```

---

## よく使うコマンド

```bash
npx --package yo --package generator-code -- yo code   # 新規スキャフォールド
npm run watch          # 開発（watch ビルド）。デバッグは VSCode で F5
npm test               # テスト
npx @vscode/vsce ls    # .vsix 梱包内容の確認（publish 前に必須）
npx @vscode/vsce package / publish   # パッケージング / Marketplace 公開
npx ovsx publish       # Open VSX 公開
```

## 参考リンク

- API：`https://code.visualstudio.com/api` / Contribution Points：`/api/references/contribution-points`
- Activation Events：`/api/references/activation-events` / 公開：`/api/working-with-extensions/publishing-extension`
