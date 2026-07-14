const vscode = require('vscode');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOOKS_DIR = path.join(os.homedir(), '.claude', 'hooks');
const TTS_INPUT_FILE = path.join(HOOKS_DIR, 'tts_input.json');
const STATE_FILE = path.join(HOOKS_DIR, 'voice_state.json');
const CONFIG_FILE = path.join(HOOKS_DIR, 'voice_config.json');
const RELAY_SCRIPT_FILE = path.join(HOOKS_DIR, 'voicevox_tts_relay.py');
const RELAY_TOKEN_FILE = path.join(HOOKS_DIR, 'voicevox_relay_token');
const BUNDLED_RELAY_SCRIPT = path.join(__dirname, 'voicevox_tts_relay.py');
const VOICEVOX_HOST = '127.0.0.1';
const VOICEVOX_PORT = 50021;
const RELAY_PORT = 50022;
const MAX_RELAY_BODY_BYTES = 64 * 1024;
const MAX_SPEAK_TEXT_LENGTH = 10_000;

let config = null;
let lastMsgHash = '';
let watcher = null;
let lastTabSwitch = 0;
let lastFocus = 0;
let greetingDone = false;

function ensureRelayAssets() {
    if (!fs.existsSync(BUNDLED_RELAY_SCRIPT)) {
        throw new Error(`Bundled relay script is missing: ${BUNDLED_RELAY_SCRIPT}`);
    }
    const bundled = fs.readFileSync(BUNDLED_RELAY_SCRIPT);
    if (!fs.existsSync(RELAY_SCRIPT_FILE) || !fs.readFileSync(RELAY_SCRIPT_FILE).equals(bundled)) {
        fs.writeFileSync(RELAY_SCRIPT_FILE, bundled, { mode: 0o700 });
    }
    if (!fs.existsSync(RELAY_TOKEN_FILE)) {
        fs.writeFileSync(RELAY_TOKEN_FILE, crypto.randomBytes(32).toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    }
    const token = fs.readFileSync(RELAY_TOKEN_FILE, 'utf-8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) {
        throw new Error(`Invalid relay token file: ${RELAY_TOKEN_FILE}`);
    }
    return token;
}

function isAuthorizedRelayRequest(req, relayToken) {
    const supplied = req.headers['x-voicevox-relay-token'];
    if (typeof supplied !== 'string') return false;
    const expectedBuffer = Buffer.from(relayToken);
    const suppliedBuffer = Buffer.from(supplied);
    return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function isSafeContainerHome(value) {
    return /^\/(?:[A-Za-z0-9._-]+\/?)*$/.test(value) && !value.split('/').includes('..');
}

// --- Config ---
function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch (e) {
        return null;
    }
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

// --- Setup Wizard ---
async function runSetupWizard() {
    const welcome = await vscode.window.showInformationMessage(
        'VOICEVOX TTS: Initial setup required. Start setup wizard?',
        'Start', 'Skip'
    );
    if (welcome !== 'Start') return null;

    // Check VOICEVOX
    const running = await checkVoicevox();
    if (!running) {
        vscode.window.showErrorMessage('VOICEVOX is not running. Please start VOICEVOX first and reload the window.');
        return null;
    }

    // Ask name
    const name = await vscode.window.showInputBox({
        prompt: 'How should the voice call you? (e.g., yamadakun, john, etc.)',
        placeHolder: 'yamadakun',
        value: ''
    });
    if (!name) return null;

    // Ask notification speaker
    const notifSpeaker = await vscode.window.showQuickPick([
        { label: 'Zundamon (Normal)', id: 3 },
        { label: 'Zundamon (Amama)', id: 1 },
        { label: 'Shikoku Metan (Normal)', id: 2 },
        { label: 'Tsumugi', id: 8 },
        { label: 'Amehare Hau', id: 10 },
    ], { placeHolder: 'Pick notification voice (short phrases)' });
    if (!notifSpeaker) return null;

    // Ask main speaker
    const mainSpeaker = await vscode.window.showQuickPick([
        { label: 'Tsumugi', id: 8 },
        { label: 'Shikoku Metan (Normal)', id: 2 },
        { label: 'Shikoku Metan (Amama)', id: 0 },
        { label: 'Zundamon (Normal)', id: 3 },
        { label: 'Kuushu Sora', id: 16 },
    ], { placeHolder: 'Pick main reading voice (reads responses)' });
    if (!mainSpeaker) return null;

    // Ask speed
    const speed = await vscode.window.showQuickPick([
        { label: '1.0x (slow)', value: 1.0 },
        { label: '1.2x (normal)', value: 1.2 },
        { label: '1.5x (fast)', value: 1.5 },
        { label: '1.8x (very fast)', value: 1.8 },
    ], { placeHolder: 'Pick voice speed' });
    if (!speed) return null;

    const cfg = {
        userName: name,
        notifSpeakerId: notifSpeaker.id,
        mainSpeakerId: mainSpeaker.id,
        notifSpeed: Math.min(speed.value + 0.3, 2.0),
        mainSpeed: speed.value,
        setupComplete: true
    };

    // Generate WAV files
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'VOICEVOX TTS: Generating voice files...',
        cancellable: false
    }, async (progress) => {
        const phrases = buildPhrases(cfg);
        const total = Object.keys(phrases).length;
        let count = 0;
        for (const [filename, { speaker, speed: spd, text }] of Object.entries(phrases)) {
            count++;
            progress.report({ message: `${count}/${total} ${filename}`, increment: (1/total)*100 });
            try {
                await generateWav(speaker, spd, text, path.join(HOOKS_DIR, filename));
            } catch (e) {
                console.error(`Failed to generate ${filename}:`, e.message);
            }
        }
    });

    saveConfig(cfg);
    vscode.window.showInformationMessage(`VOICEVOX TTS: Setup complete! Hello, ${name}!`);
    return cfg;
}

