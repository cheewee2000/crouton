/* Crouton — menu-bar popover logic */

const dom = {
  setup: document.getElementById('setup'),
  main: document.getElementById('main'),
  settings: document.getElementById('settings'),

  pickVaultBtn: document.getElementById('pick-vault-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsBack: document.getElementById('settings-back'),

  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  statusTime: document.getElementById('status-time'),
  statusRow: document.querySelector('.status-row'),

  titleInput: document.getElementById('title-input'),
  recordBtn: document.getElementById('record-btn'),
  recordLabel: document.getElementById('record-label'),

  modelProgress: document.getElementById('model-progress'),
  modelProgressBar: document.getElementById('model-progress-bar'),
  modelProgressLabel: document.getElementById('model-progress-label'),

  noteMeta: document.getElementById('note-meta'),
  noteName: document.getElementById('note-name'),

  transcriptPreview: document.getElementById('transcript-preview'),

  openNote: document.getElementById('open-note-btn'),
  revealNote: document.getElementById('reveal-note-btn'),
  newSession: document.getElementById('new-session-btn'),

  vaultPath: document.getElementById('vault-path'),
  changeVault: document.getElementById('change-vault'),
  subfolder: document.getElementById('subfolder'),
  whisperModel: document.getElementById('whisper-model'),
  language: document.getElementById('language'),
  ollamaModel: document.getElementById('ollama-model'),
  ollamaHint: document.getElementById('ollama-hint'),
  launchAtLogin: document.getElementById('launch-at-login'),
  diarizeEnabled: document.getElementById('diarize-enabled'),
  hfToken: document.getElementById('hf-token'),
  minSpeakers: document.getElementById('min-speakers'),
  maxSpeakers: document.getElementById('max-speakers'),
  diarizeStatus: document.getElementById('diarize-status'),
};

const state = {
  settings: null,
  info: null,
  session: { active: false },
  currentNote: null,
  summarizing: false,
  timerInterval: null,
};

function show(view) {
  dom.setup.classList.toggle('hidden', view !== 'setup');
  dom.main.classList.toggle('hidden', view !== 'main');
  dom.settings.classList.toggle('hidden', view !== 'settings');
}

async function refresh() {
  const info = await window.crouton.info();
  state.info = info;
  state.settings = info.settings;
  state.session = info.session;

  if (!info.settings.vaultPath) {
    show('setup');
    return;
  }
  show('main');
  applySettingsToUi();
  updateSessionUi();
}

function applySettingsToUi() {
  if (!state.settings) return;
  dom.vaultPath.value = state.settings.vaultPath || '';
  dom.subfolder.value = state.settings.subfolder || '';
  dom.whisperModel.value = state.settings.whisperModel || 'large-v3-turbo-q5_0';
  dom.language.value = state.settings.language || 'en';
  dom.launchAtLogin.checked = !!state.settings.launchAtLogin;
  dom.diarizeEnabled.checked = !!state.settings.diarizeEnabled;
  dom.hfToken.value = state.settings.hfToken || '';
  dom.minSpeakers.value = String(state.settings.minSpeakers || 0);
  dom.maxSpeakers.value = String(state.settings.maxSpeakers || 0);
  updateDiarizeStatus();

  // Populate Ollama model dropdown
  dom.ollamaModel.innerHTML = '';
  const models = (state.info && state.info.ollamaModels) || [];
  if (!state.info || !state.info.ollamaRunning) {
    dom.ollamaHint.textContent = 'Ollama is not running. Run "brew services start ollama" in Terminal.';
    const opt = document.createElement('option');
    opt.value = state.settings.ollamaModel || 'llama3.2:3b';
    opt.textContent = state.settings.ollamaModel || 'llama3.2:3b';
    dom.ollamaModel.appendChild(opt);
  } else if (models.length === 0) {
    dom.ollamaHint.textContent = 'No models installed. Run "ollama pull llama3.2:3b" in Terminal.';
    const opt = document.createElement('option');
    opt.value = state.settings.ollamaModel || 'llama3.2:3b';
    opt.textContent = `${state.settings.ollamaModel || 'llama3.2:3b'} (not installed)`;
    dom.ollamaModel.appendChild(opt);
  } else {
    dom.ollamaHint.textContent = 'Used to generate the meeting summary and action items.';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = `${m.name} · ${(m.size / 1e9).toFixed(1)} GB`;
      dom.ollamaModel.appendChild(opt);
    }
    const want = state.settings.ollamaModel || 'llama3.2:3b';
    if ([...dom.ollamaModel.options].some((o) => o.value === want)) {
      dom.ollamaModel.value = want;
    }
  }
}

