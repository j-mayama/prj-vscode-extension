---
name: structured-data
description: 構造化データ（JSON-LD / schema.org）を実装・レビュー・検証・報告する汎用skill。動作は「①対象サイトを解析し、要件書にないページも含めて有効な候補を提案 → ②型ステータスの鮮度を公式ドキュメントで検証し、差分があれば references の更新を提案 → ③承認されたサイト構造に合わせてJSON-LDのみを実装 → ④validator/Rich Results Testで検証し、Backlog等へ貼り付け可能な完了報告を回答内に出力」の4フェーズ。Organization/ロゴ・favicon・BreadcrumbList・Article/BlogPosting・VideoObject・ItemList・@idによるエンティティ集約・多言語(i18n)・ページネーションに対応。FAQ/HowTo等の廃止済みリッチリザルトで作らないよう最新の対応状況を必ず参照する。Use when implementing/reviewing JSON-LD structured data, finding useful schema opportunities omitted from a requirements document, preparing a copy-paste implementation report, rich results, Organization logo, video/ItemList markup, or debugging why a node "isn't detected".
version: "1.4.0"
---

# 構造化データ（JSON-LD）実装プレイブック

サイト種別（WordPress / 静的 / SPA / Next.js 等）や言語を問わず使える、構造化データ実装の**実行フロー・原則・要件・検証手順**。案件固有のファイルパスや構成は各プロジェクトの agent_docs 側に置き、ここには普遍的な型・手順・鮮度管理だけを持つ。

## ⚠️ このskillの動作範囲（スコープ）

- **変更するのは JSON-LD 構造化データのみ。** 既存のHTML表示・CSS・JavaScript・本文コンテンツ・レイアウトは**変更しない**。
- 新規実装で構造化データ出力コードをテンプレートに差し込む場合も、**JSON-LD出力ブロックの追加に限定**し、既存の表示ロジックは壊さない。
- 無関係なリファクタや破壊的変更は行わない。実装前に必ず Phase 1（サイト解析）を行う。

## 実行フロー（この順で必ず進める）

```
Phase 1  サイト解析・提案     … 全ページ種別と実レコード分布を棚卸しし、有効な候補を提案
Phase 2  鮮度チェック・更新提案 … 型ステータスを公式で検証し、差分があれば更新案を提示
Phase 3  実装(JSON-LDのみ)    … 明示要件と承認済み提案に限って構造化データだけを実装
Phase 4  検証・報告           … validator / Rich Results Test / curl / lint → 回答内に完了報告
```

### Phase 1 — サイト解析（先に必ず。サイトごとに構造が違う前提）
1. **生成方式を特定**：WordPress / 静的PHP / SPA / Next.js 等。構造化データを**どこで出力しているか**（共通ヘッダ、テンプレ、JSで注入か）。
2. **既存JSON-LDを実取得**：`curl -s -A "Mozilla/5.0" URL` で `<script type="application/ld+json">`〜`</script>` を抜き、現状の `@type` / `@id` / 既存エンティティを把握。
3. **ページ種別を棚卸し**：要件書・指示書に載っているページだけで終えず、ルーティング、テンプレート、サイトマップ、ナビゲーション等から代表的なページ種別を列挙する。要件書が「記載対象だけに限定する」と明示していない限り、記載漏れの可能性を必ず検討する。
4. **実データ分布を確認**：CMS/テンプレート駆動ページは、一覧・アーカイブ・サイトマップ等を実取得（例：`curl -s -A "Mozilla/5.0" URL`）し、そのテンプレートが実際に描画するレコードを列挙する。**「1テンプレート＝1エンティティ種類」ではない。** 国・地域、運営主体、エンティティ種別、言語のばらつきを確認する。分岐は推測やURLではなく**明示フィールド**で行い、その値の意味と分布を実データで確認する。
5. **列挙手段そのものを検証**：抽出パターンが対象を静かに取りこぼしていないか疑う。例外レコードはURLの階層・拡張子・言語プレフィックス等も例外的になりやすい。例えば `^/shop/[a-z0-9_-]+/$` のように1階層だけで列挙すると、唯一の2階層URL `/shop/example-region/factory/` が漏れ、「例外なし」と誤判定しうる。
   - 抽出件数を、一覧ページの表示件数・サイトマップ・CMS管理画面等の独立した件数と突き合わせる。差分があれば、解消するまで「例外なし」と結論づけない。
   - 最初は階層・拡張子・言語プレフィックス等を限定しない広いパターンで取得し、構造の種類を目視してから必要な条件へ絞る。
   - 「例外がないこと」を確認するときほど、列挙漏れが結論を反転させる。Phase 1 の報告に抽出元・抽出条件・抽出件数・照合先・基準件数・差分を残す。
