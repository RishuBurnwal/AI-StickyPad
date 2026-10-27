#!/usr/bin/env python3
"""Offline speech-to-text engine for AI-StickyPad.

Pipeline: mic (16 kHz mono) -> light noise suppression -> Silero VAD ->
faster-whisper (INT8, CPU) -> partial/final text events. Hindi, Hinglish
(code-switching) and English all work offline once the models are
downloaded (python stt/setup.py).

Why faster-whisper and not Moonshine (the original spec's pick): Moonshine
is an English-only ASR model — a Hindi/Hinglish Moonshine does not exist.
faster-whisper ships real multilingual models, quantized to INT8, and runs
on any CPU. See stt/models/README.md for sizes and licences.

Sidecar protocol (JSON, one object per line over stdio):

  commands in   {"type":"start","language":"hi","model":"base"}
                {"type":"start","mode":"call","language":"hi","model":"small"}   # dual-channel: mic=PU + loopback=SU
                {"type":"stop"}
                {"type":"state","ai_speaking":true}   # arm barge-in
                {"type":"shutdown"}
  events out    {"type":"ready","model":...,"device":"cpu"}
                {"type":"status","message":...}        # progress notes
                {"type":"vad","speech":true|false}
                {"type":"partial","text":...,"ms":...}
                {"type":"final","text":...,"ms":...,"audio_ms":...}
                {"type":"partial","ch":"mic"|"sys",...} / {"type":"final","ch":...}   # call mode
                {"type":"barge_in"}                    # user spoke over AI
                {"type":"error","message":...,"kind":...}
                {"type":"stopped"}

Human one-shot modes (no Electron needed):
  python engine.py --file recording.wav --language hi
  python engine.py --self-test
  python engine.py --check-runtime    # exit 0 = every dependency imports
"""
from __future__ import annotations

import argparse
import json
import os

# Two huggingface_hub notices otherwise print on the FIRST model download
# (Xet fallback + Windows symlinks) and look like the engine is broken.
# They are informational; silence them before hub imports anywhere here.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import sys
import threading
import time
import wave
from pathlib import Path

import numpy as np

STT_ROOT = Path(__file__).resolve().parent
if str(STT_ROOT) not in sys.path:
    sys.path.insert(0, str(STT_ROOT))

from utils.chunking import Chunker  # noqa: E402
from utils.grammar_fix import fix_text  # noqa: E402
from utils.preprocessing import (  # noqa: E402
    SAMPLE_RATE, VAD_FRAME, SileroVAD, denoise,
)

MODELS_DIR = Path(os.environ.get("STT_MODELS_DIR") or (STT_ROOT / "models"))

# Live tuning. Partials every 0.8 s keep the note feeling live without
# melting the CPU; 0.24 s of pre-roll survives the VAD's reaction time so
# the first word is not clipped; utterances cap at 20 s because whisper's
# own window is 30 s and a pause is a better commit point long before that.
PARTIAL_EVERY_S = 0.8
PREROLL_S = 0.24
MAX_UTTERANCE_S = 20.0
MIN_PARTIAL_S = 0.5

# Biasing the first pass towards Devanagari keeps Hindi words Hindi while
# English words in the same sentence stay Latin — the code-switching case.
LANGUAGE_HINTS = {
    # Whisper has a known failure mode on Hindi: with no prompt it often
    # outputs an English *translation* instead of a Devanagari transcript.
    # A Hindi first prompt pins the output script; the one English word in
    # it keeps code-switched words (market, call) acceptable in Latin.
    "hi": "यह हिंदी और English मिली-जुली बातचीत है।",
}
MODELS = ("tiny", "base", "small")
# small is the default because base garbles Devanagari Hindi (measured:
# base → "ये अक अप्लान स्वीच…"-quality output or silent translation to
# English; small → near-verbatim Devanagari). STT_MODEL overrides.
DEFAULT_MODEL = "small"


