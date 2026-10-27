#!/usr/bin/env python3
"""One-time setup for offline dictation (Hindi / Hinglish / English).

Installs the Python dependencies, downloads the speech models into
stt/models/, and verifies everything loads. After this the app's 🎤 button
works fully offline — no internet, no GPU.

Usage:
  python stt/setup.py                 # deps + default model ("small", best Hindi)
  python stt/setup.py --model base    # faster, weaker Devanagari
  python stt/setup.py --model tiny    # fastest, English-only quality
  python stt/setup.py --check         # verify only, install/download nothing

Model choice: the original requirement named Moonshine, but Moonshine is an
English-only ASR model — no Hindi version exists. faster-whisper (CTranslate2,
INT8) provides real Hindi + Hinglish code-switching on CPU, offline.
"""
from __future__ import annotations

import argparse
import importlib
import json
import os

# Same notices engine.py silences: Xet fallback + Windows symlink warnings
# on first download would otherwise look like the setup failed.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import shutil
import subprocess
import sys
import time
from pathlib import Path

STT_ROOT = Path(__file__).resolve().parent
MODELS_DIR = Path(os.environ.get("STT_MODELS_DIR") or (STT_ROOT / "models"))
REQUIREMENTS = STT_ROOT / "requirements.txt"
MODELS = ("tiny", "base", "small")
# small by default: base mangles Devanagari Hindi (measured during the
# 2026-10-25 bring-up); tiny hallucinates on it. small is the first size
# that actually meets the Hindi requirement.
DEFAULT_MODEL = "small"
DEPS = ("numpy", "faster_whisper", "silero_vad", "sounddevice", "soundcard")


def step(msg: str) -> None:
    print(f"\n=== {msg} ===", flush=True)


def have_deps() -> list[str]:
    missing = []
    for mod in DEPS:
        try:
            importlib.import_module(mod)
        except Exception:
            missing.append(mod)
    return missing


def install_deps() -> bool:
    missing = have_deps()
    if not missing:
        print("Dependencies already installed.")
        return True
    step(f"Installing Python dependencies (missing: {', '.join(missing)})")
    cmd = [sys.executable, "-m", "pip", "install", "--prefer-binary",
           "-r", str(REQUIREMENTS)]
    print(">", " ".join(cmd), flush=True)
    # Inherit the console so pip's progress and any error text are visible.
    code = subprocess.call(cmd)
    if code != 0:
        print(f"pip failed with exit code {code}."
              " If this Python is too new, try another one, e.g."
              "  py -3.14 -m pip install -r stt/requirements.txt")
        return False
    still = have_deps()
    if still:
        print(f"Still missing after install: {', '.join(still)}")
        return False
    return True


def model_dir_name(model: str) -> str:
    return f"models--Systran--faster-whisper-{model}"


def model_present(model: str) -> bool:
    return any(MODELS_DIR.glob(model_dir_name(model) + "*"))


def download_model(model: str) -> bool:
    if model_present(model):
        print(f"Model '{model}' already downloaded.")
        return True
    step(f"Downloading whisper '{model}' (INT8) into {MODELS_DIR}")
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        from faster_whisper import WhisperModel
        # Instantiating downloads into download_root; stdout is redirected
        # because download bars would garble this script's own output.
        real = sys.stdout
        try:
            sys.stdout = sys.stderr
            WhisperModel(model, device="cpu", compute_type="int8",
                         download_root=str(MODELS_DIR))
        finally:
            sys.stdout = real
    except Exception as err:
        print(f"Model download failed: {err}")
        return False
    if not model_present(model):
        print("Download reported success but the model directory is missing.")
        return False
    return True


def copy_silero() -> bool:
    step("Copying Silero VAD into stt/models/")
    try:
        import silero_vad
        pkg = Path(silero_vad.__file__).parent
        src = None
        for cand in (pkg / "data" / "silero_vad.onnx", pkg / "silero_vad.onnx"):
            if cand.is_file():
                src = cand
                break
        if src is None:  # walk as a fallback (package layout has changed before)
            for p in pkg.rglob("*.onnx"):
                if p.name == "silero_vad.onnx":
                    src = p
                    break
        if src is None:
            print("Could not find silero_vad.onnx inside the silero_vad package.")
            return False
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        dest = MODELS_DIR / "silero_vad.onnx"
        shutil.copyfile(src, dest)
        print(f"  {dest}  ({dest.stat().st_size / 1e6:.1f} MB)")
        return True
    except Exception as err:
        print(f"Silero copy failed: {err}")
        return False


def dir_size_mb(p: Path) -> float:
    total = 0
    for f in p.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            pass
    return total / 1e6


def verify(model: str) -> bool:
    step("Verifying: load model offline + transcribe silence")
    try:
        sys.path.insert(0, str(STT_ROOT))
        import numpy as np
        from faster_whisper import WhisperModel

        wm = WhisperModel(model, device="cpu", compute_type="int8",
                          download_root=str(MODELS_DIR), local_files_only=True)
        t0 = time.perf_counter()
        segs, _ = wm.transcribe(np.zeros(16000, dtype=np.float32), language="hi",
                                beam_size=1)
        _ = [s.text for s in segs]
        ms = (time.perf_counter() - t0) * 1000
        print(f"  whisper '{model}' loaded from disk and ran in {ms:.0f} ms")
        return True
    except Exception as err:
        print(f"  verification failed: {err}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Offline STT setup for AI-StickyPad")
    ap.add_argument("--model", default=DEFAULT_MODEL, choices=MODELS)
    ap.add_argument("--check", action="store_true",
                    help="only verify deps + model presence; change nothing")
    args = ap.parse_args()

    print(f"Python: {sys.version.split()[0]}  ({sys.executable})")
    if sys.version_info < (3, 9):
        print("ERROR: Python 3.9 or newer is required.")
        return 1

    if args.check:
        missing = have_deps()
        print(json.dumps({
            "deps_ok": not missing,
            "missing_deps": missing,
            "model_present": model_present(args.model),
            "models_dir": str(MODELS_DIR),
        }))
        return 0 if (not missing and model_present(args.model)) else 1

    ok = install_deps()
    ok = download_model(args.model) and ok
    ok = copy_silero() and ok
    ok = verify(args.model) and ok

    if ok:
        step("Summary")
        size = dir_size_mb(MODELS_DIR)
        print(f"  models dir : {MODELS_DIR}  ({size:.0f} MB total)")
        print("  dictation is now fully OFFLINE — press 🎤 on any note.")
        print("  (If the button says setup is needed, set STT_PYTHON to this"
              " interpreter, e.g.  STT_PYTHON=py -3.14 )")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