6. **値の根拠を実データで検証**：
   - `addressCountry` / `inLanguage` / `priceCurrency` / `areaServed` 等の定数は、全レコードで真の場合だけ直書きする。例外を確実に判定できる明示フィールドがなければ出さない。欠落を許容し、誤りを出さない。迷ったら省略する。
   - `parentOrganization` / `subOrganization` / `brand` / `publisher` / `provider` は現実の関係の主張として扱う。取扱店・パートナー・代理店・FC等の別法人が混ざりうるため、サイト主体の `Organization @id` を一律付与せず、直営フラグ等で限定する。`brand` は `parentOrganization` の代替ではない。
   - 郵便番号・営業時間・価格・寸法等を自由入力から抽出する前に、実データに存在するか確認する。存在しなければ実装せず、存在する場合も実サンプルと敵対的サンプル（桁溢れ・全角・区切り違い等）で抽出を検証する。
   - CMS自由入力は実体参照をデコードしてからタグを除去する。例：PHPでは `html_entity_decode($s, ENT_QUOTES, 'UTF-8')` の後にタグ除去する。逆順では実体参照で書かれたタグが残る／復活しうる。
7. **ページ→型のマッピングを作成**：
   - トップ → Organization + WebSite（+ WebPage/Breadcrumb）
   - 記事/ブログ → Article / BlogPosting
   - 動画一覧 → VideoObject × ItemList
   - 一覧/アーカイブ → 表示中アイテムのみ（§3）
   - 全ページ共通 → WebPage + BreadcrumbList
8. **要件とのギャップを提案**：要件書の対象とページ種別の棚卸し結果を比較する。要件にないページでも、Google対応型が可視コンテンツと一致し、正確に維持できるなら実装候補として提示する。専用リッチリザルトがない型は「検索結果の見た目が変わる」と説明せず、セマンティック上の効果と分ける。候補がなければ「追加提案なし」と明記する。
9. **提案ゲートを守る**：要件外候補は、対象ページ、候補型、期待できる効果、必要なデータ、維持上の注意、優先度を示してから、追加実装するかユーザーに判断を求める。明示要件の実装は進めてよいが、未承認の要件外候補を黙って実装しない。ユーザーが要件外の提案も禁止している場合だけ提案を省略する。
10. **既存の実装規約を尊重**：命名・出力層・多言語構成・URL正規化の癖を読む。ここで方針を固めてから Phase 3 へ。
11. **JS注入に注意**：JSでJSON-LDを注入するサイトはGoogleの処理が遅延しうる（2025/12 JS SEOガイダンス）。時間依存の型（Product/Offer等）は**初期HTMLに含める（SSR）**よう推奨。

Phase 1 のコード変更前に、最低限次の表を出力する。

| 対象ページ/テンプレート | 実データ分布・例外/分岐フィールド（列挙件数・照合先を含む） | 要件記載 | 現状 | 候補型 | 期待できる効果 | 正確に生成できる根拠 | 優先度・判断 |
|---|---|---|---|---|---|---|---|
| 例：記事詳細 | 12件（一覧表示12件・サイトマップ12件）／言語2種／言語フィールドで分岐 | なし | 未実装 | Article | 記事リッチリザルトの対象になりうる | 見出し・画像・公開日・著者を同一データから取得可能 | 高・追加提案 |

