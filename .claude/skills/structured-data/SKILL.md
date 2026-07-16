---
name: structured-data
description: 構造化データ（JSON-LD / schema.org）を実装・レビュー・検証する汎用skill。動作は「①対象サイトを解析し、要件書にないページも含めて有効な候補を提案 → ②型ステータスの鮮度を公式ドキュメントで検証し、差分があれば references の更新を提案 → ③承認されたサイト構造に合わせてJSON-LDのみを実装 → ④validator/Rich Results Testで検証」の4フェーズ。Organization/ロゴ・favicon・BreadcrumbList・Article/BlogPosting・VideoObject・ItemList・@idによるエンティティ集約・多言語(i18n)・ページネーションに対応。FAQ/HowTo等の廃止済みリッチリザルトで作らないよう最新の対応状況を必ず参照する。Use when implementing/reviewing JSON-LD structured data, finding useful schema opportunities omitted from a requirements document, rich results, Organization logo, video/ItemList markup, or debugging why a node "isn't detected".
version: "1.1.0"
---

# 構造化データ（JSON-LD）実装プレイブック

サイト種別（WordPress / 静的 / SPA / Next.js 等）や言語を問わず使える、構造化データ実装の**実行フロー・原則・要件・検証手順**。案件固有のファイルパスや構成は各プロジェクトの agent_docs 側に置き、ここには普遍的な型・手順・鮮度管理だけを持つ。

## ⚠️ このskillの動作範囲（スコープ）

- **変更するのは JSON-LD 構造化データのみ。** 既存のHTML表示・CSS・JavaScript・本文コンテンツ・レイアウトは**変更しない**。
- 新規実装で構造化データ出力コードをテンプレートに差し込む場合も、**JSON-LD出力ブロックの追加に限定**し、既存の表示ロジックは壊さない。
- 無関係なリファクタや破壊的変更は行わない。実装前に必ず Phase 1（サイト解析）を行う。

## 実行フロー（この順で必ず進める）

```
Phase 1  サイト解析・提案     … 全ページ種別を棚卸しし、要件外も含めて有効な候補を提案
Phase 2  鮮度チェック・更新提案 … 型ステータスを公式で検証し、差分があれば更新案を提示
Phase 3  実装(JSON-LDのみ)    … 明示要件と承認済み提案に限って構造化データだけを実装
Phase 4  検証                … validator / Rich Results Test / curl / lint
```

### Phase 1 — サイト解析（先に必ず。サイトごとに構造が違う前提）
1. **生成方式を特定**：WordPress / 静的PHP / SPA / Next.js 等。構造化データを**どこで出力しているか**（共通ヘッダ、テンプレ、JSで注入か）。
2. **既存JSON-LDを実取得**：`curl -s -A "Mozilla/5.0" URL` で `<script type="application/ld+json">`〜`</script>` を抜き、現状の `@type` / `@id` / 既存エンティティを把握。
3. **ページ種別を棚卸し**：要件書・指示書に載っているページだけで終えず、ルーティング、テンプレート、サイトマップ、ナビゲーション等から代表的なページ種別を列挙する。要件書が「記載対象だけに限定する」と明示していない限り、記載漏れの可能性を必ず検討する。
4. **ページ→型のマッピングを作成**：
   - トップ → Organization + WebSite（+ WebPage/Breadcrumb）
   - 記事/ブログ → Article / BlogPosting
   - 動画一覧 → VideoObject × ItemList
   - 一覧/アーカイブ → 表示中アイテムのみ（§3）
   - 全ページ共通 → WebPage + BreadcrumbList
5. **要件とのギャップを提案**：要件書の対象とページ種別の棚卸し結果を比較する。要件にないページでも、Google対応型が可視コンテンツと一致し、正確に維持できるなら実装候補として提示する。専用リッチリザルトがない型は「検索結果の見た目が変わる」と説明せず、セマンティック上の効果と分ける。候補がなければ「追加提案なし」と明記する。
6. **提案ゲートを守る**：要件外候補は、対象ページ、候補型、期待できる効果、必要なデータ、維持上の注意、優先度を示してから、追加実装するかユーザーに判断を求める。明示要件の実装は進めてよいが、未承認の要件外候補を黙って実装しない。ユーザーが要件外の提案も禁止している場合だけ提案を省略する。
7. **既存の実装規約を尊重**：命名・出力層・多言語構成・URL正規化の癖を読む。ここで方針を固めてから Phase 3 へ。
8. **JS注入に注意**：JSでJSON-LDを注入するサイトはGoogleの処理が遅延しうる（2025/12 JS SEOガイダンス）。時間依存の型（Product/Offer等）は**初期HTMLに含める（SSR）**よう推奨。

