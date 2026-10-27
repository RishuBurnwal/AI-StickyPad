#!/usr/bin/env python3
"""AI-StickyPad — interactive launcher and packager.

Run:  python main.py

On start a PREFLIGHT runs: every dependency (Node, npm packages, Python
interpreter, each speech-engine package, speech models) is checked; missing
ones are installed automatically; EVERYTHING is verified again after any
install; only then is the app launched. Already-installed items are never
reinstalled — probes run first, installs happen only for what is missing.
The menu then offers run/build/setup options.
"""
from __future__ import annotations

import importlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)

# VS Code / some terminals set this; Electron then boots as Node and dies.
os.environ.pop("ELECTRON_RUN_AS_NODE", None)

NPM = shutil.which("npm") or shutil.which("npm.cmd")
NPX = shutil.which("npx") or shutil.which("npx.cmd")
ELECTRON_EXE = ROOT / "node_modules" / "electron" / "dist" / "electron.exe"
ENGINE_SCRIPT = ROOT / "stt" / "engine.py"
SETUP_SCRIPT = ROOT / "stt" / "setup.py"

# Every Python package the speech engine needs, with the import that proves it.
PY_PACKAGES = [
    ("numpy", "numpy"),
    ("faster-whisper", "faster_whisper"),
    ("silero-vad", "silero_vad"),
    ("sounddevice", "sounddevice"),
    ("soundcard", "soundcard"),   # call mode: speaker (SU) loopback capture
]
DEFAULT_MODEL = "small"


def pause(msg: str = "Press Enter to continue...") -> None:
    try:
        input(msg)
    except EOFError:
        pass


def step(msg: str) -> None:
    print(f"\n=== {msg} ===", flush=True)


def run(cmd: list[str], **kwargs) -> int:
    print("\n>", " ".join(cmd), flush=True)
    r = subprocess.run(cmd, cwd=str(ROOT), **kwargs)
    return r.returncode


def ensure_node() -> bool:
    if not NPM:
        print("ERROR: npm was not found. Install Node.js: https://nodejs.org/")
        return False
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        print("ERROR: node was not found. Node.js must be on PATH.")
        return False
    return True


def ensure_deps() -> bool:
    if not ensure_node():
        return False
    nm = ROOT / "node_modules"
    if not nm.is_dir() or not ELECTRON_EXE.is_file():
        print("Installing dependencies (npm install)...")
        if run([NPM, "install", "--no-audit", "--no-fund"]) != 0:
            print("npm install failed.")
            return False
    return True


def ensure_builder() -> bool:
    """electron-builder is invoked via npx (not a project dependency)."""
    if not NPX:
        print("ERROR: npx was not found.")
        return False
    return True


def _child_env() -> dict[str, str]:
    """Electron dies if ELECTRON_RUN_AS_NODE is present, even as an empty string."""
    skip = {"ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR"}
    env = {k: v for k, v in os.environ.items() if k not in skip}
    env.pop("ELECTRON_RUN_AS_NODE", None)
    return env


def option_run() -> None:
    # Run does not need npm on PATH if electron.exe is already installed.
    if not ELECTRON_EXE.is_file():
        if not ensure_deps():
            return
    if not ELECTRON_EXE.is_file():
        print(f"ERROR: Electron binary missing:\n  {ELECTRON_EXE}")
        print("Try deleting node_modules and running option 1 again (npm install).")
        return
    print("Starting AI-StickyPad...")
    os.environ.pop("ELECTRON_RUN_AS_NODE", None)
    log_path = ROOT / "electron-launch.log"
    creation = 0
    if sys.platform == "win32":
        # BREAKAWAY: VS Code / jobs kill children. Do NOT use DETACHED_PROCESS —
        # it drops the env/console in a way that often makes Electron exit at once.
        creation = 0x01000000 | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        log_f = log_path.open("w", encoding="utf-8")
    except OSError:
        log_f = subprocess.DEVNULL
    try:
        proc = subprocess.Popen(
            [str(ELECTRON_EXE), str(ROOT)],
            cwd=str(ROOT),
            env=_child_env(),
            stdout=log_f,
            stderr=subprocess.STDOUT,
            creationflags=creation,
        )
    except OSError as err:
        print("ERROR: could not start Electron:", err)
        return
    finally:
        if log_f is not subprocess.DEVNULL:
            try:
                log_f.close()
            except OSError:
                pass
    # Give it a moment so a Node-mode / missing-lock crash is visible here.
    time.sleep(1.2)
    code = proc.poll()
    if code is None:
        print("App launched (control bar is in the top-right).")
        print("If you already had a copy running, that instance was reused.")
        return
    print(f"Electron exited immediately (code {code}).")
    try:
        tail = log_path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        tail = ""
    if tail:
        print("--- electron-launch.log ---")
        print(tail[-2000:])
    else:
        print("No log output. Is another copy already running, or is the binary blocked?")


