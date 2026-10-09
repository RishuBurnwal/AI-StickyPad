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
| `.env` | API keys |
| `%APPDATA%\ai-stickypad\` | Window store (Electron userData) |

## License

MIT © RishuBurnwal
