#!/usr/bin/env python3
"""AI-StickyPad — interactive launcher and packager.

Run:  python main.py
Menu only (no CLI flags or attributes).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)

# VS Code / some terminals set this; Electron then boots as Node and dies.
os.environ.pop("ELECTRON_RUN_AS_NODE", None)

NPM = shutil.which("npm") or shutil.which("npm.cmd")
NPX = shutil.which("npx") or shutil.which("npx.cmd")
ELECTRON_EXE = ROOT / "node_modules" / "electron" / "dist" / "electron.exe"


def pause(msg: str = "Press Enter to continue...") -> None:
    try:
        input(msg)
    except EOFError:
        pass


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


def option_run() -> None:
    if not ensure_deps():
        return
    print("Starting AI-StickyPad...")
    creation = 0
    if sys.platform == "win32":
        creation = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    subprocess.Popen(
        [str(ELECTRON_EXE), str(ROOT)],
        cwd=str(ROOT),
        env={k: v for k, v in os.environ.items() if k != "ELECTRON_RUN_AS_NODE"},
        close_fds=True,
        creationflags=creation,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print("App launched (control bar is in the top-right).")


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
  0  Exit
========================================
"""


def main() -> None:
    while True:
        print(MENU)
        try:
            choice = input("Option (0-3): ").strip()
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
        elif choice == "0":
            print("Bye.")
            return
        else:
            print("Invalid option. Enter 0, 1, 2, or 3.")


if __name__ == "__main__":
    main()
