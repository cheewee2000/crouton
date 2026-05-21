/* Crouton — preload for the hidden audio-capture window */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('croutonRecorder', {
  onCommand: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('recorder:command', h);
    return () => ipcRenderer.off('recorder:command', h);
  },

  // Float32 array (16kHz mono) → main process → whisper-cli → text
  transcribe: ({ audio, sampleRate, language, modelKey }) =>
    ipcRenderer.invoke('whisper:transcribe', {
      audio: audio.buffer ? new Float32Array(audio) : audio,
      sampleRate, language, modelKey,
    }),

  sendChunk: (text) => ipcRenderer.invoke('session:append-chunk', text),

  // Fired after the recorder has fully drained on stop — main process waits
  // for this before triggering diarization/summary so no audio is lost.
  reportStopped: () => ipcRenderer.send('recorder:stopped'),
});
