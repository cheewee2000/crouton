/* ===========================================================
 * Crouton — AI-powered meeting notes
 * =========================================================== */

const VERSION = '0.4.0';
const IS_ELECTRON = typeof window !== 'undefined' && window.crouton && window.crouton.isElectron === true;

const STORAGE_KEYS = {
  notes: 'crouton.notes.v1',
  active: 'crouton.activeNoteId.v1',
  settings: 'crouton.settings.v1',
};

// Migrate notes/settings from the previous "Granola Clone" naming so users
// don't lose their data when the app is renamed.
const LEGACY_STORAGE_KEYS = {
  notes: 'granola.notes.v1',
  active: 'granola.activeNoteId.v1',
  settings: 'granola.settings.v2',
};

const DEFAULT_TEMPLATE = `You are an expert meeting note formatter. Given the user's raw notes and a meeting transcript, produce clean, well-structured meeting notes.

Use this structure (markdown):
# {Concise meeting title}
*One sentence summary of what the meeting was about.*

## Key points
- Bullet the most important takeaways. Keep them tight.

## Decisions
- List decisions that were made.

## Action items
- [ ] Owner — what needs to happen, by when

## Open questions
- Items that need follow-up.

Rules:
- Preserve the user's own framing and language where possible.
- Don't invent facts. If something isn't in the notes or transcript, omit it.
- Be concise. Prefer bullets over paragraphs.
- Skip sections that have no content.`;

// In Electron we use native whisper.cpp ggml model keys; in the browser we use HF repo IDs.
const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-sonnet-4-6',
  template: '',
  whisperModel: IS_ELECTRON ? 'large-v3-turbo-q5_0' : 'Xenova/whisper-large-v3',
  whisperDtype: 'q4',
  whisperLanguage: 'en',
};

const CHUNK_SECONDS = 15;       // accumulate this many seconds, then transcribe
const TARGET_SR = 16000;        // Whisper expects 16 kHz mono
const MIN_CHUNK_SAMPLES = 16000 * 0.5; // skip chunks shorter than 0.5s

/* -----------------------------------------------------------
 * State
 * --------------------------------------------------------- */
const state = {
  notes: [],
  activeId: null,
  settings: { ...DEFAULT_SETTINGS },
  recording: false,
  finalTranscript: '',
  interimTranscript: '',
  saveTimer: null,
  // Whisper / audio state
  whisper: {
    worker: null,
    ready: false,
    loading: false,
    loadedModel: null, // 'modelId:dtype' when ready
    pending: [],       // chunks awaiting transcription while model loads
  },
  audio: {
    ctx: null,
    stream: null,
    source: null,
    processor: null,
    chunks: [],
    samples: 0,
    intervalId: null,
    sampleRate: TARGET_SR,
  },
  install: { deferredPrompt: null },
};

/* -----------------------------------------------------------
 * Persistence
 * --------------------------------------------------------- */
// Repos that turned out not to exist on the HuggingFace Hub — silently rewrite
// to a known-good equivalent so old saved settings keep working.
const WHISPER_MODEL_ALIASES = {
  'Xenova/whisper-large-v3-turbo': 'onnx-community/whisper-large-v3-turbo',
};

function migrateLegacyStorage() {
  // One-time copy from "granola.*" keys to "crouton.*" keys. Leaves the originals
  // alone so an old build can still read them if rolled back.
  for (const k of ['notes', 'active', 'settings']) {
    if (localStorage.getItem(STORAGE_KEYS[k]) == null) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEYS[k]);
      if (legacy != null) localStorage.setItem(STORAGE_KEYS[k], legacy);
    }
  }
}

function loadAll() {
  migrateLegacyStorage();
  try {
    const rawNotes = localStorage.getItem(STORAGE_KEYS.notes);
    state.notes = rawNotes ? JSON.parse(rawNotes) : [];
  } catch (_e) {
    state.notes = [];
  }
  state.activeId = localStorage.getItem(STORAGE_KEYS.active);
  try {
    const rawSettings = localStorage.getItem(STORAGE_KEYS.settings);
    state.settings = rawSettings
      ? { ...DEFAULT_SETTINGS, ...JSON.parse(rawSettings) }
      : { ...DEFAULT_SETTINGS };
  } catch (_e) {
    state.settings = { ...DEFAULT_SETTINGS };
  }
  // Repair broken Whisper model references
  if (WHISPER_MODEL_ALIASES[state.settings.whisperModel]) {
    state.settings.whisperModel = WHISPER_MODEL_ALIASES[state.settings.whisperModel];
    persistSettings();
  }
}

