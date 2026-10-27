'use strict';

// With ELECTRON_RUN_AS_NODE set, Electron boots as plain Node and
// require('electron') hands back a path string instead of the API - every call
// below then dies with an unhelpful "Cannot read properties of undefined".
// Fail loudly and say how to fix it.
const electron = require('electron');
if (typeof electron === 'string' || !electron.app) {
  console.error(
    '[sticky] Cannot start: Electron booted in Node mode.\n'
    + '         ELECTRON_RUN_AS_NODE is set in this environment (VS Code exports it,\n'
    + '         and a launcher that sets it to "" rather than deleting it counts as set).\n'
    + '         Clear it, then relaunch.',
  );
  process.exit(1);
}

const {
  app, BrowserWindow, globalShortcut, ipcMain, screen, Notification, Menu, dialog,
} = electron;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {BrowserWindow|null} */
let bar = null;
/** @type {BrowserWindow|null} */
let help = null;
/** @type {BrowserWindow|null} */
let historyWin = null;
/** @type {BrowserWindow|null} */
let aiWin = null;
/** @type {Map<string, BrowserWindow>} */
const noteWins = new Map();
/** @type {Map<string, object>} */
const noteData = new Map();
/** Deleted notes, newest first - the "history" the user can restore from. */
let archive = [];
let aiPrompts = [];
let aiSettings = { provider: 'gemini', model: '', custom: { baseUrl: '', model: '' } };

let clickThrough = false;   // notes stay visible but mouse passes through to apps below
let notesHidden = false;    // notes hidden by hotkey
let barHidden = false;
let barCollapsed = false;   // bar shrunk to a small handle
/** The bar's expanded bounds, tracked separately so collapsing can't lose them. */
let barBounds = null;

// Speaker labels for transcriptions. PU = this machine's user (mic), SU =
// the far side of a call (loopback). `defined` is the ONE extra user the
// caller may single out by a cue phrase (max one, per design).
const SPEAKER_DEFAULTS = {
  PU: { label: 'PU', color: '#1c60c8' },
  SU: { label: 'SU', color: '#b3170f' },
};
const DEFINED_KEY = 'U1';
let speakerRegistry = { PU: { ...SPEAKER_DEFAULTS.PU }, SU: { ...SPEAKER_DEFAULTS.SU }, defined: null };

// Dictation/call settings, chosen on the MAIN BAR (🎙): listener mode and
// language. Defaults per spec: auto-detect language, both-side listening.
const STT_SETTINGS_DEFAULTS = { listener: 'both', language: 'auto' };
let sttSettings = { ...STT_SETTINGS_DEFAULTS };

function sanitizeSttSettings(raw) {
  const out = { ...STT_SETTINGS_DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (['mic', 'sys', 'both'].includes(raw.listener)) out.listener = raw.listener;
    if (['auto', 'hi', 'en'].includes(raw.language)) out.language = raw.language;
    // cached interpreter for the engine (probe fast-path), tightly validated
    if (Array.isArray(raw.pythonCmd)) {
      const cmd = raw.pythonCmd
        .filter((t) => typeof t === 'string' && t.length >= 1 && t.length <= 200 && !/[\r\n\u0000]/.test(t))
        .slice(0, 4);
      if (cmd.length) out.pythonCmd = cmd;
    }
  }
  return out;
}

function sanitizeSpeakerRegistry(raw) {
  const out = { PU: { ...SPEAKER_DEFAULTS.PU }, SU: { ...SPEAKER_DEFAULTS.SU }, defined: null };
  const cleanLabel = (v) => String(v == null ? '' : v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
    // Angle brackets can never mean anything in a NAME; stripping them keeps
    // labels tidy even though they are only ever rendered via textContent.
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 40);
  const cleanColor = (v, fb) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v) : fb);
  for (const key of ['PU', 'SU']) {
    if (raw && raw[key]) {
      if (typeof raw[key].label === 'string' && raw[key].label.trim()) out[key].label = cleanLabel(raw[key].label);
      out[key].color = cleanColor(raw[key].color, out[key].color);
    }
  }
  if (raw && raw.defined && typeof raw.defined === 'object') {
    const label = cleanLabel(raw.defined.label);
    const cue = String(raw.defined.cue == null ? '' : raw.defined.cue)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
    if (label || cue) {
      out.defined = {
        key: DEFINED_KEY,
        label: label || 'User 1',
        color: cleanColor(raw.defined.color, '#14733a'),
        cue,
      };
    }
  }
  return out;
}

/** Which speaker label does this transcript line belong to? */
function speakerForChannel(ch, text) {
  if (ch !== 'sys') return { key: 'PU', ...speakerRegistry.PU };
  const d = speakerRegistry.defined;
  if (d && d.cue && String(text || '').toLowerCase().includes(d.cue.toLowerCase())) {
    return { key: d.key, label: d.label, color: d.color };
  }
  return { key: 'SU', ...speakerRegistry.SU };
}
// Set once the app is genuinely shutting down. Windows closing during a quit
// must NOT be treated as the user deleting notes.
let quitting = false;
/** The note the user last clicked into — the bar's 🔝 brings this one up. */
let lastActiveNoteId = null;

// Per-window scratch state for custom edge/corner resizing.
/** @type {Map<number, {edge: string, bounds: Electron.Rectangle}>} */
const resizeAnchors = new Map();

// One AbortController per in-flight AI run. Barge-in (the user starting to
// speak while an AI answer is being generated) aborts them all.
const aiRunAborts = new Set();

const PALETTE = ['#ffe9a3', '#ffb8c9', '#a9d9ff', '#b7efc5', '#dbc7ff', '#ffc9a3', '#e6eaee'];
const MIN_W = 216;
const MIN_H = 140;
const DEFAULT_DURATION = 25 * 60 * 1000;
const ARCHIVE_LIMIT = 200;

const ICON = path.join(__dirname, 'icon.ico');
const storeFile = () => path.join(app.getPath('userData'), 'notes.json');
const imagesDir = () => path.join(app.getPath('userData'), 'images');

// ---------------------------------------------------------------------------
// Always-on-top
// ---------------------------------------------------------------------------

/*
 * Windows lets any window claim the top slot. Two windows can both be marked
 * topmost, and whichever one was raised last wins - so a topmost note really can
 * end up behind another topmost window. Setting the flag once at creation (what
 * this app used to do) is therefore not a guarantee, it is a one-off request.
 *
 * Two more things quietly cost us the top slot:
 *   - SetWindowPos with a bounds change resets z-order, and setBounds() is called
 *     every time a note is moved, resized, or the bar collapses;
 *   - the note windows used the weaker 'floating' level while the bar used
 *     'screen-saver', so the app disagreed with itself about what "on top" means.
 *
 * So: one level for everything, re-assert after anything that can reset z-order,
 * and a slow watchdog that puts back whatever slipped.
 */
const ON_TOP_LEVEL = 'screen-saver';
// 400 ms: fast enough that a window which grabs the top slot is pushed back
// before a person notices, slow enough to cost nothing. Anything that re-raises
// faster than this - a native WinEvent hook - needs a native module, which is a
// new dependency and a new failure mode for a cosmetic race.
const KEEP_ON_TOP_MS = 400;

/** Mark a window topmost and, if it is on screen, raise it again. */
function keepOnTop(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(true, ON_TOP_LEVEL);
  } catch (err) {
    return; // window vanished between the checks
  }
  // Harmless no-op on Windows builds that don't implement it; on the ones that
  // do, a 3-finger desktop-switch no longer strands the notes on the old desk.
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (err) { /* platform may not support it */ }
  // moveTop() raises without focusing, so this never steals the user's cursor
  // out of whatever they are typing in.
  if (win.isVisible()) {
    try { win.moveTop(); } catch (err) { /* lost the race with a close */ }
  }
}

/** Release the top slot. Only notes can be unpinned; the bar/help/history never are. */
function dropTop(win) {
  if (!win || win.isDestroyed()) return;
  try { win.setAlwaysOnTop(false); } catch (err) { /* ignore */ }
}

/**
 * Windows 11's 3-finger swipe-down is Show Desktop: every window is minimized.
 * 3-finger left/right switches virtual desktops and can hide the window.
 * The user asked that the bar and notes never vanish for those gestures —
 * only for the Hide button / Ctrl+Alt+H / the bar's own minimise.
 *
 * `wanted` is a function so we re-read the flag at event time (hide notes,
 * then the 'hide' event fires — if we captured the old value we'd fight it).
 */
function reviveIfStolen(win) {
  if (!win || win.isDestroyed() || quitting) return;
  try {
    // restore() plays the Windows minimize/restore animation (the "dip").
    // Show Desktop should never have minimized us (`minimizable: false`);
    // if it hid/cloaked the window, just show it again with no animation.
    if (win.isMinimized()) {
      try { win.setMinimizable(false); } catch (e) { /* ignore */ }
      win.restore();
    }
    if (!win.isVisible()) win.showInactive();
  } catch (err) { /* window vanished between the checks */ }
  keepOnTop(win);
}

function bindStayVisible(win, wanted, { onHide = true } = {}) {
  if (!win) return;
  const bounce = () => {
    if (!wanted()) return;
    // Defer one tick so our own hide()/minimize() (barHidden, notesHidden)
    // can flip the flag before we decide to fight.
    setImmediate(() => { if (wanted()) reviveIfStolen(win); });
  };
  win.on('minimize', bounce);
  // Overlay windows (help/history/AI) are hidden on purpose by their toggle.
  // Show Desktop still *minimizes*, which we bounce. A 'hide' bounce would
  // reopen them the instant the user closed them.
  if (onHide) win.on('hide', bounce);
}

function enforceTop() {
  // Don't fight the user: re-raising a window mid-resize-drag can cancel it.
  if (resizeAnchors.size) return;
  if (bar && !barHidden) reviveIfStolen(bar);
  else keepOnTop(bar);
  // Overlays: only fight Show Desktop (minimized). A user-hidden AI/help
  // window must stay hidden — do not reviveIfStolen() them every 400 ms.
  const overlayTop = (w) => {
    if (!w || w.isDestroyed()) return;
    try {
      if (w.isMinimized()) reviveIfStolen(w);
      else if (w.isVisible()) keepOnTop(w);
    } catch (err) { /* ignore */ }
  };
  overlayTop(help);
  overlayTop(historyWin);
  overlayTop(aiWin);
  // Pinned notes float; UNPINNED notes are normal windows — the user must be
  // able to put them behind other apps, so they are never raised here.
  if (!notesHidden) {
    for (const [id, win] of noteWins) {
      const d = noteData.get(id);
      if (!d || !d.pinned) continue;
      reviveIfStolen(win);
    }
  }
}

// ---------------------------------------------------------------------------
// Where saved notes go
// ---------------------------------------------------------------------------

/*
 * The user asked for saved notes to live in the project instead of AppData.
 * When packaged, __dirname is inside app.asar, which is read-only, so the
 * fallback is the folder holding the EXE (for the portable build, right beside
 * it). Only if neither is writable do we fall back to userData - and we log it,
 * because silently saving somewhere else is how people lose trust in a "save".
 */
const SAVE_FORMATS = [
  { id: 'markdown', label: 'Markdown', ext: 'md' },
  { id: 'pdf', label: 'PDF', ext: 'pdf' },
  { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'html', label: 'HTML', ext: 'html' },
  { id: 'text', label: 'Plain text', ext: 'txt' },
];

let notesRootCache = null;

function notesRoot() {
  if (notesRootCache) return notesRootCache;
  const candidates = app.isPackaged
    ? [path.join(path.dirname(app.getPath('exe')), 'Notes')]
    : [path.join(__dirname, 'Notes')];
  candidates.push(path.join(app.getPath('userData'), 'Notes'));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      notesRootCache = dir;
      return dir;
    } catch (err) {
      console.warn(`[sticky] cannot write saved notes to ${dir}: ${err.message}`);
    }
  }
  notesRootCache = candidates[candidates.length - 1];
  return notesRootCache;
}

// `saved/` is split per format so the folder stays browsable as it fills up.
function historyDir() { return path.join(notesRoot(), 'history'); }
function savedDir(formatId) { return path.join(notesRoot(), 'saved', formatId); }
function promptRoot() { return path.join(notesRoot(), 'Prompt'); }
const DEFAULT_PROMPT_FOLDERS = ['soul', 'skills'];

function ensureNotesFolders() {
  const root = notesRoot();
  fs.mkdirSync(historyDir(), { recursive: true });
  for (const f of SAVE_FORMATS) fs.mkdirSync(savedDir(f.id), { recursive: true });
  for (const folder of DEFAULT_PROMPT_FOLDERS) {
    fs.mkdirSync(path.join(promptRoot(), folder), { recursive: true });
  }
  fs.mkdirSync(path.join(root, 'live'), { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// AI actions — providers, keys, prompts
// ---------------------------------------------------------------------------

/*
 * Keys live in a .env beside the app. When packaged, __dirname is inside
 * app.asar and read-only, so the fallback mirrors notesRoot(): the folder
 * holding the EXE, then userData. The app never logs a key value.
 *
 * Multiple keys per provider are supported: GEMINI_API_KEY,
 * GEMINI_API_KEY_2, GEMINI_API_KEY_3 ... The app rotates to the next key
 * when one hits a rate limit (HTTP 429).
 */
function envPath() {
  return app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), '.env')
    : path.join(__dirname, '.env');
}

function parseEnvFile(raw) {
  const out = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v) out[m[1]] = v;
  }
  return out;
}