function updateSessionUi() {
  const active = state.session && state.session.active;
  dom.statusRow.classList.toggle('recording', !!active);
  dom.recordBtn.classList.toggle('recording', !!active);

  if (active) {
    dom.statusText.textContent = 'Recording';
    dom.recordLabel.textContent = 'Stop recording';
    dom.titleInput.value = state.session.title || dom.titleInput.value || '';
    dom.titleInput.disabled = true;
    dom.noteMeta.hidden = false;
    dom.noteName.textContent = state.session.notePath
      ? state.session.notePath.split('/').pop()
      : 'Recording…';
    state.currentNote = state.session.notePath || null;
    dom.openNote.disabled = !state.currentNote;
    dom.revealNote.disabled = !state.currentNote;
    dom.newSession.disabled = true;

    startTimer(state.session.startedAt);
    if (state.session.transcript) renderTranscript(state.session.transcript, null);
  } else {
    dom.statusText.textContent = state.currentNote ? 'Saved' : 'Ready';
    dom.recordLabel.textContent = 'Start recording';
    dom.titleInput.disabled = false;
    stopTimer();
    dom.statusTime.textContent = '';
    dom.newSession.disabled = state.summarizing ||
      (!state.currentNote && !dom.transcriptPreview.textContent && !dom.titleInput.value);
  }
}

function clearSession() {
  state.currentNote = null;
  state.session = { active: false };
  dom.titleInput.value = '';
  dom.titleInput.disabled = false;
  dom.transcriptPreview.innerHTML = '';
  dom.noteMeta.hidden = true;
  dom.noteName.textContent = '';
  dom.openNote.disabled = true;
  dom.revealNote.disabled = true;
  dom.newSession.disabled = true;
  dom.statusText.textContent = 'Ready';
  dom.statusTime.textContent = '';
  dom.statusRow.classList.remove('recording');
  dom.titleInput.focus();
}

function startTimer(startedAt) {
  stopTimer();
  const tick = () => {
    const ms = Date.now() - startedAt;
    const s = Math.floor(ms / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    dom.statusTime.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };
  tick();
  state.timerInterval = setInterval(tick, 500);
}
function stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}

function renderTranscript(full, latest) {
  dom.transcriptPreview.innerHTML = '';
  if (!full && !latest) return;
  if (latest) {
    const head = (full || '').slice(0, Math.max(0, (full || '').length - latest.length)).trim();
    if (head) {
      const headSpan = document.createElement('span');
      headSpan.textContent = head + ' ';
      dom.transcriptPreview.appendChild(headSpan);
    }
    const latestSpan = document.createElement('span');
    latestSpan.className = 'latest';
    latestSpan.textContent = latest;
    dom.transcriptPreview.appendChild(latestSpan);
  } else {
    dom.transcriptPreview.textContent = full;
  }
  dom.transcriptPreview.scrollTop = dom.transcriptPreview.scrollHeight;
}

// -------------------------------------------------------------
// Actions
// -------------------------------------------------------------
async function pickVault() {
  const s = await window.crouton.pickVault();
  if (s && s.vaultPath) {
    state.settings = s;
    show('main');
    await refresh();
  }
}

async function toggleRecording() {
  if (state.session && state.session.active) {
    dom.recordBtn.disabled = true;
    dom.statusText.textContent = 'Stopping…';
    try {
      const res = await window.crouton.stopSession();
      if (res && res.notePath) state.currentNote = res.notePath;
    } catch (err) {
      console.error(err);
    } finally {
      dom.recordBtn.disabled = false;
    }
  } else {
    dom.recordBtn.disabled = true;
    dom.statusText.textContent = 'Preparing…';
    try {
      const title = (dom.titleInput.value || '').trim();
      const s = await window.crouton.startSession({ title });
      state.session = s;
      updateSessionUi();
    } catch (err) {
      dom.statusText.textContent = 'Error: ' + (err.message || err);
    } finally {
      dom.recordBtn.disabled = false;
    }
  }
}

async function saveCurrentSettings() {
  const patch = {
    subfolder: dom.subfolder.value.trim() || 'Crouton',
    whisperModel: dom.whisperModel.value,
    language: dom.language.value,
    ollamaModel: dom.ollamaModel.value,
    launchAtLogin: dom.launchAtLogin.checked,
    diarizeEnabled: dom.diarizeEnabled.checked,
    hfToken: dom.hfToken.value.trim(),
    minSpeakers: parseInt(dom.minSpeakers.value, 10) || 0,
    maxSpeakers: parseInt(dom.maxSpeakers.value, 10) || 0,
  };
  state.settings = await window.crouton.setSettings(patch);
  updateDiarizeStatus();
}