function persistNotes() {
  localStorage.setItem(STORAGE_KEYS.notes, JSON.stringify(state.notes));
}

function persistActive() {
  if (state.activeId) {
    localStorage.setItem(STORAGE_KEYS.active, state.activeId);
  } else {
    localStorage.removeItem(STORAGE_KEYS.active);
  }
}

function persistSettings() {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
}

/* -----------------------------------------------------------
 * Models
 * --------------------------------------------------------- */
function newNote() {
  const id = 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return {
    id,
    title: '',
    rawNotes: '',
    enhancedNotes: '',
    transcript: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    enhancedAt: null,
  };
}

function getActive() {
  return state.notes.find((n) => n.id === state.activeId) || null;
}

function ensureActiveNote() {
  if (!getActive()) {
    const note = newNote();
    state.notes.unshift(note);
    state.activeId = note.id;
    persistNotes();
    persistActive();
  }
}

/* -----------------------------------------------------------
 * DOM refs
 * --------------------------------------------------------- */
const dom = {
  notesList: document.getElementById('notes-list'),
  searchInput: document.getElementById('search-input'),
  newNoteBtn: document.getElementById('new-note-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  noteTitle: document.getElementById('note-title'),
  noteMeta: document.getElementById('note-meta'),
  rawNotes: document.getElementById('raw-notes'),
  enhancedNotes: document.getElementById('enhanced-notes'),
  enhancedSub: document.getElementById('enhanced-sub'),
  recordBtn: document.getElementById('record-btn'),
  recordLabel: document.getElementById('record-label'),
  enhanceBtn: document.getElementById('enhance-btn'),
  transcriptDrawer: document.getElementById('transcript-drawer'),
  transcriptBody: document.getElementById('transcript-body'),
  transcriptStatus: document.getElementById('transcript-status'),
  closeDrawer: document.getElementById('close-drawer'),
  settingsModal: document.getElementById('settings-modal'),
  closeSettings: document.getElementById('close-settings'),
  cancelSettings: document.getElementById('cancel-settings'),
  saveSettings: document.getElementById('save-settings'),
  apiKeyInput: document.getElementById('api-key-input'),
  modelSelect: document.getElementById('model-select'),
  templateInput: document.getElementById('template-input'),
  whisperModelSelect: document.getElementById('whisper-model-select'),
  whisperDtypeSelect: document.getElementById('whisper-dtype-select'),
  whisperLanguageSelect: document.getElementById('whisper-language-select'),
  installBtn: document.getElementById('install-btn'),
  modelProgress: document.getElementById('model-progress'),
  modelProgressBar: document.getElementById('model-progress-bar'),
  version: document.getElementById('version'),
};

/* -----------------------------------------------------------
 * Render
 * --------------------------------------------------------- */
function formatRelative(ts) {
  const delta = Date.now() - ts;
  const m = Math.floor(delta / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function previewText(note) {
  const stripped = (note.rawNotes || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (stripped) return stripped.slice(0, 80);
  if (note.transcript) return note.transcript.slice(0, 80);
  return 'Empty note';
}

function renderNotesList(filter = '') {
  const q = filter.trim().toLowerCase();
  const filtered = state.notes.filter((n) => {
    if (!q) return true;
    const blob = (n.title + ' ' + n.rawNotes + ' ' + n.enhancedNotes + ' ' + n.transcript).toLowerCase();
    return blob.includes(q);
  });

  dom.notesList.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '20px 14px';
    empty.style.fontSize = '12px';
    empty.style.color = 'var(--text-faint)';
    empty.textContent = q ? 'No matches.' : 'No notes yet.';
    dom.notesList.appendChild(empty);
    return;
  }

  // Sort newest updated first
  filtered.sort((a, b) => b.updatedAt - a.updatedAt);

  for (const note of filtered) {
    const item = document.createElement('div');
    item.className = 'note-item' + (note.id === state.activeId ? ' active' : '');
    item.dataset.id = note.id;

    const title = document.createElement('div');
    title.className = 'note-item-title';
    title.textContent = note.title || 'Untitled note';

    const preview = document.createElement('div');
    preview.className = 'note-item-preview';
    preview.textContent = previewText(note);

    const meta = document.createElement('div');
    meta.className = 'note-item-meta';
    meta.textContent = formatRelative(note.updatedAt);
    if (note.enhancedAt) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'AI';
      meta.appendChild(badge);
    }

    item.appendChild(title);
    item.appendChild(preview);
    item.appendChild(meta);
    item.addEventListener('click', () => selectNote(note.id));
    dom.notesList.appendChild(item);
  }
}

function renderActive() {
  const note = getActive();
  if (!note) {
    dom.noteTitle.value = '';
    dom.rawNotes.innerHTML = '';
    dom.enhancedNotes.innerHTML = '';
    dom.noteMeta.textContent = '';
    return;
  }
  dom.noteTitle.value = note.title || '';
  dom.rawNotes.innerHTML = note.rawNotes || '';
  if (note.enhancedNotes) {
    dom.enhancedNotes.innerHTML = note.enhancedNotes;
    dom.enhancedSub.textContent = note.enhancedAt
      ? `Last enhanced ${formatRelative(note.enhancedAt)}`
      : 'AI-formatted summary';
  } else {
    renderEmptyEnhanced();
    dom.enhancedSub.textContent = 'AI-formatted summary appears here';
  }
  dom.noteMeta.textContent = `Updated ${formatRelative(note.updatedAt)}`;
}

function renderEmptyEnhanced() {
  dom.enhancedNotes.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
      </div>
      <p class="empty-title">Enhanced notes will appear here</p>
      <p class="empty-sub">Record a meeting or type notes, then click <strong>Enhance</strong> to get an AI-formatted summary with action items.</p>
    </div>
  `;
}

/* -----------------------------------------------------------
 * Note actions
 * --------------------------------------------------------- */
function selectNote(id) {
  state.activeId = id;
  persistActive();
  renderActive();
  renderNotesList(dom.searchInput.value);
}

function createNote() {
  const note = newNote();
  state.notes.unshift(note);
  state.activeId = note.id;
  persistNotes();
  persistActive();
  renderActive();
  renderNotesList(dom.searchInput.value);
  dom.noteTitle.focus();
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveActive, 350);
}

function saveActive() {
  const note = getActive();
  if (!note) return;
  note.title = dom.noteTitle.value;
  note.rawNotes = dom.rawNotes.innerHTML;
  // Don't overwrite enhanced from contenteditable since it's HTML-only display
  note.updatedAt = Date.now();
  persistNotes();
  dom.noteMeta.textContent = `Updated ${formatRelative(note.updatedAt)}`;
  // Update the sidebar entry in-place where possible
  renderNotesList(dom.searchInput.value);
}

/* -----------------------------------------------------------
 * Recording — local Whisper via Web Worker
 * --------------------------------------------------------- */
function toggleRecording() {
  if (state.recording) stopRecording();
  else startRecording();
}

function getWhisperWorker() {
  if (state.whisper.worker) return state.whisper.worker;
  const worker = new Worker('whisper-worker.js', { type: 'module' });
  worker.onmessage = onWhisperMessage;
  worker.onerror = (e) => {
    console.error('Whisper worker error', e);
    toast('Whisper worker error: ' + (e.message || 'unknown'), 'error');
  };
  state.whisper.worker = worker;
  return worker;
}

function onWhisperMessage(event) {
  const data = event.data || {};
  if (data.type === 'progress') {
    handleWhisperProgress(data);
  } else if (data.type === 'ready') {
    state.whisper.ready = true;
    state.whisper.loading = false;
    state.whisper.loadedModel = `${state.settings.whisperModel}:${state.settings.whisperDtype}`;
    hideModelProgress();
    if (state.recording) dom.transcriptStatus.textContent = 'Listening…';
    // Drain anything queued while loading
    const pending = state.whisper.pending.splice(0);
    for (const audio of pending) sendAudioToWorker(audio);
  } else if (data.type === 'transcript') {
    const text = (data.text || '').trim();
    if (text) appendTranscript(text);
  } else if (data.type === 'error') {
    toast('Whisper: ' + data.message, 'error');
    console.error('Whisper:', data.message);
    state.whisper.loading = false;
  }
}

function handleWhisperProgress(p) {
  // Statuses we get: 'initiate', 'download', 'progress', 'done', 'ready'
  if (p.status === 'progress' && p.total) {
    const pct = Math.max(0, Math.min(100, Math.round((p.loaded / p.total) * 100)));
    showModelProgress(pct, `Downloading ${p.file || 'Whisper'} ${pct}%`);
  } else if (p.status === 'initiate' || p.status === 'download') {
    showModelProgress(0, `Loading ${p.file || 'Whisper'}…`);
  } else if (p.status === 'done') {
    showModelProgress(100, 'Initializing Whisper…');
  } else if (p.status === 'ready') {
    hideModelProgress();
  }
}

function showModelProgress(pct, label) {
  dom.modelProgress.hidden = false;
  dom.modelProgressBar.style.width = pct + '%';
  if (label) dom.transcriptStatus.textContent = label;
}

function hideModelProgress() {
  dom.modelProgress.hidden = true;
  dom.modelProgressBar.style.width = '0%';
}

function ensureWhisperLoaded() {
  const wanted = `${state.settings.whisperModel}:${state.settings.whisperDtype}`;
  if (state.whisper.ready && state.whisper.loadedModel === wanted) return;
  state.whisper.ready = false;
  state.whisper.loading = true;

  if (IS_ELECTRON) {
    // Native path: download model via main process if missing.
    showModelProgress(0, 'Preparing Whisper model…');
    window.crouton
      .ensureModel(state.settings.whisperModel)
      .then(() => {
        state.whisper.ready = true;
        state.whisper.loading = false;
        state.whisper.loadedModel = wanted;
        hideModelProgress();
        if (state.recording) dom.transcriptStatus.textContent = 'Listening…';
        const pending = state.whisper.pending.splice(0);
        for (const audio of pending) sendAudioToWorker(audio);
      })
      .catch((err) => {
        state.whisper.loading = false;
        hideModelProgress();
        toast('Could not prepare Whisper model: ' + (err.message || err), 'error');
        console.error(err);
      });
    return;
  }

  getWhisperWorker().postMessage({
    type: 'load',
    modelId: state.settings.whisperModel,
    dtype: state.settings.whisperDtype,
  });
}

async function startRecording() {
  const note = getActive();
  if (!note) return;

  // Mic permission first — fail fast and don't spin up the worker if denied
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    console.error(e);
    toast('Microphone permission denied or unavailable.', 'error');
    return;
  }

  state.finalTranscript = note.transcript ? note.transcript + ' ' : '';
  state.interimTranscript = '';
  state.audio.chunks = [];
  state.audio.samples = 0;

  // AudioContext — try 16kHz directly; fall back to default and resample on flush.
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: TARGET_SR });
  } catch (_e) {
    ctx = new AudioContext();
  }
  state.audio.ctx = ctx;
  state.audio.stream = stream;
  state.audio.sampleRate = ctx.sampleRate;

  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but ubiquitous; AudioWorklet would need a separate module file.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    // Copy because the underlying buffer is reused
    const copy = new Float32Array(input.length);
    copy.set(input);
    state.audio.chunks.push(copy);
    state.audio.samples += copy.length;
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  state.audio.source = source;
  state.audio.processor = processor;

  // Kick off model load (no-op if already loaded). Audio queues until ready.
  ensureWhisperLoaded();

  // Flush a chunk every CHUNK_SECONDS
  state.audio.intervalId = setInterval(() => flushChunk(false), CHUNK_SECONDS * 1000);

  state.recording = true;
  dom.recordBtn.classList.add('recording');
  dom.recordLabel.textContent = 'Stop';
  dom.transcriptDrawer.classList.add('visible');
  dom.transcriptStatus.textContent = state.whisper.ready ? 'Listening…' : 'Loading Whisper…';
  renderTranscript();
}

function stopRecording() {
  if (state.audio.intervalId) {
    clearInterval(state.audio.intervalId);
    state.audio.intervalId = null;
  }
  // Flush whatever is left
  flushChunk(true);

  const a = state.audio;
  try { a.processor && a.processor.disconnect(); } catch (_e) { /* ignore */ }
  try { a.source && a.source.disconnect(); } catch (_e) { /* ignore */ }
  try { a.ctx && a.ctx.close(); } catch (_e) { /* ignore */ }
  if (a.stream) a.stream.getTracks().forEach((t) => t.stop());
  state.audio = {
    ctx: null, stream: null, source: null, processor: null,
    chunks: [], samples: 0, intervalId: null, sampleRate: TARGET_SR,
  };

  state.recording = false;
  dom.recordBtn.classList.remove('recording');
  dom.recordLabel.textContent = 'Record';
  dom.transcriptStatus.textContent = 'Stopped';
}

function flushChunk(final) {
  const samples = state.audio.samples;
  if (samples === 0) return;
  if (!final && samples < MIN_CHUNK_SAMPLES) return;

  // Concatenate accumulated chunks
  const merged = new Float32Array(samples);
  let offset = 0;
  for (const c of state.audio.chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  state.audio.chunks = [];
  state.audio.samples = 0;

  // Resample to 16 kHz if necessary
  const sr = state.audio.sampleRate;
  const audio = sr === TARGET_SR ? merged : resampleLinear(merged, sr, TARGET_SR);
  if (audio.length < MIN_CHUNK_SAMPLES) return;

  if (state.whisper.ready) sendAudioToWorker(audio);
  else state.whisper.pending.push(audio);
}

function sendAudioToWorker(audio) {
  if (IS_ELECTRON) {
    // Native path — call whisper.cpp in the main process.
    window.crouton
      .transcribe({
        audio,
        sampleRate: 16000,
        language:
          state.settings.whisperLanguage && state.settings.whisperLanguage !== 'auto'
            ? state.settings.whisperLanguage
            : undefined,
        modelKey: state.settings.whisperModel,
      })
      .then((text) => {
        const t = (text || '').trim();
        if (t) appendTranscript(t);
      })
      .catch((err) => {
        toast('Whisper: ' + (err.message || err), 'error');
        console.error('Whisper:', err);
      });
    return;
  }

  // Browser path — send to transformers.js worker (zero-copy).
  state.whisper.worker.postMessage(
    {
      type: 'transcribe',
      audio,
      modelId: state.settings.whisperModel,
      dtype: state.settings.whisperDtype,
      language:
        state.settings.whisperLanguage && state.settings.whisperLanguage !== 'auto'
          ? state.settings.whisperLanguage
          : undefined,
    },
    [audio.buffer]
  );
}

function appendTranscript(text) {
  state.finalTranscript += (state.finalTranscript ? ' ' : '') + text;
  const note = getActive();
  if (note) {
    note.transcript = state.finalTranscript.trim();
    note.updatedAt = Date.now();
    persistNotes();
  }
  renderTranscript();
}

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const newLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function renderTranscript() {
  const finalSpan = document.createElement('span');
  finalSpan.textContent = state.finalTranscript;
  const interimSpan = document.createElement('span');
  interimSpan.className = 'interim';
  interimSpan.textContent = state.interimTranscript;
  dom.transcriptBody.innerHTML = '';
  dom.transcriptBody.appendChild(finalSpan);
  dom.transcriptBody.appendChild(interimSpan);
  dom.transcriptBody.scrollTop = dom.transcriptBody.scrollHeight;
}

/* -----------------------------------------------------------
 * AI Enhancement
 * --------------------------------------------------------- */
async function enhanceNotes() {
  const note = getActive();
  if (!note) return;

  const rawText = htmlToPlain(note.rawNotes || '');
  const transcript = (note.transcript || '').trim();

  if (!rawText && !transcript) {
    toast('Add some notes or record a meeting first.', 'error');
    return;
  }

  if (!state.settings.apiKey) {
    // Fall back to local stub enhancement so demo still works
    const stub = localEnhance(rawText, transcript);
    applyEnhancement(stub);
    toast('No API key set — using offline formatter. Add a key in Settings for AI enhancement.');
    return;
  }

  dom.enhanceBtn.disabled = true;
  dom.enhancedSub.textContent = 'Enhancing…';
  dom.enhancedNotes.innerHTML = '<div class="empty-state"><p class="empty-title">Enhancing your notes…</p><p class="empty-sub">Sending to Claude.</p></div>';

  try {
    const html = await callClaude(rawText, transcript);
    applyEnhancement(html);
    toast('Notes enhanced.');
  } catch (e) {
    console.error(e);
    toast('Enhancement failed: ' + (e.message || 'unknown error'), 'error');
    renderActive();
  } finally {
    dom.enhanceBtn.disabled = false;
  }
}

function applyEnhancement(html) {
  const note = getActive();
  if (!note) return;
  note.enhancedNotes = html;
  note.enhancedAt = Date.now();
  note.updatedAt = Date.now();
  // Promote first heading to title if title is empty
  if (!note.title) {
    const m = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (m) {
      note.title = m[1].trim();
      dom.noteTitle.value = note.title;
    }
  }
  persistNotes();
  renderActive();
  renderNotesList(dom.searchInput.value);
}

async function callClaude(rawText, transcript) {
  const template = (state.settings.template || '').trim() || DEFAULT_TEMPLATE;
  const userContent = [
    'RAW NOTES (what the user wrote):',
    rawText || '(none)',
    '',
    'MEETING TRANSCRIPT (auto-captured):',
    transcript || '(none)',
    '',
    'Produce the final notes in clean markdown, following the template instructions exactly.',
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': state.settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: state.settings.model || 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: template,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const md = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return markdownToHtml(md);
}

/* Minimal local fallback when no API key is present */
function localEnhance(rawText, transcript) {
  const lines = [];
  lines.push('# Meeting notes');
  lines.push('*Auto-formatted locally (no API key set).*');
  lines.push('');
  if (rawText) {
    lines.push('## My notes');
    rawText.split(/\n+/).forEach((l) => {
      const t = l.trim();
      if (t) lines.push(`- ${t}`);
    });
    lines.push('');
  }
  if (transcript) {
    lines.push('## From the transcript');
    const sentences = transcript
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean)
      .slice(0, 8);
    sentences.forEach((s) => lines.push(`- ${s}`));
    lines.push('');
  }
  lines.push('## Action items');
  lines.push('- [ ] Review notes and add owners');
  return markdownToHtml(lines.join('\n'));
}

/* -----------------------------------------------------------
 * Tiny markdown renderer (headings, lists, code, bold/italic, blockquotes)
 * --------------------------------------------------------- */
function markdownToHtml(md) {
  const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, (_, c) => `<code>${escape(c)}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const lines = md.split(/\r?\n/);
  const out = [];
  let listType = null; // 'ul' | 'ol' | null
  let inBlockquote = false;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeBlockquote = () => {
    if (inBlockquote) {
      out.push('</blockquote>');
      inBlockquote = false;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (!line.trim()) {
      closeList();
      closeBlockquote();
      continue;
    }

    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      closeBlockquote();
      const lvl = Math.min(m[1].length, 6);
      out.push(`<h${lvl}>${inline(escape(m[2]))}</h${lvl}>`);
      continue;
    }

    if ((m = line.match(/^>\s?(.*)$/))) {
      closeList();
      if (!inBlockquote) {
        out.push('<blockquote>');
        inBlockquote = true;
      }
      out.push(`<p>${inline(escape(m[1]))}</p>`);
      continue;
    }

    if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      closeBlockquote();
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      const checked = m[1].toLowerCase() === 'x';
      out.push(
        `<li><input type="checkbox" disabled ${checked ? 'checked' : ''} style="margin-right:6px;"/>${inline(escape(m[2]))}</li>`
      );
      continue;
    }

    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      closeBlockquote();
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inline(escape(m[1]))}</li>`);
      continue;
    }

    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      closeBlockquote();
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inline(escape(m[1]))}</li>`);
      continue;
    }

    closeList();
    closeBlockquote();
    out.push(`<p>${inline(escape(line))}</p>`);
  }
  closeList();
  closeBlockquote();
  return out.join('\n');
}