function readEnv() {
  try { return parseEnvFile(fs.readFileSync(envPath(), 'utf8')); }
  catch (err) { return {}; } // no .env yet = no keys configured
}

/**
 * Write .env back while preserving comments and the order of the lines —
 * the user edits this file by hand too, and a rewrite that drops their
 * comments would be a small act of vandalism. Keys are updated in place,
 * appended at the end when new.
 */
function writeEnv(updates) {
  const p = envPath();
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (err) { raw = ''; }

  const lines = raw.split(/\r?\n/);
  const pending = { ...updates };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)([A-Za-z0-9_]+)\s*=/);
    if (!m) continue;
    const name = m[2];
    if (!(name in pending)) continue;
    lines[i] = `${name}=${pending[name]}`;
    delete pending[name];
  }
  for (const [name, value] of Object.entries(pending)) {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    // A newline inside a value would inject extra variables into .env
    // (measured in QA 2026-10-27: key "x\nEVIL=1" created EVIL). Flatten.
    lines.push(`${name}=${String(value).replace(/[\r\n\u0000]+/g, ' ')}`);
  }
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
}

const AI_PROVIDERS = {
  gemini: {
    label: 'Google Gemini', envName: 'GEMINI_API_KEY', modelsApi: 'rest',
    // 2026-10-27 live probe: 2.0-flash and flash-latest return HTTP 410 now;
    // 2.5-flash answered in 1.7 s. flash-lite-latest is the cheap fallback.
    defaultModel: 'gemini-2.5-flash',
  },
  groq: {
    label: 'Groq', envName: 'GROQ_API_KEY', modelsApi: 'openai',
    base: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-8b-instant',
  },
  nvidia: {
    label: 'NVIDIA NIM', envName: 'NVIDIA_API_KEY', modelsApi: 'openai',
    base: 'https://integrate.api.nvidia.com/v1', defaultModel: 'meta/llama-3.1-8b-instruct',
  },
  openai: {
    label: 'OpenAI', envName: 'OPENAI_API_KEY', modelsApi: 'openai',
    base: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini',
  },
  perplexity: {
    label: 'Perplexity', envName: 'PERPLEXITY_API_KEY', modelsApi: 'openai',
    base: 'https://api.perplexity.ai/v1', defaultModel: 'sonar',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)', envName: 'CUSTOM_API_KEY', modelsApi: 'openai',
    base: '', defaultModel: '',
  },
};

function keysForProvider(env, provider) {
  const name = AI_PROVIDERS[provider] && AI_PROVIDERS[provider].envName;
  if (!name) return [];
  return [env[name], env[`${name}_2`], env[`${name}_3`], env[`${name}_4`]
    ].filter((k) => typeof k === 'string' && k.length > 0);
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Classify an API failure into something a person can act on. */
function aiErrorInfo(status, body) {
  let apiMessage = '';
  try { apiMessage = body && (body.error && (body.error.message || body.error.status)) || body.message || ''; } catch (err) { /* best effort */ }
  // The provider's own diagnosis is worth showing verbatim — "key invalid" and
  // "key valid but for the wrong project" need different fixes.
  const tail = apiMessage ? ` Provider said: ${String(apiMessage).slice(0, 300)}` : '';
  if (status === 401 || status === 403) return { kind: 'auth', message: 'API key rejected (invalid or revoked). Add a working key in AI settings.' + tail };
  if (status === 429) return { kind: 'rate-limit', message: apiMessage || 'Rate limit hit. If you added multiple keys for this provider, the next one is tried automatically.' };
  if (status === 402 || status === 404 || status === 410) {
    return { kind: 'not-available', message: apiMessage || `Model gone or unavailable (HTTP ${status}). Trying another model/provider.` };
  }
  if (status >= 500) return { kind: 'provider-down', message: `Provider error (HTTP ${status}). Try again shortly.` + tail };
  return { kind: 'http', message: apiMessage || `Request failed (HTTP ${status}).` };
}

/** One tiny authenticated request — is this model alive right now? */
async function aiTestModel({ provider, model, baseUrl }) {
  const t0 = Date.now();
  try {
    const { text } = await aiChat({
      provider, model, baseUrl,
      system: 'You are a connectivity probe. Reply with exactly: OK',
      user: 'ping', maxTokens: 5,
    });
    return { ok: true, latencyMs: Date.now() - t0, reply: String(text || '').slice(0, 40) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, kind: err.kind || 'unknown', message: err.message };
  }
}

async function fetchWithTimeout(url, options, ms = 30000, externalSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  // A caller-side abort (barge-in cancelling an in-flight AI run) and our
  // own timeout both surface as AbortError — keep them distinguishable.
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      throw Object.assign(new Error('Interrupted by your voice (barge-in).'), { kind: 'barge-in' });
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 20)) {
      if (externalSignal && externalSignal.aborted) {
        throw Object.assign(new Error('Interrupted by your voice (barge-in).'), { kind: 'barge-in' });
      }
      throw Object.assign(new Error('The request timed out.'), { kind: 'provider-down' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * The single chat entry point. Tries every configured key for the provider
 * in order; a 429 moves on to the next key, anything else fails fast with a
 * classified error the UI can show as-is.
 */
async function aiChat({ provider, model, baseUrl, system, user, maxTokens, images, signal }) {
  const prov = AI_PROVIDERS[provider];
  if (!prov) throw Object.assign(new Error(`Unknown provider "${provider}"`), { kind: 'config' });
  const keys = keysForProvider(readEnv(), provider);
  if (!keys.length) throw Object.assign(new Error(`No API key configured for ${prov.label}. Add one under AI → Settings → Keys.`), { kind: 'no-key' });

  const geminiAlts = ['gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.0-flash'];
  let lastErr = null;
  for (const key of keys) {
    const tryModels = provider === 'gemini' ? [model, ...geminiAlts.filter((m) => m !== model)] : [model];
    for (let i = 0; i < tryModels.length; i++) {
      try {
        if (provider === 'gemini') return await geminiChat(key, tryModels[i], system, user, maxTokens, images, signal);
        const base = baseUrl || prov.base;
        if (!base) throw Object.assign(new Error('This custom provider has no base URL. Set it in AI → Settings → Custom model.'), { kind: 'config' });
        return await openaiCompatibleChat(base, key, tryModels[i], system, user, maxTokens, images, signal);
      } catch (err) {
        if (err && err.name === 'AbortError') {
          err = Object.assign(new Error('The request timed out. Trying another model/provider.'), { kind: 'provider-down' });
        }
        lastErr = err;
        const retryable = err && (err.kind === 'not-available' || err.kind === 'rate-limit' || err.kind === 'provider-down');
        if (retryable && i < tryModels.length - 1) continue;
        if (retryable && keys.length > 1) break;
        if (retryable) break;
        throw err;
      }
    }
  }
  throw lastErr || new Error('All keys failed.');
}

function shouldFallbackProvider(err) {
  if (!err) return false;
  if (err.kind === 'rate-limit' || err.kind === 'provider-down' || err.kind === 'no-key' || err.kind === 'not-available') return true;
  const msg = String(err.message || '').toLowerCase();
  return /does not exist|model_not_found|not found|quota|resource exhausted|unavailable|high demand|http 410|gone/.test(msg);
}

/**
 * After every key for the chosen provider is exhausted (quota / 429 / 5xx),
 * try every other provider that still has a key. Auth failures stay on the
 * chosen provider so a bad key is not silently swapped.
 */
async function aiChatWithFallback(opts) {
  const env = readEnv();
  const ids = Object.keys(AI_PROVIDERS);
  const order = [opts.provider, ...ids.filter((id) => id !== opts.provider)];
  let lastErr = null;
  for (const provider of order) {
    if (!keysForProvider(env, provider).length) continue;
    const prov = AI_PROVIDERS[provider];
    let model = opts.model;
    let baseUrl = opts.baseUrl;
    if (provider !== opts.provider) {
      if (provider === 'custom') {
        model = (aiSettings.custom && aiSettings.custom.model) || '';
        baseUrl = (aiSettings.custom && aiSettings.custom.baseUrl) || '';
        if (!model || !baseUrl) continue;
      } else {
        model = prov.defaultModel;
        baseUrl = prov.base;
      }
    }
    if (!model) continue;
    try {
      const out = await aiChat({ ...opts, provider, model, baseUrl });
      out.usedProvider = provider;
      out.usedModel = model;
      return out;
    } catch (err) {
      lastErr = err;
      if (err.kind === 'not-available' && prov.defaultModel && model !== prov.defaultModel) {
        try {
          const out = await aiChat({ ...opts, provider, model: prov.defaultModel, baseUrl: baseUrl || prov.base });
          out.usedProvider = provider;
          out.usedModel = prov.defaultModel;
          return out;
        } catch (err2) {
          lastErr = err2;
        }
      }
      if (!shouldFallbackProvider(lastErr)) throw lastErr;
    }
  }
  throw lastErr || new Error('No provider with a working key is available.');
}

function geminiUserParts(user, images) {
  const parts = [{ text: String(user || '') }];
  for (const img of images || []) {
    parts.push({
      text: `\n[Attached image: ${img.name} — look at the pixels, not just the filename]\n`,
    });
    parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
  }
  return parts;
}

async function geminiChat(key, model, system, user, maxTokens, images, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: 'user', parts: geminiUserParts(user, images) }],
    generationConfig: { maxOutputTokens: maxTokens || 4096, temperature: 0.7 },
  };
  if (system) body.systemInstruction = { parts: [{ text: String(system) }] };

  const r = await fetchWithTimeout(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, images && images.length ? 60000 : 20000, signal);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const info = aiErrorInfo(r.status, j);
    throw Object.assign(new Error(info.message), { kind: info.kind, status: r.status });
  }
  const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
  const text = (parts || []).map((p) => p.text || '').join('');
  if (!text) throw Object.assign(new Error('The model answered with an empty response. Try again.'), { kind: 'empty' });
  return { text };
}

async function openaiCompatibleChat(baseUrl, key, model, system, user, maxTokens, images, signal) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const messages = [];
  if (system) messages.push({ role: 'system', content: String(system) });
  if (images && images.length) {
    const content = [{ type: 'text', text: String(user || '') }];
    for (const img of images) {
      content.push({ type: 'text', text: `[Attached image: ${img.name}]` });
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.data}` },
      });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: String(user || '') });
  }

  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens || 4096 }),
  }, images && images.length ? 60000 : 20000, signal);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const info = aiErrorInfo(r.status, j);
    throw Object.assign(new Error(info.message), { kind: info.kind, status: r.status });
  }
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!text) throw Object.assign(new Error('The model answered with an empty response. Try again.'), { kind: 'empty' });
  return { text };
}

async function aiListModels(provider) {
  const prov = AI_PROVIDERS[provider];
  if (!prov) throw new Error(`Unknown provider "${provider}"`);
  const keys = keysForProvider(readEnv(), provider);
  if (!keys.length) throw Object.assign(new Error(`No API key configured for ${prov.label}.`), { kind: 'no-key' });
  const key = keys[0];

  if (provider === 'gemini') {
    const r = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const info = aiErrorInfo(r.status, j); throw Object.assign(new Error(info.message), { kind: info.kind }); }
    const list = (j.models || [])
      .filter((m) => String(m.name || '').includes('models/'))
      .map((m) => m.name.replace(/^models\//, ''));
    return list.slice(0, 120);
  }

  const base = prov.base;
  if (!base) throw Object.assign(new Error('Set the base URL for the custom provider first.'), { kind: 'config' });
  const r = await fetchWithTimeout(`${base.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const info = aiErrorInfo(r.status, j); throw Object.assign(new Error(info.message), { kind: info.kind }); }
  return (j.data || []).map((m) => m.id).filter(Boolean).slice(0, 120);
}

/** A title the user never typed still has to produce a sensible file name. */
function titleFor(data) {
  const typed = String(data.title || '').trim();
  if (typed) return typed;
  const firstLine = String(data.text || '')
    .split('\n').map((l) => l.trim()).find(Boolean);
  if (firstLine) return firstLine.slice(0, 60);
  return `note-${new Date().toISOString().slice(0, 10)}`;
}

/** Strip everything Windows will not accept in a file name. */
function safeFileName(title) {
  let name = String(title || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');          // Windows drops these anyway, which would shift the name
  if (!name) name = 'note';
  if (name.length > 80) name = name.slice(0, 80).trim();
  return name;
}

/** History copies keep a unique name (title + timestamp). */
function uniquePath(dir, base, ext) {
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${base}.${ext}`);
  let n = 2;
  while (fs.existsSync(file)) {
    file = path.join(dir, `${base} (${n}).${ext}`);
    n += 1;
  }
  return file;
}

/** 💾 export: same title → same file (overwrite), never Note (2).md. */
function titledSavePath(dir, base, ext) {
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${base}.${ext}`);
}

