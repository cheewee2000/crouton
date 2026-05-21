/* Crouton — hidden audio-capture renderer
 * Listens for { type: 'start' | 'stop' } from main, captures the mic
 * with Web Audio API, chunks every 15 seconds (configurable), and pushes
 * each chunk to whisper-cli via the preload bridge. Text comes back and
 * is forwarded to the main process to append to the live Obsidian note.
 */

const CHUNK_SECONDS = 15;
const TARGET_SR = 16000;
const MIN_CHUNK_SAMPLES = TARGET_SR * 0.5;

let recording = false;
let audioCtx = null;
let micStream = null;
let sourceNode = null;
let processor = null;
let chunks = [];
let samples = 0;
let sampleRate = TARGET_SR;
let intervalId = null;
// Track every in-flight flushChunk() call so Stop can await them all.
// Without this, a chunk fired by the 15s timer right before the user clicks
// Stop would still be transcribing when we declare done — and its text would
// arrive AFTER the session has been closed, so it'd be silently dropped.
const pendingFlushes = new Set();

async function startRecording() {
  if (recording) return;
  let stream;
  try {
    // Important: disable echoCancellation / noiseSuppression / autoGainControl.
    // We're recording for transcription, not a video call. With echoCancellation
    // on, the ScriptProcessor → ctx.destination loop below (required to make
    // ScriptProcessorNode fire) acts as an echo source — the AEC cancels the
    // mic against its own playback and Whisper ends up with silent buffers,
    // which it hallucinates as "you you you thank you".
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    console.error('[crouton] mic error', err);
    return;
  }

  let ctx;
  try { ctx = new AudioContext({ sampleRate: TARGET_SR }); }
  catch (_e) { ctx = new AudioContext(); }
  audioCtx = ctx;
  micStream = stream;
  sampleRate = ctx.sampleRate;
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch (_e) { /* ignore */ }
  }

  // Log which mic the OS actually gave us, useful when debugging "you you you"
  // hallucinations caused by the wrong (muted/virtual) input being selected.
  try {
    const track = stream.getAudioTracks()[0];
    if (track) console.log('[crouton] mic device:', track.label, '| sampleRate=', ctx.sampleRate);
  } catch {}

  sourceNode = ctx.createMediaStreamSource(stream);
  processor = ctx.createScriptProcessor(4096, 1, 1);
  // Route through a muted gain node so the mic isn't actually played back to
  // the speakers. ScriptProcessorNode still needs *something* downstream of
  // ctx.destination to fire its callback reliably.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  let cbCount = 0;
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    chunks.push(copy);
    samples += copy.length;
    cbCount++;
    if (cbCount === 1) console.log('[crouton] first audioprocess callback fired — mic is live');
    if (cbCount % 200 === 0) console.log(`[crouton] audioprocess callbacks: ${cbCount}`);
  };
  sourceNode.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);

  chunks = [];
  samples = 0;
  recording = true;
  intervalId = setInterval(() => flushChunk(false), CHUNK_SECONDS * 1000);
}

async function stopRecording() {
  if (!recording) return;
  recording = false;
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  // Stop pulling new audio off the mic immediately, so flushChunk(true) gets
  // exactly what's been captured up to this moment and no more.
  try { processor && processor.disconnect(); } catch {}
  try { sourceNode && sourceNode.disconnect(); } catch {}
  if (micStream) micStream.getTracks().forEach((t) => t.stop());

  // Flush whatever has accumulated since the last timer tick.
  await flushChunk(true);

  // Drain anything still being transcribed (e.g. the timer fired ~14.9s into a
  // chunk and the transcribe call is mid-flight when the user clicks Stop).
  if (pendingFlushes.size) await Promise.allSettled([...pendingFlushes]);

  try { audioCtx && audioCtx.close(); } catch {}
  audioCtx = null; micStream = null; sourceNode = null; processor = null;
  chunks = []; samples = 0;
}

async function flushChunk(isFinal) {
  if (samples === 0) return;
  if (!isFinal && samples < MIN_CHUNK_SAMPLES) return;

  const merged = new Float32Array(samples);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  chunks = []; samples = 0;

  const audio = sampleRate === TARGET_SR ? merged : resampleLinear(merged, sampleRate, TARGET_SR);
  if (audio.length < MIN_CHUNK_SAMPLES) return;

  // Log RMS so we can diagnose silent-mic problems. Don't gate on it — that
  // was too aggressive; whisper-cli's --no-speech-thold already handles
  // silence and the hallucination scrubber in main.js catches the rest.
  let sumSq = 0;
  for (let i = 0; i < audio.length; i++) sumSq += audio[i] * audio[i];
  const rms = Math.sqrt(sumSq / audio.length);
  console.log(`[crouton] chunk: ${(audio.length / TARGET_SR).toFixed(1)}s, rms=${rms.toFixed(5)}${isFinal ? ' (final)' : ''}`);

  const work = (async () => {
    try {
      const text = await window.croutonRecorder.transcribe({
        audio,
        sampleRate: TARGET_SR,
      });
      if (text && text.trim()) {
        await window.croutonRecorder.sendChunk(text.trim());
      }
    } catch (err) {
      console.error('transcribe failed:', err);
    }
  })();
  pendingFlushes.add(work);
  work.finally(() => pendingFlushes.delete(work));
  await work;
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

window.croutonRecorder.onCommand(async (cmd) => {
  if (!cmd) return;
  if (cmd.type === 'start') {
    await startRecording();
  } else if (cmd.type === 'stop') {
    try { await stopRecording(); }
    finally {
      // Signal to main that all audio captured before Stop has been
      // transcribed and sent. Only now is it safe to summarize/diarize.
      window.croutonRecorder.reportStopped();
    }
  }
});