function htmlToPlain(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  // Convert <div> and <p> and <br> to newlines
  tmp.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  tmp.querySelectorAll('p, div, li').forEach((el) => {
    el.appendChild(document.createTextNode('\n'));
  });
  return (tmp.innerText || tmp.textContent || '').trim();
}

/* -----------------------------------------------------------
 * Settings modal
 * --------------------------------------------------------- */
function openSettings() {
  dom.apiKeyInput.value = state.settings.apiKey || '';
  dom.modelSelect.value = state.settings.model || 'claude-sonnet-4-6';
  dom.templateInput.value = state.settings.template || '';
  dom.whisperModelSelect.value = state.settings.whisperModel || 'Xenova/whisper-large-v3';
  dom.whisperDtypeSelect.value = state.settings.whisperDtype || 'q4';
  dom.whisperLanguageSelect.value = state.settings.whisperLanguage || 'en';
  dom.settingsModal.hidden = false;
}

function closeSettings() {
  dom.settingsModal.hidden = true;
}

function saveSettings() {
  const prevModel = state.settings.whisperModel;
  const prevDtype = state.settings.whisperDtype;
  state.settings = {
    apiKey: dom.apiKeyInput.value.trim(),
    model: dom.modelSelect.value,
    template: dom.templateInput.value,
    whisperModel: dom.whisperModelSelect.value,
    whisperDtype: dom.whisperDtypeSelect.value,
    whisperLanguage: dom.whisperLanguageSelect.value,
  };
  persistSettings();
  closeSettings();
  toast('Settings saved.');

  // If the Whisper model changed, drop the worker so the new one loads next time.
  if (
    state.whisper.worker &&
    (prevModel !== state.settings.whisperModel || prevDtype !== state.settings.whisperDtype)
  ) {
    try { state.whisper.worker.postMessage({ type: 'unload' }); } catch (_e) {}
    try { state.whisper.worker.terminate(); } catch (_e) {}
    state.whisper = { worker: null, ready: false, loading: false, loadedModel: null, pending: [] };
  }
}

