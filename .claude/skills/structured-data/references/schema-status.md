# Schema 型ステータス（Google 検索機能との対応）

このファイルは、structured-data skill が実行時（Phase 2）に公式情報で鮮度検証するデータ。
schema.org で有効な型であることと、Google 検索のリッチリザルト対象であることを区別する。

```
last_verified: 2026-07-14
scope: この skill が主に扱う型。Google 対応機能の網羅一覧ではない
verify_with:
  - https://developers.google.com/search/docs/appearance/structured-data/search-gallery
  - 各機能の公式要件ページ
re_verify_if: last_verified が概ね30日超 / 重要型を扱う / ユーザーが最新性を要求
```

## ✅ 公式ギャラリー掲載を確認済み

| 型 | 用途・注意 |
|---|---|
| Organization | 組織情報・ロゴ。公式の Organization 要件を確認する |
| BreadcrumbList | パンくずリスト |
| Article / BlogPosting / NewsArticle | 記事。Article の必須・推奨プロパティに従う |
| VideoObject | 動画。動画の公式要件に従う |
| Product / ProductGroup / Offer | 商品。価格・在庫など時間依存情報は特に正確性を保つ |
| Event | イベント。日時・場所・開催状態を可視情報と一致させる |
| JobPosting | 求人。期限切れデータを残さない |
| LocalBusiness | ローカルビジネス |
| Recipe | レシピ |
| SoftwareApplication | ソフトウェアアプリ |
| ProfilePage | プロフィールページ |
| DiscussionForumPosting / QAPage | フォーラム・ユーザーQ&A。FAQPage と混同しない |
| Dataset | データセット |
| ClaimReview | Fact check 機能。利用条件を公式ページで都度確認する |

## 🟡 schema.org では有効だが、専用リッチリザルトを前提にしない型

- WebSite / WebPage / ImageObject / Person / ContactPage / Service
- Trip / TouristTrip
- ItemList 単体

`ItemList` は入れ物であり、カルーセル対象になるかは中身の型と公式 Carousel 要件で決まる。
上記の型はエンティティ関係の表現には使えるが、「付ければ検索結果の見た目が変わる」と説明しない。

## ❌ リッチリザルト目的で新規実装しない型

- FAQPage
- HowTo
- SpecialAnnouncement
- CourseInfo / EstimatedSalary / LearningVideo
- VehicleListing

これらは 2026-07-14 時点の構造化データ機能ギャラリーに掲載されていない。
既存マークアップを保持する意味は別途判断し、検索機能への対応を断言しない。

## 実装時の追加ルール

- 相対URLを避け、canonical と一致する絶対URLを使う。
- プレースホルダ文字列を本番出力に残さない。
- 日付は ISO 8601 で出力する。
- 可視コンテンツと JSON-LD を同一データソースから生成する。
- JavaScript 注入を使う場合も、Google の JavaScript 生成ガイダンスと対象機能の要件を確認する。

## changelog（自己更新の記録）

- 2026-07-14 Google 公式の構造化データ機能ギャラリーと主要型ページで再検証。外部 skill 由来の記録と未検証の網羅一覧を廃止し、この skill が扱う型に範囲を限定。ClaimReview を Fact check 掲載型へ訂正し、ギャラリー非掲載型を整理。