// ---------------------------------------------------------------------------
// Turning a note into each format
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * HTML -> Markdown for the tag set this editor can actually produce:
 * the execCommand formatting, lists, links, images and highlighted spans.
 *
 * This runs in the main process, which has no DOM, so it is a regex pass rather
 * than a parse. It is deliberately conservative: anything it does not recognise
 * keeps its text and loses its markup, instead of emitting broken Markdown.
 */
function htmlToMarkdown(html) {
  let s = String(html || '');

  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // Block-level media and rules first, so they are not eaten by the inline pass.
  s = s.replace(/<hr\b[^>]*>/gi, '\n\n---\n\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<img\b[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi, (m, src) => {
    let name = 'image';
    try {
      const raw = decodeURIComponent(String(src).replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1'));
      name = path.basename(raw.replace(/\\/g, '/')) || 'image';
    } catch (err) { name = 'image'; }
    return `\n\n![${name}](img/${name})\n\n`;
  });
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (m, href, label) => `[${label.replace(/<[^>]+>/g, '')}](${href})`);

  // Highlighted text has no Markdown equivalent; ==x== is the common extension
  // and renders in GitHub, Obsidian and most editors. execCommand runs in
  // styleWithCSS mode, so the value is `background-color: rgb(255, 224, 102);` -
  // commas and a trailing semicolon included, which the value pattern must allow.
  s = s.replace(/<(?:span|font)\b[^>]*style\s*=\s*["'][^"']*background-color\s*:[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|font)>/gi,
    (m, inner) => `==${inner}==`);

  s = s.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  s = s.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');
  s = s.replace(/<(?:s|strike|del)\b[^>]*>([\s\S]*?)<\/(?:s|strike|del)>/gi, '~~$1~~');
  s = s.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, '<u>$1</u>');   // no Markdown equivalent
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (m, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${inner}\n\n`);

  // Lists. The editor has no indent control, so one level is all it can make;
  // a deeper list still keeps its text, just flattened.
  s = s.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, kind, inner) => {
    let n = 0;
    const ordered = kind.toLowerCase() === 'ol';
    const body = inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (mm, item) => {
      n += 1;
      return `\n${ordered ? `${n}. ` : '- '}${item.replace(/<[^>]+>/g, '').trim()}`;
    });
    return `\n${body.replace(/<[^>]+>/g, '')}\n`;
  });
  s = s.replace(/<\/?li\b[^>]*>/gi, '\n');       // an <li> with no list around it

  s = s.replace(/<\/(?:div|p|blockquote)>/gi, '\n');
  s = s.replace(/<(?:div|p|blockquote)\b[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');                 // whatever is left is markup we don't model
  s = decodeEntities(s);

  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim() + '\n';
}

/** "line 12", "lines 10-14", "L3, L8" → 1-based line numbers. */
function parseLineRefs(text) {
  const set = new Set();
  const src = String(text || '');
  const addRange = (a, b) => {
    let lo = Number(a);
    let hi = b == null || b === '' ? lo : Number(b);
    if (!Number.isFinite(lo) || lo < 1) return;
    if (!Number.isFinite(hi)) hi = lo;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    hi = Math.min(hi, lo + 400);
    for (let n = lo; n <= hi; n++) set.add(n);
  };
  let m;
  const re = /\blines?\s*(?:no\.?|number|#)?\s*(\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?/gi;
  while ((m = re.exec(src))) addRange(m[1], m[2]);
  const reL = /\bL(\d+)(?:\s*[-–—]\s*L?(\d+))?/g;
  while ((m = reL.exec(src))) addRange(m[1], m[2]);
  return [...set].sort((a, b) => a - b);
}

function extractNumberedLines(md, nums) {
  const rows = String(md || '').replace(/\n$/, '').split('\n');
  return nums.map((n) => `${n}: ${rows[n - 1] == null ? '' : rows[n - 1]}`).join('\n');
}

function applyNumberedLinePatch(md, reply) {
  const rows = String(md || '').replace(/\n$/, '').split('\n');
  const re = /(?:^|\n)(\d+):\s?(.*)/g;
  let m;
  const found = [];
  while ((m = re.exec(String(reply || '')))) found.push({ n: Number(m[1]), text: m[2] });
  if (!found.length) {
    // Single-line edit: the whole reply replaces the only mentioned line if the
    // caller already narrowed the request; otherwise leave the note unchanged.
    return String(md || '');
  }
  for (const { n, text } of found) {
    if (n < 1) continue;
    while (rows.length < n) rows.push('');
    rows[n - 1] = text;
  }
  return rows.join('\n') + '\n';
}

function inlineMarkdown(s) {
  let t = escapeHtml(s);
  t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  t = t.replace(/\*(.+?)\*/g, '<i>$1</i>');
  t = t.replace(/~~(.+?)~~/g, '<s>$1</s>');
  t = t.replace(/`(.+?)`/g, '<code>$1</code>');
  return t;
}

function resolveNoteImageSrc(src, data) {
  const raw = String(src || '').trim();
  if (/^(file:|data:)/i.test(raw)) return raw;
  const name = path.basename(raw.replace(/\\/g, '/'));
  if (!name || !data) return raw;
  try { return pathToFileURL(path.join(noteImgDir(data), name)).href; } catch (err) { return raw; }
}

function inlineMarkdownWithImages(s, data) {
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let last = 0;
  let html = '';
  let m;
  while ((m = re.exec(s))) {
    html += inlineMarkdown(s.slice(last, m.index));
    html += `<img src="${resolveNoteImageSrc(m[2], data)}" alt="${escapeHtml(m[1])}">`;
    last = m.index + m[0].length;
  }
  html += inlineMarkdown(s.slice(last));
  return html;
}

function noteLiveDir(data) {
  return path.join(notesRoot(), 'live', String(data && data.id ? data.id : 'note'));
}
function noteImgDir(data) {
  return path.join(noteLiveDir(data), 'img');
}

function markdownToHtml(md, data) {
  let s = String(md || '').replace(/\r\n/g, '\n');
  const noteTitle = data ? String(titleFor(data) || '').trim() : '';
  if (noteTitle && s.startsWith(`# ${noteTitle}`)) {
    s = s.replace(/^# [^\n]+\n+/, '');
  }
  const lines = s.replace(/\n$/, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (img) {
      out.push(`<div><img src="${resolveNoteImageSrc(img[2], data)}" alt="${escapeHtml(img[1])}"></div>`);
      i += 1;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inlineMarkdownWithImages(h[2], data)}</h${lvl}>`);
      i += 1;
      continue;
    }
    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(`<li>${inlineMarkdownWithImages(lines[i].replace(/^[-*] /, ''), data)}</li>`);
        i += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(`<li>${inlineMarkdownWithImages(lines[i].replace(/^\d+\. /, ''), data)}</li>`);
        i += 1;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    out.push(`<div>${inlineMarkdownWithImages(line, data)}</div>`);
    i += 1;
  }
  return out.join('') || '<div><br></div>';
}

function readPromptFolderText(folder, cap) {
  const dir = path.join(promptRoot(), folder);
  if (!fs.existsSync(dir)) return '';
  let acc = '';
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /\.md$/i.test(n)).sort(); } catch (err) { return ''; }
  for (const name of names) {
    let body = '';
    try { body = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (err) { continue; }
    const chunk = `### ${name.replace(/\.md$/i, '')}\n${body.trim()}\n`;
    if (acc.length + chunk.length > cap) break;
    acc += chunk;
  }
  return acc.trim();
}

function writeLiveMarkdown(data, mdOpt) {
  if (!data || !data.id) return;
  try {
    ensureNotesFolders();
    const dir = noteLiveDir(data);
    fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
    const md = mdOpt != null ? mdOpt : htmlToMarkdown(data.html);
    const title = titleFor(data);
    fs.writeFileSync(path.join(dir, 'note.md'), `# ${title}\n\n${md}`, 'utf8');
  } catch (err) {
    console.warn('[sticky] live markdown save failed:', err.message);
  }
}

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
};
const MAX_AI_IMAGES = 8;
const MAX_AI_IMAGE_BYTES = 3.5 * 1024 * 1024;