def log(*args: object) -> None:
    """Diagnostics go to stderr only — stdout is the protocol channel."""
    print(*args, file=sys.stderr, flush=True)


def suppress_prompt_echo(text: str, language: str) -> str:
    """Whisper sometimes parrots the initial prompt back when the audio is
    silence, hum or noise; inserting that into a note would be a lie."""
    hint = (LANGUAGE_HINTS.get(language) or "").strip()
    t = (text or "").strip()
    if hint and t and t in hint:
        return ""
    if hint and t:
        # Fragment echo: "यह यह यह बातचीत है।" — every word lifted from the
        # prompt. Real speech always contains words the prompt does not have.
        words = [w for w in t.split() if w.strip("।,.!?")]
        hint_words = {w.strip("।,.!?") for w in hint.split()}
        if words and all(w in hint_words for w in words):
            return ""
    return text


class Transcriber:
    """Lazy wrapper around faster-whisper; loads once, reuses per call."""

    def __init__(self, model_name: str = DEFAULT_MODEL) -> None:
        self.model_name = model_name if model_name in MODELS else DEFAULT_MODEL
        self._model = None
        self.last_ms = 0.0

    @staticmethod
    def _downloaded(model_name: str) -> bool:
        if not MODELS_DIR.is_dir():
            return False
        return any(MODELS_DIR.glob(f"models--Systran--faster-whisper-{model_name}*"))

    def load(self) -> None:
        if self._model is not None:
            return
        from faster_whisper import WhisperModel

        have_local = self._downloaded(self.model_name)
        # With the model already on disk we refuse the network entirely —
        # "offline" must not depend on huggingface.co being reachable.
        kwargs = dict(local_files_only=True) if have_local else dict()
        # faster-whisper prints download progress to stdout, which would
        # corrupt the JSON protocol — route it to stderr while loading.
        real_stdout = sys.stdout
        try:
            sys.stdout = sys.stderr
            self._model = WhisperModel(
                self.model_name,
                device="cpu",
                compute_type="int8",
                download_root=str(MODELS_DIR),
                **kwargs,
            )
        finally:
            sys.stdout = real_stdout

    def transcribe(self, audio: np.ndarray, language: str = "hi") -> str:
        self.load()
        # Near-silence short-circuit: tonal hum and faint noise get past the
        # gate but must never reach the model, which hallucinates on them.
        rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
        if rms < 0.002:
            self.last_ms = 0.0
            return ""
        t0 = time.perf_counter()
        segments, _info = self._model.transcribe(
            audio,
            language=None if language == "auto" else language,
            beam_size=1,
            condition_on_previous_text=False,
            vad_filter=False,  # our own Silero pass already ran
            initial_prompt=LANGUAGE_HINTS.get(language),
        )
        text = "".join(s.text for s in segments).strip()
        self.last_ms = (time.perf_counter() - t0) * 1000.0
        return text


# ---------------------------------------------------------------------------
# WAV helpers (file mode)
# ---------------------------------------------------------------------------

def read_wav_mono(path: str) -> tuple[np.ndarray, int]:
    """Read a PCM or float WAV as mono float32 at its own sample rate."""
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        width = w.getsampwidth()
        n = w.getnframes()
        raw = w.readframes(n)

    if width == 2:
        audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        audio = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 1:
        audio = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f"unsupported sample width: {width} bytes")

    if ch > 1:
        audio = audio.reshape(-1, ch).mean(axis=1)
    return np.ascontiguousarray(audio), sr


