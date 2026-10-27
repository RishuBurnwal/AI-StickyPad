# AI-StickyPad

Always-on-top desktop sticky notes for Windows, with **AI rewrite**, **vision**, global hotkeys, click-through mode, and timers. Built on Electron.

**Author:** [RishuBurnwal](https://github.com/RishuBurnwal)  
**Repo:** https://github.com/RishuBurnwal/AI-StickyPad

## Launching

Double-click **`Sticky Notes.vbs`** in this folder (no console window). Only one copy runs at a time. First time: `npm install`, then `npm start` or the VBS launcher.

Quit with the red `✕` on the control bar. To start with Windows: `Win+R` → `shell:startup` → drop a shortcut there.

A small dark bar sits in the top-right. That bar is home base.

## Features

### Notes
- Always-on-top notes (pin off = normal window)
- Drag the top strip to move; drag any edge/corner to resize
- Rich text: bold, italic, underline, strike, highlights, font size (`Aa`, `Ctrl+B`, `Ctrl+H`, Ctrl+wheel)
- Pictures: file picker, paste, or drag-and-drop
- 7-colour palette
- Title field names the window and exported files
- Line-number gutter (Notepad++ style: unselectable, aligned to each line)
- Instant autosave of live markdown to `Notes/live/<id>/note.md` (+ `img/`)
- Undo / redo (`↶ ↷`) for typing and AI applies
- Two-step delete; empty notes delete immediately
- History (`Ctrl+Alt+D`) — restore deleted notes

### AI (`✦` on the bar or a note, or `Ctrl+Alt+Y`)
- **Soul** — always prepended to every request. Edit in **AI → Settings → Soul** (`Notes/Prompt/soul/Soul.md`) or add extra `.md` files in that folder. Also editable on the Prompts tab with folder `soul`.
- **Skills** — reusable prompts (folder `skills`). Built-in **Summarize** (editable/deletable).
- **Custom prompt** — Send button; **Enter** sends, **Ctrl+Enter** new line; menu closes on send; unsent draft is kept if you click outside
- Full-note rewrite **or** cited lines only (`shorten line 2`)
- Response **replaces** the note (or only those lines)
- Images sent as **real pixels** (Gemini `inlineData` / OpenAI `image_url`); markdown `![name](img/file)` in the reply **reloads** the file in the note
- **Key fallback:** extra keys `GEMINI_API_KEY_2` … rotate on 429 / 5xx
- **Provider fallback:** if the chosen API is quota/rate-limited or down, the next provider that still has a key is used automatically
- Keys live in `.env` (never committed). Manage them under Settings → Keys.

### Export (`💾`)
Markdown, PDF, JSON, HTML, plain text under `Notes/saved/<format>/`.  
**Same title overwrites the same file** — no `Note (2).md` spam. If the file is already identical, save is skipped.

### Offline dictation (`🎤` on a note)
Speech-to-text that runs **entirely on your machine** — Hindi, Hinglish (code-switched) and English, no internet, no GPU, no cloud. Your words appear in the note live while you speak; finished sentences are inserted as plain text (undoable like any edit). While an AI answer is in flight, starting to speak **cancels it instantly** (barge-in).

One-time setup (downloads the model once — default `small`, the first size whose Devanagari Hindi is actually good):

```bat
python stt\setup.py          :: or:  python main.py  →  option 4
```

Then tap `🎤` on any note → speak (tap again to stop). Mode & language live on the **bar → 🎙 → Dictation tab** (defaults: both sides + auto-detect). `STT_MODEL` selects `tiny` (fastest) / `base` (faster, weaker Hindi) / `small` (default, best Hindi); `STT_PYTHON` points at the interpreter that has the dependencies if you have several.

**Echo guard** - superseded by **Call mode** below: instead of suppressing speaker audio in the mic, PU and SU are captured on two separate channels, so the call's audio can never contaminate the user's transcript.

### Call mode 📞 — transcribe Zoom / Meet / WhatsApp calls (PU + SU)

Set it on the **bar → 🎙 → AI window → Dictation tab → Listener = Both sides** (or Only speaker), then tap `🎤` on a note. Two independent channels run at once:

- **PU (Primary User)** — your microphone
- **SU (Secondary User)** — the far side of the call, captured digitally from the system mixer (WASAPI loopback via the pure-python `soundcard` package), so it works with any call app and never shares a channel with your voice

Each line lands in the note with a coloured speaker label. Manage speakers under **AI → Speakers**:

- **Rename once, updates everywhere** — labels are keyed in the note; renaming PU/SU rewrites every occurrence in every note instantly
- **Per-speaker colours**, customizable
- **One definable user** — in a meeting, single out one extra speaker by a **cue phrase** (e.g. their name): any call line containing it is tagged with that user instead of SU

Engine: **faster-whisper** (INT8, CPU) + **Silero VAD**, both MIT-licensed and cached in `stt\models\` (≈150 MB total — see `stt\models\README.md`). The original spec named Moonshine, but Moonshine is an English-only ASR model, so a Hindi/Hinglish engine that actually meets "offline + CPU + quantized" was chosen instead.

### Click-through & timers
- `Ctrl+Alt+T` — mouse passes through notes; bar stays clickable
- Bar timer + per-note timers (wall-clock deadline, survives restart)

## Hotkeys (global)

| Hotkey | Action |
| --- | --- |
| `Ctrl+Alt+M` | New note |
| `Ctrl+Alt+H` | Hide / show all notes |
| `Ctrl+Alt+T` | Click-through |
| `Ctrl+Alt+B` | Hide / show the bar |
| `Ctrl+Alt+D` | History |
| `Ctrl+Alt+/` | Cheat sheet |
| `Ctrl+Alt+Y` | AI window |

Hotkeys avoid Latvian AltGr letters. Cheat sheet: `?` on the bar.

## Build

```bat
npm install
npm start
npm run dist
npx electron-builder --win nsis
```

Or `python main.py` (run / portable EXE / NSIS installer). Output is `dist\` as **AI-StickyPad**.

## Layout

| Path | What |
| --- | --- |
| `Notes/live/<id>/note.md` | Instant markdown + `img/` |
| `Notes/Prompt/soul/` | Soul (every AI call) |
| `Notes/Prompt/skills/` | Reusable skills |
| `Notes/saved/<format>/` | 💾 exports (one file per title) |
| `Notes/history/` | Deleted-note copies |
| `stt/` | Offline dictation engine (Python sidecar + `setup.py`) |
| `stt/models/` | Speech models downloaded by setup — git-ignored, never shipped |
| `.env` | API keys |
| `%APPDATA%\ai-stickypad\` | Window store (Electron userData) |

## License

MIT © RishuBurnwal