function fileFromImgSrc(src) {
  if (!src) return null;
  try {
    if (/^file:/i.test(src)) return fileURLToPath(src);
  } catch (err) { /* fall through */ }
  const cleaned = String(src).replace(/^file:\/\//i, '');
  if (/^[A-Za-z]:[\\/]/.test(cleaned) || cleaned.startsWith('\\\\')) return cleaned;
  return null;
}

/** Load the note's actual image files so the model can see them, not just the names. */
/** Real image? Answered from the file's magic bytes, not its name — a junk
 * file renamed .png otherwise rides to the provider as "image/png" and fails
 * the whole request (measured in QA: "Unable to process input image"). */
function imageMagicMime(buf) {
  const starts = (sig, off = 0) => sig.every((b, i) => buf[off + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';         // GIF8
  if (starts([0x42, 0x4d])) return 'image/bmp';                      // BM
  if (starts([0x52, 0x49, 0x46, 0x46]) && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function collectNoteImages(data, { onlyNames } = {}) {
  const out = [];
  const seen = new Set();
  const allow = onlyNames && onlyNames.length
    ? new Set(onlyNames.map((n) => String(n).toLowerCase()))
    : null;

  const addFile = (abs) => {
    if (!abs || out.length >= MAX_AI_IMAGES) return;
    let resolved;
    try { resolved = path.resolve(abs); } catch (err) { return; }
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const name = path.basename(resolved);
    if (allow && !allow.has(name.toLowerCase())) return;
    let buf;
    try {
      const st = fs.statSync(resolved);
      if (!st.isFile() || st.size < 8 || st.size > MAX_AI_IMAGE_BYTES) return;
      buf = fs.readFileSync(resolved);
    } catch (err) { return; }
    const mime = imageMagicMime(buf);
    if (!mime) return;  // junk/wrong-content file: skip it, never fail the run
    out.push({ name, mime, data: buf.toString('base64') });
  };

  const html = (data && data.html) || '';
  const re = /<img\b[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) addFile(fileFromImgSrc(m[1]));

  if (data) {
    const dir = noteImgDir(data);
    if (fs.existsSync(dir)) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (err) { names = []; }
      for (const name of names) addFile(path.join(dir, name));
    }
  }
  return out;
}

function noteJson(data) {
  return JSON.stringify({
    title: titleFor(data),
    text: data.text || '',
    html: data.html || '',
    color: data.color || null,
    fontSize: data.fontSize || null,
    pinned: data.pinned !== false,
    savedAt: new Date().toISOString(),
    noteId: data.id || null,
  }, null, 2);
}

/** A self-contained page: the saved HTML and the printed PDF are the same document. */
function standaloneHtml(data) {
  const title = titleFor(data);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body {
    margin: 0;
    padding: 34px 40px 60px;
    background: #fff;
    color: #222;
    font-family: "Segoe UI", system-ui, sans-serif;
    font-size: ${Math.max(11, Math.min(28, data.fontSize || 14))}px;
    line-height: 1.5;
  }
  h1.title {
    margin: 0 0 4px;
    font-size: 1.6em;
    line-height: 1.25;
    word-wrap: break-word;
  }
  .meta { margin: 0 0 22px; color: #888; font-size: .78em; }
  .note { word-wrap: break-word; }
  .note img { max-width: 100%; height: auto; border-radius: 5px; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
<h1 class="title">${escapeHtml(title)}</h1>
<p class="meta">Saved ${new Date().toLocaleString()}</p>
<div class="note">${data.html || ''}</div>
</body>
</html>
`;
}

// printToPDF renders the page itself; an offscreen window keeps that off-screen
// and out of the user's way. No dependency: Electron ships this.
async function writePdf(file, html) {
  const tmp = path.join(app.getPath('temp'), `sticky-print-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, sandbox: true },
  });
  try {
    // loadFile rather than a data: URL so file:// images inside the note resolve.
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    fs.writeFileSync(file, pdf);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try { fs.unlinkSync(tmp); } catch (err) { /* temp file is disposable */ }
  }
}

async function saveNoteAs(data, format) {
  ensureNotesFolders();
  const base = safeFileName(titleFor(data));
  const file = titledSavePath(savedDir(format.id), base, format.ext);

  let body = null;
  if (format.id === 'markdown') body = htmlToMarkdown(data.html);
  else if (format.id === 'json') body = noteJson(data);
  else if (format.id === 'html') body = standaloneHtml(data);
  else if (format.id !== 'pdf') body = String(data.text || '');

  if (body != null && fs.existsSync(file)) {
    let prev = '';
    try { prev = fs.readFileSync(file, 'utf8'); } catch (err) { prev = ''; }
    if (prev === body) return { file, skipped: true };
  }

  if (format.id === 'pdf') await writePdf(file, standaloneHtml(data));
  else fs.writeFileSync(file, body, 'utf8');

  return { file, skipped: false };
}

/** Keep a readable copy of every deleted note, next to the live ones. */
function writeHistoryFile(entry) {
  try {
    ensureNotesFolders();
    const when = new Date(entry.deletedAt || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} `
      + `${p(when.getHours())}-${p(when.getMinutes())}-${p(when.getSeconds())}`;
    const file = uniquePath(historyDir(), `${safeFileName(titleFor(entry))} (${stamp})`, 'md');
    const header = `# ${titleFor(entry)}\n\n_Deleted ${when.toLocaleString()}_\n\n`;
    fs.writeFileSync(file, header + htmlToMarkdown(entry.html), 'utf8');
    return file;
  } catch (err) {
    // Never let a full disk or a locked folder stop the user deleting a note.
    console.error('[sticky] could not write the history copy:', err);
    return null;
  }
}

/*
 * Global hotkeys. Change them here - the labels in help.html and README.md are
 * the only other places they appear.
 *
 * IMPORTANT: Windows reports AltGr as Ctrl+Alt, and a global shortcut swallows
 * the combo system-wide. So any Ctrl+Alt+<letter> we take is a letter the user
 * can no longer type with AltGr, in ANY app. The Latvian layout puts its
 * diacritics on AltGr + a c e g i k l n o r s u z - all of those are off
 * limits. Safe letters: b d f h j m p q t v w x y.
 */
const HOTKEYS = {
  newNote:     'CommandOrControl+Alt+M',   // "Make" - N would eat ņ
  toggleHide:  'CommandOrControl+Alt+H',
  clickThrough:'CommandOrControl+Alt+T',   // "Through" - C would eat č
  toggleBar:   'CommandOrControl+Alt+B',
  history:     'CommandOrControl+Alt+D',
  help:        'CommandOrControl+Alt+/',
  ai:          'CommandOrControl+Alt+Y',   // "AI" — Y is safe (not on the Latvian AltGr row)
};

// Offered in the duration picker, in minutes.
const DURATIONS = [1, 2, 3, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120];

function durationLabel(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m) return `${h} h ${m} min`;
  return h === 1 ? '1 hour' : `${h} hours`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let saveTimer = null;

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

function saveNow() {
  clearTimeout(saveTimer);
  const payload = {
    version: 2,
    clickThrough,
    barCollapsed,
    bar: barBounds,
    notes: [...noteData.values()],
    archive,
    aiPrompts,
    aiSettings,
    speakerRegistry,
    sttSettings,
  };
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[sticky] save failed:', err);
  }
}

function loadStore() {
  let raw;
  try {
    raw = fs.readFileSync(storeFile(), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[sticky] could not read store:', err);
    return { notes: [] };
  }

  try {
    // Strip a UTF-8 BOM: any editor or script that rewrites this file by hand
    // can leave one behind, and JSON.parse rejects it.
    const parsed = JSON.parse(raw.replace(/^﻿/, ''));
    if (parsed && Array.isArray(parsed.notes)) {
      if (!Array.isArray(parsed.archive)) parsed.archive = [];
      return parsed;
    }
    throw new Error('store has no notes array');
  } catch (err) {
    // Never start empty on top of a file we failed to understand - that would
    // silently destroy every note the moment we next save.
    const backup = storeFile().replace(/\.json$/, `.corrupt-${Date.now()}.json`);
    try {
      fs.copyFileSync(storeFile(), backup);
      console.error(`[sticky] unreadable store (${err.message}); kept a copy at ${backup}`);
    } catch (copyErr) {
      console.error('[sticky] unreadable store and the backup failed too:', copyErr);
    }
    return { notes: [] };
  }
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function newId() {
  return `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** Move a deleted note into history. Blank notes aren't worth keeping. */
function archiveNote(data) {
  if (!data) return;
  const hasText = String(data.text || '').trim().length > 0;
  const hasImage = /<img\b/i.test(data.html || '');
  if (!hasText && !hasImage) return;

  const entry = { ...data, deletedAt: Date.now(), key: `${data.id}@${Date.now()}` };
  archive.unshift(entry);
  if (archive.length > ARCHIVE_LIMIT) archive.length = ARCHIVE_LIMIT;
  // Also drop a readable copy in Notes/history, so the history survives outside
  // the app. archive[] stays the source of truth for Restore.
  writeHistoryFile(entry);
  saveSoon();
  pushHistory();
}

function pushHistory() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.webContents.send('history:changed', archive);
  }
  pushState();
}

/** Escape plain text from a v1 store into the rich-text body used from v2 on. */
function textToHtml(text) {
  const esc = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split('\n').map((line) => `<div>${line || '<br>'}</div>`).join('');
}

/** Keep a note fully on some connected display, cascading new notes so they don't stack. */
function defaultBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const step = (noteData.size % 8) * 26;
  // Wide enough that the whole 13-button toolbar (incl. 🎤) fits on one row
  // and the close button is never clipped (measured: toolbar needs ~296 px).
  return {
    x: area.x + 80 + step,
    y: area.y + 80 + step,
    width: 340,
    height: 280,
  };
}

function clampToDisplay(b) {
  const nearest = screen.getDisplayMatching(b).workArea;
  const width = Math.max(MIN_W, Math.round(b.width));
  const height = Math.max(MIN_H, Math.round(b.height));
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(b.x, nearest.x - width + 60), nearest.x + nearest.width - 60)),
    y: Math.round(Math.min(Math.max(b.y, nearest.y), nearest.y + nearest.height - 40)),
  };
}

function createNote(seed = {}, { focus = false } = {}) {
  const bounds = clampToDisplay({ ...defaultBounds(), ...seed });
  const data = {
    id: seed.id || newId(),
    // `html` is the source of truth (bold, highlights, images); `text` is the
    // plain-text shadow kept for previews and notification labels.
    html: seed.html != null ? seed.html : textToHtml(seed.text),
    text: seed.text || '',
    // Optional. When it is blank, saving falls back to the first line of the
    // text so a file still gets a name the user recognises.
    title: typeof seed.title === 'string' ? seed.title : '',
    color: PALETTE.includes(seed.color) ? seed.color : PALETTE[0],
    fontSize: Math.min(28, Math.max(11, seed.fontSize || 14)),
    // Normal window by default: only a user-pinned note floats above apps.
    pinned: seed.pinned === true,
    // Each note owns an independent countdown. `deadline` is an absolute
    // timestamp, so a timer left running survives an app restart.
    timer: seed.timer || {
      enabled: false,
      durationMs: DEFAULT_DURATION,
      remainingMs: DEFAULT_DURATION,
      deadline: null,
      finished: false,
    },
    ...bounds,
  };

  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: data.color,
    icon: ICON,
    title: data.title || 'Sticky note',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: true,
    },
  });

  noteWins.set(data.id, win);
  noteData.set(data.id, data);

  if (data.pinned) keepOnTop(win);
  // The Show-Desktop revive is a PINNED-note behaviour; an unpinned note is
  // a normal window and may be minimized/covered like any other.
  if (data.pinned) bindStayVisible(win, () => !quitting && !notesHidden && noteWins.has(data.id));
  if (clickThrough) win.setIgnoreMouseEvents(true, { forward: true });

  const syncBounds = () => {
    const d = noteData.get(data.id);
    if (!d || win.isDestroyed()) return;
    Object.assign(d, win.getBounds());
    // Moving or resizing a window goes through SetWindowPos, which resets the
    // z-order - so a note could drop behind after nothing but a drag. Put it
    // back straight away rather than waiting up to a second for the watchdog.
    if (d.pinned) keepOnTop(win);
    saveSoon();
  };
  win.on('moved', syncBounds);
  win.on('resized', syncBounds);

  // Coming back from hidden, or from behind another window, is exactly when the
  // top slot needs claiming again.
  win.on('show', () => { if (noteData.get(data.id)?.pinned) keepOnTop(win); });
  win.on('blur', () => { if (noteData.get(data.id)?.pinned) keepOnTop(win); });

  win.on('closed', () => {
    resizeAnchors.delete(win.id);
    // During a quit every window closes; that is not the user deleting notes.
    // Without this guard a Windows shutdown would archive and then erase them.
    if (quitting) return;
    archiveNote(noteData.get(data.id));
    noteWins.delete(data.id);
    noteData.delete(data.id);
    // Closing the note that was dictating stops dictation — the mic cannot
    // feed a window that no longer exists.
    if (stt.activeNoteId === data.id) sttStop();
    saveSoon();
    pushState();
  });

  win.loadFile(path.join(__dirname, 'note.html'), { query: { id: data.id } });
  win.once('ready-to-show', () => {
    if (!notesHidden) win.show();
    if (focus && !clickThrough && !notesHidden) {
      win.focus();
      win.webContents.send('note:focus-text');
    }
  });

  // Track the note the user last worked in — the bar's 🔝 raises this one.
  win.on('focus', () => { lastActiveNoteId = data.id; });

  saveSoon();
  pushState();
  return win;
}

function eachNote(fn) {
  for (const win of noteWins.values()) if (!win.isDestroyed()) fn(win);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function setNotesHidden(hidden) {
  notesHidden = hidden;
  eachNote((win) => (hidden ? win.hide() : win.showInactive()));
  pushState();
}

function setClickThrough(on) {
  clickThrough = on;
  // Notes let the mouse pass straight through to whatever app is underneath,
  // but stay visible. `forward: true` keeps hover events flowing so the note
  // still repaints normally.
  eachNote((win) => win.setIgnoreMouseEvents(on, { forward: true }));
  if (on) eachNote((win) => win.blur());
  saveSoon();
  pushState();
}

function pushState() {
  if (bar && !bar.isDestroyed()) {
    bar.webContents.send('state', {
      clickThrough,
      notesHidden,
      noteCount: noteWins.size,
      helpOpen: !!(help && !help.isDestroyed()),
      historyOpen: !!(historyWin && !historyWin.isDestroyed()),
      historyCount: archive.length,
    });
  }
  pushAiPrompts();
}

function pushAiPrompts() {
  if (aiWin && !aiWin.isDestroyed()) aiWin.webContents.send('ai:prompts-changed', aiPrompts);
}

// ---------------------------------------------------------------------------
// Control bar
// ---------------------------------------------------------------------------

const BAR_W = 690;
const BAR_H = 66;
const PILL_W = 52;
const PILL_H = 44;

/**
 * Collapse the bar down to a small handle instead of hiding it outright, so it
 * stays reachable with a click rather than only via a remembered hotkey.
 */
function setBarCollapsed(on) {
  if (!bar || bar.isDestroyed()) return;
  barCollapsed = on;

  const current = bar.getBounds();
  if (!on && !barBounds) barBounds = current;
  const area = screen.getDisplayMatching(current).workArea;

  const width = on ? PILL_W : BAR_W;
  const height = on ? PILL_H : BAR_H;
  // Keep the right edge planted so a right-docked bar collapses "into" itself.
  const right = current.x + current.width;
  const x = Math.min(Math.max(right - width, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(current.y, area.y), area.y + area.height - height);

  bar.setMinimumSize(width, height);
  bar.setMaximumSize(width, height);
  bar.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  // Collapsing is a resize, and a resize resets z-order: without this the bar
  // can drop behind the taskbar or any other topmost window.
  keepOnTop(bar);

  if (!on) barBounds = bar.getBounds();
  bar.webContents.send('collapsed', on);
  saveSoon();
}

function createBar(saved, collapsed) {
  const area = screen.getPrimaryDisplay().workArea;
  const width = BAR_W;
  const height = BAR_H;
  // The bar is the app's only permanent control surface, so unlike a note it is
  // kept entirely inside the work area - never tucked behind the taskbar.
  let bounds = { x: area.x + area.width - width - 24, y: area.y + 24, width, height };
  if (saved && Number.isFinite(saved.x)) {
    const near = screen.getDisplayMatching({ ...saved, width, height }).workArea;
    bounds = {
      width,
      height,
      x: Math.round(Math.min(Math.max(saved.x, near.x), near.x + near.width - width)),
      y: Math.round(Math.min(Math.max(saved.y, near.y), near.y + near.height - height)),
    };
  }

  barBounds = { ...bounds };

  bar = new BrowserWindow({
    ...bounds,
    minWidth: width,
    minHeight: height,
    maxWidth: width,
    maxHeight: height,
    frame: false,
    // Resizable so the collapse/expand calls can change the size; the min/max
    // pair still pins it to exactly one size at a time.
    resizable: true,
    maximizable: false,
    minimizable: false,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#1b1d21',
    icon: ICON,
    title: 'AI-StickyPad',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  keepOnTop(bar);
  bindStayVisible(bar, () => !quitting && !barHidden && bar && !bar.isDestroyed());
  bar.loadFile(path.join(__dirname, 'bar.html'));
  bar.once('ready-to-show', () => {
    bar.show();
    if (collapsed) setBarCollapsed(true);
    keepOnTop(bar);
    pushState();
  });
  // The bar is the app's control surface: it has no off switch, so it reclaims
  // the top slot on every show and whenever it loses focus.
  bar.on('show', () => keepOnTop(bar));
  bar.on('blur', () => keepOnTop(bar));
  bar.on('moved', () => {
    if (!barCollapsed && bar && !bar.isDestroyed()) barBounds = bar.getBounds();
    saveSoon();
  });
  bar.on('closed', () => { bar = null; });
}

// ---------------------------------------------------------------------------
// History (deleted notes)
// ---------------------------------------------------------------------------

function toggleHistory() {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.close();
    return;
  }

  const anchor = bar && !bar.isDestroyed() ? bar.getBounds() : screen.getPrimaryDisplay().workArea;
  const area = screen.getDisplayMatching(anchor).workArea;
  const width = 430;
  const height = Math.min(560, area.height - 40);

  let y = anchor.y + (anchor.height || 0) + 12;
  if (y + height > area.y + area.height - 10) y = anchor.y - height - 12;
  y = Math.min(Math.max(y, area.y + 10), area.y + area.height - height - 10);
  const x = Math.min(Math.max(anchor.x, area.x + 10), area.x + area.width - width - 10);

  historyWin = new BrowserWindow({
    width,
    height,
    x: Math.round(x),
    y: Math.round(y),
    minWidth: 320,
    minHeight: 240,
    frame: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#1b1d21',
    icon: ICON,
    title: 'AI-StickyPad - History',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  keepOnTop(historyWin);
  bindStayVisible(historyWin, () => !quitting && historyWin && !historyWin.isDestroyed(), { onHide: false });
  historyWin.loadFile(path.join(__dirname, 'history.html'));
  historyWin.once('ready-to-show', () => {
    historyWin.show();
    keepOnTop(historyWin);
    historyWin.focus();
  });
  historyWin.on('show', () => keepOnTop(historyWin));
  historyWin.on('blur', () => keepOnTop(historyWin));
  historyWin.on('closed', () => { historyWin = null; pushState(); });
  pushState();
}

// ---------------------------------------------------------------------------
// Help / cheat sheet
// ---------------------------------------------------------------------------

function closeHelp() {
  if (help && !help.isDestroyed()) help.close();
  help = null;
}

function toggleHelp() {
  if (help && !help.isDestroyed()) return closeHelp();

  const anchor = bar && !bar.isDestroyed() ? bar.getBounds() : screen.getPrimaryDisplay().workArea;
  const area = screen.getDisplayMatching(anchor).workArea;
  const width = 470;
  const height = Math.min(580, area.height - 40);

  // Sit under the bar, but flip above it when the bar lives near the bottom of
  // the screen - otherwise the sheet ends up behind the taskbar.
  let y = anchor.y + (anchor.height || 0) + 12;
  if (y + height > area.y + area.height - 10) y = anchor.y - height - 12;
  y = Math.min(Math.max(y, area.y + 10), area.y + area.height - height - 10);

  const x = Math.min(Math.max(anchor.x + (anchor.width - width) / 2, area.x + 10),
    area.x + area.width - width - 10);

  help = new BrowserWindow({
    width,
    height,
    x: Math.round(x),
    y: Math.round(y),
    frame: false,
    resizable: true,
    minWidth: 380,
    minHeight: 260,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#1b1d21',
    icon: ICON,
    title: 'AI-StickyPad - Help',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  keepOnTop(help);
  bindStayVisible(help, () => !quitting && help && !help.isDestroyed(), { onHide: false });
  help.loadFile(path.join(__dirname, 'help.html'));
  help.once('ready-to-show', () => {
    help.show();
    keepOnTop(help);
    help.focus();
  });
  help.on('show', () => keepOnTop(help));
  help.on('blur', () => keepOnTop(help));
  help.on('closed', () => { help = null; pushState(); });
  pushState();
}

// ---------------------------------------------------------------------------
// AI window (prompt library + settings)
// ---------------------------------------------------------------------------

function createAiWindow() {
  if (aiWin && !aiWin.isDestroyed()) { aiWin.show(); aiWin.focus(); return; }
  aiWin = new BrowserWindow({
    title: 'AI-StickyPad — AI',
    width: 430, height: 580,
    frame: false, transparent: true, resizable: true,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  keepOnTop(aiWin);
  bindStayVisible(aiWin, () => !quitting && aiWin && !aiWin.isDestroyed() && aiWin.isVisible(), { onHide: false });
  // Click anywhere else (another note, the desktop, the bar) dismisses it —
  // same idea as the save-format menu closing when you click outside.
  let aiBlurTimer = null;
  aiWin.on('blur', () => {
    clearTimeout(aiBlurTimer);
    aiBlurTimer = setTimeout(() => {
      if (quitting || !aiWin || aiWin.isDestroyed()) return;
      if (!aiWin.isFocused()) aiWin.hide();
    }, 120);
  });
  aiWin.on('focus', () => clearTimeout(aiBlurTimer));
  aiWin.on('closed', () => { aiWin = null; });
  aiWin.loadFile(path.join(__dirname, 'ai.html'));
}

function aiWindow() {
  if (aiWin && !aiWin.isDestroyed()) { aiWin.show(); aiWin.focus(); return aiWin; }
  createAiWindow();
  return aiWin;
}

function toggleAiWindow() {
  if (aiWin && !aiWin.isDestroyed() && aiWin.isVisible()) aiWin.hide();
  else aiWindow();
}

// ---------------------------------------------------------------------------
// AI actions — IPC
// ---------------------------------------------------------------------------

function sanitizePromptText(s) {
  return String(s || '').trim().slice(0, 4000);
}

function sanitizePromptFolder(s) {
  const name = safeFileName(s).toLowerCase();
  return name || 'skills';
}

function promptRelPath(folder, title) {
  return `${sanitizePromptFolder(folder)}/${safeFileName(title)}.md`.replace(/\\/g, '/');
}

function promptAbs(rel) {
  return path.join(promptRoot(), rel);
}

function removePromptFile(rel) {
  if (!rel) return;
  try {
    const abs = promptAbs(rel);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch (err) {
    console.warn('[sticky] could not remove prompt file', rel, err.message);
  }
}

function writePromptFile(p) {
  const rel = promptRelPath(p.folder, p.title);
  const abs = promptAbs(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, p.prompt, 'utf8');
  if (p.file && p.file !== rel) removePromptFile(p.file);
  p.file = rel;
  return rel;
}

function listPromptFolders() {
  const folders = new Set(DEFAULT_PROMPT_FOLDERS);
  for (const p of aiPrompts) folders.add(sanitizePromptFolder(p.folder));
  try {
    if (fs.existsSync(promptRoot())) {
      for (const ent of fs.readdirSync(promptRoot(), { withFileTypes: true })) {
        if (ent.isDirectory()) folders.add(ent.name);
      }
    }
  } catch (err) { /* folder listing is best-effort */ }
  return Array.from(folders).sort();
}

/** Pull any .md files the user dropped into Notes/Prompt/<folder>/ that we don't know yet. */
function importPromptFiles() {
  let root;
  try { root = promptRoot(); } catch (err) { return; }
  if (!fs.existsSync(root)) return;
  const known = new Set(aiPrompts.map((p) => String(p.file || '').replace(/\\/g, '/')));
  let changed = false;
  let folders;
  try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch (err) { return; }
  for (const ent of folders) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    let files;
    try { files = fs.readdirSync(dir); } catch (err) { continue; }
    for (const name of files) {
      if (!/\.md$/i.test(name)) continue;
      const rel = `${ent.name}/${name}`.replace(/\\/g, '/');
      if (known.has(rel)) continue;
      let text;
      try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (err) { continue; }
      const title = name.replace(/\.md$/i, '');
      aiPrompts.push({
        id: newId(),
        title,
        prompt: sanitizePromptText(text),
        folder: ent.name,
        file: rel,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      known.add(rel);
      changed = true;
    }
  }
  if (changed) saveSoon();
}

function ensureBuiltinPrompts() {
  const exists = aiPrompts.some((p) => String(p.title || '').trim().toLowerCase() === 'summarize');
  if (exists) return;
  const row = {
    id: newId(),
    title: 'Summarize',
    folder: 'skills',
    prompt: 'Summarize this entire note into short bullet points. Keep every image as `![name](img/name)` on its own line in the same relative place. Output markdown only — no commentary.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  try { writePromptFile(row); } catch (err) { /* still keep it in memory */ }
  aiPrompts.push(row);
  saveSoon();
  pushAiPrompts();
}

function soulDir() { return path.join(promptRoot(), 'soul'); }
function soulMainFile() { return path.join(soulDir(), 'Soul.md'); }

const OLD_DEFAULT_SOUL = 'You are a careful editor for this sticky note. Keep the user\'s voice and facts. Do not invent details. Preserve every ![name](img/file) image path exactly.';
const DEFAULT_SOUL = [
  'You help with this sticky note.',
  'If the user asks you to write, draft, or compose something (letter, application, email, essay, etc.), produce the full usable text. Fill reasonable placeholders (date, name, school) rather than leaving the note empty.',
  'If they ask to edit existing note content, keep their voice and facts; do not invent events they did not mention.',
  'Never dump leftover instructions or fake image markdown like ![name](img/file) into the note. Only keep real image paths that already exist in the note.',
].join(' ');

function ensureBuiltinSoul() {
  try {
    fs.mkdirSync(soulDir(), { recursive: true });
    const file = soulMainFile();
    const names = fs.readdirSync(soulDir()).filter((n) => /\.md$/i.test(n));
    if (!names.length) {
      fs.writeFileSync(file, `${DEFAULT_SOUL}\n`, 'utf8');
      return;
    }
    if (names.length === 1 && names[0].toLowerCase() === 'soul.md' && fs.existsSync(file)) {
      const cur = fs.readFileSync(file, 'utf8').trim();
      if (cur === OLD_DEFAULT_SOUL) fs.writeFileSync(file, `${DEFAULT_SOUL}\n`, 'utf8');
    }
  } catch (err) { /* first-run soul is best-effort */ }
}

ipcMain.handle('ai:soul:get', () => {
  try { ensureNotesFolders(); ensureBuiltinSoul(); } catch (err) { /* */ }
  return { ok: true, text: readPromptFolderText('soul', 8000), file: soulMainFile() };
});
ipcMain.handle('ai:soul:set', (_e, { text } = {}) => {
  try {
    ensureNotesFolders();
    fs.mkdirSync(soulDir(), { recursive: true });
    const body = String(text || '').trim();
    fs.writeFileSync(soulMainFile(), body ? `${body}\n` : '', 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('ai:prompts:list', () => aiPrompts);
ipcMain.handle('ai:prompts:folders', () => listPromptFolders());

ipcMain.on('ai:prompts:save', (event, { id, title, prompt, folder } = {}) => {
  const clean = sanitizePromptText(prompt);
  const name = String(title || '').trim().slice(0, 80) || 'Untitled prompt';
  const folderName = sanitizePromptFolder(folder || 'skills');
  if (!clean) return;
  try { ensureNotesFolders(); } catch (err) { /* still save in memory */ }
  if (id) {
    const p = aiPrompts.find((x) => x.id === id);
    if (p) {
      p.title = name;
      p.prompt = clean;
      p.folder = folderName;
      p.updatedAt = Date.now();
      try { writePromptFile(p); } catch (err) { console.warn('[sticky] prompt file write failed:', err.message); }
      saveSoon(); pushAiPrompts(); return;
    }
  }
  const row = { id: newId(), title: name, prompt: clean, folder: folderName, createdAt: Date.now(), updatedAt: Date.now() };
  try { writePromptFile(row); } catch (err) { console.warn('[sticky] prompt file write failed:', err.message); }
  aiPrompts.push(row);
  saveSoon(); pushAiPrompts();
});

ipcMain.on('ai:prompts:delete', (_event, id) => {
  const victim = aiPrompts.find((p) => p.id === id);
  const before = aiPrompts.length;
  aiPrompts = aiPrompts.filter((p) => p.id !== id);
  if (aiPrompts.length !== before) {
    if (victim) removePromptFile(victim.file);
    saveSoon(); pushAiPrompts();
  }
});

ipcMain.handle('ai:settings:get', () => {
  const env = readEnv();
  return {
    settings: aiSettings,
    providers: Object.entries(AI_PROVIDERS).map(([id, p]) => ({
      id, label: p.label, defaultModel: p.defaultModel,
      keyCount: keysForProvider(env, id).length,
    })),
  };
});

ipcMain.on('ai:settings:set', (_event, patch) => {
  if (!patch || typeof patch !== 'object') return;
  if (patch.provider && AI_PROVIDERS[patch.provider]) aiSettings.provider = patch.provider;
  if (typeof patch.model === 'string') aiSettings.model = patch.model;
  if (patch.custom && typeof patch.custom === 'object') {
    aiSettings.custom = { ...aiSettings.custom, ...patch.custom };
  }
  saveSoon();
});

ipcMain.handle('ai:keys:list', () => {
  const env = readEnv();
  return Object.entries(AI_PROVIDERS).map(([id, p]) => ({
    id, label: p.label,
    keys: keysForProvider(env, id).map(maskKey),
  }));
});

ipcMain.on('ai:keys:add', (_event, { provider, key } = {}) => {
  const prov = AI_PROVIDERS[provider];
  if (!prov || !key) return;
  const env = readEnv();
  const existing = keysForProvider(env, provider);
  const suffix = existing.length === 0 ? '' : `_${existing.length + 1}`;
  const varName = `${prov.envName}${suffix}`;
  writeEnv({ [varName]: String(key).trim() });
  if (aiWin && !aiWin.isDestroyed()) aiWin.webContents.send('ai:keys-changed');
});

ipcMain.on('ai:keys:remove', (_event, { provider, index } = {}) => {
  const prov = AI_PROVIDERS[provider];
  if (!prov || typeof index !== 'number') return;
  const names = [prov.envName, `${prov.envName}_2`, `${prov.envName}_3`, `${prov.envName}_4`];
  const varName = names[index];
  if (!varName) return;
  const p = envPath();
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (err) { return; }
  const lines = raw.split(/\r?\n/).filter((l) => !l.match(new RegExp(`^\\s*${varName}\\s*=`)));
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  if (aiWin && !aiWin.isDestroyed()) aiWin.webContents.send('ai:keys-changed');
});

ipcMain.handle('ai:models:fetch', async (_event, provider) => {
  try {
    if (provider === 'custom') {
      const base = (aiSettings.custom && aiSettings.custom.baseUrl || '').trim();
      if (!base) return { ok: false, message: 'Set the base URL for the custom provider first.' };
      const env = readEnv();
      const keys = keysForProvider(env, 'custom');
      if (!keys.length) return { ok: false, message: 'No API key configured for Custom provider. Add one under Keys.' };
      const r = await fetchWithTimeout(`${base.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${keys[0]}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const info = aiErrorInfo(r.status, j); return { ok: false, message: info.message }; }
      return { ok: true, models: (j.data || []).map((m) => m.id).filter(Boolean).slice(0, 120) };
    }
    const models = await aiListModels(provider);
    return { ok: true, models };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('ai:model:test', async (_event, { provider, model, baseUrl }) => {
  const prov = AI_PROVIDERS[provider];
  const effectiveModel = model || (prov && prov.defaultModel) || '';
  if (!effectiveModel) return { ok: false, message: 'No model specified.' };
  return aiTestModel({ provider, model: effectiveModel, baseUrl });
});

ipcMain.handle('ai:run', async (event, { prompt, content } = {}) => {
  const t0 = Date.now();
  // Arm barge-in: while this request is in flight the speech engine is told
  // "AI is speaking", so the user starting to talk cancels it mid-flight.
  const runAbort = new AbortController();
  aiRunAborts.add(runAbort);
  sttEngineTell({ type: 'state', ai_speaking: true });
  try {
    const { data } = senderNote(event);
    const instruction = String(prompt || '').trim();
    if (!instruction) return { ok: false, message: 'Empty prompt.' };

    const prov = AI_PROVIDERS[aiSettings.provider];
    const isCustom = aiSettings.provider === 'custom';
    const model = isCustom
      ? (aiSettings.custom.model || '')
      : (aiSettings.model || (prov && prov.defaultModel) || '');
    if (!model) throw Object.assign(new Error('No model configured. Set one in AI → Settings.'), { kind: 'config' });

    const md = data ? htmlToMarkdown(data.html) : String(content || '');
    const hasNote = !!(data && ((data.text && data.text.trim()) || /<img\b/i.test(data.html || '')));
    const lineNums = parseLineRefs(instruction);
    const wantFull = /\bsummari[sz]e|summerize|full note|pura notes\b/i.test(instruction);
    const wantCompose = !hasNote || /\b(write|draft|compose|generate|create|make|likh|application|letter|essay|email|mail|leave)\b/i.test(instruction);
    const useLines = lineNums.length > 0 && !wantFull && !wantCompose && hasNote;

    let nameFilter = null;
    if (useLines) {
      const slice = extractNumberedLines(md, lineNums);
      nameFilter = [...slice.matchAll(/!\[[^\]]*\]\(img\/([^)]+)\)/g)].map((x) => path.basename(x[1]));
    }
    const images = data ? collectNoteImages(data, { onlyNames: nameFilter && nameFilter.length ? nameFilter : null }) : [];
    // Line edits with no image on those lines: skip pixels (tokens). Full/summarize: send every image.

    const soul = readPromptFolderText('soul', 2500);
    const chunks = [];
    chunks.push(instruction);
    if (hasNote) {
      if (useLines) {
        chunks.push(
          '## Selected lines only (1-based). Reply with ONLY those lines as `N: replacement text`.\n'
          + extractNumberedLines(md, lineNums),
        );
      } else if (!wantCompose) {
        chunks.push(
          '## Note (markdown). Reply with the full updated markdown.'
          + (images.length ? ' Keep existing `![name](img/file)` paths.\n' : '\n')
          + md,
        );
      } else {
        chunks.push('## Current note (optional context — write the requested document even if this is empty)\n' + (md || '(empty)'));
      }
    }
    if (images.length) {
      chunks.push(
        `## Images\n${images.length} image file(s) are attached as real pixels (not just names): `
        + images.map((i) => i.name).join(', ')
        + '. Look at each image when you rewrite or summarize.',
      );
    }

    const systemBits = [];
    if (soul) systemBits.push(soul);
    if (useLines) {
      systemBits.push('You edit only the numbered lines you were given. Output ONLY `N: text` lines. No commentary, no fences, no other lines.');
      if (images.length) systemBits.push('Attached images belong to those lines — use what you see in them.');
    } else if (wantCompose) {
      systemBits.push('The user wants you to WRITE a document. Output ONLY that document as Markdown. No HTML, no fences, no commentary, no headings named Soul or Instruction. Do not paste these system rules into the note. Do not insert fake image markdown.');
    } else {
      systemBits.push('You rewrite the existing note as Markdown. Output ONLY markdown — no HTML, no fences, no commentary.');
      systemBits.push(images.length ? 'Preserve existing ![alt](img/...) paths.' : 'Do not invent image markdown.');
    }
    const system = systemBits.join('\n');

    const { text, usedProvider, usedModel } = await aiChatWithFallback({
      provider: aiSettings.provider,
      model,
      baseUrl: isCustom ? aiSettings.custom.baseUrl : undefined,
      system,
      user: chunks.join('\n\n'),
      images,
      signal: runAbort.signal,
    });

    let reply = String(text || '').trim();
    reply = reply.replace(/^```(?:markdown|md|html)?\s*/i, '').replace(/```\s*$/, '');
    reply = reply.replace(/^##\s*(Soul|Instruction)\s*$/gmi, '').trim();
    if (!images.length) {
      reply = reply.replace(/!\[[^\]]*\]\(\s*img\/[^)]+\)\s*/g, '').trim();
    }

    let newMd;
    if (useLines) {
      newMd = applyNumberedLinePatch(md, reply);
      if (lineNums.length === 1 && !/(?:^|\n)\d+:/m.test(reply)) {
        const rows = md.replace(/\n$/, '').split('\n');
        const n = lineNums[0];
        while (rows.length < n) rows.push('');
        rows[n - 1] = reply.split('\n')[0];
        newMd = rows.join('\n') + '\n';
      }
    } else {
      newMd = reply.endsWith('\n') ? reply : `${reply}\n`;
    }

    const html = markdownToHtml(newMd, data);
    if (data) {
      data.html = html;
      data.text = newMd.replace(/!\[[^\]]*\]\([^)]+\)/g, '').replace(/[#*_`]/g, '');
      writeLiveMarkdown(data, newMd);
      saveSoon();
    }
    return {
      ok: true, html, markdown: newMd, mode: useLines ? 'lines' : 'full',
      lines: lineNums, imagesSent: images.map((i) => i.name),
      usedProvider: usedProvider || aiSettings.provider,
      usedModel: usedModel || model,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    return { ok: false, message: err.message, kind: err.kind };
  } finally {
    aiRunAborts.delete(runAbort);
    sttEngineTell({ type: 'state', ai_speaking: false });
  }
});

ipcMain.on('ai:open', () => aiWindow());
ipcMain.on('ai:toggle', () => toggleAiWindow());
ipcMain.on('ai:close', () => { if (aiWin && !aiWin.isDestroyed()) aiWin.hide(); });

// ---------------------------------------------------------------------------
// Offline speech-to-text (Python sidecar)
// ---------------------------------------------------------------------------

/*
 * Dictation (🎤 on a note) runs in stt/engine.py: mic capture, Silero VAD
 * and faster-whisper (INT8, CPU — Hindi, Hinglish code-switching, English)
 * all live in Python, out of this process. The protocol is one JSON object
 * per line over stdio, both directions.
 *
 * Python is discovered lazily: the first candidate whose
 * `engine.py --check-runtime` exits 0 wins, so a machine with several
 * Pythons (some without the deps) still works. If none passes, the mic
 * menu says exactly how to set up instead of failing silently.
 */
// Dictation language/mode selection moved to the MAIN BAR (🎙 panel) —
// the note's 🎤 is only an on/off toggle (stt:toggle).
const stt = {
  proc: null,          // the child, once spawned
  ready: false,
  spawning: null,      // in-flight spawn guard (two notes must not double-spawn)
  pythonCmd: null,     // verified winner of the interpreter probe
  pythonProbed: false,
  activeNoteId: null,  // the note currently dictating — one mic, one note
  mode: null,          // 'dictation' | 'call'
  listener: null,      // 'mic' | 'sys' | 'both'
  starting: false,     // tap seen, engine still probing/loading
  engineFile: null,    // staged engine.py path (set before probing)
  engineDir: null,
  readyWaiters: [],
  readyReject: null,
  stderrTail: [],
};

let sttFilesStaged = null; // promise resolving to the stt dir (or null on failure)

function copySttTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let names;
  try { names = fs.readdirSync(src); } catch (err) { return; }
  for (const name of names) {
    // models are downloaded per machine, never shipped; pycache is build junk
    if (name === '__pycache__' || name === 'models') continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    let st;
    try { st = fs.statSync(s); } catch (err) { continue; }
    if (st.isDirectory()) copySttTree(s, d);
    else {
      try { if (fs.statSync(d).size === st.size) continue; } catch (err) { /* not there yet */ }
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * Where the engine script really lives. Dev: the repo's stt/ folder.
 * Packaged: python cannot read inside app.asar, so the stt/ code is staged
 * out to real files once — beside the EXE when that is writable (portable
 * build: models live next to the app), else userData. The asar copy is the
 * source of truth; an already-staged copy is refreshed in place.
 */
function ensureSttFiles() {
  if (!app.isPackaged) return Promise.resolve(path.join(__dirname, 'stt'));
  if (sttFilesStaged) return sttFilesStaged;
  sttFilesStaged = (async () => {
    const src = path.join(app.getAppPath(), 'stt');
    const candidates = [
      path.join(path.dirname(app.getPath('exe')), 'stt'),
      path.join(app.getPath('userData'), 'stt'),
    ];
    for (const dest of candidates) {
      try {
        copySttTree(src, dest);
        if (fs.existsSync(path.join(dest, 'engine.py'))) return dest;
      } catch (err) {
        console.warn(`[stt] cannot stage the engine at ${dest}:`, err.message);
      }
    }
    return null;
  })();
  sttFilesStaged.catch(() => { /* callers see null */ });
  return sttFilesStaged;
}

function sttModelChoice() {
  return ['tiny', 'base', 'small'].includes(process.env.STT_MODEL) ? process.env.STT_MODEL : 'small';
}

function sttPythonCandidates() {
  const out = [];
  if (process.env.STT_PYTHON) out.push(process.env.STT_PYTHON.trim().split(/\s+/).filter(Boolean));
  out.push(['python'], ['py', '-3.14'], ['py', '-3.13'], ['py', '-3.12'], ['py'], ['python3']);
  return out;
}

/** exit 0 from `engine.py --check-runtime` = this interpreter has the deps.
 * All candidates are probed IN PARALLEL — on a busy machine a sequential
 * chain can take minutes, and a slow-but-working interpreter used to be
 * declared "no setup" (15 s timeout) purely because imports were slow. */
function sttProbePython(cmd, engineFile) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd[0], [...cmd.slice(1), engineFile, '--check-runtime'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch (err) { resolve(false); return; }
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (err) { /* already gone */ }
      finish(false);
    }, 60000);   // slow machines: imports alone can take >30 s
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  });
}

