/* Crouton — Whisper worker
 * Loads @huggingface/transformers in a module worker and runs
 * Whisper Large v3 (q4-quantized) for on-device speech recognition.
 *
 * Messages (main → worker):
 *   { type: 'load', modelId, dtype, language }
 *   { type: 'transcribe', audio: Float32Array, language }
 *   { type: 'unload' }
 *
 * Messages (worker → main):
 *   { type: 'progress', status, file, name, loaded, total, progress }
 *   { type: 'ready' }
 *   { type: 'transcript', text }
 *   { type: 'error', message }
 */

import {
  pipeline,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2/+esm';

// Use ONNX models served from the HuggingFace Hub.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.proxy = false;

let pipelinePromise = null;
let currentModelId = null;
let currentDtype = null;

function loadPipeline(modelId, dtype) {
  const id = modelId || 'Xenova/whisper-large-v3';
  const dt = dtype || 'q4';
  if (pipelinePromise && currentModelId === id && currentDtype === dt) {
    return pipelinePromise;
  }
  currentModelId = id;
  currentDtype = dt;
  pipelinePromise = pipeline('automatic-speech-recognition', id, {
    dtype: dt,
    device: 'wasm',
    progress_callback: (p) => {
      self.postMessage({ type: 'progress', ...p });
    },
  }).catch((err) => {
    // Don't cache the failed promise — let the next call retry from scratch.
    pipelinePromise = null;
    currentModelId = null;
    currentDtype = null;
    throw err;
  });
  return pipelinePromise;
}

function describeError(err, modelId) {
  const msg = String((err && err.message) || err);
  if (/Unauthorized|401|404|not found/i.test(msg)) {
    return `Couldn't load "${modelId}" from the Hugging Face Hub. The repo may not exist or may require auth. Try a different model in Settings.`;
  }
  return msg;
}

self.onmessage = async (event) => {
  const data = event.data || {};

  try {
    if (data.type === 'load') {
      await loadPipeline(data.modelId, data.dtype);
      self.postMessage({ type: 'ready' });
      return;
    }

    if (data.type === 'unload') {
      pipelinePromise = null;
      currentModelId = null;
      currentDtype = null;
      self.postMessage({ type: 'unloaded' });
      return;
    }

    if (data.type === 'transcribe') {
      const pipe = await loadPipeline(data.modelId, data.dtype);
      const audio = data.audio; // Float32Array @ 16kHz mono
      if (!audio || audio.length === 0) {
        self.postMessage({ type: 'transcript', text: '' });
        return;
      }
      const result = await pipe(audio, {
        language: data.language || 'en',
        task: 'transcribe',
        return_timestamps: false,
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const text = (result && (result.text || result[0]?.text)) || '';
      self.postMessage({ type: 'transcript', text });
      return;
    }

    self.postMessage({ type: 'error', message: `Unknown message type: ${data.type}` });
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: describeError(err, data.modelId || currentModelId || 'whisper'),
    });
  }
};