### Phase 2 — 鮮度チェック & 更新提案（古い情報でJSON-LDを作らない）
1. **`references/schema-status.md` を読む**（型ごとの ACTIVE / 非推奨 / 廃止）。冒頭 `last_verified` を確認。
2. **再検証要否を判断**：`last_verified` が概ね30日超／扱う型が重要（Article, Product, VideoObject, FAQ系, Event 等）／ユーザーが最新性を要求 のいずれかなら再検証。
3. **公式で再検証**：`WebSearch`（`allowed_domains: ["developers.google.com"]`）で対象型の最新の対応状況・非推奨を確認。※`WebFetch` は developers.google.com が403になりやすいので `WebSearch` を使う。必要なら「構造化データ機能ギャラリー」を確認。
4. **差分があれば更新を提案**：確認した差分と現在の実装判断への影響を示し、スキルファイルを更新するかユーザーに確認する。未承認でも今回の実装判断には公式の確認結果を使うが、既存ファイルは変更しない。承認後に限り `references/schema-status.md` の `last_verified` と末尾 changelog を更新する。型ステータスが変わった場合は SKILL.md の patch versionも上げ、下記変更履歴に記録する。
5. **廃止済みの型でリッチリザルト目的の実装をしない**（例：HowTo/FAQ のリッチリザルトは終了。詳細は references）。

### Phase 3 — 実装（JSON-LD のみ）
Phase 1 のマッピングのうち、明示要件とユーザーが承認した追加提案に従い、下記の原則（§0〜§5）を守って**構造化データだけ**を実装する。未承認候補は提案として残し、コードには含めない。

### Phase 4 — 検証・報告
§6 の検証ワークフロー（validator / Rich Results Test / curl / lint / canonical）を実行し、§7 の形式で回答内に完了報告を出力する。変更が未デプロイで実URLから旧出力しか取得できない場合は、CMS関数をスタブした生成ハーネスに本番から取得した実データサンプルを流し、構文・生成ロジックを検証してよい。海外レコードに国内の定数を出さない、別法人にサイト主体との関係を出さない等の**否定的アサーション**を必ず含める。ただしこれは実URL検証の代替完了ではない。デプロイ後に実URLを curl し、Rich Results Test / validator.schema.org でも別途確認する。

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
| 定数の直書き | addressCountry・inLanguage・priceCurrency | 例外レコードだけ静かに誤る | 全レコードで真か確認。明示フィールドで分岐できなければ省略 |
| 関係プロパティ | parentOrganization・provider | 運営実態と違っても画面は壊れない | 実際の運営主体を確認し、明示フィールドで対象を限定 |
| 自由入力からの抽出 | 郵便番号・営業時間・価格 | デッドコードや誤検出が残る | 実データの存在確認＋実サンプル／敵対的サンプルで検証 |
| 実体参照 | `&amp;`・`&lt;...&gt;` | JSON-LD内だけ文字化け／タグが復活 | 実体参照デコード→タグ除去の順で正規化 |

## 6. 検証ワークフロー（ツールの役割を取り違えない）

1. **validator.schema.org**：全ノード構文。`@id`参照ノードは親にネスト＝独立表示されなくて正常。
2. **Google Rich Results Test**：Google対応リッチリザルトのみ「検出」。**Organization/Logoは出ない＝正常**。Video/Breadcrumb/Articleは出る。
3. **本番/検証環境を curl** して JSON-LD を実確認。未デプロイなら Phase 4 のスタブ・ハーネスで生成ロジックを検証し、デプロイ後に実URL検証を必ず行う。
4. **サーバーコード lint**（PHPなら `php -l`）。
5. **canonical/URL二重化**（ベースURL定数＋絶対URL返す関数の連結事故）に注意。

## 7. 完了報告フォーマット（ファイルを作らず、回答内に出力）

実装・レビューの完了時、またはユーザーが報告文だけを求めたときは、対象ページ種別ごとに次のブロックを**通常のMarkdown本文**として出力する。ファイルは生成せず、リンクを有効にするためコードフェンスでも囲まない。Backlog等へ貼り付けたとき単体で意味が通るように、リポジトリのファイル名や内部事情ではなく、対象URL・実装内容・条件・対象外・検証結果を書く。

```text
■{対象機能名}（{ページ種別}）
[https://example.com/{path}/{slug}/](https://example.com/%7Bpath%7D/%7Bslug%7D/) （例: [https://example.com/shop/example-store/](https://example.com/shop/example-store/)）
→ {Schema.org型} を実装。
→ {実際に出力する主要プロパティ}を付与。＋{BreadcrumbList等の併用型}。
→ {関係プロパティや値を付ける条件。条件外で付けない理由}。
→ {対象外ページ・レコードと判定条件}。

構造化データの確認：
[https://validator.schema.org/#url={URLエンコード済みの代表URL}](https://validator.schema.org/#url={URLエンコード済みの代表URL})
```