def option_portable() -> None:
    if not ensure_deps() or not ensure_builder():
        return
    print("Building portable EXE (electron-builder --win portable)...")
    print("The first run may take a while (Electron download).")
    code = run(
        [NPX, "--yes", "electron-builder", "--win", "portable", "--x64"],
    )
    dist = ROOT / "dist"
    if code == 0:
        print("\nDone. Portable files:")
        if dist.is_dir():
            for p in sorted(dist.iterdir()):
                if p.is_file() and p.suffix.lower() in {".exe", ".zip"}:
                    print(" ", p)
        else:
            print(" ", dist)
    else:
        print("Portable build failed. See the error above.")


def option_installer() -> None:
    if not ensure_deps() or not ensure_builder():
        return
    print("Building Windows installer (NSIS)...")
    print("The first run may take a while.")
    code = run(
        [NPX, "--yes", "electron-builder", "--win", "nsis", "--x64"],
    )
    dist = ROOT / "dist"
    if code == 0:
        print("\nDone. Installer:")
        if dist.is_dir():
            for p in sorted(dist.iterdir()):
                if p.is_file() and p.suffix.lower() == ".exe":
                    print(" ", p)
        else:
            print(" ", dist)
    else:
        print("Installer build failed. See the error above.")


MENU = """
========================================
  AI-StickyPad
========================================
  1  Run the app (Electron)
  2  Build portable EXE
  3  Build installer (NSIS)
  4  Speech setup tools (models / check)
  5  Re-run dependency preflight
  0  Exit
========================================
"""


# ---------------------------------------------------------------------------
# Dependency preflight: check -> install only what is missing -> re-verify
# ---------------------------------------------------------------------------

def _pythons() -> list[str]:
    """Interpreter candidates, best guess first."""
    out = [sys.executable]
    py = shutil.which("py")
    if py:
        for ver in ("3.14", "3.13", "3.12", "3.11"):
            out.append(f"{py} -{ver}")
    return out


