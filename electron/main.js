/* ===========================================================
 * Crouton — menu-bar app for macOS
 *  - Tray icon + popover UI
 *  - Hidden BrowserWindow captures mic and chunks audio
 *  - Native whisper.cpp (whisper-cli + Metal) for transcription
 *  - Local Ollama LLM for summary + action items
 *  - Writes transcript + summary into a new note inside the
 *    user's Obsidian vault, live-updating as chunks come in
 * =========================================================== */

const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage,
  screen, shell, globalShortcut, Notification,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const https = require('node:https');

// -------------------------------------------------------------
// Paths + persistent settings
// -------------------------------------------------------------
const PROJECT_ROOT = path.join(__dirname, '..');
const USER_DATA = app.getPath('userData');
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json');
const MODELS_DIR = path.join(USER_DATA, 'models');
const TMP_DIR = path.join(os.tmpdir(), 'crouton');
fs.mkdirSync(MODELS_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const DEFAULTS = {
  vaultPath: '',
  subfolder: 'Crouton',
  whisperModel: 'large-v3-turbo-q5_0',
  language: 'en',           // 'auto' for auto-detect
  chunkSeconds: 15,
  ollamaModel: 'llama3.2:3b',
  ollamaHost: 'http://127.0.0.1:11434',
  launchAtLogin: true,
  // Diarization (WhisperX + pyannote)
  diarizeEnabled: true,
  hfToken: '',
  diarizeModel: 'large-v3',   // whisperx -model
  // Note: WhisperX uses ctranslate2 under the hood, which does not support MPS.
  // CPU on Apple Silicon is still plenty fast (~10s per 10min on M-series).
  minSpeakers: 0,              // 0 = auto
  maxSpeakers: 0,              // 0 = auto
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(s) {
  settings = { ...settings, ...s };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  applyLoginItem();
  return settings;
}
let settings = loadSettings();

function applyLoginItem() {
  if (process.platform !== 'darwin') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.launchAtLogin,
      openAsHidden: true,
    });
  } catch (_e) { /* ignore in dev */ }
}