async function sttFindPython() {
  const dir = await ensureSttFiles();
  if (!dir) {
    stt.pythonProbed = true;   // nothing to probe against
    return null;
  }
  stt.engineDir = dir;
  stt.engineFile = path.join(dir, 'engine.py');
  if (stt.pythonProbed) return stt.pythonCmd;
  stt.pythonProbed = true;
  // Fast path: the interpreter that worked last time (saved in the store).
  // Probing every candidate costs 20-60 s on a busy machine — every start.
  const cached = sttSettings.pythonCmd;
  if (cached && Array.isArray(cached) && cached.length) {
    // eslint-disable-next-line no-await-in-loop
    if (await sttProbePython(cached, stt.engineFile)) {
      stt.pythonCmd = cached;
      return stt.pythonCmd;
    }
  }
  const candidates = sttPythonCandidates();
  const results = await Promise.all(candidates.map((cmd) => sttProbePython(cmd, stt.engineFile)));
  const winner = candidates[results.indexOf(true)];
  if (winner) {
    stt.pythonCmd = winner;
    sttSettings.pythonCmd = winner;
    saveSoon();
  }
  return stt.pythonCmd;
}

function sttWrite(obj) {
  if (stt.proc && stt.proc.exitCode === null) {
    try { stt.proc.stdin.write(`${JSON.stringify(obj)}\n`); } catch (err) { /* closing */ }
  }
}