def resample_linear(audio: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst or audio.size == 0:
        return audio
    n_out = int(round(audio.size * dst / src))
    idx = np.linspace(0.0, audio.size - 1.0, n_out)
    left = np.floor(idx).astype(np.int64)
    right = np.minimum(left + 1, audio.size - 1)
    frac = (idx - left).astype(np.float32)
    return (audio[left] * (1.0 - frac) + audio[right] * frac).astype(np.float32)


# ---------------------------------------------------------------------------
# Live dictation state machine
# ---------------------------------------------------------------------------

class Dictation:
    """VAD-gated utterance recorder + partial/final emitter.

    One utterance = pre-roll + everything between a VAD start and the
    matching end (or the 20 s cap). Partials transcribe the growing buffer
    so the note updates while the user is still talking; the final pass
    re-transcribes the whole utterance for the best text.
    """

    def __init__(self, emit, language: str = "hi", model: str = DEFAULT_MODEL) -> None:
        self.emit = emit
        self.language = language
        self.transcriber = Transcriber(model)
        self.vad = SileroVAD()
        self.speaking = False
        self.ai_speaking = False
        self._preroll = np.zeros(0, dtype=np.float32)
        self._buf = np.zeros(0, dtype=np.float32)
        self._last_partial_t = 0.0
        self._last_partial_samples = 0
        self._last_partial_text = ""
        self._barge_in_fired = False
        self._frames_since_data = 0

    # -- frame loop -----------------------------------------------------------

    def on_frame(self, frame: np.ndarray) -> None:
        if frame is None or frame.size == 0:
            self._frames_since_data += 1
            return
        frame = np.ascontiguousarray(frame.astype(np.float32, copy=False))
        self._frames_since_data = 0
        for ev in self.vad.push(frame):
            if ev["type"] == "start":
                self._on_speech_start()
            elif ev["type"] == "end":
                self._on_speech_end()
        if self.speaking:
            self._buf = np.concatenate([self._buf, frame.astype(np.float32, copy=False)])
            self._maybe_partial()
            if self._buf.size >= MAX_UTTERANCE_S * SAMPLE_RATE:
                # Hard cap: commit what we have, keep listening.
                self._commit(restart=True)
        else:
            # Keep a small tail before speech so the onset survives VAD latency.
            keep = int(PREROLL_S * SAMPLE_RATE)
            self._preroll = np.concatenate([self._preroll, frame.astype(np.float32, copy=False)])[-keep:]

    def _on_speech_start(self) -> None:
        self.speaking = True
        self._barge_in_fired = False
        self.emit({"type": "vad", "speech": True})
        if self.ai_speaking:
            # The user is talking over the AI — that is a barge-in. One event
            # per utterance; the host decides what "pause" means for it.
            self._barge_in_fired = True
            self.emit({"type": "barge_in"})

    def _on_speech_end(self) -> None:
        self.emit({"type": "vad", "speech": False})
        self._commit(restart=False)

    # -- transcription --------------------------------------------------------

    def _utterance(self) -> np.ndarray:
        pre = self._preroll if self._preroll.size > int(0.08 * SAMPLE_RATE) else np.zeros(0, dtype=np.float32)
        return np.concatenate([pre, self._buf])

    def _maybe_partial(self) -> None:
        if self._buf.size < MIN_PARTIAL_S * SAMPLE_RATE:
            return
        # Two gates: enough wall time AND enough new audio. Without the audio
        # gate, a machine slower than the cadence would re-transcribe the same
        # buffer back-to-back (measured: 105 partials for a 4 s utterance).
        if self._buf.size - self._last_partial_samples < int(0.4 * SAMPLE_RATE):
            return
        now = time.perf_counter()
        if now - self._last_partial_t < PARTIAL_EVERY_S:
            return
        self._last_partial_t = now
        self._last_partial_samples = self._buf.size
        try:
            text = self.transcriber.transcribe(denoise(self._utterance()), self.language)
        except Exception as err:  # a failed partial must never kill the stream
            log("partial failed:", err)
            return
        text = fix_text(text, self.language)
        text = suppress_prompt_echo(text, self.language)
        if text and text != self._last_partial_text:
            self._last_partial_text = text
            self.emit({
                "type": "partial", "text": text,
                "ms": round(self.transcriber.last_ms, 1),
            })

    def _commit(self, restart: bool) -> None:
        audio_ms = self._utterance().size * 1000.0 / SAMPLE_RATE
        text = ""
        if self._buf.size >= 0.32 * SAMPLE_RATE:  # ignore clicks shorter than a word
            try:
                text = self.transcriber.transcribe(denoise(self._utterance()), self.language)
            except Exception as err:
                log("final failed:", err)
            text = suppress_prompt_echo(fix_text(text, self.language), self.language)
        self.speaking = False
        self._buf = np.zeros(0, dtype=np.float32)
        self._preroll = np.zeros(0, dtype=np.float32)
        self._last_partial_text = ""
        self._last_partial_samples = 0
        if text or audio_ms >= 400:
            self.emit({
                "type": "final", "text": text,
                "ms": round(self.transcriber.last_ms, 1),
                "audio_ms": round(audio_ms, 1),
            })
        if restart:
            self.emit({"type": "vad", "speech": False})
            self.vad.reset()


# ---------------------------------------------------------------------------
# Mic capture
# ---------------------------------------------------------------------------

class MicStream:
    """sounddevice capture at 16 kHz mono, 512-sample frames.

    The PortAudio callback only pushes to a queue; every expensive thing
    (VAD, whisper) happens on the worker thread so the audio path never
    glitches.
    """

    def __init__(self, on_frame, emit) -> None:
        self.on_frame = on_frame
        self.emit = emit
        self._queue: "queue.Queue[np.ndarray]" = None  # type: ignore[assignment]
        self._stream = None
        self._running = False
        self._thread = None

    def start(self) -> None:
        import queue
        import threading

        import sounddevice as sd

        self._queue = queue.Queue()
        try:
            self._stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype="float32",
                blocksize=VAD_FRAME,
                callback=self._callback,
            )
            self._stream.start()
        except Exception as err:
            raise RuntimeError(
                f"Could not open the microphone: {err}. "
                "Check that a default input device exists (Settings → Sound)."
            ) from err

        self._running = True

        def worker() -> None:
            import numpy as _np  # local alias keeps the hot loop tight

            while self._running:
                try:
                    frame = self._queue.get(timeout=0.25)
                except queue.Empty:
                    self.on_frame(None)
                    continue
                self.on_frame(_np.asarray(frame, dtype=_np.float32))

        self._thread = threading.Thread(target=worker, name="stt-mic", daemon=True)
        self._thread.start()

    def _callback(self, indata, frames, time_info, status) -> None:
        if status:
            log("mic status:", status)
        self._queue.put(indata[:, 0].copy())

    def stop(self) -> None:
        self._running = False
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None