function updateDiarizeStatus() {
  const el = dom.diarizeStatus;
  if (!el) return;
  el.classList.remove('ok', 'warn', 'err');
  const cli = state.info && state.info.whisperXCli;
  const enabled = !!(state.settings && state.settings.diarizeEnabled);
  const hasToken = !!(state.settings && state.settings.hfToken);

  if (!enabled) {
    el.textContent = 'Diarization is off. Enable it above to label speakers.';
    return;
  }
  if (!cli) {
    el.classList.add('warn');
    el.textContent = 'WhisperX is still installing. Check back in a minute. (uv tool install whisperx)';
    return;
  }
  if (!hasToken) {
    el.classList.add('warn');
    el.textContent = 'Add a HuggingFace token above to download the pyannote model.';
    return;
  }
  el.classList.add('ok');
  el.textContent = `Ready. WhisperX installed at ${cli}.`;
}

// -------------------------------------------------------------
// Wire up
// -------------------------------------------------------------
dom.pickVaultBtn.addEventListener('click', pickVault);
dom.changeVault.addEventListener('click', pickVault);

dom.settingsBtn.addEventListener('click', async () => {
  // Refresh ollama state when opening settings
  const info = await window.crouton.info();
  state.info = info;
  applySettingsToUi();
  show('settings');
});
dom.settingsBack.addEventListener('click', async () => {
  await saveCurrentSettings();
  show('main');
});

dom.recordBtn.addEventListener('click', toggleRecording);

dom.openNote.addEventListener('click', () => state.currentNote && window.crouton.openNote(state.currentNote));
dom.revealNote.addEventListener('click', () => state.currentNote && window.crouton.revealNote(state.currentNote));
dom.newSession.addEventListener('click', clearSession);

// Save settings on change (so they persist across blur-hides)
for (const el of [
  dom.subfolder, dom.whisperModel, dom.language, dom.ollamaModel, dom.launchAtLogin,
  dom.diarizeEnabled, dom.hfToken, dom.minSpeakers, dom.maxSpeakers,
]) {
  const ev = el.type === 'checkbox' ? 'change' : (el.tagName === 'SELECT' ? 'change' : 'input');
  el.addEventListener(ev, saveCurrentSettings);
}
// Token field: save on blur to avoid spamming writes per keystroke
dom.hfToken.addEventListener('blur', saveCurrentSettings);

// External-link clicks (HuggingFace docs) open in the system browser
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-url]');
  if (!link) return;
  e.preventDefault();
  const url = link.dataset.url;
  if (url && window.crouton.openExternal) window.crouton.openExternal(url);
  else if (url) { /* fallback noop in renderer w/o nodeIntegration */ }
});

// Event subscriptions from main
window.crouton.onSessionState((s) => { state.session = s; updateSessionUi(); });
window.crouton.onChunk(({ text, transcript }) => {
  state.session.transcript = transcript;
  renderTranscript(transcript, text);
});
window.crouton.onSummaryStatus(({ status, notePath, message }) => {
  state.summarizing = status !== 'done';
  dom.newSession.disabled = state.summarizing;
  if (status === 'draining') {
    dom.statusText.textContent = 'Finishing transcription…';
    dom.statusRow.classList.remove('recording');
  } else if (status === 'diarizing') {
    dom.statusText.textContent = 'Diarizing speakers…';
    dom.statusRow.classList.remove('recording');
  } else if (status === 'diarize-failed') {
    dom.statusText.textContent = 'Diarization failed; using plain transcript';
    if (message) console.warn('[diarize]', message);
  } else if (status === 'generating') {
    dom.statusText.textContent = 'Summarizing with local LLM…';
    dom.statusRow.classList.remove('recording');
  } else if (status === 'done') {
    dom.statusText.textContent = 'Saved';
    if (notePath) {
      state.currentNote = notePath;
      dom.noteMeta.hidden = false;
      dom.noteName.textContent = notePath.split('/').pop();
      dom.openNote.disabled = false;
      dom.revealNote.disabled = false;
    }
  }
});
window.crouton.onWhisperProgress((p) => {
  if (!p) return;
  if (p.total && p.loaded < p.total) {
    dom.modelProgress.hidden = false;
    const pct = Math.round((p.loaded / p.total) * 100);
    dom.modelProgressBar.style.setProperty('--p', pct + '%');
    dom.modelProgressLabel.textContent = `Downloading model… ${pct}%`;
  } else {
    dom.modelProgress.hidden = true;
  }
});

refresh();