def _py_run(python_cmd: str, args: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(python_cmd.split() + args, cwd=str(ROOT),
                          capture_output=True, text=True, timeout=timeout)


def _has_pip(python_cmd: str) -> bool:
    try:
        return _py_run(python_cmd, ["-m", "pip", "--version"], timeout=60).returncode == 0
    except Exception:
        return False


def _import_missing(python_cmd: str) -> list[tuple[str, str]]:
    """Per-package probe: [(pip_name, module)] that fail to import."""
    missing = []
    for pip_name, module in PY_PACKAGES:
        try:
            r = _py_run(python_cmd, ["-c", f"import {module}"], timeout=90)
            if r.returncode != 0:
                missing.append((pip_name, module))
        except Exception:
            missing.append((pip_name, module))
    return missing


def _engine_ok(python_cmd: str) -> bool:
    try:
        return _py_run(python_cmd, [str(ENGINE_SCRIPT), "--check-runtime"], timeout=90).returncode == 0
    except Exception:
        return False


def _model_ok() -> bool:
    models = ROOT / "stt" / "models"
    if not models.is_dir():
        return False
    if not any(models.glob(f"models--Systran--faster-whisper-{DEFAULT_MODEL}*")):
        return False
    return (models / "silero_vad.onnx").is_file()


def preflight() -> dict:
    """Check every dependency; install ONLY what is missing; re-verify each
    installed item; return {'ok': bool, 'python': str|None}."""
    step("DEPENDENCY PREFLIGHT - check, install if missing, verify")
    state = {"ok": True, "python": None}

    def mark(name: str, status: str) -> None:
        print(f"  [{status:^20}] {name}", flush=True)

    # 1. Node.js + npm (app runtime)
    if shutil.which("node") and NPM:
        mark("Node.js + npm", "ALREADY OK")
    else:
        mark("Node.js + npm", "MISSING - install from https://nodejs.org/")
        state["ok"] = False

    # 2. npm packages (Electron) - never reinstall when present
    if ELECTRON_EXE.is_file():
        mark("npm packages (electron)", "ALREADY OK")
    else:
        if NPM:
            print("  > npm install --no-audit --no-fund", flush=True)
            code = subprocess.run([NPM, "install", "--no-audit", "--no-fund"],
                                  cwd=str(ROOT)).returncode
            if code == 0 and ELECTRON_EXE.is_file():
                mark("npm packages (electron)", "INSTALLED + VERIFIED")
            else:
                mark("npm packages (electron)", "INSTALL FAILED")
                state["ok"] = False
        else:
            mark("npm packages (electron)", "SKIPPED (no npm)")
            state["ok"] = False

    # 3. Python interpreter with every speech-engine package
    chosen = None
    for cand in _pythons():
        if not _has_pip(cand):
            continue
        if not _import_missing(cand):
            chosen = cand
            mark(f"Python engine deps ({cand})", "ALREADY OK")
            break
    if chosen is None:
        # Install ONLY the missing packages, fewest-missing interpreter first —
        # so a machine with one small gap is repaired before a candidate whose
        # gap is an unbuildable wheel (e.g. av on brand-new Pythons) is tried.
        candidates = []
        for cand in _pythons():
            if not _has_pip(cand):
                continue
            missing = _import_missing(cand)
            candidates.append((len(missing), cand, missing))
        candidates.sort(key=lambda t: t[0])
        for _count, cand, missing in candidates:
            if not missing:
                chosen = cand
                break
            names = [m[0] for m in missing]
            print(f"  > {cand} -m pip install --prefer-binary --user {' '.join(names)}", flush=True)
            try:
                code = subprocess.run(
                    cand.split() + ["-m", "pip", "install", "--prefer-binary", "--user"] + names,
                    cwd=str(ROOT)).returncode
            except Exception:
                code = 1
            # RE-VERIFY every package individually after install
            still = _import_missing(cand)
            if code == 0 and not still:
                chosen = cand
                mark(f"Python packages ({', '.join(names)})", "INSTALLED + VERIFIED")
                break
            if still:
                mark(f"Python packages ({', '.join(names)})",
                     f"STILL MISSING: {', '.join(m[1] for m in still)}")
    if chosen:
        state["python"] = chosen
    else:
        mark("Python interpreter with engine deps", "NOT FOUND (install Python 3.12-3.14)")
        state["ok"] = False

    # 4. speech models - setup.py is idempotent (skips what exists)
    if chosen:
        if _model_ok():
            mark(f"Speech model ({DEFAULT_MODEL}) + Silero VAD", "ALREADY OK")
        else:
            print(f"  > python stt/setup.py --model {DEFAULT_MODEL} (downloads only what is missing)", flush=True)
            try:
                code = subprocess.run(
                    chosen.split() + [str(SETUP_SCRIPT), "--model", DEFAULT_MODEL],
                    cwd=str(ROOT)).returncode
            except Exception:
                code = 1
            if code == 0 and _model_ok():
                mark(f"Speech model ({DEFAULT_MODEL}) + Silero VAD", "INSTALLED + VERIFIED")
            else:
                mark(f"Speech model ({DEFAULT_MODEL}) + Silero VAD", "INSTALL/VERIFY FAILED")
                state["ok"] = False
        # final gate: the engine itself confirms everything imports
        if state["ok"] and not _engine_ok(chosen):
            mark("Engine self-check (--check-runtime)", "FAILED")
            state["ok"] = False
        elif state["ok"]:
            mark("Engine self-check (--check-runtime)", "VERIFIED")

    print("\n  PREFLIGHT: " + ("ALL DEPENDENCIES VERIFIED" if state["ok"]
                              else "INCOMPLETE - see the [FAILED] lines above"))
    return state


def option_run(auto: bool = False) -> None:
    # Run does not need npm on PATH if electron.exe is already installed.
    if not ELECTRON_EXE.is_file():
        if not ensure_deps():
            return
    if not ELECTRON_EXE.is_file():
        print(f"ERROR: Electron binary missing:\n  {ELECTRON_EXE}")
        print("Try deleting node_modules and running again (npm install).")
        return
    print("Launching AI-StickyPad (dependencies verified)..." if auto
          else "Starting AI-StickyPad...")
    os.environ.pop("ELECTRON_RUN_AS_NODE", None)
    log_path = ROOT / "electron-launch.log"
    creation = 0
    if sys.platform == "win32":
        # BREAKAWAY: VS Code / jobs kill children. Do NOT use DETACHED_PROCESS -
        # it drops the env/console in a way that often makes Electron exit at once.
        creation = 0x01000000 | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        log_f = log_path.open("w", encoding="utf-8")
    except OSError:
        log_f = subprocess.DEVNULL
    try:
        proc = subprocess.Popen(
            [str(ELECTRON_EXE), str(ROOT)],
            cwd=str(ROOT),
            env=_child_env(),
            stdout=log_f,
            stderr=subprocess.STDOUT,
            creationflags=creation,
        )
    except OSError as err:
        print("ERROR: could not start Electron:", err)
        return
    finally:
        if log_f is not subprocess.DEVNULL:
            try:
                log_f.close()
            except OSError:
                pass
    # Give it a moment so a Node-mode / missing-lock crash is visible here.
    time.sleep(1.2)
    code = proc.poll()
    if code is None:
        print("App launched (control bar is in the top-right).")
        print("If you already had a copy running, that instance was reused.")
        return
    print(f"Electron exited immediately (code {code}).")
    try:
        tail = log_path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        tail = ""
    if tail:
        print("--- electron-launch.log ---")
        print(tail[-2000:])
    else:
        print("No log output. Is another copy already running, or is the binary blocked?")


def option_portable() -> None:
    if not ensure_deps() or not ensure_builder():
        return
    print("Building portable EXE (electron-builder --win portable)...")
    print("The first run may take a while (Electron download).")
    code = run(
        [NPX, "--yes", "electron-builder", "--win", "portable", "--x64"],
    )
    dist = ROOT / "dist"
    if code == 0:
        print("\nDone. Portable files:")
        if dist.is_dir():
            for p in sorted(dist.iterdir()):
                if p.is_file() and p.suffix.lower() in {".exe", ".zip"}:
                    print(" ", p)
    else:
        print("Portable build failed. See the error above.")


def option_installer() -> None:
    if not ensure_deps() or not ensure_builder():
        return
    print("Building Windows installer (NSIS)...")
    print("The first run may take a while.")
    code = run(
        [NPX, "--yes", "electron-builder", "--win", "nsis", "--x64"],
    )
    dist = ROOT / "dist"
    if code == 0:
        print("\nDone. Installer:")
        if dist.is_dir():
            for p in sorted(dist.iterdir()):
                if p.is_file() and p.suffix.lower() == ".exe":
                    print(" ", p)
    else:
        print("Installer build failed. See the error above.")


def option_stt() -> None:
    """Manual speech tools: model download / dependency check."""
    print("Speech setup tools:")
    print("  a  Download / verify model (small default; base/tiny also possible)")
    print("  b  Check runtime dependencies only")
    what = input("Choose (a/b, Enter = a): ").strip().lower() or "a"
    if what == "b":
        run([sys.executable, str(ENGINE_SCRIPT), "--check-runtime"])
        return
    model = input("Model (small/base/tiny, Enter = small): ").strip() or "small"
    if model not in ("small", "base", "tiny"):
        model = "small"
    run([sys.executable, str(SETUP_SCRIPT), "--model", model])


def main() -> None:
    # PREFLIGHT on every start: check everything, install only what is
    # missing, verify each install, then launch the app automatically.
    state = preflight()
    if state["ok"]:
        print("\nAll dependencies verified - launching the app.")
        option_run(auto=True)
    else:
        print("\nPreflight incomplete - the menu below still works;"
              " fix the [FAILED] items (usually internet for pip/npm).")

    while True:
        print(MENU)
        try:
            choice = input("Option (0-5): ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye.")
            return
        if choice == "1":
            option_run()
            pause()
        elif choice == "2":
            option_portable()
            pause()
        elif choice == "3":
            option_installer()
            pause()
        elif choice == "4":
            option_stt()
            pause()
        elif choice == "5":
            preflight()
            pause()
        elif choice == "0":
            print("Bye.")
            return
        else:
            print("Invalid option. Enter 0, 1, 2, 3, 4, or 5.")


if __name__ == "__main__":
    main()