/* -----------------------------------------------------------
 * Toast
 * --------------------------------------------------------- */
let toastTimer = null;
function toast(msg, kind = 'info') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2800);
}

/* -----------------------------------------------------------
 * Keyboard shortcuts
 * --------------------------------------------------------- */
function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'n') {
      e.preventDefault();
      createNote();
    } else if (mod && e.key === 'k') {
      e.preventDefault();
      dom.searchInput.focus();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      enhanceNotes();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      toggleRecording();
    } else if (e.key === 'Escape' && !dom.settingsModal.hidden) {
      closeSettings();
    }
  });
}

/* -----------------------------------------------------------
 * Wire up
 * --------------------------------------------------------- */
function bindEvents() {
  dom.newNoteBtn.addEventListener('click', createNote);
  dom.settingsBtn.addEventListener('click', openSettings);
  dom.closeSettings.addEventListener('click', closeSettings);
  dom.cancelSettings.addEventListener('click', closeSettings);
  dom.saveSettings.addEventListener('click', saveSettings);

  dom.searchInput.addEventListener('input', (e) => renderNotesList(e.target.value));

  dom.noteTitle.addEventListener('input', scheduleSave);
  dom.rawNotes.addEventListener('input', scheduleSave);

  dom.recordBtn.addEventListener('click', toggleRecording);
  dom.enhanceBtn.addEventListener('click', enhanceNotes);
  dom.closeDrawer.addEventListener('click', () => dom.transcriptDrawer.classList.remove('visible'));
  dom.installBtn.addEventListener('click', triggerInstall);
}