// -------------------------------------------------------------
// Whisper model registry (whisper.cpp ggml format)
// -------------------------------------------------------------
const MODELS = {
  'large-v3':            { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',            file: 'ggml-large-v3.bin' },
  'large-v3-q5_0':       { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin',       file: 'ggml-large-v3-q5_0.bin' },
  'large-v3-turbo':      { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',      file: 'ggml-large-v3-turbo.bin' },
  'large-v3-turbo-q5_0': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin', file: 'ggml-large-v3-turbo-q5_0.bin' },
  'medium':              { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',              file: 'ggml-medium.bin' },
  'small':               { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',               file: 'ggml-small.bin' },
  'base':                { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',                file: 'ggml-base.bin' },
};

function modelPath(key) {
  const m = MODELS[key]; if (!m) throw new Error(`Unknown model: ${key}`);
  return path.join(MODELS_DIR, m.file);
}
function modelExists(key) {
  try { return fs.statSync(modelPath(key)).size > 1_000_000; } catch { return false; }
}

function findWhisperCli() {
  const candidates = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const w = spawnSync('which', ['whisper-cli'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.trim() : null;
}
const WHISPER_CLI = findWhisperCli();

function findWhisperX() {
  // Prefer uv-tool install location, then anything on PATH
  const home = process.env.HOME || '';
  const candidates = [
    path.join(home, '.local/bin/whisperx'),
    '/opt/homebrew/bin/whisperx',
    '/usr/local/bin/whisperx',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const w = spawnSync('which', ['whisperx'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.trim() : null;
}
function whisperXPath() { return findWhisperX(); }

// -------------------------------------------------------------
// HTTPS download (with redirect + progress)
// -------------------------------------------------------------
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    let received = 0, total = 0;
    const handle = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        https.get(res.headers.location, handle).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      total = parseInt(res.headers['content-length'] || '0', 10);
      res.on('data', (c) => { received += c.length; onProgress && onProgress({ loaded: received, total }); });
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      out.on('error', reject);
    };
    https.get(url, handle).on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} reject(e); });
  });
}

async function ensureWhisperModel(modelKey, onProgress) {
  if (modelExists(modelKey)) return modelPath(modelKey);
  const m = MODELS[modelKey]; if (!m) throw new Error(`Unknown model: ${modelKey}`);
  await downloadFile(m.url, modelPath(modelKey), onProgress);
  return modelPath(modelKey);
}

// -------------------------------------------------------------
// Float32 → 16-bit PCM WAV
// -------------------------------------------------------------
function encodeWav(float32, sampleRate) {
  const n = float32.length;
  const buf = Buffer.alloc(44 + n * 2);
  let o = 0;
  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(36 + n * 2, o); o += 4;
  buf.write('WAVE', o); o += 4;
  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(16, o); o += 4;
  buf.writeUInt16LE(1, o);  o += 2;
  buf.writeUInt16LE(1, o);  o += 2;
  buf.writeUInt32LE(sampleRate, o); o += 4;
  buf.writeUInt32LE(sampleRate * 2, o); o += 4;
  buf.writeUInt16LE(2, o);  o += 2;
  buf.writeUInt16LE(16, o); o += 2;
  buf.write('data', o); o += 4;
  buf.writeUInt32LE(n * 2, o); o += 4;
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    buf.writeInt16LE(s | 0, o);
    o += 2;
  }
  return buf;
}

// -------------------------------------------------------------
// Transcribe a chunk via whisper-cli
// -------------------------------------------------------------
async function transcribeChunk({ audio, sampleRate, language, modelKey }) {
  if (!WHISPER_CLI) throw new Error('whisper-cli not found. Install with: brew install whisper-cpp');
  const mp = modelPath(modelKey || settings.whisperModel);
  if (!fs.existsSync(mp)) throw new Error(`Whisper model not downloaded: ${path.basename(mp)}`);

  // Accumulate raw audio for the post-session diarization pass.
  if (session && settings.diarizeEnabled) {
    session.audioChunks.push(audio);
    session.audioSamples += audio.length;
  }

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const wavPath = path.join(TMP_DIR, `chunk-${stamp}.wav`);
  const outBase = path.join(TMP_DIR, `out-${stamp}`);
  fs.writeFileSync(wavPath, encodeWav(audio, sampleRate || 16000));

  const args = [
    '-m', mp, '-f', wavPath,
    '-otxt', '-of', outBase,
    '-nt', '--no-prints',
    '-t', String(Math.max(4, Math.min(8, os.cpus().length))),
  ];
  if (language && language !== 'auto') args.push('-l', language);

  await new Promise((resolve, reject) => {
    const p = spawn(WHISPER_CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`whisper-cli exited ${code}: ${stderr.slice(0, 400)}`)));
  });

  let text = '';
  try { text = await fsp.readFile(outBase + '.txt', 'utf8'); } catch {}
  fsp.unlink(wavPath).catch(() => {});
  fsp.unlink(outBase + '.txt').catch(() => {});
  return text.replace(/\s+/g, ' ').trim();
}

// -------------------------------------------------------------
// Diarization (WhisperX + pyannote)
// -------------------------------------------------------------
function writeSessionAudio(outPath, chunks, totalSamples) {
  // Concatenate all accumulated Float32 chunks into one 16-bit PCM WAV @16kHz mono.
  const merged = new Float32Array(totalSamples);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  fs.writeFileSync(outPath, encodeWav(merged, 16000));
}

async function runWhisperX(wavPath, outDir) {
  const cli = whisperXPath();
  if (!cli) throw new Error('whisperx not installed. Wait for the background install to finish, or run: uv tool install whisperx');

  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    wavPath,
    '--model', settings.diarizeModel || 'large-v3',
    '--language', settings.language && settings.language !== 'auto' ? settings.language : 'en',
    '--diarize',
    '--output_format', 'json',
    '--output_dir', outDir,
    // ctranslate2 (whisperx's ASR backend) only supports CPU/CUDA on macOS.
    // CPU + int8 is the fastest+leanest combo on Apple Silicon.
    '--device', 'cpu',
    '--compute_type', 'int8',
    '--threads', String(Math.max(4, Math.min(8, os.cpus().length))),
    '--print_progress', 'False',
  ];
  if (settings.hfToken) args.push('--hf_token', settings.hfToken);
  if (settings.minSpeakers && settings.minSpeakers > 0) args.push('--min_speakers', String(settings.minSpeakers));
  if (settings.maxSpeakers && settings.maxSpeakers > 0) args.push('--max_speakers', String(settings.maxSpeakers));

  await new Promise((resolve, reject) => {
    const p = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stdout.on('data', (d) => process.stdout.write(`[whisperx] ${d}`));
    p.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(`[whisperx] ${d}`); });
    p.on('error', reject);
    p.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`whisperx exited ${code}: ${stderr.slice(-600)}`)));
  });

  // WhisperX writes <basename>.json into outDir
  const base = path.basename(wavPath, path.extname(wavPath));
  const jsonPath = path.join(outDir, base + '.json');
  if (!fs.existsSync(jsonPath)) throw new Error(`WhisperX output missing: ${jsonPath}`);
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  return data;
}

