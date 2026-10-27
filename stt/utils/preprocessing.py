"""Noise suppression + voice activity detection.

Denoise keeps to plain numpy on purpose: a high-pass filter (speech lives
above ~85 Hz; rumble and hum live below) plus a soft RMS gate per 30 ms
frame. Heavy spectral suppression (RNNoise-class) is available through the
optional `noisereduce` package — enable with STT_NOISEREDUCE=1 — but it is
off by default because it costs latency and Silero VAD already gates
silence, while faster-whisper itself is robust to steady noise.

VAD is Silero (~2 MB ONNX, CPU, fully offline) through the `silero-vad`
package. It decides when an utterance starts and ends, and fires the
barge-in signal the moment speech begins.
"""
from __future__ import annotations

import os
from collections import deque

import numpy as np

SAMPLE_RATE = 16000
# Silero expects 512-sample frames at 16 kHz (32 ms) — anything else drops accuracy.
VAD_FRAME = 512


def highpass(audio: np.ndarray, sample_rate: int = SAMPLE_RATE, cutoff: float = 90.0) -> np.ndarray:
    """Second-order high-pass (two cascaded first-order stages).

    Mains hum sits at 50 Hz; a single first-order stage at 85 Hz only
    attenuates it ~5 dB, which whisper then hallucinates on (measured).
    Two stages put the hum ~17 dB down before the gate even runs.
    """
    if audio.size == 0:
        return audio
    out = audio
    for _ in range(2):
        rc = 1.0 / (2.0 * np.pi * cutoff)
        dt = 1.0 / sample_rate
        alpha = rc / (rc + dt)
        filtered = np.empty_like(out)
        prev_in = float(out[0])
        prev_out = 0.0
        for i in range(out.size):
            cur = float(out[i])
            prev_out = alpha * (prev_out + cur - prev_in)
            filtered[i] = prev_out
            prev_in = cur
        out = filtered
    return out


def soft_noise_gate(audio: np.ndarray, sample_rate: int = SAMPLE_RATE,
                    frame_ms: int = 30, attenuation_db: float = -14.0) -> np.ndarray:
    """Attenuate frames whose RMS is far below the utterance's median.

    Conservative by design: quiet-but-real speech tails survive because the
    threshold tracks the utterance's own level, and the gain floor is -14 dB,
    not silence.
    """
    if audio.size < sample_rate * frame_ms / 1000:
        return audio
    frame = int(sample_rate * frame_ms / 1000)
    n = audio.size // frame
    gain = 10.0 ** (attenuation_db / 20.0)
    out = audio.copy()
    rms = np.sqrt(np.mean(np.square(audio[: n * frame].reshape(n, frame)), axis=1))
    floor = max(np.median(rms) * 0.45, 1e-4)
    quiet = np.where(rms < floor)[0]
    for i in quiet:
        out[i * frame: (i + 1) * frame] *= gain
    return out


def denoise(audio: np.ndarray, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """The default light chain: high-pass then soft gate."""
    if audio.size == 0:
        return audio
    audio = highpass(audio, sample_rate)
    audio = soft_noise_gate(audio, sample_rate)
    if os.environ.get("STT_NOISEREDUCE", "").lower() in ("1", "true", "yes"):
        try:
            import noisereduce as nr  # optional dependency
            audio = nr.reduce_noise(y=audio, sr=sample_rate, stationary=False)
        except Exception:
            pass
    audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 1.0:
        audio = audio / peak  # whisper expects [-1, 1]
    return audio.astype(np.float32, copy=False)


class SileroVAD:
    """Silero VAD wrapper speaking start/end events in sample offsets.

    is_speech() answers the "is anyone talking right now" question for a
    single frame (barge-in); push() runs the iterator's hysteresis so a
    cough does not end an utterance and a pause between words does not
    split it into three.
    """

    def __init__(self, threshold: float = 0.5,
                 min_silence_ms: int = 420, speech_pad_ms: int = 90) -> None:
        from silero_vad import VADIterator, load_silero_vad
        self._model = load_silero_vad(onnx=True)
        self.iterator = VADIterator(
            self._model,
            sampling_rate=SAMPLE_RATE,
            threshold=threshold,
            min_silence_duration_ms=min_silence_ms,
            speech_pad_ms=speech_pad_ms,
        )
        self.total_samples = 0

    @staticmethod
    def frame_ok(frame: np.ndarray) -> bool:
        return frame is not None and np.asarray(frame).size == VAD_FRAME

    def is_speech(self, frame: np.ndarray) -> bool:
        """Instant answer for one 512-sample frame (used for barge-in)."""
        if not self.frame_ok(frame):
            return False
        import torch  # silero's ONNX path still routes through torch tensors
        with torch.no_grad():
            prob = self._model(torch.from_numpy(np.asarray(frame, dtype=np.float32)), SAMPLE_RATE).item()
        return prob >= 0.5

    def push(self, frame: np.ndarray) -> list[dict]:
        """Feed one 512-sample frame; returns [] or [{'start': n}] / [{'end': n}]."""
        if not self.frame_ok(frame):
            self.total_samples += np.asarray(frame).size if frame is not None else 0
            return []
        events = self.iterator(np.asarray(frame, dtype=np.float32), SAMPLE_RATE)
        self.total_samples += VAD_FRAME
        out = []
        if isinstance(events, dict):
            for kind in ("start", "end"):
                if kind in events:
                    out.append({"type": kind, "sample": int(events[kind])})
        return out

    def reset(self) -> None:
        try:
            self.iterator.reset_states()
        except Exception:
            pass
