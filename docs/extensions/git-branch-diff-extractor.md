# Git Branch Diff Extractor

## 目的 / 解決する課題

サイドバーの TreeView から Git ブランチを選択し、そのブランチで変更（コミット）されたファイルを
「分岐元 〜 ブランチ先端」の範囲で抽出して、日時フォルダ（`YYYYMMDD HH-MM`）へ実ファイルとして
コピー出力する拡張。コミット範囲（FROM..TO）を Webview のコミットグラフ上で選んで抽出することもできる。

## フェーズ1：事前調査の結論

- インストール済み v1.1.0 を基にソースを復元し、その後 v1.1.1 で公開向けの安全性・配布性を修正した。
- 復元の経緯：
  - ソースプロジェクトが失われていたため、インストール済み拡張の `out/extension.js`
    （tsc のコンパイル出力。ミニファイなし・コメント保持）から `src/extension.ts` を復元した。
  - tsc の emit は識別子・コメント・文の構造をほぼそのまま保持するため、主な作業は型注釈の復元。
  - 検証：復元した `src/extension.ts` を `tsc -p ./`（TypeScript 5.9.3）で再コンパイルし、
    生成された `out/extension.js` が当時のインストール済みファイルとバイト一致することを確認した。
    現在の v1.1.1 はセキュリティ修正を含むため、復元元とのバイト一致を目的にしていない。
  - 推定したコンパイル設定：`target: ES2020` / `module: commonjs` / `strict: true` /
    `esModuleInterop: true` / `sourceMap: true` / `outDir: out` / `rootDir: src`
    （`?.` の保持・クラスフィールドのコンストラクタ内代入・`__importStar` ヘルパーの形などから逆算）。
  - 注意：型注釈は emit に現れないため、一部（`EventEmitter` の型引数など）は推定。動作・出力コードには影響しない。
  - 配布物に同梱されていた `extension.js.map` は古い世代のソースに対応しており、
    同梱の `extension.js` とは整合しない（復元とは無関係。再コンパイルで正しい map が生成される）。

## 使う VSCode API / Contribution Points

### Contribution Points（package.json）
- `viewsContainers.activitybar`：アクティビティバーにコンテナ `gitBranchDiffExtractor` を追加
- `views`：ビュー `branchList`（ブランチ一覧）
- `commands`：`refresh` / `extractDiff` / `extractByCommitRange`
- `menus`：`view/title`（更新ボタン）、`view/item/context`（inline / コンテキストメニュー）
- `configuration`：`defaultOutputDir`（既定の出力先）、`rememberLastOutputDir`（前回出力先の記憶）
- `activationEvents` は空（VS Code 1.74+ では views / commands の contribution から自動生成）

### 実行時 API（src/extension.ts）
- TreeView：`vscode.window.createTreeView` / `TreeDataProvider` 実装 / `TreeItem` 継承クラス /
  `EventEmitter`・`Event`（`onDidChangeTreeData`）/ `ThemeIcon` / `TreeItemCollapsibleState`
- コマンド：`vscode.commands.registerCommand` / `vscode.commands.executeCommand('revealFileInOS', uri)`
- 進捗表示：`vscode.window.withProgress`（`ProgressLocation.Notification`、`CancellationToken` によるキャンセル対応）
- Webview：`vscode.window.createWebviewPanel`（`enableScripts` / `retainContextWhenHidden`）/
  `webview.html` / `webview.onDidReceiveMessage` / Webview 側 `acquireVsCodeApi().postMessage`
- 通知・ダイアログ：`showInformationMessage` / `showWarningMessage` / `showErrorMessage` / `showOpenDialog` /
  `createOutputChannel`
- ワークスペース：`workspace.workspaceFolders` / `workspace.getConfiguration` /
  `workspace.createFileSystemWatcher('**/.git/HEAD')` / `workspace.onDidChangeWorkspaceFolders`
- 状態保存：`ExtensionContext.globalState`（Memento、前回出力先の記憶）
- リソース管理：`context.subscriptions.push(...)` で dispose 登録
- Node.js 側：`child_process.execFile` で `git` を直接実行
  （`branch` / `rev-parse` / `merge-base` / `reflog` / `log` / `diff --name-status -z` / `cat-file blob` / `rev-list`）、
  `fs` / `path` でファイル出力

## ベストプラクティス（調査結果）

- 参照した公式ドキュメント URL：
  - `https://code.visualstudio.com/api/extension-guides/tree-view`
  - `https://code.visualstudio.com/api/extension-guides/webview`
- 推奨パターン：
  - contribution からの遅延アクティベーション（`activationEvents` 空）に準拠済み
  - 長時間処理は `withProgress` + キャンセル対応、エラーは `showErrorMessage` でユーザーに提示済み
- 避けるべきこと（アンチパターン）：
  - コミットメッセージ等は `textContent` / `createTextNode` で構築し、`innerHTML` に渡さない
  - インラインデータの `<` 等をUnicodeエスケープし、Webviewはランダムnonce付きCSPで制限する
- パフォーマンス / アクティベーションの注意：
  - `git log` は `--max-count` で件数制限、`execFile` の `maxBuffer` を拡大して大きめのリポジトリに対応

## セキュリティ上の注意（この拡張固有）

- 扱うシークレット / 認証情報：なし（git コマンドのローカル実行のみ）
- Webview の有無と CSP 方針：Webview あり（コミット範囲選択）。ランダムnonce付きCSPを設定し、
  Git由来データの `</script>` 脱出を防ぐUnicodeエスケープと、受信コミットハッシュの照合を行う
- 外部送信するデータ：なし（テレメトリなし、ネットワークアクセスなし）

## 実装メモ

- 主要ファイル：
  - `extensions/git-branch-diff-extractor/src/extension.ts`（全ロジック）
  - `extensions/git-branch-diff-extractor/tsconfig.json`
- ロジックの要点：ブランチの「分岐元（作成地点）」推定を
  ①統合先ブランチのマージ履歴 → ②reflog の最古エントリ → ③親ブランチ（develop/main/master）との merge-base →
  ④ルートコミット、の優先順位で行う（詳細はソース内コメント参照）
- 未解決の課題 / TODO：
  - テストが無い（`@vscode/test-cli` + `@vscode/test-electron` の導入を検討）
  - `catch (err: any)` が多用されている（`unknown` + 型ガードへの置き換え候補）
  - 旧配布物には未使用のバックアップ画像が混入していた（復元プロジェクトでは除外済み）
