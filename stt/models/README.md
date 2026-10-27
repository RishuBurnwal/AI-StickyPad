# Speech models (downloaded here by `python stt/setup.py`)

Nothing in this folder is committed to git — `setup.py` fills it once, after
which dictation runs **fully offline**.

| Item | What | Size (approx, on disk) | Licence |
| --- | --- | --- | --- |
| `models--Systran--faster-whisper-small` | Whisper **small**, CTranslate2 **INT8** (**default** — first size whose Devanagari Hindi is good) | ~490 MB | MIT |
| `models--Systran--faster-whisper-base` | Whisper **base**, INT8 (`--model base` / `STT_MODEL=base` — faster, garbles Devanagari) | ~150 MB | MIT |
| `models--Systran--faster-whisper-tiny` | Whisper **tiny**, INT8 (`--model tiny` — fastest) | ~80 MB | MIT |
| `silero_vad.onnx` | Silero VAD (speech / silence detection, barge-in) | ~2 MB | MIT |

All models run on CPU (`int8`, no GPU needed). Pick **one** model — a single
download stays inside the 500 MB budget (the sizes above include the
HuggingFace cache's blob + snapshot copy, which doubles on Windows where
symlinks need Developer Mode; keeping all three downloaded at once does not).

## Why faster-whisper and not Moonshine

The original requirement asked for "Moonshine, optimized for Hindi/Hinglish",
but Moonshine is an **English-only** ASR model — no Hindi or code-switching
version exists to download or quantize. faster-whisper was chosen because it
is the smallest widely-verified engine that actually meets the requirement:
Hindi + Hinglish code-switching, INT8-quantized, offline, CPU-only.

## Overriding the location

Set `STT_MODELS_DIR` before running `setup.py` / the app to store the models
somewhere else (e.g. a shared drive). The engine reads the same variable.