Phase 1 のコード変更前に、最低限次の表を出力する。

| 対象ページ/テンプレート | 要件記載 | 現状 | 候補型 | 期待できる効果 | 正確に生成できる根拠 | 優先度・判断 |
|---|---|---|---|---|---|---|
| 例：記事詳細 | なし | 未実装 | Article | 記事リッチリザルトの対象になりうる | 見出し・画像・公開日・著者を同一データから取得可能 | 高・追加提案 |

### Phase 2 — 鮮度チェック & 更新提案（古い情報でJSON-LDを作らない）
1. **`references/schema-status.md` を読む**（型ごとの ACTIVE / 非推奨 / 廃止）。冒頭 `last_verified` を確認。
2. **再検証要否を判断**：`last_verified` が概ね30日超／扱う型が重要（Article, Product, VideoObject, FAQ系, Event 等）／ユーザーが最新性を要求 のいずれかなら再検証。
3. **公式で再検証**：`WebSearch`（`allowed_domains: ["developers.google.com"]`）で対象型の最新の対応状況・非推奨を確認。※`WebFetch` は developers.google.com が403になりやすいので `WebSearch` を使う。必要なら「構造化データ機能ギャラリー」を確認。
4. **差分があれば更新を提案**：確認した差分と現在の実装判断への影響を示し、スキルファイルを更新するかユーザーに確認する。未承認でも今回の実装判断には公式の確認結果を使うが、既存ファイルは変更しない。承認後に限り `references/schema-status.md` の `last_verified` と末尾 changelog を更新する。型ステータスが変わった場合は SKILL.md の patch versionも上げ、下記変更履歴に記録する。
5. **廃止済みの型でリッチリザルト目的の実装をしない**（例：HowTo/FAQ のリッチリザルトは終了。詳細は references）。

### Phase 3 — 実装（JSON-LD のみ）
Phase 1 のマッピングのうち、明示要件とユーザーが承認した追加提案に従い、下記の原則（§0〜§5）を守って**構造化データだけ**を実装する。未承認候補は提案として残し、コードには含めない。

### Phase 4 — 検証
§6 の検証ワークフロー（validator / Rich Results Test / curl / lint / canonical）。

---

## 0. 実装4原則（迷ったらここへ）

1. **可視コンテンツと一致させる。** ページに表示中のものだけをマークアップ（[sd-policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)）。
2. **不正確 > 無し で悪い。** 正確に保てないプロパティは入れない。
3. **`@id` でエンティティを1つに集約。** 実体は1箇所で完全定義し、他は `@id` 参照。
4. **表示とJSON-LDを同一データソースから生成。** 別々に手書きするとズレる。

## 1. `@id` によるエンティティ集約（@graph 設計）

- `{"@context":"https://schema.org","@graph":[ ... ]}` に複数ノードを並べる。
- **Organization / WebSite はトップで一度だけ完全定義**し `@id`（例 `.../#organization`）を付与。他ノード・他ページは `{"@id":".../#organization"}` で**参照だけ**。名前・ロゴを毎回インライン重複させない。
- **落とし穴：** validatorで `@id` 参照ノードは**参照元にネストされ独立「検出」に出ない**＝正常（§6）。
- **Article/BlogPosting の publisher だけは `@id` + `name` + `logo` のハイブリッド**（Article系は publisher に name/logo を要求するため）。

## 2. 型ごとの要点（ステータスは references/schema-status.md を必ず参照）

### Organization（ロゴのリッチリザルト）
- 必須：`logo`(ImageObject.url) と `url`。ロゴ画像は**最小112×112px**、PNG/JPEG/SVG/WebP、クロール可能。
- 推奨：`sameAs`・`address`・`telephone`・`parentOrganization`。
- **`image` にロゴと同じ画像を重複指定しない。** ロゴ目的なら `logo` だけで足りる。

### favicon（検索結果のサイト名の横に出る小ロゴ）
- Organization.logo ではなく **`<link rel="icon">`** が使われる。別物。
- **48×48pxの倍数**・正方形・全ページ設置・クロール可能。小さすぎ（32px未満）は不安定。

### WebPage / BreadcrumbList
- BreadcrumbList は Rich Results Test の検出対象。`itemListElement`（`ListItem`：`position`+`item{@id,name}`）。

### Article / BlogPosting
- `headline`,`image`,`datePublished`,`dateModified`,`author`,`publisher`(name+logo),`mainEntityOfPage`。