function buildPhrases(cfg) {
    const n = cfg.userName;
    const ns = cfg.notifSpeakerId;
    const ms = cfg.mainSpeakerId;
    const nspd = cfg.notifSpeed;
    const mspd = cfg.mainSpeed;

    return {
        // VSCode events
        'vsc_saved.wav': { speaker: ns, speed: nspd, text: 'save!' },
        'vsc_tab.wav': { speaker: ns, speed: nspd, text: 'kirikae!' },
        'vsc_file_create.wav': { speaker: ns, speed: nspd, text: 'atarashii fairu!' },
        'vsc_file_delete.wav': { speaker: ns, speed: nspd, text: 'sakujo!' },
        'vsc_file_rename.wav': { speaker: ns, speed: nspd, text: 'namae kaeta!' },
        'vsc_terminal_open.wav': { speaker: ns, speed: nspd, text: 'taaminaru hiraita!' },
        'vsc_terminal_close.wav': { speaker: ns, speed: nspd, text: 'tojita!' },
        'vsc_debug_start.wav': { speaker: ns, speed: nspd, text: 'debaggu kaishi!' },
        'vsc_debug_end.wav': { speaker: ns, speed: nspd, text: 'debaggu shuuryou!' },
        'vsc_focus.wav': { speaker: ns, speed: nspd, text: 'okaeri!' },
        'vsc_task_start.wav': { speaker: ns, speed: nspd, text: 'tasuku kaishi!' },
        'vsc_task_end.wav': { speaker: ns, speed: nspd, text: 'tasuku owatta!' },
        'kangaechuu.wav': { speaker: ns, speed: nspd, text: 'kangaechuu' },
        'break_1.wav': { speaker: ns, speed: nspd, text: 'kyuukei shiyou!' },
        'break_2.wav': { speaker: ms, speed: mspd, text: `${n}, sukoshi yasumou.` },
        'break_3.wav': { speaker: ns, speed: nspd, text: 'me to karada wo yasumete ne.' },
        'latenight_1.wav': { speaker: ms, speed: mspd, text: `${n}, mou osoku dayo.` },
        'latenight_2.wav': { speaker: ns, speed: nspd, text: 'muri shinai de ne.' },
        'latenight_3.wav': { speaker: ms, speed: mspd, text: 'soro soro yasumou.' },

        // Git
        'git_commit.wav': { speaker: ns, speed: nspd, text: 'komitto shitayo!' },
        'git_push.wav': { speaker: ns, speed: nspd, text: 'pusshu kanryou!' },
        'git_pull.wav': { speaker: ns, speed: nspd, text: 'puru shitayo!' },
        'git_merge.wav': { speaker: ns, speed: nspd, text: 'maaji shitayo!' },
        'git_conflict.wav': { speaker: ns, speed: nspd, text: 'konfurikuto dayo! ki wo tsukete!' },
        'git_stash.wav': { speaker: ns, speed: nspd, text: 'taihi shitayo!' },
        'git_branch.wav': { speaker: ns, speed: nspd, text: 'buranchi kirikae!' },

        // Time greetings (with user name)
        'time_morning1.wav': { speaker: ms, speed: mspd, text: `ohayou, ${n}! kyou mo yattekou!` },
        'time_morning2.wav': { speaker: ns, speed: nspd, text: `ohayou! kyou mo yoroshikune!` },
        'time_afternoon1.wav': { speaker: ms, speed: mspd, text: `gogo mo ganbarou, ${n}!` },
        'time_afternoon2.wav': { speaker: ns, speed: nspd, text: `gogo mo yoroshiku!` },
        'time_evening1.wav': { speaker: ms, speed: mspd, text: `osoku made yatterune. muri shinaide, ${n}.` },
        'time_evening2.wav': { speaker: ns, speed: nspd, text: `yoru mo ganbatterune!` },
        'time_latenight1.wav': { speaker: ms, speed: mspd, text: `${n}, mou yonaka dayo. karada ni ki wo tsukete.` },
        'time_latenight2.wav': { speaker: ns, speed: nspd, text: `shinya made tsukiau yo. muri shinaide.` },

        // Emotions
        'emo_error1.wav': { speaker: 7, speed: 1.3, text: 'eraa dane. ochitsuite kakunin shiyou.' },
        'emo_error2.wav': { speaker: ns, speed: nspd, text: 'eraa mitsukattayo. daijoubu, naoseru!' },
        'emo_success1.wav': { speaker: ms, speed: mspd, text: `yattane, ${n}! umaku ittayo!` },
        'emo_success2.wav': { speaker: ns, speed: nspd, text: 'dekita! kanpeki jan!' },
        'emo_think1.wav': { speaker: 2, speed: 1.2, text: 'naruhodo ne. chotto kangaete mirune.' },
        'emo_think2.wav': { speaker: ms, speed: mspd, text: 'uun, kangae chuu. chotto matte ne.' },
        'emo_warn1.wav': { speaker: 7, speed: 1.2, text: 'ki wo tsukete! koko abunai kamo.' },
        'emo_warn2.wav': { speaker: 5, speed: 1.2, text: 'chuui ga hitsuyou dayo. kakunin shite.' },

        // Memory
        'mem_streak.wav': { speaker: ms, speed: mspd, text: `${n}, kyou takusan sagyou shiterune! sugoi yo!` },
        'mem_bugfix.wav': { speaker: ms, speed: mspd, text: `sakki no bagu, chanto naottane! yokatta!` },
        'mem_longwork.wav': { speaker: ms, speed: mspd, text: `${n}, nagai sagyou otsukare. hitoiki tsuitemo iiyo.` },
    };
}