/* -----------------------------------------------------------
 * PWA install + service worker
 * --------------------------------------------------------- */
function registerServiceWorker() {
  if (IS_ELECTRON) return; // Native shell — no PWA service worker needed.
  if (!('serviceWorker' in navigator)) return;
  // Use absolute path within scope so it works under any host path
  navigator.serviceWorker.register('sw.js').catch((err) => {
    console.warn('SW registration failed:', err);
  });
}

function bindInstallPrompt() {
  if (IS_ELECTRON) {
    // Already installed (we ARE the native app).
    dom.installBtn.hidden = true;
    return;
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.install.deferredPrompt = e;
    dom.installBtn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    state.install.deferredPrompt = null;
    dom.installBtn.hidden = true;
    toast('Installed. Launch Crouton from your dock or home screen.');
  });
}

async function triggerInstall() {
  const prompt = state.install.deferredPrompt;
  if (!prompt) {
    toast('Already installed, or your browser doesn\'t support installing this app.');
    return;
  }
  prompt.prompt();
  const choice = await prompt.userChoice;
  state.install.deferredPrompt = null;
  if (choice.outcome === 'accepted') dom.installBtn.hidden = true;
}

function seedIfEmpty() {
  if (state.notes.length === 0) {
    const intro = newNote();
    intro.title = 'Welcome to Crouton';
    intro.rawNotes = `<p>Crouton is a local-first PWA for meeting notes — inspired by Granola.</p>
<p><strong>How it works</strong></p>
<ul>
  <li>Hit <strong>Record</strong>. Your mic audio is transcribed on-device by <strong>Whisper Large v3</strong> running in your browser — no audio ever leaves your machine.</li>
  <li>Type your own notes on the left while you listen.</li>
  <li>Click <strong>Enhance</strong> to turn your raw notes + the transcript into clean, structured meeting notes on the right (uses Claude — add a key in Settings).</li>
  <li>Click <strong>Install</strong> in the sidebar to install Crouton as a standalone app.</li>
</ul>
<p><strong>Shortcuts</strong></p>
<ul>
  <li><code>⌘N</code> new note · <code>⌘K</code> search · <code>⌘⇧R</code> record · <code>⌘⇧E</code> enhance</li>
</ul>
<p>First time you record, the browser downloads the Whisper Large model (≈ 900 MB q4-quantized) and caches it. Subsequent loads are instant and work offline.</p>`;
    intro.enhancedNotes = markdownToHtml(`# Welcome to Crouton
*A local-first PWA meeting notes app with on-device Whisper transcription.*

## Key points
- Two-pane editor: raw notes (left) and AI-enhanced notes (right).
- **On-device** speech-to-text via Whisper Large v3 in a Web Worker — audio never leaves your machine.
- **Installable PWA**: works offline once the app shell and model are cached.
- **Enhance** sends only the text (raw notes + transcript) to Claude for formatting.

## Get started
- [ ] Click **Install** in the sidebar to add Crouton to your dock.
- [ ] (Optional) Add an **Anthropic API key** in Settings to enable AI enhancement.
- [ ] Start a new note with **⌘N**.
- [ ] Hit **Record** — first launch downloads Whisper (~900 MB).

## Notes
- All notes are stored locally in your browser (\`localStorage\`).
- Crouton is independent and not affiliated with Granola.`);
    intro.enhancedAt = Date.now();
    state.notes.push(intro);
    state.activeId = intro.id;
    persistNotes();
    persistActive();
  }
}