### VideoObject
- `name`,`thumbnailUrl`,`uploadDate`,`description` ＋（`embedUrl` または `contentUrl`。YouTubeは `embedUrl`）。
- `duration` は推奨だが**正確に自動取得できないなら入れない**（§5）。

### ItemList（"入れ物"。効果は中身の型で決まる）
- 中身が対応型（**Video/Recipe/Course/Movie/Restaurant/Product** 等）→ カルーセル対象になりうる。
- 非対応型（**Trip/TouristTrip=旅行/モデルコース** 等）→ 付けても見た目は変わらない。
- 動画ギャラリーは公式パターン：`ItemList`→`ListItem`(`position`)→`item` に VideoObject をネスト、順序＝表示順。

## 3. 一覧・ページネーション

- 一覧/アーカイブ：**表示中のアイテムだけ**マークアップ。
- ページ送り：各ページのノード `@id`/`url` は**そのページ固有**に（全ページ同一@idで違う中身にしない）。

## 4. 多言語（i18n）

- **全言語で構造を揃える**（片方だけ更新しない）。`@id`・ロゴ・形は共有、`name`・`inLanguage`(`ja`/`en`/`zh-Hant`)はローカライズ。

## 5. "静かな不一致"を作らない

| 種類 | 例 | ミス時 | 対策 |
|---|---|---|---|
| 可視（表示＋JSON-LD） | id・サムネ・タイトル | 画面が壊れ気づく | 同一ソース生成で自動一致 |
| 不可視（JSON-LD専用） | uploadDate・duration | 静かに不一致が残る | 極力持たない／安定IDから自動導出 |

## 6. 検証ワークフロー（ツールの役割を取り違えない）

1. **validator.schema.org**：全ノード構文。`@id`参照ノードは親にネスト＝独立表示されなくて正常。
2. **Google Rich Results Test**：Google対応リッチリザルトのみ「検出」。**Organization/Logoは出ない＝正常**。Video/Breadcrumb/Articleは出る。
3. **本番/検証環境を curl** して JSON-LD を実確認（未デプロイだと旧出力＝切り分け）。
4. **サーバーコード lint**（PHPなら `php -l`）。
5. **canonical/URL二重化**（ベースURL定数＋絶対URL返す関数の連結事故）に注意。

## 7. 「付ける価値ある？」判定
- [ ] 要件書にないページ種別も棚卸しし、有効な候補を提案したか（候補なしの場合も明記したか）
- [ ] Google がリッチリザルト対応の型か（references参照。非推奨/廃止でないか） → Noなら効果はセマンティック中心
- [ ] 全フィールドを将来も正確に保てるか → Noなら該当フィールドは入れない
- [ ] 可視コンテンツと一致か
- [ ] 既存エンティティと `@id` 連結済みか
- [ ] 多言語なら全言語で構造が揃っているか

## 8. 必須プロパティ早見表

| 型 | 必須級 |
|---|---|
| Organization(logo) | `logo`(ImageObject.url), `url` |
| WebSite | `url`, `name` |
| BreadcrumbList | `itemListElement[]`(`position`,`item{@id,name}`) |
| Article/BlogPosting | `headline`,`image`,`datePublished`,`dateModified`,`author`,`publisher`(name+logo),`mainEntityOfPage` |
| VideoObject | `name`,`thumbnailUrl`,`uploadDate`,`description`,(`embedUrl`\|`contentUrl`) |
| ItemList | `itemListElement[]`(`ListItem`:`position`, +`url` or ネスト`item`) |

## 参考（公式）
- [General Structured Data Guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- [構造化データ機能ギャラリー（対応機能一覧）](https://developers.google.com/search/docs/appearance/structured-data/search-gallery)
- [Video (VideoObject)](https://developers.google.com/search/docs/appearance/structured-data/video) / [Carousel (ItemList)](https://developers.google.com/search/docs/appearance/structured-data/carousel) / [Logo](https://developers.google.com/search/docs/appearance/structured-data/logo)
- 型ステータスの基準値は **`references/schema-status.md`**（実行時に鮮度を検証し、差分があれば更新を提案する）

---

## 変更履歴

| バージョン | 日付       | 変更内容                                                                                             |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| 1.1.0      | 2026-07-16 | 要件書に未記載のページ種別も棚卸しして追加提案するゲートと、参照情報を承認後だけ更新する安全策を追加 |
| 1.0.0      | 2026-07-14 | frontmatter と変更履歴を追加。型ステータスを Google 公式資料で再検証し、外部 skill の流用元記録を除去 |