/** Best-effort tell — arming barge-in before the engine exists is fine to skip. */
function sttEngineTell(obj) { if (stt.proc) sttWrite(obj); }

function sttTellNote(noteId, channel, payload) {
  const win = noteId ? noteWins.get(noteId) : null;
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function sttBroadcastState() {
  for (const win of noteWins.values()) {
    if (!win.isDestroyed()) {
      win.webContents.send('stt:state', {
        running: !!stt.activeNoteId,
        noteId: stt.activeNoteId,
        starting: !!stt.starting,
      });
    }
  }
}

function sttResolveReady() {
  stt.readyReject = null;
  const waiters = stt.readyWaiters;
  stt.readyWaiters = [];
  for (const resolve of waiters) resolve();
}

function handleSttEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  switch (ev.type) {
    case 'ready':
      stt.ready = true;
      sttResolveReady();
      break;
    case 'vad':
      sttTellNote(stt.activeNoteId, 'stt:vad', { speech: !!ev.speech, ch: ev.ch });
      break;
    case 'partial':
      if (ev.ch) {
        // Call mode: channel-tagged; the ghost strip shows whose voice it is.
        const spk = speakerForChannel(ev.ch, ev.text);
        sttTellNote(stt.activeNoteId, 'stt:partial', { text: String(ev.text || ''), ms: ev.ms, speaker: spk });
      } else {
        sttTellNote(stt.activeNoteId, 'stt:partial', { text: String(ev.text || ''), ms: ev.ms });
      }
      break;
    case 'final':
      if (ev.ch) {
        const spk = speakerForChannel(ev.ch, ev.text);
        sttTellNote(stt.activeNoteId, 'stt:final', {
          text: String(ev.text || ''), ms: ev.ms, audioMs: ev.audio_ms, speaker: spk,
        });
      } else {
        sttTellNote(stt.activeNoteId, 'stt:final', { text: String(ev.text || ''), ms: ev.ms, audioMs: ev.audio_ms });
      }
      break;
    case 'barge_in':
      // The user spoke while an AI run was in flight. There is no TTS in
      // this app yet, so "pause the AI" = cancel every live AI request; the
      // aborted ai:run itself reports "Interrupted by your voice."
      for (const ctrl of aiRunAborts) {
        try { ctrl.abort(); } catch (err) { /* already aborted */ }
      }
      break;
    case 'status':
      // Engine progress ("loading model…", "listening (hi)"). Named
      // stt:progress so it cannot be confused with the stt:status invoke.
      sttTellNote(stt.activeNoteId, 'stt:progress', { message: String(ev.message || '') });
      break;
    case 'stopped':
      stt.activeNoteId = null;
      sttBroadcastState();
      break;
    case 'error':
      sttTellNote(stt.activeNoteId, 'stt:error', {
        kind: ev.kind || 'unknown',
        message: String(ev.message || 'Dictation error.'),
      });
      if (ev.kind === 'model' && stt.proc) {
        try { stt.proc.kill(); } catch (err) { /* ignore */ }
      }
      if (ev.kind === 'no-mic') {
        stt.activeNoteId = null;
        sttBroadcastState();
      }
      break;
    default:
      break;
  }
}