async function checkVoicevox() {
    return new Promise(resolve => {
        const req = http.request({ hostname: VOICEVOX_HOST, port: VOICEVOX_PORT, path: '/version', method: 'GET', timeout: 2000 }, () => resolve(true));
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

async function generateWav(speakerId, speed, text, outPath) {
    const query = await httpPost(`/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`, '');
    query.speedScale = speed;
    const audio = await httpPost(`/synthesis?speaker=${speakerId}`, query, true);
    fs.writeFileSync(outPath, audio);
}

// --- State management (conversation memory) ---
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
    catch (e) { return { actionCount: 0, lastDate: '', errors: 0, fixes: 0, sessionStart: Date.now() }; }
}
function saveState(state) {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8'); } catch (e) {}
}

// --- Audio playback ---
function playWav(filename) {
    if (typeof filename !== 'string' || !/^[A-Za-z0-9_.-]+\.wav$/i.test(filename)) return false;
    const hooksRoot = path.resolve(HOOKS_DIR);
    const wavPath = path.resolve(hooksRoot, filename);
    if (!wavPath.startsWith(hooksRoot + path.sep) || !fs.existsSync(wavPath) || !fs.statSync(wavPath).isFile()) return false;
    execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', '(New-Object Media.SoundPlayer $env:VOICEVOX_WAV_PATH).PlaySync()'],
        { windowsHide: true, env: { ...process.env, VOICEVOX_WAV_PATH: wavPath } }
    );
    return true;
}

function randomPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function registerInterval(context, callback, delay) {
    const interval = setInterval(callback, delay);
    context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

function registerTimeout(context, callback, delay) {
    const timeout = setTimeout(callback, delay);
    context.subscriptions.push({ dispose: () => clearTimeout(timeout) });
}

function httpPost(reqPath, body, binary = false) {
    return new Promise((resolve, reject) => {
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        const req = http.request({
            hostname: VOICEVOX_HOST, port: VOICEVOX_PORT, path: reqPath, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (binary) resolve(buf); else resolve(JSON.parse(buf.toString()));
            });
        });
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

function saveBinaryAndPlay(buffer) {
    const tmp = path.join(os.tmpdir(), `voicevox_${Date.now()}.wav`);
    fs.writeFileSync(tmp, buffer);
    execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', '(New-Object Media.SoundPlayer $env:VOICEVOX_WAV_PATH).PlaySync(); Remove-Item -LiteralPath $env:VOICEVOX_WAV_PATH'],
        { windowsHide: true, env: { ...process.env, VOICEVOX_WAV_PATH: tmp } }
    );
}

async function speak(text) {
    if (!text || !config) return;
    try {
        const query = await httpPost(`/audio_query?text=${encodeURIComponent(text)}&speaker=${config.mainSpeakerId}`, '');
        query.speedScale = config.mainSpeed;
        const audio = await httpPost(`/synthesis?speaker=${config.mainSpeakerId}`, query, true);
        saveBinaryAndPlay(audio);
    } catch (e) { console.error('VOICEVOX TTS error:', e.message); }
}

function cleanText(text) {
    return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '').replace(/^#{1,6}\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
        .replace(/https?:\/\/\S+/g, '').replace(/<[^>]+>/g, '').replace(/\n{2,}/g, '\u3002')
        .replace(/\s{2,}/g, ' ').trim();
}

// --- Time-based greeting ---
function getTimeGreeting() {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return randomPick(['time_morning1.wav', 'time_morning2.wav']);
    if (h >= 12 && h < 18) return randomPick(['time_afternoon1.wav', 'time_afternoon2.wav']);
    if (h >= 18) return randomPick(['time_evening1.wav', 'time_evening2.wav']);
    return randomPick(['time_latenight1.wav', 'time_latenight2.wav']);
}

// --- Git detection ---
function setupGitWatcher(context) {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (!gitExt) return;
    const git = gitExt.exports.getAPI(1);
    if (!git || !git.repositories || git.repositories.length === 0) return;
    let lastBranch = {};
    git.repositories.forEach(repo => {
        try { lastBranch[repo.rootUri.path] = repo.state.HEAD?.name || ''; } catch(e) {}
        repo.state.onDidChange(() => {
            try {
                const cur = repo.state.HEAD?.name || '';
                const prev = lastBranch[repo.rootUri.path] || '';
                if (cur && prev && cur !== prev) playWav('git_branch.wav');
                lastBranch[repo.rootUri.path] = cur;
            } catch(e) {}
        });
    });
}

// --- Conversation memory ---
function checkMemoryTriggers(state) {
    const today = new Date().toISOString().slice(0, 10);
    if (state.lastDate !== today) { state.lastDate = today; state.actionCount = 0; state.errors = 0; state.fixes = 0; }
    state.actionCount++;
    if (state.actionCount === 10) playWav('mem_streak.wav');
    if (Date.now() - state.sessionStart > 2*60*60*1000 && state.actionCount % 20 === 0) playWav('mem_longwork.wav');
    saveState(state);
}

function onFileChanged() {
    try {
        const raw = fs.readFileSync(TTS_INPUT_FILE, 'utf-8');
        const data = JSON.parse(raw);
        const msg = data.last_assistant_message || '';
        const ts = data.ts || '';
        const hash = msg + '|' + ts;
        if (msg && hash !== lastMsgHash) { lastMsgHash = hash; const c = cleanText(msg); if (c) speak(c); }
    } catch (e) {}
}

// --- Docker integration ---
async function detectDockerProject() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;
    for (const folder of folders) {
        const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
        for (const cf of composeFiles) {
            const composePath = path.join(folder.uri.fsPath, cf);
            if (fs.existsSync(composePath)) {
                const overridePath = path.join(folder.uri.fsPath, 'docker-compose.override.yml');
                if (!fs.existsSync(overridePath)) {
                    const choice = await vscode.window.showInformationMessage(
                        'VOICEVOX: Docker project detected. Setup container voice integration?',
                        'Setup', 'Later'
                    );
                    if (choice === 'Setup') await setupDockerIntegration();
                }
                return;
            }
        }
    }
}

function execProcess(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve(stdout);
        });
    });
}

