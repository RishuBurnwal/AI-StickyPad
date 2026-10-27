"""Call mode: dual-channel live transcription.

PU (Primary User)  = the real microphone  — whoever sits at this machine.
SU (Secondary User) = WASAPI loopback of the default output device — whoever
is on the far side of a Zoom / Google Meet / WhatsApp call, captured
digitally from the system mixer (no acoustics, no echo problem: the two
channels never mix).

One shared whisper instance (CTranslate2 model ~500 MB in RAM once) serves
both channels through a single worker thread; each channel keeps its own
Silero VAD and utterance state machine. Events are channel-tagged:

  {"type":"partial","ch":"mic","text":...}   {"type":"final","ch":"sys",...}

Labeling PU/SU and per-user colours live in the Electron host (main.js);
the engine only reports which channel spoke.
"""
from __future__ import annotations

import queue
import threading
import time

import numpy as np

from engine import (
    DEFAULT_MODEL, LANGUAGE_HINTS, MAX_UTTERANCE_S, MIN_PARTIAL_S,
    PARTIAL_EVERY_S, PREROLL_S, SAMPLE_RATE, VAD_FRAME, Transcriber, log,
)
from utils.grammar_fix import fix_text
from utils.preprocessing import SileroVAD, denoise

CALL_PARTIAL_EVERY_S = 1.4   # two channels share one CPU: slower partial cadence


class Channel:
    """One audio source's VAD + utterance state machine (job-queue based).

    Mirrors engine.Dictation's frame logic, but instead of transcribing
    inline it enqueues (kind, channel, audio) jobs so a single worker can
    serve both channels with one whisper instance safely.
    """

    def __init__(self, ch: str, jobs: queue.Queue, emit, language: str) -> None:
        self.ch = ch
        self.jobs = jobs
        self.emit = emit
        self.language = language
        self.vad = SileroVAD()
        self.speaking = False
        self.ai_speaking = False
        self._preroll = np.zeros(0, dtype=np.float32)
        self._buf = np.zeros(0, dtype=np.float32)
        self._last_partial_t = 0.0
        self._last_partial_samples = 0
        self._last_partial_text = ""

    def emit_ch(self, ev: dict) -> None:
        ev["ch"] = self.ch
        self.emit(ev)

    def on_frame(self, frame: np.ndarray) -> None:
        if frame is None or frame.size == 0:
            return
        frame = np.ascontiguousarray(frame.astype(np.float32, copy=False))
        for ev in self.vad.push(frame):
            if ev["type"] == "start":
                self._on_start()
            elif ev["type"] == "end":
                self._on_end()
        if self.speaking:
            self._buf = np.concatenate([self._buf, frame])
            self._maybe_partial()
            if self._buf.size >= MAX_UTTERANCE_S * SAMPLE_RATE:
                self._commit(restart=True)
        else:
            keep = int(PREROLL_S * SAMPLE_RATE)
            self._preroll = np.concatenate([self._preroll, frame])[-keep:]

    def _on_start(self) -> None:
        self.speaking = True
        self.emit_ch({"type": "vad", "speech": True})
        if self.ai_speaking and self.ch == "mic":
            # Only the local user can barge in on the AI; the far side of a
            # call is exactly what the AI is allowed to finish saying.
            self.emit({"type": "barge_in"})

    def _on_end(self) -> None:
        self.emit_ch({"type": "vad", "speech": False})
        self._commit(restart=False)

    def _utterance(self) -> np.ndarray:
        pre = self._preroll if self._preroll.size > int(0.08 * SAMPLE_RATE) else np.zeros(0, dtype=np.float32)
        return np.concatenate([pre, self._buf])

    def _maybe_partial(self) -> None:
        if self._buf.size < MIN_PARTIAL_S * SAMPLE_RATE:
            return
        if self._buf.size - self._last_partial_samples < int(0.5 * SAMPLE_RATE):
            return
        now = time.perf_counter()
        if now - self._last_partial_t < CALL_PARTIAL_EVERY_S:
            return
        self._last_partial_t = now
        self._last_partial_samples = self._buf.size
        self.jobs.put(("partial", self.ch, self._utterance().copy()))

    def _commit(self, restart: bool) -> None:
        audio_ms = self._utterance().size * 1000.0 / SAMPLE_RATE
        if self._buf.size >= 0.32 * SAMPLE_RATE:
            self.jobs.put(("final", self.ch, self._utterance().copy(), audio_ms))
        elif audio_ms >= 400:
            self.emit_ch({"type": "final", "text": "", "ms": 0.0, "audio_ms": round(audio_ms, 1)})
        self.speaking = False
        self._buf = np.zeros(0, dtype=np.float32)
        self._preroll = np.zeros(0, dtype=np.float32)
        self._last_partial_text = ""
        self._last_partial_samples = 0
        if restart:
            self.emit_ch({"type": "vad", "speech": False})
            self.vad.reset()