function spawnSttEngine() {
  if (stt.proc && stt.proc.exitCode === null) return Promise.resolve(stt.proc);
  if (stt.spawning) return stt.spawning;

  const child = spawn(stt.pythonCmd[0],
    [...stt.pythonCmd.slice(1), stt.engineFile, '--stdio', '--model', sttModelChoice()],
    {
      cwd: stt.engineDir,
      windowsHide: true,
      // Whisper load/transcription saturates the CPU and starves the whole
      // UI (measured: notes froze for a minute during model load). Below-
      // normal priority keeps the app responsive while the engine works.
      ...(process.platform === 'win32' ? { creationflags: 0x4000 } : {}), // BELOW_NORMAL_PRIORITY_CLASS
    });
  stt.proc = child;
  stt.stderrTail = [];

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handleSttEvent(JSON.parse(line));
      } catch (err) {
        console.warn('[stt] unparseable line:', line.slice(0, 200));
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stt.stderrTail.push(String(chunk));
    if (stt.stderrTail.length > 30) stt.stderrTail.shift();
  });

  stt.spawning = new Promise((resolve, reject) => {
    stt.readyWaiters.push(resolve);
    stt.readyReject = reject;
    // First run may legitimately download the model — allow 10 minutes
    // rather than declaring a healthy install broken.
    const timer = setTimeout(() => {
      try { child.kill(); } catch (err) { /* ignore */ }
      reject(new Error('The speech engine did not become ready in time.'));
    }, 10 * 60 * 1000);
    stt.readyWaiters.push(() => clearTimeout(timer));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  stt.spawning.catch(() => { /* callers get the error; nothing to do here */ });

  child.on('exit', (code) => {
    stt.proc = null;
    stt.ready = false;
    stt.spawning = null;
    if (stt.readyReject) {
      const tail = stt.stderrTail.join('').slice(-300);
      stt.readyReject(new Error(`Speech engine exited early (code ${code}).${tail ? ` ${tail}` : ''}`));
      stt.readyReject = null;
    }
    stt.activeNoteId = null;
    sttBroadcastState();
  });

  return stt.spawning;
}

function sttToggle(noteId) {
  // The note's 🎤 is pure on/off: OFF -> start with the bar's settings
  // (defaults: auto-detect language, both-side listener); ON -> stop.
  if (stt.activeNoteId === noteId) {
    sttStop();
    return;
  }
  sttStop();   // cleanly end any other note's session
  // IMMEDIATE feedback: probe + model load can take tens of seconds on a
  // busy machine — the user must see "starting" the moment they tap.
  stt.activeNoteId = noteId;
  stt.starting = true;
  sttTellNote(noteId, 'stt:starting', {});
  sttBroadcastState();
  // keepActive: sttStart must not re-stop the state we just armed.
  return sttStart(noteId, sttSettings.language, sttSettings.listener, true)
    .catch((err) => {
      sttTellNote(noteId, 'stt:error', { kind: 'start', message: String(err && err.message || err) });
    })
    .finally(() => { stt.starting = false; });
}

async function sttStart(noteId, language, listener = 'both', keepActive = false) {
  if (!noteWins.has(noteId)) return;
  if (!keepActive && stt.activeNoteId) sttStop();   // one mic — the previous note stops first

  const python = await sttFindPython();
  if (!python) {
    const setupHint = stt.engineDir
      ? `Run:  python "${path.join(stt.engineDir, 'setup.py')}"\n`
        + '(If you have several Pythons, set STT_PYTHON to the one with the deps, e.g.  py -3.14 )'
      : 'The speech engine files could not be staged (writable folder needed beside the app or in AppData).';
    sttTellNote(noteId, 'stt:error', {
      kind: 'setup',
      message: `Dictation needs a one-time setup.\n${setupHint}`,
    });
    return;
  }

  try {
    await spawnSttEngine();
  } catch (err) {
    sttTellNote(noteId, 'stt:error', { kind: 'engine', message: `Speech engine failed: ${err.message}` });
    return;
  }

  stt.activeNoteId = noteId;
  stt.starting = false;          // engine is listening: solid "on" state now
  stt.mode = listener === 'mic' ? 'dictation' : 'call';
  stt.listener = listener;
  sttWrite({
    type: 'start',
    language: language || 'auto',
    model: sttModelChoice(),
    mode: stt.mode,
    // call mode captures only what the listener mode asks for
    channels: listener === 'mic' ? ['mic'] : listener === 'sys' ? ['sys'] : ['mic', 'sys'],
  });
  sttBroadcastState();
}

function sttStop() {
  sttWrite({ type: 'stop' });   // engine flushes the last utterance, replies "stopped"
  stt.activeNoteId = null;
  stt.starting = false;
  sttBroadcastState();
}

// The note's 🎤 is a pure ON/OFF toggle now — mode/language live on the bar.
ipcMain.on('stt:pick', (event) => {
  const { id } = senderNote(event);
  if (!id) return;
  sttToggle(id);
});

ipcMain.handle('stt:status', () => ({
  running: !!stt.activeNoteId,
  noteId: stt.activeNoteId,
  mode: stt.mode || null,
  listener: stt.listener || null,
  starting: !!stt.starting,
  engineUp: !!(stt.proc && stt.proc.exitCode === null),
  pythonFound: stt.pythonProbed ? !!stt.pythonCmd : null,
  model: sttModelChoice(),
}));

// ---- speaker registry (names, colours, the one definable user) ------------

function broadcastSpeakers() {
  for (const win of noteWins.values()) {
    if (!win.isDestroyed()) win.webContents.send('stt:speakers-changed', speakerRegistry);
  }
  if (aiWin && !aiWin.isDestroyed()) aiWin.webContents.send('stt:speakers-changed', speakerRegistry);
}

ipcMain.handle('stt:speakers:get', () => speakerRegistry);

ipcMain.on('stt:speakers:set', (_event, patch) => {
  if (!patch || typeof patch !== 'object') return;
  // Route through the same sanitizer used at load: hostile labels, colours
  // or cue phrases can never reach a note's DOM.
  speakerRegistry = sanitizeSpeakerRegistry({
    PU: { ...speakerRegistry.PU, ...(patch.PU || {}) },
    SU: { ...speakerRegistry.SU, ...(patch.SU || {}) },
    defined: patch.defined === undefined ? speakerRegistry.defined : patch.defined,
  });
  saveSoon();
  broadcastSpeakers();
});

// ---- dictation settings (listener mode + language) ------------------------
// Edited on the AI window's Dictation tab (same navigation pattern as
// prompts/settings/speakers: tabs + ✕ to close). The bar's 🎙 opens it.

ipcMain.handle('stt:settings:get', () => sttSettings);

ipcMain.on('stt:settings:set', (_event, patch) => {
  if (!patch || typeof patch !== 'object') return;
  sttSettings = sanitizeSttSettings({ ...sttSettings, ...patch });
  saveSoon();
  if (bar && !bar.isDestroyed()) bar.webContents.send('stt:settings-changed', sttSettings);
  if (aiWin && !aiWin.isDestroyed()) aiWin.webContents.send('stt:settings-changed', sttSettings);
});

ipcMain.on('app:open-dict', () => {
  const alreadyOpen = !!(aiWin && !aiWin.isDestroyed());
  aiWindow();
  if (!aiWin || aiWin.isDestroyed()) return;
  // A freshly created window has not registered its ai:show-page listener
  // yet — wait for the page, or the tab switch is silently lost.
  if (alreadyOpen) aiWin.webContents.send('ai:show-page', 'dictation');
  else aiWin.webContents.once('did-finish-load', () => {
    if (aiWin && !aiWin.isDestroyed()) aiWin.webContents.send('ai:show-page', 'dictation');
  });
});

// The bar's 🔝: raise the note the user last worked in. ONLY that — it does
// not pin, focus-steal, or change anything else.
ipcMain.on('app:raise-active-note', () => {
  let id = lastActiveNoteId;
  if (!id || !noteWins.has(id)) {
    // fall back: the only note, else the newest
    const ids = [...noteWins.keys()];
    id = ids.length === 1 ? ids[0] : ids[ids.length - 1];
  }
  const win = id ? noteWins.get(id) : null;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.moveTop();
  }
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function idFor(sender) {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win) return null;
  for (const [id, w] of noteWins) if (w === win) return id;
  return null;
}

const senderNote = (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return {};
  for (const [id, w] of noteWins) if (w === win) return { id, win, data: noteData.get(id) };
  return { win };
};

ipcMain.handle('note:init', (event) => {
  const { data } = senderNote(event);
  return { data, palette: PALETTE };
});

ipcMain.on('note:patch', (event, patch) => {
  const id = idFor(event.sender);
  const d = noteData.get(id);
  if (!d || !patch || typeof patch !== 'object') return;

  // Whitelist what a renderer may change; anything else is dropped.
  for (const key of ['html', 'text', 'title', 'color', 'fontSize', 'pinned', 'timer']) {
    if (key in patch) d[key] = patch[key];
  }

  // Keep the OS window title in sync with the note's own title — that's the
  // name the user sees in the taskbar and alt-tab, and the one saved files use.
  if ('title' in patch) {
    const win = noteWins.get(id);
    if (win && !win.isDestroyed()) {
      const t = String(patch.title || '').trim();
      win.setTitle(t || 'Sticky note');
    }
  }

  saveSoon();
  if ('html' in patch || 'text' in patch || 'title' in patch) writeLiveMarkdown(d);
});

ipcMain.on('note:delete', (event) => {
  const { win } = senderNote(event);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.on('note:new', (event) => {
  // Spawned from a note's own "+" button: cascade off that note and inherit its
  // size, so "one more like this one" lands where you expect.
  const { id, win } = senderNote(event);
  if (id && win && !win.isDestroyed()) {
    const b = win.getBounds();
    return createNote({ x: b.x + 28, y: b.y + 28, width: b.width, height: b.height },
      { focus: true });
  }
  return createNote({}, { focus: true });
});

// Custom resize: frameless windows only expose a couple of pixels of native
// resize border, so the note renders its own grips and streams screen-space
// deltas here.
ipcMain.on('resize:start', (event, edge) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  // Garbage here would poison every later resize:move — require a real edge tag.
  if (typeof edge !== 'string' || !/^[nsew]{1,2}$/.test(edge)) return;
  resizeAnchors.set(win.id, { edge, bounds: win.getBounds() });
});

ipcMain.on('resize:move', (event, { dx, dy } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const anchor = resizeAnchors.get(win.id);
  if (!anchor) return;
  // NaN/Infinity reach SetWindowPos, which wedges the window (and, with
  // several notes up, the whole UI) for tens of seconds. Measured — QA 2026-10-27.
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const { edge, bounds } = anchor;
  const next = { ...bounds };

  if (edge.includes('e')) next.width = Math.max(MIN_W, bounds.width + dx);
  if (edge.includes('s')) next.height = Math.max(MIN_H, bounds.height + dy);
  if (edge.includes('w')) {
    next.width = Math.max(MIN_W, bounds.width - dx);
    next.x = bounds.x + (bounds.width - next.width);
  }
  if (edge.includes('n')) {
    next.height = Math.max(MIN_H, bounds.height - dy);
    next.y = bounds.y + (bounds.height - next.height);
  }

  win.setBounds({
    x: Math.round(next.x), y: Math.round(next.y),
    width: Math.round(next.width), height: Math.round(next.height),
  });
  // A custom edge/corner drag can fire faster than 'resized' propagates, and
  // setBounds resets z-order - so re-assert here too, not only in syncBounds.
  for (const [id, w] of noteWins) {
    if (w === win && noteData.get(id)?.pinned) keepOnTop(win);
  }
});

ipcMain.on('resize:end', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  resizeAnchors.delete(win.id);
  const { id } = senderNote(event);
  if (id) Object.assign(noteData.get(id), win.getBounds());
  saveSoon();
});

ipcMain.on('app:toggle-hide', () => setNotesHidden(!notesHidden));
ipcMain.on('app:toggle-clickthrough', () => setClickThrough(!clickThrough));
ipcMain.on('app:hide-bar', () => {
  if (!bar || bar.isDestroyed()) return;
  barHidden = true;
  bar.hide();
});
ipcMain.on('app:quit', () => { quitting = true; saveNow(); app.quit(); });

ipcMain.on('app:toggle-help', toggleHelp);
ipcMain.on('app:close-help', closeHelp);
ipcMain.on('app:toggle-history', toggleHistory);
ipcMain.on('app:open-ai', () => aiWindow());
ipcMain.on('app:toggle-ai', () => toggleAiWindow());
ipcMain.on('app:collapse-bar', (_event, on) => setBarCollapsed(!!on));

// ---- history --------------------------------------------------------------

ipcMain.handle('history:list', () => archive);

ipcMain.on('history:close', () => {
  if (historyWin && !historyWin.isDestroyed()) historyWin.close();
});

ipcMain.on('history:restore', (_event, key) => {
  const idx = archive.findIndex((e) => e.key === key);
  if (idx < 0) return;
  const [entry] = archive.splice(idx, 1);
  const { deletedAt, key: _k, ...seed } = entry;
  // Reuse the original id only if nothing live is holding it.
  createNote(noteWins.has(seed.id) ? { ...seed, id: undefined } : seed, { focus: true });
  saveSoon();
  pushHistory();
});

ipcMain.on('history:forget', (_event, key) => {
  const before = archive.length;
  archive = archive.filter((e) => e.key !== key);
  if (archive.length !== before) { saveSoon(); pushHistory(); }
});

ipcMain.on('history:clear', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete them', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Clear history',
    message: `Permanently delete all ${archive.length} note(s) in history?`,
    detail: 'This clears the list inside the app. Copies already written to the '
      + 'Notes/history folder are left on disk, so nothing you can see in that '
      + 'folder is deleted from here.',
  });
  if (response !== 0) return;
  archive = [];
  saveSoon();
  pushHistory();
});