async function findContainerName(serviceName) {
    try {
        const out = await execProcess('docker', ['ps', '--format', '{{.Names}}']);
        const names = out.split('\n').map(s => s.trim()).filter(s => s);
        // Match patterns: project_service_1, project-service-1
        const match = names.find(n => n.includes(`_${serviceName}_`) || n.includes(`-${serviceName}-`) || n.endsWith(`_${serviceName}`) || n.endsWith(`-${serviceName}`));
        return match || null;
    } catch (e) {
        return null;
    }
}

async function findContainerHomePath(containerName) {
    try {
        // Get default user's home directory
        const out = await execProcess('docker', ['exec', containerName, 'sh', '-c', 'printf %s "$HOME"']);
        const home = out.trim();
        if (isSafeContainerHome(home)) return home;
    } catch (e) {}
    return '/root';
}

async function findContainerPython(containerName) {
    for (const cmd of ['python3', 'python']) {
        try {
            await execProcess('docker', ['exec', containerName, cmd, '--version']);
            return cmd;
        } catch (e) {}
    }
    return null;
}

async function autoSetupContainer(containerName) {
    const result = { success: false, steps: [] };
    try {
        // 1. Find home dir
        const home = await findContainerHomePath(containerName);
        result.steps.push(`Home: ${home}`);

        // 2. Find python
        const python = await findContainerPython(containerName);
        if (!python) {
            result.steps.push('ERROR: Python not found in container');
            return result;
        }
        result.steps.push(`Python: ${python}`);

        // 3. Create hooks dir
        const containerHooksDir = `${home}/.claude/hooks`;
        await execProcess('docker', ['exec', containerName, 'mkdir', '-p', containerHooksDir]);
        result.steps.push(`Created ${home}/.claude/hooks`);

        // 4. Copy relay assets unless they are already supplied by the read-only host mount.
        const containerRelayPath = `${containerHooksDir}/voicevox_tts_relay.py`;
        const containerTokenPath = `${containerHooksDir}/voicevox_relay_token`;
        try {
            await execProcess('docker', ['exec', containerName, 'test', '-r', containerRelayPath]);
            await execProcess('docker', ['exec', containerName, 'test', '-r', containerTokenPath]);
            result.steps.push('Relay script and authentication token are already mounted');
        } catch (e) {
            await execProcess('docker', ['cp', RELAY_SCRIPT_FILE, `${containerName}:${containerRelayPath}`]);
            await execProcess('docker', ['cp', RELAY_TOKEN_FILE, `${containerName}:${containerTokenPath}`]);
            result.steps.push('Copied relay script and authentication token');
        }

        // 5. Fix ownership (in case docker cp made it root-owned)
        try {
            const userInfo = await execProcess('docker', ['exec', containerName, 'sh', '-c', 'id -u; id -g']);
            const [uid, gid] = userInfo.trim().split('\n');
            if (/^\d+$/.test(uid) && /^\d+$/.test(gid)) {
                await execProcess('docker', ['exec', '-u', '0', containerName, 'chown', '-R', `${uid}:${gid}`, containerHooksDir]);
                result.steps.push(`Fixed ownership to ${uid}:${gid}`);
            }
        } catch (e) {}

        // 6. Add Stop hook to settings.json (merge, don't replace)
        const mergeScript = `
import json, os, sys
p = os.path.expanduser('~/.claude/settings.json')
try:
    s = json.load(open(p)) if os.path.exists(p) else {}
except:
    s = {}
s.setdefault('hooks', {})
stop_hooks = s['hooks'].setdefault('Stop', [])
if not isinstance(stop_hooks, list):
    stop_hooks = [stop_hooks]
relay_command = ${JSON.stringify(python)} + ' ' + os.path.expanduser('~/.claude/hooks/voicevox_tts_relay.py')
filtered_hooks = []
for entry in stop_hooks:
    if not isinstance(entry, dict):
        filtered_hooks.append(entry)
        continue
    has_relay = any(
        hook.get('command') == relay_command
        for hook in entry.get('hooks', []) if isinstance(hook, dict)
    )
    if not has_relay:
        filtered_hooks.append(entry)
stop_hooks = filtered_hooks
stop_hooks.append({
    'matcher': '',
    'hooks': [{
        'type': 'command',
        'command': relay_command,
        'timeout': 10,
        'async': True
    }]
})
s['hooks']['Stop'] = stop_hooks
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(s, open(p, 'w'), indent=2, ensure_ascii=False)
print('OK')
`;
        // Pass the setup script as base64 without invoking a host shell.
        const scriptB64 = Buffer.from(mergeScript).toString('base64');
        const executeSetup = 'import base64,sys;exec(compile(base64.b64decode(sys.argv[1]), "voicevox_setup.py", "exec"))';
        await execProcess('docker', ['exec', containerName, python, '-c', executeSetup, scriptB64]);
        result.steps.push('Added Stop hook to settings.json');

        // 7. Test relay
        try {
            const testCode = "import pathlib,urllib.request,json; token=(pathlib.Path.home()/'.claude/hooks/voicevox_relay_token').read_text().strip(); urllib.request.urlopen(urllib.request.Request('http://host.docker.internal:50022/speak', data=json.dumps({'text':'docker setup complete'}).encode(), headers={'Content-Type':'application/json','X-VOICEVOX-Relay-Token':token}, method='POST'), timeout=5).read()";
            await execProcess('docker', ['exec', containerName, python, '-c', testCode]);
            result.steps.push('Test relay OK - voice should play now!');
        } catch (e) {
            result.steps.push(`Test relay failed: ${e.message}`);
        }

        result.success = true;
    } catch (e) {
        result.steps.push(`ERROR: ${e.message}`);
    }
    return result;
}