function formatDiarizedTranscript(whisperxJson) {
  // WhisperX JSON: { segments: [ { start, end, text, speaker? } ], ... }
  const segments = (whisperxJson && whisperxJson.segments) || [];
  if (segments.length === 0) return '';

  const out = [];
  let current = null;
  for (const seg of segments) {
    const speaker = seg.speaker || 'Unknown';
    const text = (seg.text || '').trim();
    if (!text) continue;
    if (current && current.speaker === speaker) {
      current.text += ' ' + text;
    } else {
      if (current) out.push(current);
      current = { speaker, text };
    }
  }
  if (current) out.push(current);

  // Rename "SPEAKER_00" → "Speaker 1", etc.
  const nameMap = new Map();
  const niceName = (raw) => {
    if (!nameMap.has(raw)) {
      const m = /SPEAKER[_-]?(\d+)/i.exec(raw);
      const n = m ? parseInt(m[1], 10) + 1 : nameMap.size + 1;
      nameMap.set(raw, `Speaker ${n}`);
    }
    return nameMap.get(raw);
  };

  return out
    .map((p) => `**${niceName(p.speaker)}:** ${p.text}`)
    .join('\n\n');
}

// -------------------------------------------------------------
// Ollama summarization
// -------------------------------------------------------------
const SUMMARY_SYSTEM = `You are an expert meeting note-taker. You are given a raw meeting transcript and (optionally) the user's own freeform notes that they typed during the meeting. Produce concise structured notes in markdown.

Use exactly this structure (omit sections that have no real content):
## Summary
*One paragraph TL;DR.*

## Key points
- Tight bullets, important takeaways only

## Decisions
- Decisions that were made

## Action items
- [ ] {Owner if mentioned} — {what to do, by when if mentioned}

## Open questions
- Things still unresolved

How to use the user's own notes (when provided):
- Treat the user's notes as a strong signal of what they consider important. Anything they wrote down should be reflected in your summary.
- If the user noted a decision, action item, or question, surface it explicitly — don't drop it just because the transcript was vague.
- If the user's notes and the transcript conflict, prefer the user's framing.
- Don't quote the user's notes verbatim back at them — they're already preserved in the note file separately. Paraphrase or extract structured info.
- If the user noted owners ("Mira: contract") or deadlines ("by Fri"), keep them in action items.

General rules:
- Don't invent facts. If something isn't in the transcript or the user's notes, omit it.
- Action items must use \`- [ ]\` checkbox syntax.
- Be brief. No filler.
- Output markdown only, no preamble or commentary.`;

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = Buffer.from(JSON.stringify(body));
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    };
    const lib = url.protocol === 'https:' ? https : require('node:http');
    const req = lib.request(opts, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { resolve(buf); }
        } else reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function ollamaListModels() {
  return new Promise((resolve, reject) => {
    const url = new URL(settings.ollamaHost + '/api/tags');
    const lib = url.protocol === 'https:' ? https : require('node:http');
    const req = lib.request({ method: 'GET', hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function ollamaIsRunning() {
  try { await ollamaListModels(); return true; } catch { return false; }
}

async function summarizeTranscript(transcript, userNotes) {
  const notes = (userNotes || '').trim();
  const userMsg = [
    notes
      ? `User's own notes (typed during the meeting — treat as priority signal):\n\n${notes}`
      : `(The user did not type any notes during this meeting — work from the transcript alone.)`,
    '',
    `Transcript:\n\n${transcript}`,
    '',
    'Produce the structured markdown notes.',
  ].join('\n');

  const body = {
    model: settings.ollamaModel,
    stream: false,
    options: { temperature: 0.2, num_ctx: 8192 },
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: userMsg },
    ],
  };
  const res = await postJson(settings.ollamaHost + '/api/chat', body);
  return (res && res.message && res.message.content) || '';
}

// -------------------------------------------------------------
// Obsidian note management
// -------------------------------------------------------------
function pad(n) { return String(n).padStart(2, '0'); }
function timestampStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
}
function isoLocal(d = new Date()) {
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const abs = Math.abs(tz);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function sessionDir() {
  if (!settings.vaultPath) throw new Error('Vault not set');
  const dir = settings.subfolder
    ? path.join(settings.vaultPath, settings.subfolder)
    : settings.vaultPath;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newNotePath(title) {
  const dir = sessionDir();
  const stamp = timestampStr();
  const safeTitle = (title || 'Recording').replace(/[\/\\:*?"<>|]/g, '-').trim();
  let base = `${stamp} — ${safeTitle}`;
  let p = path.join(dir, base + '.md');
  let i = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base} (${i}).md`);
    i++;
  }
  return p;
}

function initialNoteContent(title) {
  const now = isoLocal();
  return `---
created: ${now}
tags: [meeting, crouton]
source: crouton
---
# ${title}

## Notes


## Status
🔴 *Recording in progress…*
`;
}

// Pull the user's free-form text out of the live note so we can preserve it
// across the post-session rewrite. Looks for the "## Notes" heading and
// returns everything until the next "## " heading or end-of-file.
function extractUserNotes(fileContent) {
  if (!fileContent) return '';
  const lines = fileContent.split('\n');
  let inNotes = false;
  const out = [];
  for (const line of lines) {
    if (inNotes) {
      if (/^##\s+/.test(line)) break;
      out.push(line);
    } else if (/^##\s+Notes\s*$/i.test(line)) {
      inNotes = true;
    }
  }
  // Strip the boilerplate HTML comment and trim
  return out
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function rewriteWithSummary(title, summaryMarkdown, transcript, createdISO, userNotes) {
  const sum = (summaryMarkdown || '').trim();
  const notes = (userNotes || '').trim();
  return `---
created: ${createdISO}
tags: [meeting, crouton]
source: crouton
---
# ${title}

## Notes
${notes || '*(none — type your notes here)*'}

${sum || '*No summary generated.*'}

## Transcript

${transcript.trim()}
`;
}

// -------------------------------------------------------------
// Session state
// -------------------------------------------------------------
let session = null;
/*
session = {
  startedAt, title, notePath, createdISO,
  transcript: string,
}
*/

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function startSession(title) {
  if (session) return session;
  if (!settings.vaultPath) throw new Error('No Obsidian vault selected.');
  const t = (title && title.trim()) || `Recording — ${timestampStr()}`;
  const notePath = newNotePath(t);
  const createdISO = isoLocal();
  const initial = initialNoteContent(t);
  fs.writeFileSync(notePath, initial, 'utf8');
  session = {
    startedAt: Date.now(),
    title: t,
    notePath,
    createdISO,
    transcript: '',
    audioChunks: [],
    audioSamples: 0,
  };
  broadcast('session:state', sessionState());
  return session;
}

async function endSession({ generateSummary = true } = {}) {
  if (!session) return null;
  const s = session;
  session = null;
  broadcast('session:state', sessionState());

  // 0) Pull the user's free-form notes off disk before we touch anything.
  let userNotes = '';
  try {
    const cur = fs.readFileSync(s.notePath, 'utf8');
    userNotes = extractUserNotes(cur);
  } catch (_e) { /* file just won't have user notes */ }

  // 1) Optional diarization pass over the full session audio
  let diarizedTranscript = '';
  const canDiarize =
    settings.diarizeEnabled &&
    !!whisperXPath() &&
    !!settings.hfToken &&
    s.audioChunks.length > 0 &&
    s.audioSamples >= 16000; // at least 1s of audio

  if (canDiarize) {
    try {
      broadcast('session:summary-status', { status: 'diarizing' });
      const sessionDir = path.join(TMP_DIR, `session-${s.startedAt}`);
      fs.mkdirSync(sessionDir, { recursive: true });
      const wavPath = path.join(sessionDir, 'audio.wav');
      writeSessionAudio(wavPath, s.audioChunks, s.audioSamples);

      const json = await runWhisperX(wavPath, sessionDir);
      diarizedTranscript = formatDiarizedTranscript(json);

      // Clean up (keep audio.wav around for now in case user wants to re-process)
      // fs.promises.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    } catch (err) {
      console.error('Diarization failed:', err);
      broadcast('session:summary-status', {
        status: 'diarize-failed',
        message: (err.message || String(err)).slice(0, 240),
      });
    }
  }

  const transcriptForFile = diarizedTranscript || s.transcript;
  const transcriptForSummary = diarizedTranscript
    ? diarizedTranscript
    : s.transcript;

  // 2) Local LLM summary — feed both the transcript and the user's notes so
  // the LLM treats what the user wrote down as a priority signal.
  let summary = '';
  if (generateSummary && transcriptForSummary.trim().length > 0) {
    try {
      broadcast('session:summary-status', { status: 'generating' });
      summary = await summarizeTranscript(transcriptForSummary.trim(), userNotes);
    } catch (err) {
      console.error('Summarization failed:', err);
      summary = `*Summary failed: ${(err.message || err).toString().replace(/\n/g, ' ')}*`;
    }
  }

  // 3) Final note — user notes preserved verbatim
  const finalContent = rewriteWithSummary(s.title, summary, transcriptForFile, s.createdISO, userNotes);
  try { fs.writeFileSync(s.notePath, finalContent, 'utf8'); } catch (e) { console.error('Write failed:', e); }

  broadcast('session:summary-status', { status: 'done', notePath: s.notePath });
  try {
    new Notification({ title: 'Crouton', body: `Saved: ${path.basename(s.notePath)}` }).show();
  } catch {}
  return s;
}

function appendChunkToNote(text) {
  if (!session) return;
  if (!text || !text.trim()) return;
  // Don't write to the live Obsidian file during the session: that would race
  // with the user typing in the "## Notes" section (Obsidian auto-saves their
  // edits, then we'd clobber/conflict). Live transcript is shown in the
  // popover; the full transcript is committed to the file in endSession().
  session.transcript += (session.transcript ? ' ' : '') + text.trim();
  broadcast('session:chunk', { text: text.trim(), transcript: session.transcript });
}

function sessionState() {
  return session
    ? {
        active: true,
        title: session.title,
        notePath: session.notePath,
        startedAt: session.startedAt,
        transcript: session.transcript,
      }
    : { active: false };
}

// -------------------------------------------------------------
// Windows: hidden recorder + tray popover
// -------------------------------------------------------------
let recorderWin = null;
let popoverWin = null;
let tray = null;

function createRecorderWindow() {
  recorderWin = new BrowserWindow({
    show: false,
    width: 320, height: 200,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-recorder.js'),
      contextIsolation: true,
      backgroundThrottling: false, // keep audio capture running when hidden
      sandbox: false,
    },
  });
  recorderWin.loadFile(path.join(PROJECT_ROOT, 'recorder.html'));
  // Uncomment to debug audio capture:
  // recorderWin.webContents.openDevTools({ mode: 'detach' });
}

function createPopover() {
  popoverWin = new BrowserWindow({
    width: 380,
    height: 520,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: '#faf9f6',
    fullscreenable: false,
    hasShadow: true,
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload-menubar.js'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  popoverWin.loadFile(path.join(PROJECT_ROOT, 'menubar.html'));
  popoverWin.on('blur', () => popoverWin && popoverWin.hide());
}

function positionPopover() {
  if (!popoverWin || !tray) return;
  const trayBounds = tray.getBounds();
  const winBounds = popoverWin.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  let y = Math.round(trayBounds.y + trayBounds.height + 4);

  // Clamp to screen
  const w = display.workArea;
  x = Math.max(w.x + 8, Math.min(x, w.x + w.width - winBounds.width - 8));
  if (y + winBounds.height > w.y + w.height) y = w.y + w.height - winBounds.height - 8;

  popoverWin.setPosition(x, y, false);
}

function togglePopover() {
  if (!popoverWin) return;
  if (popoverWin.isVisible()) popoverWin.hide();
  else {
    positionPopover();
    popoverWin.show();
    popoverWin.focus();
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'tray-iconTemplate.png');
  const img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) {
    console.error('[Crouton] Tray icon failed to load:', iconPath);
  } else {
    console.log('[Crouton] Tray icon loaded:', iconPath, img.getSize());
  }
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Crouton');
  tray.setTitle(''); // could put a text label here next to the icon
  tray.on('click', togglePopover);
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: session ? `Stop recording (${session.title})` : 'Start recording',
        click: () => {
          if (session) ipcMain.emit('session:stop-via-menu');
          else ipcMain.emit('session:start-via-menu');
        } },
      { type: 'separator' },
      { label: 'Open vault in Finder',
        enabled: !!settings.vaultPath,
        click: () => settings.vaultPath && shell.openPath(settings.vaultPath) },
      { label: 'Open models folder', click: () => shell.openPath(MODELS_DIR) },
      { type: 'separator' },
      { label: 'Quit Crouton', role: 'quit' },
    ]);
    tray.popUpContextMenu(menu);
  });
}

// -------------------------------------------------------------
// IPC
// -------------------------------------------------------------
ipcMain.handle('app:info', async () => ({
  whisperCli: WHISPER_CLI,
  whisperXCli: whisperXPath(),
  modelsDir: MODELS_DIR,
  models: Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, { ...m, present: modelExists(k) }])),
  settings,
  session: sessionState(),
  ollamaRunning: await ollamaIsRunning().catch(() => false),
  ollamaModels: (await ollamaListModels().catch(() => ({ models: [] }))).models || [],
  platform: process.platform,
  arch: process.arch,
}));

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch || {}));

ipcMain.handle('vault:pick', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Choose your Obsidian vault',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Choose vault',
  });
  if (res.canceled || !res.filePaths[0]) return settings;
  return saveSettings({ vaultPath: res.filePaths[0] });
});

ipcMain.handle('whisper:ensure-model', async (event, modelKey) => {
  return ensureWhisperModel(modelKey || settings.whisperModel, (p) => {
    if (popoverWin && !popoverWin.isDestroyed()) popoverWin.webContents.send('whisper:progress', p);
  });
});

ipcMain.handle('whisper:transcribe', async (_event, payload) => {
  const audio = payload.audio instanceof Float32Array ? payload.audio : new Float32Array(payload.audio);
  return transcribeChunk({
    audio,
    sampleRate: payload.sampleRate || 16000,
    language: payload.language || (settings.language !== 'auto' ? settings.language : undefined),
    modelKey: payload.modelKey || settings.whisperModel,
  });
});

ipcMain.handle('session:start', async (_e, opts) => {
  if (!settings.vaultPath) throw new Error('Pick an Obsidian vault first.');
  // Ensure whisper model is present
  await ensureWhisperModel(settings.whisperModel, (p) => {
    if (popoverWin && !popoverWin.isDestroyed()) popoverWin.webContents.send('whisper:progress', p);
  });
  const s = startSession((opts && opts.title) || '');
  // Tell hidden recorder to start
  if (recorderWin && !recorderWin.isDestroyed()) recorderWin.webContents.send('recorder:command', { type: 'start' });
  return sessionState();
});

ipcMain.handle('session:stop', async () => {
  await drainRecorderAndEnd();
  return session ? null : (lastEndedSession ? { notePath: lastEndedSession.notePath } : null);
});

let lastEndedSession = null;

async function drainRecorderAndEnd() {
  if (recorderWin && !recorderWin.isDestroyed()) {
    // Wait for the recorder to confirm it's fully drained (final chunk
    // transcribed, all in-flight transcribes awaited). Hard timeout of 5
    // minutes — way more than any sane meeting tail; we never want to drop
    // audio because of an arbitrary fixed delay.
    broadcast('session:summary-status', { status: 'draining' });
    await waitForRecorderDrain(5 * 60 * 1000);
  }
  const s = await endSession({ generateSummary: true });
  lastEndedSession = s;
}

function waitForRecorderDrain(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const onStopped = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ipcMain.removeListener('recorder:stopped', onStopped);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      ipcMain.removeListener('recorder:stopped', onStopped);
      console.warn('[Crouton] recorder:stopped timeout — proceeding anyway');
      resolve(false);
    }, timeoutMs);
    ipcMain.on('recorder:stopped', onStopped);
    recorderWin.webContents.send('recorder:command', { type: 'stop' });
  });
}

ipcMain.handle('session:append-chunk', (_e, text) => {
  appendChunkToNote(text);
  return sessionState();
});

ipcMain.handle('session:state', () => sessionState());

function obsidianInstalled() {
  // Common install locations on macOS
  const candidates = [
    '/Applications/Obsidian.app',
    path.join(process.env.HOME || '', 'Applications/Obsidian.app'),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

ipcMain.handle('note:open', async (_e, p) => {
  if (!p) return;
  // Prefer Obsidian's URI scheme so the note opens in Obsidian even when
  // .md files are associated with VS Code / another editor on this machine.
  if (obsidianInstalled()) {
    try {
      const url = `obsidian://open?path=${encodeURIComponent(p)}`;
      await shell.openExternal(url);
      return;
    } catch (err) {
      console.warn('[Crouton] obsidian:// open failed, falling back:', err.message);
    }
  }
  return shell.openPath(p);
});
ipcMain.handle('note:reveal', (_e, p) => p && shell.showItemInFolder(p));
ipcMain.handle('app:open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) return shell.openExternal(url);
});

// Menu shortcuts that go via ipcMain.emit
ipcMain.on('session:start-via-menu', async () => {
  try {
    if (!settings.vaultPath) { togglePopover(); return; }
    await ensureWhisperModel(settings.whisperModel);
    startSession('');
    if (recorderWin) recorderWin.webContents.send('recorder:command', { type: 'start' });
  } catch (e) { console.error(e); }
});
ipcMain.on('session:stop-via-menu', async () => {
  await drainRecorderAndEnd();
});

// -------------------------------------------------------------
// App lifecycle
// -------------------------------------------------------------
app.whenReady().then(() => {
  applyLoginItem();
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createTray();
  createRecorderWindow();
  createPopover();

  // Backup: a global shortcut to open the popover even if the tray icon is
  // hidden under the notch on a crowded menu bar. Cmd+Shift+\ is the default.
  try {
    const accelerator = 'CommandOrControl+Shift+\\';
    const ok = globalShortcut.register(accelerator, togglePopover);
    if (ok) console.log('[Crouton] Global shortcut registered:', accelerator);
    else console.warn('[Crouton] Could not register global shortcut');
  } catch (e) {
    console.warn('[Crouton] Shortcut registration failed:', e.message);
  }
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});

app.on('window-all-closed', (e) => {
  // Stay running as a tray-only app on macOS
  e.preventDefault();
});

app.on('before-quit', () => {
  // Force-close hidden windows so we exit cleanly
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.removeAllListeners('blur'); w.destroy(); } catch {}
  }
});