店舗詳細を報告する場合の汎用例：

```text
■店舗情報（店舗詳細）
[https://example.com/shop/{store-slug}/](https://example.com/shop/%7Bstore-slug%7D/) （例: [https://example.com/shop/example-store/](https://example.com/shop/example-store/)）
→ FurnitureStore を実装。
→ 店舗プロパティ一式（name・image・address・telephone・hasMap・description・url）を付与。＋パンくず。
→ 直営フラグが有効な店舗のみ parentOrganization でサイト運営組織に接続。
（パートナー店・海外店・法人取扱店は別法人のため付けない）
→ 商品販売のない工場ページ・店舗以外のページ（規約ページ等）は対象外。

構造化データの確認：
[https://validator.schema.org/#url=https%3A%2F%2Fexample.com%2Fshop%2Fexample-store%2F](https://validator.schema.org/#url=https%3A%2F%2Fexample.com%2Fshop%2Fexample-store%2F)
```

- `{対象機能名}` は「店舗情報」「記事情報」「動画一覧」等、報告先の担当者が理解できる名称にする。
- URLパターンと、実在する代表URLを1件以上示す。プレースホルダだけのURLを検証リンクに使わない。
- 「実装」と書くのはコード変更が完了した場合だけにする。提案・未着手・レビューのみなら「提案」「実装予定」「確認」に置き換える。
- プロパティは予定一覧ではなく、実際に出力するものだけを書く。条件付きプロパティは条件と、条件外で出さない理由を続けて書く。
- 対象外ページや例外レコードがある場合は、URLの見た目だけでなく実際の判定フィールド・条件も簡潔に書く。
- validatorリンクは代表URLをURLエンコードして作る。実URLで確認済みなら結果も一言添える。未デプロイ・アクセス不能・未実行の場合はリンクだけで確認済みと見せず、「未デプロイのため実URL検証は未実施」等を明記する。
- Google対応型を Rich Results Test でも確認した場合は、その確認URLと結果を続けて追記する。対象外の型にリッチリザルト効果があるような表現はしない。
- 複数のページ種別を変更した場合は、このブロックをページ種別ごとに繰り返す。該当しない行を無理に残さず省略してよい。

## 8. 「付ける価値ある？」判定
- [ ] 要件書にないページ種別も棚卸しし、有効な候補を提案したか（候補なしの場合も明記したか）
- [ ] Google がリッチリザルト対応の型か（references参照。非推奨/廃止でないか） → Noなら効果はセマンティック中心
- [ ] 全フィールドを将来も正確に保てるか → Noなら該当フィールドは入れない
- [ ] その定数は、このテンプレートが描画する**全レコード**で真か
- [ ] 抽出件数を独立した一覧・サイトマップ・CMS等の件数と照合し、列挙漏れがないか
- [ ] 所有・包含関係は**実際の運営主体**と一致するか（別法人が混ざっていないか）
- [ ] 自由入力からの抽出は、**実データに存在する**情報か
- [ ] 可視コンテンツと一致か
- [ ] 既存エンティティと `@id` 連結済みか
- [ ] 多言語なら全言語で構造が揃っているか

## 9. 必須プロパティ早見表

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
| 1.4.0      | 2026-07-16 | Backlog等へ貼り付け可能な構造化データ実装・検証レポートを、ファイル生成せず回答内に出力する形式を追加 |
| 1.3.0      | 2026-07-16 | 例外的なURL構造を抽出条件が取りこぼすリスクと、独立した件数との照合を Phase 1 に追加 |
| 1.2.0      | 2026-07-16 | テンプレートの実レコード分布、定数・関係・自由入力抽出の根拠確認、未デプロイ時の生成ハーネス検証を追加 |
| 1.1.0      | 2026-07-16 | 要件書に未記載のページ種別も棚卸しして追加提案するゲートと、参照情報を承認後だけ更新する安全策を追加 |
| 1.0.0      | 2026-07-14 | frontmatter と変更履歴を追加。型ステータスを Google 公式資料で再検証し、外部 skill の流用元記録を除去 |
