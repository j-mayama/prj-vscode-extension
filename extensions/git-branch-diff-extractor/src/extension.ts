import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
// ─────────────────────────────────────────────
// Utility: exec git commands
// ─────────────────────────────────────────────
function execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr || err.message));
            }
            else {
                resolve(stdout);
            }
        });
    });
}
function execGitBuffer(args: string[], cwd: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        cp.execFile('git', args, { cwd, maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
            if (err) {
                reject(err);
            }
            else {
                resolve(stdout);
            }
        });
    });
}
function getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}
// ─────────────────────────────────────────────
// Branch Item for TreeView
// ─────────────────────────────────────────────
class BranchItem extends vscode.TreeItem {
    constructor(public readonly branchName: string, public readonly isCurrent: boolean, public readonly lastCommitDate: string) {
        super(branchName, vscode.TreeItemCollapsibleState.None);
        const prefix = isCurrent ? '● ' : '';
        this.label = `${prefix}${branchName}`;
        this.description = lastCommitDate;
        this.tooltip = `${branchName}\n最終コミット: ${lastCommitDate}`;
        this.contextValue = 'branch';
        this.iconPath = new vscode.ThemeIcon(isCurrent ? 'git-branch' : 'source-control');
        // クリック時に差分抽出コマンドを実行
        this.command = {
            command: 'gitBranchDiffExtractor.extractDiff',
            title: '差分を抽出',
            arguments: [this]
        };
    }
}
// ─────────────────────────────────────────────
// TreeDataProvider: ブランチ一覧
// ─────────────────────────────────────────────
class BranchTreeProvider implements vscode.TreeDataProvider<BranchItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<BranchItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element: BranchItem): vscode.TreeItem {
        return element;
    }
    async getChildren(): Promise<BranchItem[]> {
        const root = getWorkspaceRoot();
        if (!root) {
            vscode.window.showInformationMessage('ワークスペースが開かれていません。');
            return [];
        }
        try {
            // ローカルブランチを最終コミット日時順(降順)で取得
            const output = await execGit([
                'branch',
                '--sort=-committerdate',
                '--format=%(refname:short)\t%(committerdate:iso)\t%(HEAD)'
            ], root);
            const lines = output.trim().split('\n').filter(l => l.length > 0);
            const items: BranchItem[] = [];
            for (const line of lines) {
                const parts = line.split('\t');
                const branchName = parts[0].trim();
                const commitDate = parts[1]?.trim() || '';
                const isCurrent = parts[2]?.trim() === '*';
                // 日時を見やすい形式に変換
                let displayDate = commitDate;
                try {
                    const d = new Date(commitDate);
                    displayDate = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                }
                catch {
                    // パース失敗時はそのまま表示
                }
                items.push(new BranchItem(branchName, isCurrent, displayDate));
            }
            return items;
        }
        catch (err: any) {
            vscode.window.showErrorMessage(`ブランチ一覧の取得に失敗しました: ${err.message}`);
            return [];
        }
    }
}
// ─────────────────────────────────────────────
// 分岐元（ブランチが作成された地点）を特定するユーティリティ
// ─────────────────────────────────────────────
// git コマンドを実行し、失敗時は null を返す（判定用）
async function tryGit(args: string[], cwd: string): Promise<string | null> {
    try {
        return (await execGit(args, cwd)).trim();
    }
    catch {
        return null;
    }
}
// a が b の祖先（または同一）かどうか
async function isAncestor(a: string, b: string, cwd: string): Promise<boolean> {
    if (a === b) {
        return true;
    }
    return (await tryGit(['merge-base', '--is-ancestor', a, b], cwd)) !== null;
}
// 機能ブランチが「作成される元」となる代表的なブランチ（マージ先の test/staging 等は含めない）
const PARENT_PRIMARY = ['develop', 'main', 'master'];
const PARENT_FALLBACK = ['test', 'staging', 'release'];
// reflog の最古エントリ（= ブランチ作成地点）を取得する
async function getReflogCreationBase(branchName: string, branchTip: string, cwd: string): Promise<string | null> {
    const toParentIfPossible = async (hash: string) => {
        const parent = await tryGit(['rev-parse', `${hash}^`], cwd);
        return parent || hash;
    };
    const raw = await tryGit(['reflog', 'show', '--format=%H\t%gs', branchName], cwd);
    if (!raw) {
        return null;
    }
    const lines = raw.split('\n').filter(l => l.length > 0);
    if (lines.length === 0) {
        return null;
    }
    // 最古のエントリ = ブランチが最初に指していたコミット = 作成地点
    const oldest = lines[lines.length - 1];
    const h = oldest.split('\t')[0];
    if (h && h !== branchTip && await isAncestor(h, branchTip, cwd)) {
        return await toParentIfPossible(h);
    }
    // 念のため "Created from" 明示エントリも探す
    const created = lines.slice().reverse().find(l => l.includes('Created from'));
    if (created) {
        const ch = created.split('\t')[0];
        if (ch && ch !== branchTip && await isAncestor(ch, branchTip, cwd)) {
            return await toParentIfPossible(ch);
        }
    }
    return null;
}
// 既に親へマージ済みの場合、親側のマージコミットから元の分岐地点を復元する
async function recoverForkFromMerge(parent: string, branchTip: string, cwd: string): Promise<string | null> {
    const raw = await tryGit(['log', '--merges', '--format=%H %P', '--max-count=500', parent], cwd);
    if (!raw) {
        return null;
    }
    for (const line of raw.split('\n')) {
        const parts = line.trim().split(' ').filter(part => part.length > 0);
        const parents = parts.slice(1);
        if (parents.length > 1 && parents.slice(1).includes(branchTip) && parents[0] !== branchTip) {
            const b = await tryGit(['merge-base', parents[0], branchTip], cwd);
            if (b) {
                return b;
            }
        }
    }
    return null;
}
// 統合先ブランチ上の "Merge branch 'feature/..." 履歴から分岐点を復元する
async function getBaseFromIntegrationMerges(branchName: string, cwd: string): Promise<string | null> {
    const allBranchesRaw = await tryGit(['branch', '--format=%(refname:short)'], cwd);
    if (!allBranchesRaw) {
        return null;
    }
    const allBranches = allBranchesRaw
        .split('\n')
        .map(b => b.trim())
        .filter(b => b.length > 0);
    const integrationBranches = ['test', 'develop', 'main', 'master'].filter(b => allBranches.includes(b));
    const candidates: string[] = [];
    for (const target of integrationBranches) {
        const mergeRaw = await tryGit([
            'log', target, '--merges', '--reverse',
            '--format=%H %P %s',
            `--grep=Merge branch '${branchName}'`
        ], cwd);
        if (!mergeRaw) {
            continue;
        }
        const mergeLine = mergeRaw.split('\n').find(line => line.trim().length > 0);
        if (!mergeLine) {
            continue;
        }
        const parts = mergeLine.trim().split(' ').filter(p => p.length > 0);
        // format: <merge> <parent1> <parent2> ... <subject>
        if (parts.length < 3) {
            continue;
        }
        const p1 = parts[1];
        const p2 = parts[2];
        const base = await tryGit(['merge-base', p1, p2], cwd);
        if (base) {
            candidates.push(base);
        }
    }
    if (candidates.length === 0) {
        return null;
    }
    // 最も古い（他候補の祖先）を採用
    let base = candidates[0];
    for (const c of candidates.slice(1)) {
        if (await isAncestor(c, base, cwd)) {
            base = c;
        }
    }
    return base;
}
// ─────────────────────────────────────────────
// ブランチの分岐元（作成地点）コミットを推定する
//
// 方針: 「そのブランチが作られた地点 〜 最後のコミット」を取得するため、
//        “作成地点” を基準にする（最後のマージ地点ではない）。
//  1. reflog の作成地点を最優先で採用（ローカルで作成したブランチに最も正確）
//  2. reflog が無ければ、作成元となる親ブランチ(develop/main/master)との
//     merge-base を採用。マージ先となる test/staging/release は基準に使わない
//     （ブランチを test 等へマージしても基準が先端へ寄らないようにするため）
//  3. 既に親へマージ済みなら、親側のマージコミットから元の分岐地点を復元
//  4. 最終手段としてルートコミット
// ─────────────────────────────────────────────
async function findBranchBase(branchName: string, cwd: string): Promise<string> {
    const branchTip = (await execGit(['rev-parse', branchName], cwd)).trim();
    const allBranchesRaw = await execGit(['branch', '--format=%(refname:short)'], cwd);
    const allBranches = allBranchesRaw.trim().split('\n').map(b => b.trim()).filter(b => b.length > 0);
    const isMainline = PARENT_PRIMARY.includes(branchName);
    // (0) 統合先ブランチのマージ履歴から分岐点を復元（取り込み済みブランチに有効）
    const mergedBase = await getBaseFromIntegrationMerges(branchName, cwd);
    if (mergedBase && mergedBase !== branchTip) {
        return mergedBase;
    }
    // (1) reflog の作成地点（最優先）
    const reflogBase = await getReflogCreationBase(branchName, branchTip, cwd);
    if (reflogBase) {
        return reflogBase;
    }
    // (2) 作成元となる親ブランチとの merge-base（マージ先 test/staging/release は除外）
    let parents = PARENT_PRIMARY.filter(b => allBranches.includes(b) && b !== branchName);
    if (parents.length === 0) {
        parents = PARENT_FALLBACK.filter(b => allBranches.includes(b) && b !== branchName);
    }
    const head = await tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (parents.length === 0 && head && head !== 'HEAD' && head !== branchName) {
        parents = [head];
    }
    const bases: string[] = [];
    for (const p of parents) {
        const mb = await tryGit(['merge-base', p, branchName], cwd);
        if (mb && mb !== branchTip) {
            bases.push(mb);
        }
        else if (mb === branchTip) {
            const rec = await recoverForkFromMerge(p, branchTip, cwd);
            if (rec) {
                bases.push(rec);
            }
        }
    }
    if (bases.length > 0) {
        // 作成地点 = 親との分岐のうち最も古いもの（作成時からの全コミットを確実に含める）
        let base = bases[0];
        for (const b of bases.slice(1)) {
            if (await isAncestor(b, base, cwd)) {
                base = b;
            }
        }
        return base;
    }
    // (3) 最終手段
    if (isMainline) {
        const root = await tryGit(['rev-list', '--max-parents=0', branchName], cwd);
        if (root) {
            return root.split('\n')[0];
        }
    }
    for (const p of parents) {
        const mb = await tryGit(['merge-base', p, branchName], cwd);
        if (mb) {
            return mb;
        }
    }
    const rootCommit = await tryGit(['rev-list', '--max-parents=0', branchName], cwd);
    if (rootCommit) {
        return rootCommit.split('\n')[0];
    }
    throw new Error(`ブランチ "${branchName}" の分岐元を特定できませんでした。`);
}
// ─────────────────────────────────────────────
// 日時フォルダ名を生成 (重複時は通し番号付与)
// ─────────────────────────────────────────────
function generateDateFolderPath(parentDir: string): string {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const baseName = `${yyyy}${mm}${dd} ${hh}-${min}`;
    let candidate = path.join(parentDir, baseName);
    if (!fs.existsSync(candidate)) {
        return candidate;
    }
    // 重複がある場合は (2), (3), ... と通し番号を付与
    let counter = 2;
    while (true) {
        candidate = path.join(parentDir, `${baseName}(${counter})`);
        if (!fs.existsSync(candidate)) {
            return candidate;
        }
        counter++;
    }
}
// ─────────────────────────────────────────────
// デフォルト出力先を決定する
// 優先順位: 前回の出力先 > 設定値 > デスクトップ
// ─────────────────────────────────────────────
function getDefaultOutputUri(context: vscode.ExtensionContext): vscode.Uri | undefined {
    const config = vscode.workspace.getConfiguration('gitBranchDiffExtractor');
    const rememberLast = config.get('rememberLastOutputDir', true);
    // ① 前回の出力先を記憶している場合
    if (rememberLast) {
        const lastDir = context.globalState.get<string>('lastOutputDir');
        if (lastDir && fs.existsSync(lastDir)) {
            return vscode.Uri.file(lastDir);
        }
    }
    // ② 設定でデフォルト出力先が指定されている場合
    const configDir = config.get('defaultOutputDir', '');
    if (configDir && fs.existsSync(configDir)) {
        return vscode.Uri.file(configDir);
    }
    // ③ デスクトップをデフォルトにする
    const homeDir = process.env.USERPROFILE || process.env.HOME || '';
    const desktop = path.join(homeDir, 'Desktop');
    if (fs.existsSync(desktop)) {
        return vscode.Uri.file(desktop);
    }
    return undefined;
}
// ─────────────────────────────────────────────
// 差分ファイルを抽出してコピー
// ─────────────────────────────────────────────
async function extractBranchDiff(branchItem: BranchItem, context: vscode.ExtensionContext) {
    const root = getWorkspaceRoot();
    if (!root) {
        vscode.window.showErrorMessage('ワークスペースが開かれていません。');
        return;
    }
    const branchName = branchItem.branchName;
    // クリック時はダイアログを出さず、既定の出力先へ自動出力する
    const defaultUri = getDefaultOutputUri(context);
    if (!defaultUri) {
        vscode.window.showErrorMessage('出力先フォルダを決定できませんでした。設定を確認してください。');
        return;
    }
    const parentDir = defaultUri.fsPath;
    // 選択したフォルダを記憶
    const config = vscode.workspace.getConfiguration('gitBranchDiffExtractor');
    if (config.get('rememberLastOutputDir', true)) {
        context.globalState.update('lastOutputDir', parentDir);
    }
    // 日時フォルダ名を生成 (YYYYMMDD HH:MM)
    const outputDir = generateDateFolderPath(parentDir);
    // フォルダを作成
    fs.mkdirSync(outputDir, { recursive: true });
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `"${branchName}" の差分を抽出中...`,
        cancellable: true
    }, async (progress, token) => {
        try {
            // 1. 分岐元を特定
            progress.report({ message: '分岐元を特定中...' });
            let baseCommit: string;
            const defaultBranches = ['main', 'master', 'develop'];
            if (defaultBranches.includes(branchName)) {
                const currentBranch = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], root)).trim();
                if (!currentBranch || currentBranch === branchName) {
                    vscode.window.showInformationMessage(`"${branchName}" は現在チェックアウト中のため、抽出対象の差分がありません。`);
                    return;
                }
                baseCommit = (await execGit(['merge-base', currentBranch, branchName], root)).trim();
            }
            else {
                baseCommit = await findBranchBase(branchName, root);
            }
            if (token.isCancellationRequested) {
                return;
            }
            // 2. 作成地点〜先端の「そのブランチでコミットした」ファイルを集約
            //    （first-parent / マージ除外 で、ブランチ自身のコミット分のみを対象）
            progress.report({ message: 'コミット変更ファイル一覧を取得中...' });
            const logOutput = (await execGit([
                'log', '--first-parent', '--no-merges',
                '--format=', '--name-only',
                `${baseCommit}..${branchName}`
            ], root)).trim();
            const uniquePaths = Array.from(new Set(logOutput
                .split('\n')
                .map(l => l.trim())
                .filter(l => l.length > 0)));
            const filesToExtract: string[] = [];
            for (const filePath of uniquePaths) {
                // 先端に存在するファイルのみ抽出（削除済みは除外）
                const exists = (await tryGit(['cat-file', '-e', `${branchName}:${filePath}`], root)) !== null;
                if (exists) {
                    filesToExtract.push(filePath);
                }
            }
            if (filesToExtract.length === 0) {
                vscode.window.showInformationMessage(`"${branchName}" の抽出対象ファイルはありません。`);
                return;
            }
            if (token.isCancellationRequested) {
                return;
            }
            // 3. ファイルを抽出
            const total = filesToExtract.length;
            let copied = 0;
            let errors: string[] = [];
            for (const filePath of filesToExtract) {
                if (token.isCancellationRequested) {
                    vscode.window.showWarningMessage('抽出がキャンセルされました。');
                    return;
                }
                progress.report({
                    message: `(${copied + 1}/${total}) ${filePath}`,
                    increment: (1 / total) * 100
                });
                const destPath = path.join(outputDir, filePath);
                const destDir = path.dirname(destPath);
                try {
                    fs.mkdirSync(destDir, { recursive: true });
                    // git cat-file --filters で改行コード等を保持して取得
                    const fileContent = await execGitBuffer(['cat-file', '--filters', `${branchName}:${filePath}`], root);
                    fs.writeFileSync(destPath, fileContent);
                    copied++;
                }
                catch (err: any) {
                    errors.push(`${filePath}: ${err.message}`);
                }
            }
            // 4. 結果表示
            if (errors.length > 0) {
                vscode.window.showWarningMessage(`${copied}/${total} ファイルを抽出しました（${errors.length} 件エラー）`, '詳細を見る', 'フォルダを開く').then(async (selection) => {
                    if (selection === '詳細を見る') {
                        const channel = vscode.window.createOutputChannel('Branch Diff Extractor');
                        channel.appendLine(`=== エラー詳細 (${branchName}) ===`);
                        errors.forEach(e => channel.appendLine(e));
                        channel.show();
                    }
                    if (selection === 'フォルダを開く') {
                        const uri = vscode.Uri.file(outputDir);
                        await vscode.commands.executeCommand('revealFileInOS', uri);
                    }
                });
            }
            else {
                vscode.window.showInformationMessage(`"${branchName}" のコミット差分ファイル ${copied} 件を抽出しました。`, 'フォルダを開く').then(async (selection) => {
                    if (selection === 'フォルダを開く') {
                        const uri = vscode.Uri.file(outputDir);
                        await vscode.commands.executeCommand('revealFileInOS', uri);
                    }
                });
            }
        }
        catch (err: any) {
            vscode.window.showErrorMessage(`差分の抽出に失敗しました: ${err.message}`);
        }
    });
}
// ─────────────────────────────────────────────
// 共通: 差分を抽出して出力する (baseCommit..targetRef)
// ─────────────────────────────────────────────
async function extractDiffToFolder(baseCommit: string, targetRef: string, label: string, root: string, outputDir: string) {
    const diffOutput = (await execGit([
        'diff', '--name-status', '--no-renames',
        baseCommit, targetRef
    ], root)).trim();
    if (!diffOutput) {
        return { copied: 0, total: 0, deleted: 0, errors: [] as string[] };
    }
    const fileStatus = new Map<string, string>();
    for (const line of diffOutput.split('\n')) {
        if (!line) {
            continue;
        }
        const [st, ...fp] = line.split('\t');
        const fpath = fp.join('\t');
        if (st && fpath) {
            fileStatus.set(fpath, st.charAt(0));
        }
    }
    const filesToExtract: string[] = [];
    const deletedFiles: string[] = [];
    for (const [fp, st] of fileStatus) {
        if (st === 'D') {
            deletedFiles.push(fp);
        }
        else {
            filesToExtract.push(fp);
        }
    }
    let copied = 0;
    const errors: string[] = [];
    for (const filePath of filesToExtract) {
        const destPath = path.join(outputDir, filePath);
        const destDir = path.dirname(destPath);
        try {
            fs.mkdirSync(destDir, { recursive: true });
            const fileContent = await execGitBuffer(['cat-file', '--filters', `${targetRef}:${filePath}`], root);
            fs.writeFileSync(destPath, fileContent);
            copied++;
        }
        catch (err: any) {
            errors.push(`${filePath}: ${err.message}`);
        }
    }
    return { copied, total: filesToExtract.length, deleted: 0, errors };
}
interface CommitInfo {
    hash: string;
    shortHash: string;
    message: string;
    date: string;
    parents: string[];
    isMerge: boolean;
    refs: string[];
}
async function getCommitGraph(branchName: string, cwd: string): Promise<CommitInfo[]> {
    const logRaw = (await execGit([
        'log',
        '--format=%H\t%P\t%s\t%ai\t%D',
        '--max-count=300',
        branchName
    ], cwd)).trim();
    if (!logRaw) {
        return [];
    }
    return logRaw.split('\n').map(line => {
        const [hash, parentsStr, message, date, refsStr] = line.split('\t');
        const parents = parentsStr ? parentsStr.split(' ').filter(p => p) : [];
        const refs = refsStr ? refsStr.split(',').map(r => r.trim()).filter(r => r) : [];
        return {
            hash,
            shortHash: hash.substring(0, 7),
            message,
            date,
            parents,
            isMerge: parents.length > 1,
            refs
        };
    });
}
function buildCommitGraphHtml(commits: CommitInfo[], branchName: string): string {
    const commitsJson = JSON.stringify(commits);
    return /*html*/ `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #d4d4d4);
    padding: 0;
    overflow-x: hidden;
}
.header {
    position: sticky;
    top: 0;
    z-index: 100;
    background: var(--vscode-editor-background, #1e1e1e);
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    padding: 12px 16px;
}
.header h2 {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 6px;
    color: var(--vscode-foreground, #ccc);
}
.selection-info {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    min-height: 28px;
}
.selection-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
}
.badge-from {
    background: #264f78;
    color: #7cb7ff;
}
.badge-to {
    background: #3d5a1f;
    color: #89d185;
}
.badge-arrow {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 14px;
}
.hint {
    color: var(--vscode-descriptionForeground, #888);
    font-size: 11px;
}
.extract-btn {
    margin-left: auto;
    padding: 4px 14px;
    background: var(--vscode-button-background, #0078d4);
    color: var(--vscode-button-foreground, #fff);
    border: none;
    border-radius: 3px;
    font-size: 12px;
    cursor: pointer;
    display: none;
}
.extract-btn:hover {
    background: var(--vscode-button-hoverBackground, #026ec1);
}
.extract-btn.visible { display: inline-block; }

.graph-container {
    padding: 4px 0;
}
.commit-row {
    display: flex;
    align-items: center;
    padding: 3px 16px;
    cursor: pointer;
    min-height: 30px;
    transition: background 0.1s;
    position: relative;
}
.commit-row:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
}
.commit-row.selected-from {
    background: #264f7844;
}
.commit-row.selected-to {
    background: #3d5a1f44;
}
.commit-row.in-range {
    background: #ffffff08;
}
.commit-row.in-range::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: #0078d4;
}

/* Graph column */
.graph-col {
    width: 36px;
    min-width: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
}
.graph-col svg {
    display: block;
}

/* Info columns */
.hash-col {
    width: 64px;
    min-width: 64px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: #e8ab53;
    margin-right: 8px;
}
.message-col {
    flex: 1;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.ref-tag {
    display: inline-block;
    font-size: 10px;
    padding: 0px 5px;
    border-radius: 3px;
    margin-right: 4px;
    font-weight: 600;
}
.ref-branch {
    background: #3fb9504d;
    color: #3fb950;
    border: 1px solid #3fb95066;
}
.ref-head {
    background: #f0883e4d;
    color: #f0883e;
    border: 1px solid #f0883e66;
}
.merge-label {
    color: var(--vscode-descriptionForeground, #888);
    font-style: italic;
}
.date-col {
    width: 130px;
    min-width: 130px;
    text-align: right;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
    margin-left: 8px;
}

/* Selection markers */
.select-marker {
    position: absolute;
    right: 8px;
    font-size: 10px;
    font-weight: bold;
    padding: 1px 6px;
    border-radius: 3px;
}
.marker-from {
    background: #264f78;
    color: #7cb7ff;
}
.marker-to {
    background: #3d5a1f;
    color: #89d185;
}
</style>
</head>
<body>
<div class="header">
    <h2>コミット範囲を選択 — <span id="branchLabel"></span></h2>
    <div class="selection-info">
        <span class="hint" id="hintText">開始コミット（古い方）をクリックしてください</span>
        <span class="selection-badge badge-from" id="fromBadge" style="display:none">FROM: <span id="fromHash"></span></span>
        <span class="badge-arrow" id="arrow" style="display:none">→</span>
        <span class="selection-badge badge-to" id="toBadge" style="display:none">TO: <span id="toHash"></span></span>
        <button class="extract-btn" id="extractBtn">差分を抽出</button>
    </div>
</div>

<div class="graph-container" id="graphContainer"></div>

<script>
const vscode = acquireVsCodeApi();
const commits = ${commitsJson};
const branchName = ${JSON.stringify(branchName)};
let fromIdx = -1;
let toIdx = -1;

document.getElementById('branchLabel').textContent = branchName;

const container = document.getElementById('graphContainer');

function formatDate(dateStr) {
    const d = new Date(dateStr);
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    const h = String(d.getHours()).padStart(2,'0');
    const min = String(d.getMinutes()).padStart(2,'0');
    return y+'/'+m+'/'+day+' '+h+':'+min;
}

function renderGraph() {
    container.innerHTML = '';
    commits.forEach((c, idx) => {
        const row = document.createElement('div');
        row.className = 'commit-row';
        row.dataset.idx = idx;

        // Graph node SVG
        const graphCol = document.createElement('div');
        graphCol.className = 'graph-col';
        const circleColor = c.isMerge ? '#da70d6' : '#0078d4';
        const nodeSize = c.isMerge ? 7 : 5;
        graphCol.innerHTML =
            '<svg width="36" height="30">' +
            (idx > 0 ? '<line x1="18" y1="0" x2="18" y2="' + (15-nodeSize) + '" stroke="#555" stroke-width="2"/>' : '') +
            (idx < commits.length-1 ? '<line x1="18" y1="' + (15+nodeSize) + '" x2="18" y2="30" stroke="#555" stroke-width="2"/>' : '') +
            '<circle cx="18" cy="15" r="' + nodeSize + '" fill="' + circleColor + '" stroke="' + circleColor + '" stroke-width="1.5"/>' +
            '</svg>';

        // Hash
        const hashCol = document.createElement('div');
        hashCol.className = 'hash-col';
        hashCol.textContent = c.shortHash;

        // Message + refs
        const msgCol = document.createElement('div');
        msgCol.className = 'message-col';

        let refHtml = '';
        for (const r of c.refs) {
            if (r.startsWith('HEAD')) {
                refHtml += '<span class="ref-tag ref-head">' + escHtml(r) + '</span>';
            } else {
                refHtml += '<span class="ref-tag ref-branch">' + escHtml(r) + '</span>';
            }
        }

        const msgText = c.isMerge && c.message.startsWith('Merge ')
            ? '<span class="merge-label">' + escHtml(c.message) + '</span>'
            : escHtml(c.message);

        msgCol.innerHTML = refHtml + msgText;

        // Date
        const dateCol = document.createElement('div');
        dateCol.className = 'date-col';
        dateCol.textContent = formatDate(c.date);

        row.appendChild(graphCol);
        row.appendChild(hashCol);
        row.appendChild(msgCol);
        row.appendChild(dateCol);

        row.addEventListener('click', () => onCommitClick(idx));
        container.appendChild(row);
    });
    updateHighlights();
}

function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function onCommitClick(idx) {
    if (fromIdx === -1) {
        // 最初のクリック → FROM(古い方)
        fromIdx = idx;
        toIdx = -1;
        document.getElementById('hintText').textContent = '終了コミット（新しい方）をクリックしてください';
        document.getElementById('fromBadge').style.display = 'inline-flex';
        document.getElementById('fromHash').textContent = commits[idx].shortHash;
        document.getElementById('toBadge').style.display = 'none';
        document.getElementById('arrow').style.display = 'none';
        document.getElementById('extractBtn').classList.remove('visible');
    } else if (toIdx === -1) {
        // 2番目のクリック → TO(新しい方)
        let fIdx = fromIdx;
        let tIdx = idx;
        // commits[0]が最新なので、idx が小さい方が新しい
        // FROM は古い方(idx大)、TO は新しい方(idx小)
        if (fIdx < tIdx) {
            // fromの方が新しい → 入れ替え
            const tmp = fIdx; fIdx = tIdx; tIdx = tmp;
        }
        if (fIdx === tIdx) {
            // 同じコミットをクリック → リセット
            fromIdx = -1; toIdx = -1;
            document.getElementById('hintText').textContent = '開始コミット（古い方）をクリックしてください';
            document.getElementById('hintText').style.display = '';
            document.getElementById('fromBadge').style.display = 'none';
            document.getElementById('toBadge').style.display = 'none';
            document.getElementById('arrow').style.display = 'none';
            document.getElementById('extractBtn').classList.remove('visible');
            updateHighlights();
            return;
        }
        fromIdx = fIdx;
        toIdx = tIdx;
        document.getElementById('hintText').style.display = 'none';
        document.getElementById('fromBadge').style.display = 'inline-flex';
        document.getElementById('fromHash').textContent = commits[fromIdx].shortHash;
        document.getElementById('arrow').style.display = 'inline';
        document.getElementById('toBadge').style.display = 'inline-flex';
        document.getElementById('toHash').textContent = commits[toIdx].shortHash;
        document.getElementById('extractBtn').classList.add('visible');
    } else {
        // 3回目 → リセットして新しくFROMを選択
        fromIdx = idx;
        toIdx = -1;
        document.getElementById('hintText').textContent = '終了コミット（新しい方）をクリックしてください';
        document.getElementById('hintText').style.display = '';
        document.getElementById('fromBadge').style.display = 'inline-flex';
        document.getElementById('fromHash').textContent = commits[idx].shortHash;
        document.getElementById('toBadge').style.display = 'none';
        document.getElementById('arrow').style.display = 'none';
        document.getElementById('extractBtn').classList.remove('visible');
    }
    updateHighlights();
}

function updateHighlights() {
    const rows = container.querySelectorAll('.commit-row');
    rows.forEach((row, idx) => {
        row.classList.remove('selected-from', 'selected-to', 'in-range');
        if (idx === fromIdx) { row.classList.add('selected-from'); }
        if (idx === toIdx) { row.classList.add('selected-to'); }
        if (fromIdx !== -1 && toIdx !== -1 && idx > toIdx && idx < fromIdx) {
            row.classList.add('in-range');
        }
    });
}

document.getElementById('extractBtn').addEventListener('click', () => {
    if (fromIdx !== -1 && toIdx !== -1) {
        vscode.postMessage({
            type: 'extract',
            fromHash: commits[fromIdx].hash,
            toHash: commits[toIdx].hash,
            fromShort: commits[fromIdx].shortHash,
            toShort: commits[toIdx].shortHash
        });
    }
});

renderGraph();
</script>
</body>
</html>`;
}
async function extractByCommitRange(branchItem: BranchItem, context: vscode.ExtensionContext) {
    const root = getWorkspaceRoot();
    if (!root) {
        vscode.window.showErrorMessage('ワークスペースが開かれていません。');
        return;
    }
    const branchName = branchItem.branchName;
    // コミット履歴を取得
    const commits = await getCommitGraph(branchName, root);
    if (commits.length === 0) {
        vscode.window.showInformationMessage('コミット履歴がありません。');
        return;
    }
    // WebView パネルを作成
    const panel = vscode.window.createWebviewPanel('commitGraph', `コミット範囲選択: ${branchName}`, vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = buildCommitGraphHtml(commits, branchName);
    // WebView からのメッセージを受信
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'extract') {
            panel.dispose();
            // 出力先選択
            const defaultUri = getDefaultOutputUri(context);
            const outputUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: '出力先フォルダを選択',
                title: `コミット範囲の差分ファイル出力先`,
                defaultUri: defaultUri
            });
            if (!outputUri || outputUri.length === 0) {
                return;
            }
            const parentDir = outputUri[0].fsPath;
            const config = vscode.workspace.getConfiguration('gitBranchDiffExtractor');
            if (config.get('rememberLastOutputDir', true)) {
                context.globalState.update('lastOutputDir', parentDir);
            }
            const outputDir = generateDateFolderPath(parentDir);
            fs.mkdirSync(outputDir, { recursive: true });
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `${msg.fromShort}..${msg.toShort} の差分を抽出中...`,
                cancellable: false
            }, async (progress) => {
                try {
                    progress.report({ message: '差分ファイルを抽出中...' });
                    const result = await extractDiffToFolder(msg.fromHash, msg.toHash, `${msg.fromShort}..${msg.toShort}`, root, outputDir);
                    if (result.total === 0 && result.deleted === 0) {
                        vscode.window.showInformationMessage('この範囲には差分ファイルがありません。');
                        return;
                    }
                    const delMsg = result.deleted > 0
                        ? `（削除 ${result.deleted} 件は _DELETED_FILES.txt に記録）`
                        : '';
                    if (result.errors.length > 0) {
                        vscode.window.showWarningMessage(`${result.copied}/${result.total} ファイルを抽出しました（${result.errors.length} 件エラー）${delMsg}`, '詳細を見る', 'フォルダを開く').then(async (selection) => {
                            if (selection === '詳細を見る') {
                                const channel = vscode.window.createOutputChannel('Branch Diff Extractor');
                                channel.appendLine(`=== エラー詳細 (${msg.fromShort}..${msg.toShort}) ===`);
                                result.errors.forEach((e: string) => channel.appendLine(e));
                                channel.show();
                            }
                            if (selection === 'フォルダを開く') {
                                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
                            }
                        });
                    }
                    else {
                        vscode.window.showInformationMessage(`${msg.fromShort}..${msg.toShort} の差分ファイル ${result.copied} 件を抽出しました。${delMsg}`, 'フォルダを開く').then(async (selection) => {
                            if (selection === 'フォルダを開く') {
                                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputDir));
                            }
                        });
                    }
                }
                catch (err: any) {
                    vscode.window.showErrorMessage(`差分の抽出に失敗しました: ${err.message}`);
                }
            });
        }
    });
}
// ─────────────────────────────────────────────
// Extension activation
// ─────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
    const treeProvider = new BranchTreeProvider();
    const treeView = vscode.window.createTreeView('branchList', {
        treeDataProvider: treeProvider,
        showCollapseAll: false
    });
    // コマンド: ブランチ一覧更新
    const refreshCmd = vscode.commands.registerCommand('gitBranchDiffExtractor.refresh', () => treeProvider.refresh());
    // コマンド: 差分抽出
    const extractCmd = vscode.commands.registerCommand('gitBranchDiffExtractor.extractDiff', (item: BranchItem) => extractBranchDiff(item, context));
    // コマンド: コミット範囲を指定して抽出
    const extractRangeCmd = vscode.commands.registerCommand('gitBranchDiffExtractor.extractByCommitRange', (item: BranchItem) => extractByCommitRange(item, context));
    // Git操作を監視して自動更新
    const fsWatcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
    fsWatcher.onDidChange(() => treeProvider.refresh());
    // ワークスペース変更時にも更新
    const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => treeProvider.refresh());
    context.subscriptions.push(treeView, refreshCmd, extractCmd, extractRangeCmd, fsWatcher, workspaceListener);
}
export function deactivate() {
    // cleanup
}