const NATIVE_MODEL_OPTIONS = [
  { value: 'large-v3-turbo-q5_0', label: 'Whisper Large v3 Turbo · q5_0 (~550 MB, recommended)' },
  { value: 'large-v3-turbo',     label: 'Whisper Large v3 Turbo (~1.6 GB)' },
  { value: 'large-v3-q5_0',      label: 'Whisper Large v3 · q5_0 (~1.1 GB)' },
  { value: 'large-v3',           label: 'Whisper Large v3 (~3.1 GB, best quality)' },
  { value: 'medium',             label: 'Whisper Medium (~1.5 GB)' },
  { value: 'small',              label: 'Whisper Small (~490 MB)' },
  { value: 'base',               label: 'Whisper Base (~150 MB)' },
];

function applyNativeUiTweaks() {
  if (!IS_ELECTRON) return;

  // Swap dropdown to native ggml model keys
  dom.whisperModelSelect.innerHTML = '';
  for (const o of NATIVE_MODEL_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    dom.whisperModelSelect.appendChild(opt);
  }
  // Hide the dtype select — quantization is baked into the native model file
  const dtypeField = dom.whisperDtypeSelect.closest('label');
  if (dtypeField) dtypeField.hidden = true;

  // Repair stale settings: if the user previously saved a HF repo ID, swap to the native default
  if (!NATIVE_MODEL_OPTIONS.find((o) => o.value === state.settings.whisperModel)) {
    state.settings.whisperModel = 'large-v3-turbo-q5_0';
    persistSettings();
  }

  // Style: tiny "native" badge in the version footer
  if (dom.version) dom.version.textContent = 'v' + VERSION + ' · native';
}

function init() {
  loadAll();
  seedIfEmpty();
  ensureActiveNote();
  dom.version.textContent = 'v' + VERSION;
  applyNativeUiTweaks();
  renderNotesList();
  renderActive();
  bindEvents();
  bindShortcuts();
  bindInstallPrompt();
  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', init);