class SpeakerLoopback:
    """Capture what the default OUTPUT device is playing (WASAPI loopback).

    Uses the pure-python `soundcard` package; COM is initialised on the
    worker thread (WASAPI calls fail there otherwise: 0x800401f0).
    """

    def __init__(self, on_frame) -> None:
        self.on_frame = on_frame
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        import soundcard as sc

        spk = sc.default_speaker()
        lb = sc.get_microphone(spk.id, include_loopback=True)
        self._thread = threading.Thread(target=self._run, args=(lb,), name="stt-call-sys", daemon=True)
        self._thread.start()

    def _run(self, lb) -> None:
        try:
            import comtypes
            comtypes.CoInitialize()
        except Exception:
            pass
        try:
            with lb.recorder(samplerate=SAMPLE_RATE, channels=1) as rec:
                while not self._stop.is_set():
                    data = rec.record(numframes=VAD_FRAME)
                    if data.size:
                        self.on_frame(data.reshape(-1)[:VAD_FRAME].astype(np.float32))
        except Exception as err:
            log("loopback capture ended:", err)
            self.on_frame(None)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None


class CallSession:
    """Active channels + the shared transcription worker.

    `channels` picks what to capture: ['mic'] (only PU), ['sys'] (only SU,
    the speaker loopback) or both — driven by the bar's listener setting.
    """

    def __init__(self, emit, language: str = "hi", model: str = DEFAULT_MODEL,
                 channels: list[str] | None = None) -> None:
        self.emit = emit
        self.jobs: queue.Queue = queue.Queue()
        self.transcriber = Transcriber(model)
        self.active = channels or ["mic", "sys"]
        self.mic_ch = Channel("mic", self.jobs, emit, language)
        self.sys_ch = Channel("sys", self.jobs, emit, language)
        self.mic_stream = None
        self.loopback = None
        self._worker = None
        self._stop_worker = threading.Event()

    def start(self) -> None:
        from engine import MicStream

        self.transcriber.load()
        if "mic" in self.active:
            self.mic_stream = MicStream(self.mic_ch.on_frame, self.emit)
            self.mic_stream.start()
        if "sys" in self.active:
            self.loopback = SpeakerLoopback(self.sys_ch.on_frame)
            self.loopback.start()
        self._worker = threading.Thread(target=self._work, name="stt-call-worker", daemon=True)
        self._worker.start()
        sides = " + ".join({"mic": "PU", "sys": "SU"}.get(c, c) for c in self.active)
        self.emit({"type": "status", "message": f"call mode listening: {sides}"})

    def _work(self) -> None:
        # Drains even after _stop_worker is set — a stop() mid-utterance must
        # still deliver the queued finals.
        while not (self._stop_worker.is_set() and self.jobs.empty()):
            try:
                job = self.jobs.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                kind, ch, audio = job[0], job[1], job[2]
                audio_ms = job[3] if len(job) > 3 else audio.size * 1000.0 / SAMPLE_RATE
                raw = self.transcriber.transcribe(denoise(audio), "hi")
                text = suppress_echo_text(fix_text(raw, "hi"), "hi")
                if kind == "final" and not text and audio_ms < 400:
                    continue
                self.emit({
                    "type": kind, "ch": ch, "text": text,
                    "ms": round(self.transcriber.last_ms, 1),
                    "audio_ms": round(audio_ms, 1),
                })
            except Exception as err:
                # The worker serves BOTH channels — it must never die on one
                # bad job (a dead worker silently eats every final after it).
                log(f"call job failed ({job[1] if len(job) > 1 else '?'}):", err)

    def set_ai_speaking(self, on: bool) -> None:
        self.mic_ch.ai_speaking = on

    def stop(self) -> None:
        # Flush both channels so the last words are not lost.
        for ch in (self.mic_ch, self.sys_ch):
            if ch.speaking:
                ch._commit(restart=False)
        if self.mic_stream is not None:
            self.mic_stream.stop()
            self.mic_stream = None
        if self.loopback is not None:
            self.loopback.stop()
            self.loopback = None
        self._stop_worker.set()
        if self._worker is not None:
            self._worker.join(timeout=60)   # drain: queued finals must land
            self._worker = None


def suppress_echo_text(text: str, language: str) -> str:
    """Reuses engine's prompt-echo suppression (import-time function)."""
    from engine import suppress_prompt_echo
    return suppress_prompt_echo(text, language)
