# Crouton

A local-first macOS menu-bar app that captures meetings, transcribes them with **Whisper**, identifies speakers with **WhisperX + pyannote**, summarizes them with a **local Ollama LLM**, and writes the result straight into your **Obsidian vault**.

Nothing leaves your machine — no cloud APIs, no accounts, no telemetry.

**Version:** 0.5.0

## What it does

1. Click the menu bar mic icon → popover opens.
2. Click **Start recording**. Crouton creates a new note in `<your vault>/Crouton/` with empty `## Notes` and `## Status` sections.
3. While recording, you can open the note in Obsidian and type your own thoughts under `## Notes` — those stay verbatim.
4. The popover shows a live transcript (chunked every 15 s, processed by `whisper-cli` with Metal acceleration).
5. Click **Stop**. Crouton:
   - Drains every in-flight transcription chunk so no audio is lost.
   - Re-processes the full session audio through **WhisperX + pyannote** to label `Speaker 1 / Speaker 2 / …`.
   - Sends the diarized transcript + your typed notes to a **local Ollama model** for summarization with checkbox action items.
   - Rewrites the note: your notes preserved verbatim, AI summary in the middle, diarized transcript at the bottom.
6. macOS notification: "Saved: 2026-05-20 14-30 — Recording.md".

## Stack

| Concern | What runs |
| --- | --- |
| App shell | Electron 33, menu-bar only (LSUIElement) |
| Live transcription | `whisper-cli` (Homebrew `whisper-cpp`) with Metal acceleration |
| Speaker diarization | `whisperx` (Python, via `uv`) + `pyannote/speaker-diarization-3.1` |
| Summarization | [Ollama](https://ollama.com) (default model: `llama3.2:3b`) |
| Note destination | Markdown file inside your Obsidian vault |

## Setup

You need a Mac with Apple Silicon and Homebrew.

```bash
# 1) Core dependencies
brew install whisper-cpp ollama ffmpeg uv
brew services start ollama

# 2) Local LLM for summaries
ollama pull llama3.2:3b

# 3) Speaker diarization (Python, isolated)
uv tool install whisperx

# 4) HuggingFace token for pyannote (required for diarization)
#    - Sign in at huggingface.co
#    - Accept terms at:
#      https://huggingface.co/pyannote/segmentation-3.0
#      https://huggingface.co/pyannote/speaker-diarization-3.1
#    - Generate a read token at https://huggingface.co/settings/tokens
#    - Paste it into Crouton → Settings → HuggingFace token
```

## Run

```bash
git clone https://github.com/cheewee2000/crouton.git
cd crouton
npm install
npm start                          # dev mode
# or:
npm run pack                       # builds dist/mac-arm64/Crouton.app
cp -R dist/mac-arm64/Crouton.app /Applications/
```

Once installed, launch from Spotlight (`⌘Space` → "Crouton"). The app lives in the menu bar; there's no Dock icon. Use `⌘ ⇧ \` to toggle the popover from anywhere.

First run prompts you to choose your Obsidian vault. Recordings land in `<vault>/Crouton/<timestamp> — <title>.md`.

## Settings

Open the popover and click the gear icon.

- **Obsidian vault / Subfolder** — where Crouton saves notes.
- **Whisper model** — defaults to `large-v3-turbo-q5_0` (~550 MB, Metal-accelerated). Models download to `~/Library/Application Support/Crouton/models/` on first use.
- **Language** — English by default, or auto-detect.
- **Summary model (Ollama)** — picks from whatever's locally installed.
- **Diarization** — toggle on/off, paste HF token, set min/max speakers.
- **Launch at login** — registers Crouton as a Login Item.

## The note format

```markdown
---
created: 2026-05-20T14:30:00-04:00
tags: [meeting, crouton]
source: crouton
---
# Recording — 2026-05-20 14-30

## Notes
{your verbatim notes from during the meeting}

## Summary
{one-paragraph TL;DR}

## Key points
- ...

## Decisions
- ...

## Action items
- [ ] Owner — what, by when

## Open questions
- ...

## Transcript

**Speaker 1:** ...

**Speaker 2:** ...
```

The LLM is prompted to treat your `## Notes` as a priority signal — anything you wrote down will be reflected in Summary / Action items / etc.

## File layout

```
electron/
  main.js                 — Tray, popover, recorder window, IPC,
                            whisper-cli / whisperx / ollama orchestration
  preload-menubar.js      — bridge for the popover renderer
  preload-recorder.js     — bridge for the hidden audio-capture renderer
  tray-iconTemplate.png   — menu bar icon (template image)
menubar.html / .css / .js — popover UI
recorder.html / .js       — hidden window: getUserMedia → 15s chunks → IPC
package.json              — npm config + electron-builder
legacy/                   — earlier PWA prototype (kept for reference)
```

## Privacy

- Audio is captured by `getUserMedia` in a hidden renderer, chunked, written to a temp WAV, and handed to `whisper-cli` / `whisperx` as a subprocess. None of it is uploaded anywhere.
- The Ollama summary call hits `http://127.0.0.1:11434` — the local Ollama daemon. No outbound network calls from Crouton itself.
- pyannote's diarization model is fetched from HuggingFace **once** (cached afterward).
- All notes are written to your local Obsidian vault.

## Not affiliated with Granola

Crouton is an independent project, not affiliated with Granola.ai. It exists because I wanted Granola's UX without the cloud dependency.