async function setupDockerIntegration() {
    vscode.window.showInformationMessage('VOICEVOX: Docker setup starting...');

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showWarningMessage('VOICEVOX: No workspace folder open.');
        return;
    }
    vscode.window.showInformationMessage(`VOICEVOX: Found ${folders.length} folder(s). Path: ${folders[0].uri.fsPath}`);

    // Find docker-compose file
    let projectRoot = null;
    let composeFile = null;
    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const folder of folders) {
        for (const cf of composeFiles) {
            const cp = path.join(folder.uri.fsPath, cf);
            if (fs.existsSync(cp)) {
                projectRoot = folder.uri.fsPath;
                composeFile = cp;
                break;
            }
        }
        if (composeFile) break;
    }

    if (!composeFile) {
        // Try to let user pick the docker-compose file manually
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Docker Compose': ['yml', 'yaml'] },
            openLabel: 'Select docker-compose file'
        });
        if (!picked || picked.length === 0) {
            vscode.window.showWarningMessage('VOICEVOX: No docker-compose file selected.');
            return;
        }
        composeFile = picked[0].fsPath;
        projectRoot = path.dirname(composeFile);
    }
    vscode.window.showInformationMessage(`VOICEVOX: Using compose: ${composeFile}`);

    // Read compose to find service names
    let services = [];
    try {
        const content = fs.readFileSync(composeFile, 'utf-8');
        const matches = content.match(/^\s{2}([a-zA-Z][a-zA-Z0-9_-]*):\s*$/gm);
        if (matches) {
            services = matches.map(m => m.trim().replace(':', ''));
        }
    } catch (e) {}

    if (services.length === 0) {
        vscode.window.showWarningMessage('VOICEVOX: Could not parse services from docker-compose. Edit override manually.');
    }

    // Ask user which service runs Claude Code
    let serviceName = 'app';
    if (services.length > 0) {
        const picked = await vscode.window.showQuickPick(services, {
            placeHolder: 'Select the service that runs Claude Code'
        });
        if (!picked) return;
        serviceName = picked;
    }

    const containerName = await findContainerName(serviceName);
    let containerHome = '/root';
    if (containerName) {
        containerHome = await findContainerHomePath(containerName);
    } else {
        const enteredHome = await vscode.window.showInputBox({
            prompt: 'Container user home directory used by Claude Code',
            value: '/root',
            validateInput: value => isSafeContainerHome(value) ? null : 'Use an absolute POSIX path containing only letters, numbers, dot, underscore, dash, and slash.'
        });
        if (!enteredHome) return;
        containerHome = enteredHome === '/' ? '/' : enteredHome.replace(/\/$/, '');
    }

    // Generate docker-compose.override.yml
    const overridePath = path.join(projectRoot, 'docker-compose.override.yml');
    const hooksHostPath = HOOKS_DIR.replace(/\\/g, '/').replace(/\$/g, () => '$$');
    const overrideContent = `# Auto-generated by VOICEVOX TTS extension
# Mounts host's ~/.claude/hooks/ into the container so the relay script is available
services:
  ${serviceName}:
    volumes:
      - "${hooksHostPath.replace(/"/g, '\\"')}:${containerHome === '/' ? '' : containerHome}/.claude/hooks:ro"
    environment:
      - VOICEVOX_RELAY_HOST=host.docker.internal:50022
    extra_hosts:
      - "host.docker.internal:host-gateway"
`;

    let writeOverride = true;
    if (fs.existsSync(overridePath)) {
        const overwrite = await vscode.window.showWarningMessage(
            'docker-compose.override.yml already exists. Overwrite?',
            'Overwrite', 'Cancel'
        );
        writeOverride = overwrite === 'Overwrite';
    }

    if (writeOverride) {
        fs.writeFileSync(overridePath, overrideContent, 'utf-8');
    } else {
        vscode.window.showInformationMessage('VOICEVOX: Docker setup canceled; existing override was not changed.');
        return;
    }

    // Try to auto-setup the running container
    let autoSetupResult = null;
    if (containerName) {
        const doAuto = await vscode.window.showInformationMessage(
            `VOICEVOX: Container '${containerName}' is running. Auto-setup now?`,
            'Auto Setup', 'Manual'
        );
        if (doAuto === 'Auto Setup') {
            autoSetupResult = await autoSetupContainer(containerName);
        }
    }

    // Show setup instructions
    const settingsSnippet = `{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/voicevox_tts_relay.py",
        "timeout": 10,
        "async": true
      }]
    }]
  }
}`;

    const autoStepsHtml = autoSetupResult
        ? `<div class="step ${autoSetupResult.success ? 'done' : ''}">
  <h2>Auto Setup ${autoSetupResult.success ? 'Complete!' : 'Result'}</h2>
  <ul>${autoSetupResult.steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>
</div>`
        : '';

    const panel = vscode.window.createWebviewPanel(
        'voicevoxDockerSetup',
        'VOICEVOX: Docker Setup',
        vscode.ViewColumn.One,
        { enableScripts: false }
    );
    panel.webview.html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body { font-family: sans-serif; padding: 20px; line-height: 1.6; }