// ---- images ---------------------------------------------------------------

function newImageFile(ext, data) {
  // Only real image extensions: the regex alone would happily bless
  // 'exe' / 'bat' / 'vbs' / 'ps1' and let a hostile payload plant
  // executable files in the notes tree (QA 2026-10-27).
  const exts = new Set(Object.keys(IMAGE_MIME).map((e) => e.slice(1)));
  const safe = exts.has(String(ext).toLowerCase()) ? String(ext).toLowerCase() : 'png';
  const name = `img-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.${safe}`;
  const dir = data ? noteImgDir(data) : imagesDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

// Images live as files beside the store rather than as base64 inside it - a
// couple of screenshots would otherwise turn notes.json into megabytes that get
// rewritten on every keystroke.
ipcMain.handle('image:save', (event, { bytes, ext }) => {
  try {
    // A string like 'not-an-array' would otherwise be written as file
    // content via Buffer.from(string); only real byte arrays pass.
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      return null;
    }
    const { data } = senderNote(event);
    const file = newImageFile(ext, data);
    fs.writeFileSync(file, Buffer.from(bytes));
    if (data) writeLiveMarkdown(data);
    return pathToFileURL(file).href;
  } catch (err) {
    console.error('[sticky] could not save pasted image:', err);
    return null;
  }
});

ipcMain.handle('image:choose', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Add a picture',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled) return [];
  const { data } = senderNote(event);
  return res.filePaths.map((src) => {
    try {
      const dest = newImageFile(path.extname(src).slice(1), data);
      fs.copyFileSync(src, dest);
      return pathToFileURL(dest).href;
    } catch (err) {
      console.error('[sticky] could not copy image:', err);
      return null;
    }
  }).filter(Boolean);
});

/** Drop image files no live note or archived note refers to any more. */
function gcImages() {
  try {
    if (!fs.existsSync(imagesDir())) return;
    const used = new Set();
    const scan = (html) => {
      const re = /img-[A-Za-z0-9._-]+/g;
      let m;
      while ((m = re.exec(html || ''))) used.add(m[0]);
    };
    [...noteData.values(), ...archive].forEach((n) => scan(n.html));

    // Only sweep files older than a day, so an image written moments ago can
    // never be collected before its note has been saved.
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const name of fs.readdirSync(imagesDir())) {
      if (used.has(name)) continue;
      const file = path.join(imagesDir(), name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch (err) {
    console.error('[sticky] image cleanup skipped:', err);
  }
}

// Every native menu in the app goes through here so the foreground fix below is
// applied in one place. The watchdog deliberately keeps running while a menu is
// open: raising the owner does not close its own popup (measured - the menu
// stayed up for 1.4 s across three watchdog ticks), and a guard here could get
// stuck on and silently retire the watchdog for good.
function popupMenu(win, template) {
  // Windows will not show an owned popup unless the owner is the foreground
  // window; the menu then simply never appears. Clicking the button that opens
  // the menu focuses the note anyway, so this only removes the timing dependence.
  if (win && !win.isDestroyed() && !win.isFocused()) win.focus();
  Menu.buildFromTemplate(template).popup({ window: win });
}

// A native menu rather than an in-page dropdown: a note window can be as small
// as 190x130, and an OS menu is free to spill outside those bounds.
ipcMain.on('timer:pick', (event, { durationMs } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;

  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };

  const template = DURATIONS.map((min) => ({
    label: durationLabel(min),
    type: 'checkbox',
    checked: durationMs === min * 60000,
    click: () => send('timer:set', min * 60000),
  }));
  template.push(
    { type: 'separator' },
    { label: 'Custom…', click: () => send('timer:custom') },
  );

  popupMenu(win, template);
});

ipcMain.on('timer:done', (event, { label } = {}) => {
  if (Notification.isSupported()) {
    new Notification({
      title: "Time's up",
      body: label ? `${label} finished.` : 'Your timer finished.',
      urgency: 'critical',
    }).show();
  }

  const { id, win } = senderNote(event);
  if (id && win && !win.isDestroyed()) {
    // A note timer firing is worth interrupting for: if notes were hidden,
    // bring them back, and float the one that fired above its siblings.
    if (notesHidden) setNotesHidden(false);
    win.showInactive();
    win.moveTop();
    return;
  }

  if (bar && !bar.isDestroyed()) {
    if (barHidden) { barHidden = false; bar.show(); }
    bar.flashFrame(true);
    bar.setAlwaysOnTop(true, 'screen-saver');
    setTimeout(() => bar && !bar.isDestroyed() && bar.flashFrame(false), 4000);
  }
});

// ---- saving a note to disk -------------------------------------------------

/*
 * A native menu, for the same reason the timer uses one: a note window can be
 * far too small for an in-page list of five formats.
 *
 * The renderer flushes its current text as a note:patch just before sending
 * note:save, and ipcMain handles same-channel messages in order - so by the time
 * a format is picked, `data` is exactly what is on screen.
 */
ipcMain.on('note:save', (event) => {
  const { win, data } = senderNote(event);
  if (!win || !data || win.isDestroyed()) return;

  const reply = (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send('note:saved', payload);
  };

  const template = SAVE_FORMATS.map((format) => ({
    label: format.label,
    click: async () => {
      try {
        const out = await saveNoteAs(data, format);
        reply({
          ok: true,
          skipped: !!out.skipped,
          name: path.basename(out.file),
          dir: path.dirname(out.file),
          format: format.label,
        });
      } catch (err) {
        console.error('[sticky] save failed:', err);
        reply({ ok: false, error: err.message });
      }
    },
  }));
  template.push(
    { type: 'separator' },
    { label: `Save into ${path.join(notesRoot(), 'saved')}`, enabled: false },
  );

  popupMenu(win, template);
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (bar && !bar.isDestroyed()) { barHidden = false; bar.show(); bar.focus(); }
  });

  app.whenReady().then(() => {
    const store = loadStore();
    clickThrough = false; // always start interactive; the saved flag is informational
    archive = Array.isArray(store.archive) ? store.archive : [];
    aiPrompts = Array.isArray(store.aiPrompts) ? store.aiPrompts : [];
    if (store.aiSettings && typeof store.aiSettings === 'object') aiSettings = { ...aiSettings, ...store.aiSettings };
    speakerRegistry = sanitizeSpeakerRegistry(store.speakerRegistry);
    sttSettings = sanitizeSttSettings(store.sttSettings);
    createBar(store.bar, store.barCollapsed);

    // Create Notes/history, Notes/saved/<format>, and Notes/Prompt/{soul,skills}
    // at startup, so the user can see where things land before they ever save.
    try {
      ensureNotesFolders();
      for (const p of aiPrompts) {
        if (!p.folder) p.folder = 'skills';
        if (!p.file) {
          try { writePromptFile(p); } catch (err) { /* first-run mirror is best-effort */ }
        }
      }
      importPromptFiles();
      ensureBuiltinPrompts();
      ensureBuiltinSoul();
    } catch (err) {
      console.error('[sticky] could not prepare the Notes folder:', err);
    }

    // The top-slot watchdog. Windows has no band a normal app can reserve for
    // good, so the only honest guarantee is to keep putting the bar and any
    // pinned note back on top. One second is slow enough to cost nothing and
    // fast enough that a window never visibly sits behind.
    const topWatchdog = setInterval(enforceTop, KEEP_ON_TOP_MS);
    app.on('will-quit', () => clearInterval(topWatchdog));

    if (store.notes.length) {
      store.notes.forEach((n) => createNote(n));
    } else {
      createNote({
        text: 'Welcome 👋\n\nForgot a hotkey? Press Ctrl+Alt+/ or click ? on the bar.\n\nCtrl+Alt+M  new note\nCtrl+Alt+H  hide / show all\nCtrl+Alt+T  click-through\nCtrl+Alt+B  show this bar\nCtrl+Alt+D  history (restore deleted)\n\nDrag the top strip to move.\nDrag any edge or the corner to resize.\n⏱ gives this note its own timer.\n＋ makes another note.',
      });
    }

    if (store.clickThrough) setClickThrough(true);

    const shortcuts = {
      [HOTKEYS.newNote]: () => createNote({}, { focus: true }),
      [HOTKEYS.toggleHide]: () => setNotesHidden(!notesHidden),
      [HOTKEYS.clickThrough]: () => setClickThrough(!clickThrough),
      [HOTKEYS.toggleBar]: () => {
        if (!bar || bar.isDestroyed()) return;
        barHidden = !barHidden;
        if (barHidden) bar.hide();
        else { bar.show(); bar.focus(); }
      },
      [HOTKEYS.help]: toggleHelp,
      // Reachable even when the bar is collapsed or hidden.
      [HOTKEYS.history]: toggleHistory,
      [HOTKEYS.ai]: toggleAiWindow,
    };
    for (const [accel, fn] of Object.entries(shortcuts)) {
      if (!globalShortcut.register(accel, fn)) {
        console.warn(`[sticky] hotkey already taken by another app: ${accel}`);
      }
    }

    app.on('activate', () => {
      if (bar && !bar.isDestroyed()) bar.show();
    });

    gcImages();
  });

  // Notes and the bar are all frameless helpers - closing them must not quit.
  app.on('window-all-closed', () => app.quit());
  // Flip `quitting` before any window closes, so the per-window 'closed'
  // handlers know not to treat a shutdown as a pile of deletions.
  app.on('before-quit', () => { quitting = true; saveNow(); });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    saveNow();
    try { if (stt.proc) stt.proc.kill(); } catch (err) { /* ignore */ }
  });
}