# ---------------------------------------------------------------------------
# stdio service
# ---------------------------------------------------------------------------

def stdio_service(model: str = DEFAULT_MODEL) -> int:
    emit_lock = __import__("threading").Lock()

    def emit(obj: dict) -> None:
        with emit_lock:
            sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    dictation: Dictation | None = None
    mic: MicStream | None = None
    language = "hi"
    call = None              # CallSession when running in call mode

    def stop_dictation(report_stopped: bool) -> None:
        nonlocal dictation, mic, call
        if call is not None:
            call.stop()
            call = None
        if mic is not None:
            mic.stop()
            mic = None
        if dictation is not None:
            # The VAD never fires "end" once the stream is gone; flush what
            # was being said so the last words are not lost.
            if dictation.speaking:
                dictation._commit(restart=False)
            dictation = None
        if report_stopped:
            emit({"type": "stopped"})

    # Model load happens before "ready" so the first partial is not slow —
    # but it must NOT block the stdin loop: while loading, a killed host
    # (crash, task-kill) would otherwise leave this process running for
    # minutes as an orphan. Load in a thread; watch stdin here.
    emit({"type": "status", "message": "loading model (first run may download)…"})
    load_result = {"error": None}

    def _load() -> None:
        try:
            Transcriber(model).load()
        except Exception as err:
            load_result["error"] = err

    threading.Thread(target=_load, name="stt-model-load", daemon=True).start()
    host_gone = threading.Event()

    def _stdin_watch() -> None:
        for _line in sys.stdin:
            # commands during load are not actionable; just consume them
            pass
        host_gone.set()

    threading.Thread(target=_stdin_watch, name="stt-stdin", daemon=True).start()

    t0 = time.time()
    while load_result["error"] is None:
        if host_gone.is_set():
            log("host went away during model load; exiting")
            return 0
        if not any(getattr(t, "name", "") == "stt-model-load" and t.is_alive()
                   for t in threading.enumerate()):
            break
        time.sleep(0.2)
    if load_result["error"] is not None:
        emit({"type": "error", "kind": "model",
              "message": f"Model not ready. Run  python stt\\setup.py  first. ({load_result['error']})"})
        return 2
    emit({"type": "ready", "model": model, "device": "cpu"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        mtype = msg.get("type")

        if mtype == "start":
            stop_dictation(False)
            language = msg.get("language", language)
            model = msg.get("model", model)
            if language not in ("hi", "en", "auto"):
                language = "hi"
            if msg.get("mode") == "call":
                # Dual-channel: mic = PU (primary user), loopback of the
                # default output = SU (the far side of a call). The bar's
                # listener setting picks which channels actually capture.
                try:
                    from call import CallSession
                    channels = msg.get("channels") or ["mic", "sys"]
                    if not isinstance(channels, list) or not channels:
                        channels = ["mic", "sys"]
                    channels = [c for c in channels if c in ("mic", "sys")] or ["mic", "sys"]
                    call = CallSession(emit, language=language, model=model, channels=channels)
                    call.start()
                except Exception as err:
                    call = None
                    emit({"type": "error", "kind": "call",
                          "message": f"Call mode could not start: {err}"})
                    continue
            else:
                dictation = Dictation(emit, language=language, model=model)
                dictation.ai_speaking = ai_speaking_state.get("on", False)
                try:
                    mic = MicStream(dictation.on_frame, emit)
                    mic.start()
                except Exception as err:
                    mic = None
                    dictation = None
                    emit({"type": "error", "kind": "no-mic", "message": str(err)})
                    continue
            emit({"type": "status", "message": f"listening ({language})"})

        elif mtype == "stop":
            stop_dictation(True)

        elif mtype == "state":
            on = bool(msg.get("ai_speaking"))
            ai_speaking_state["on"] = on
            if dictation is not None:
                dictation.ai_speaking = on
            if call is not None:
                call.set_ai_speaking(on)

        elif mtype == "shutdown":
            stop_dictation(False)
            return 0

    # stdin closed = host went away
    stop_dictation(False)
    return 0


ai_speaking_state = {"on": False}


# ---------------------------------------------------------------------------
# One-shot modes
# ---------------------------------------------------------------------------

def file_mode(path: str, language: str, model: str, chunked: bool) -> int:
    audio, sr = read_wav_mono(path)
    if sr != SAMPLE_RATE:
        audio = resample_linear(audio, sr, SAMPLE_RATE)
    t = Transcriber(model)
    t.load()
    audio = denoise(audio)

    t0 = time.perf_counter()
    text = fix_text(t.transcribe(audio, language), language)
    total_ms = (time.perf_counter() - t0) * 1000.0
    audio_ms = audio.size * 1000.0 / SAMPLE_RATE

    out = {
        "file": path,
        "language": language,
        "model": model,
        "text": text,
        "audio_ms": round(audio_ms, 1),
        "transcribe_ms": round(total_ms, 1),
        "rtf": round(total_ms / max(audio_ms, 1.0), 3),
    }

    if chunked:
        # Spec's chunking proof: 1.5 s windows, 0.5 s overlap, one latency
        # measurement per chunk — this is the number the ≤300 ms claim is
        # checked against.
        chunks = []
        ch = Chunker(SAMPLE_RATE)
        for piece, t0s in ch.feed(audio) + ch.flush():
            c0 = time.perf_counter()
            ctext = fix_text(t.transcribe(piece, language), language)
            c_ms = (time.perf_counter() - c0) * 1000.0
            chunks.append({
                "t0_s": round(t0s, 2), "audio_ms": 1500,
                "ms": round(c_ms, 1), "text": ctext,
            })
        out["chunks"] = chunks
        per = [c["ms"] for c in chunks]
        out["chunk_ms_avg"] = round(sum(per) / len(per), 1) if per else None
        out["chunk_ms_max"] = round(max(per), 1) if per else None

    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def check_runtime() -> int:
    import importlib

    missing = []
    for mod in ("numpy", "faster_whisper", "silero_vad", "sounddevice"):
        try:
            importlib.import_module(mod)
        except Exception as err:
            missing.append(f"{mod} ({err.__class__.__name__})")
    if missing:
        log("check-runtime: missing", ", ".join(missing))
        return 3
    log("check-runtime: ok")
    return 0


def self_test() -> int:
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    print("self-test: imports")
    check("numpy", _try_import("numpy"))
    check("faster_whisper", _try_import("faster_whisper"))
    check("silero_vad", _try_import("silero_vad"))
    check("sounddevice", _try_import("sounddevice"))

    print("self-test: chunking (1.5 s / 0.5 s overlap)")
    ch = Chunker(SAMPLE_RATE)
    chunks = ch.feed(np.zeros(int(SAMPLE_RATE * 3.0), dtype=np.float32)) + ch.flush()
    # 3 s of audio, step 1.0 s → 2 full chunks + 1 s tail (> 0.5 s overlap)
    check("chunk count", len(chunks) == 3, f"got {len(chunks)}")
    check("chunk size", all(c[0].size == int(1.5 * SAMPLE_RATE) for c in chunks[:2]))
    check("overlap", chunks[0][1] + 1.0 == chunks[1][1] if len(chunks) > 1 else False)

    print("self-test: grammar fixes")
    check("tidy spacing", fix_text("क्या है  ?", "hi") == "क्या है?")
    check("roman map", fix_text("main nahi ja raha", "hi") == "मैं नहीं ja रहा")

    print("self-test: VAD on silence")
    try:
        vad = SileroVAD()
        evs = []
        for _ in range(10):
            evs += vad.push(np.zeros(VAD_FRAME, dtype=np.float32))
        check("silence = no speech", not evs, str(evs))
    except Exception as err:
        check("VAD loads", False, str(err))

    print("self-test: model load + silence transcription")
    try:
        t = Transcriber()
        t.load()
        raw = t.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), "hi")
        cleaned = suppress_prompt_echo(raw, "hi")
        check("model loads; silence yields no text (prompt echo suppressed)",
              cleaned == "", f"raw={raw!r} cleaned={cleaned!r}")
    except Exception as err:
        check("model loads", False, str(err))

    print("self-test:", "ALL PASS" if not failures else f"{len(failures)} FAIL")
    return 0 if not failures else 1


def _try_import(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--stdio", action="store_true", help="run as the Electron sidecar")
    ap.add_argument("--file", metavar="WAV", help="transcribe a .wav file and exit")
    ap.add_argument("--language", default="hi", choices=["hi", "en", "auto"])
    ap.add_argument("--model", default=DEFAULT_MODEL, choices=MODELS)
    ap.add_argument("--chunked", action="store_true",
                    help="file mode: also report per-chunk latency (1.5 s / 0.5 s overlap)")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--check-runtime", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()
    if args.check_runtime:
        return check_runtime()
    if args.file:
        try:
            return file_mode(args.file, args.language, args.model, args.chunked)
        except Exception as err:
            # A bad WAV (e.g. float32 format the wave module rejects) must
            # answer cleanly, not with a traceback.
            print(json.dumps({"error": f"{type(err).__name__}: {err}", "file": args.file}))
            return 4
    return stdio_service(args.model)


if __name__ == "__main__":
    sys.exit(main())
