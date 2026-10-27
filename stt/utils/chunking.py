"""Audio chunking: 1.5 s windows with 0.5 s overlap (spec defaults).

The overlap exists so a word spoken across a chunk boundary is present
whole in at least one chunk — the classic streaming-ASR trick. The live
dictation loop feeds whole utterances to the model instead (better: no
boundary at all), so this module is used by the file mode, the self-test
and any caller that must process a long recording in fixed pieces.
"""
from __future__ import annotations

import numpy as np

CHUNK_MS = 1500
OVERLAP_MS = 500


class Chunker:
    """Turns a continuous sample stream into overlapping fixed-size chunks.

    feed() returns the chunks that became complete; flush() returns the
    trailing remainder (shorter than a full chunk) so no audio is lost.
    Each chunk is reported as (audio, start_seconds) where start_seconds
    is the position of the chunk's first sample in the original stream.
    """

    def __init__(self, sample_rate: int = 16000,
                 chunk_ms: int = CHUNK_MS, overlap_ms: int = OVERLAP_MS) -> None:
        self.chunk = int(sample_rate * chunk_ms / 1000)
        overlap = int(sample_rate * overlap_ms / 1000)
        # Overlap longer than half the chunk would emit the same audio twice.
        self.overlap = min(overlap, self.chunk // 2)
        self.step = self.chunk - self.overlap
        self.sample_rate = sample_rate
        self._buf = np.zeros(0, dtype=np.float32)
        self._buf_start = 0  # sample offset of _buf[0] in the stream

    def feed(self, audio: np.ndarray) -> list[tuple[np.ndarray, float]]:
        out: list[tuple[np.ndarray, float]] = []
        if audio is not None and audio.size:
            self._buf = np.concatenate([self._buf, audio.astype(np.float32, copy=False)])
        while self._buf.size >= self.chunk:
            t0 = self._buf_start / self.sample_rate
            out.append((self._buf[: self.chunk].copy(), t0))
            self._buf = self._buf[self.step:]
            self._buf_start += self.step
        return out

    def flush(self) -> list[tuple[np.ndarray, float]]:
        # A tail shorter than the overlap carries almost no new audio; anything
        # longer is worth transcribing.
        if self._buf.size <= self.overlap:
            self._buf = np.zeros(0, dtype=np.float32)
            return []
        t0 = self._buf_start / self.sample_rate
        out = [(self._buf.copy(), t0)]
        self._buf = np.zeros(0, dtype=np.float32)
        return out