code { background: #2a2a2a; padding: 2px 6px; border-radius: 3px; }
pre { background: #1a1a1a; padding: 12px; border-radius: 6px; overflow-x: auto; }
.step { background: #2d2d2d; padding: 12px; margin: 10px 0; border-left: 4px solid #4a9eff; }
.done { border-left-color: #4ade80; }
h2 { color: #4a9eff; }
</style></head><body>
<h1>VOICEVOX Docker Setup</h1>
${autoStepsHtml}
<div class="step done">
  <h2>docker-compose.override.yml created</h2>
  <p>Path: <code>${escapeHtml(overridePath.replace(/\\/g, '/'))}</code></p>
  <p>This mounts your host's hooks directory into the container (for future restarts).</p>
</div>
<div class="step">
  <h2>Step 2: Container Settings (Manual)</h2>
  <p>Add this hook to your container's <code>~/.claude/settings.json</code>:</p>
  <pre>${escapeHtml(settingsSnippet)}</pre>
  <p><strong>How to do it:</strong></p>
  <ol>
    <li>Restart your container: <code>docker-compose down && docker-compose up -d</code></li>
    <li>Enter the container: <code>docker-compose exec ${escapeHtml(serviceName)} bash</code></li>
    <li>Edit settings.json: <code>nano ~/.claude/settings.json</code></li>
    <li>Add the hook above (merge with existing hooks if present)</li>
  </ol>
</div>
<div class="step">
  <h2>Step 3: Test</h2>
  <p>From inside the container, test the relay:</p>
  <pre>curl -X POST http://host.docker.internal:50022/speak \\
  -H "Content-Type: application/json" \\
  -H "X-VOICEVOX-Relay-Token: $(cat ~/.claude/hooks/voicevox_relay_token)" \\
  -d '{"text":"Hello from Docker"}'</pre>
  <p>You should hear Tsumugi from your host PC speakers!</p>
</div>
<div class="step">
  <h2>Notes</h2>
  <ul>
    <li>VOICEVOX must be running on the host PC (port 50021)</li>
    <li>VSCode with this extension must be running on the host (relay server on port 50022)</li>
    <li>The relay script and authentication token are auto-mounted from host</li>
  </ul>
</div>
</body></html>
    `;

    vscode.window.showInformationMessage('VOICEVOX Docker setup created! See instructions panel.');
}

// --- Main activate ---
async function activate(context) {
    const outputChannel = vscode.window.createOutputChannel('VOICEVOX TTS');
    outputChannel.appendLine('VOICEVOX TTS v2 activate');

    // Ensure hooks dir exists
    if (!fs.existsSync(HOOKS_DIR)) fs.mkdirSync(HOOKS_DIR, { recursive: true });
    if (!fs.existsSync(TTS_INPUT_FILE)) fs.writeFileSync(TTS_INPUT_FILE, '{"last_assistant_message": ""}', 'utf-8');
    const relayToken = ensureRelayAssets();

    // Load or run setup wizard
    config = loadConfig();
    if (!config || !config.setupComplete) {
        config = await runSetupWizard();
        if (!config) {
            outputChannel.appendLine('Setup skipped');
            vscode.window.showInformationMessage('VOICEVOX TTS: Setup skipped. Run "VOICEVOX: Setup Wizard" to configure.');
            // Register setup command for later
            context.subscriptions.push(
                vscode.commands.registerCommand('voicevox-tts.setup', () => runSetupWizard().then(c => { if (c) config = c; }))
            );
            return;
        }
    }

    // Register setup command (for re-configuration)
    context.subscriptions.push(
        vscode.commands.registerCommand('voicevox-tts.setup', async () => {
            const c = await runSetupWizard();
            if (c) {
                config = c;
                vscode.window.showInformationMessage('VOICEVOX TTS: Config updated! Reload window to apply.');
            }
        })
    );

    // Docker integration setup command
    context.subscriptions.push(
        vscode.commands.registerCommand('voicevox-tts.setupDocker', async () => {
            await setupDockerIntegration();
        })
    );

    // Auto-detect Docker project on activation
    registerTimeout(context, () => detectDockerProject(), 3000);

    const state = loadState();
    state.sessionStart = Date.now();
    saveState(state);

    // Time greeting
    if (!greetingDone) { greetingDone = true; playWav(getTimeGreeting()); }

    // tts_input.json watcher
    watcher = fs.watch(TTS_INPUT_FILE, (eventType) => { if (eventType === 'change' || eventType === 'rename') onFileChanged(); });
    let lastMtime = 0;
    registerInterval(context, () => { try { const s = fs.statSync(TTS_INPUT_FILE); if (s.mtimeMs !== lastMtime) { lastMtime = s.mtimeMs; onFileChanged(); } } catch(e) {} }, 100);

    // VSCode events
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => { playWav('vsc_saved.wav'); checkMemoryTriggers(loadState()); }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(e => { if (!e) return; const n = Date.now(); if (n - lastTabSwitch > 2000) { lastTabSwitch = n; playWav('vsc_tab.wav'); } }));
    context.subscriptions.push(vscode.workspace.onDidCreateFiles(() => playWav('vsc_file_create.wav')));
    context.subscriptions.push(vscode.workspace.onDidDeleteFiles(() => playWav('vsc_file_delete.wav')));
    context.subscriptions.push(vscode.workspace.onDidRenameFiles(() => playWav('vsc_file_rename.wav')));
    context.subscriptions.push(vscode.window.onDidOpenTerminal(() => playWav('vsc_terminal_open.wav')));
    context.subscriptions.push(vscode.window.onDidCloseTerminal(() => playWav('vsc_terminal_close.wav')));
    context.subscriptions.push(vscode.debug.onDidStartDebugSession(() => playWav('vsc_debug_start.wav')));
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(() => playWav('vsc_debug_end.wav')));
    context.subscriptions.push(vscode.window.onDidChangeWindowState(s => { if (!s.focused) return; const n = Date.now(); if (n - lastFocus > 3000) { lastFocus = n; playWav('vsc_focus.wav'); } }));
    context.subscriptions.push(vscode.tasks.onDidStartTask(() => playWav('vsc_task_start.wav')));
    context.subscriptions.push(vscode.tasks.onDidEndTask(() => playWav('vsc_task_end.wav')));

    setupGitWatcher(context);

    // Break reminder (every 60 minutes)
    registerInterval(context, () => {
        const breakWavs = ['break_1.wav', 'break_2.wav', 'break_3.wav'];
        playWav(randomPick(breakWavs));
        vscode.window.showInformationMessage('VOICEVOX: Break time! Stretch and rest your eyes.');
    }, 60 * 60 * 1000);

    // Late night check (every 30 minutes after 23:00)
    registerInterval(context, () => {
        const h = new Date().getHours();
        if (h >= 23 || h < 5) {
            const lateWavs = ['latenight_1.wav', 'latenight_2.wav', 'latenight_3.wav'];
            playWav(randomPick(lateWavs));
        }
    }, 30 * 60 * 1000);

    // Authenticated HTTP relay server for Docker containers.
    const relayServer = http.createServer((req, res) => {
        const requestPath = new URL(req.url || '/', 'http://localhost').pathname;

        if (req.method === 'GET' && requestPath === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: true, version: '2.2.1' }));
            return;
        }

        if (req.method !== 'POST') {
            res.writeHead(405); res.end('Method Not Allowed'); return;
        }
        if (!isAuthorizedRelayRequest(req, relayToken)) {
            res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
            return;
        }
        const declaredLength = Number(req.headers['content-length'] || 0);
        if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_RELAY_BODY_BYTES) {
            res.writeHead(413); res.end('Payload Too Large'); return;
        }
        let body = '';
        let bodyBytes = 0;
        let rejected = false;
        req.on('data', chunk => {
            bodyBytes += chunk.length;
            if (bodyBytes > MAX_RELAY_BODY_BYTES) {
                rejected = true;
                res.writeHead(413); res.end('Payload Too Large');
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on('end', () => {
            if (rejected) return;
            try {
                const data = JSON.parse(body);
                if (requestPath === '/speak' && typeof data.text === 'string' && data.text.length > 0 && data.text.length <= MAX_SPEAK_TEXT_LENGTH) {
                    speak(data.text);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } else if (requestPath === '/play' && typeof data.wav === 'string' && playWav(data.wav)) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } else if (requestPath === '/notify' && typeof data.message === 'string' && data.message.length <= MAX_SPEAK_TEXT_LENGTH) {
                    // Extract last meaningful line
                    let t = data.message;
                    t = t.replace(/```[\s\S]*?```/g, '')
                         .replace(/`[^`]+`/g, '')
                         .replace(/^#{1,6}\s+/gm, '')
                         .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
                         .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
                         .replace(/https?:\/\/\S+/g, '')
                         .replace(/<[^>]+>/g, '');
                    const lines = t.split('\n').map(l => l.trim());
                    const meaningful = [];
                    for (const l of lines) {
                        if (!l) continue;
                        if (/^[\-\*\+\|=_]+$/.test(l)) continue;
                        let l2 = l.replace(/^[\-\*\+]\s+/, '').replace(/^\d+[\.\)]\s+/, '');
                        if (l2) meaningful.push(l2);
                    }
                    let last = meaningful.length ? meaningful[meaningful.length - 1].slice(0, 120) : '';
                    // Prepend user name if not present
                    try {
                        const cfg = loadConfig();
                        if (cfg && cfg.userName && !last.includes(cfg.userName)) {
                            last = cfg.userName + '、' + last;
                        }
                    } catch (e) {}
                    if (last) speak(last);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } else {
                    res.writeHead(400); res.end('Bad Request');
                }
            } catch (e) {
                res.writeHead(500); res.end('Error: ' + e.message);
            }
        });
    });
    // Docker reaches this listener via host.docker.internal; every mutating endpoint requires a random local token.
    relayServer.listen(RELAY_PORT, '0.0.0.0', () => {
        outputChannel.appendLine(`HTTP relay server listening on port ${RELAY_PORT}`);
    });
    relayServer.on('error', (e) => {
        outputChannel.appendLine(`HTTP relay error: ${e.message}`);
    });
    context.subscriptions.push({ dispose: () => relayServer.close() });

    outputChannel.appendLine('VOICEVOX TTS v2 ready');
    vscode.window.showInformationMessage(`VOICEVOX TTS v2: Hello, ${config.userName}!`);
}

function deactivate() { if (watcher) { watcher.close(); watcher = null; } }

module.exports = { activate, deactivate };
