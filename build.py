"""Build a standalone Blood Connect executable with PyInstaller.

Usage:
    python build.py            # build the bundle
    python build.py --run      # build, then launch the result

The output lands in ``dist/``:
    Windows : dist/BloodConnect.exe
    macOS   : dist/BloodConnect.app
    Linux   : dist/BloodConnect

PyInstaller must be installed first:
    python -m pip install "pyinstaller>=6.0"
or, with the project extras:
    python -m pip install -e ".[build]"
"""

from __future__ import annotations

import argparse
import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPEC = ROOT / "blood_connect.spec"
MIN_PYTHON = (3, 10)


def check_python() -> None:
    if sys.version_info < MIN_PYTHON:
        current = ".".join(str(part) for part in sys.version_info[:3])
        required = ".".join(str(part) for part in MIN_PYTHON)
        raise SystemExit(
            f"Blood Connect needs Python {required} or newer; this is {current}."
        )


def check_tkinter() -> None:
    if importlib.util.find_spec("tkinter") is None:
        raise SystemExit(
            "tkinter is missing, so a bundle built here would not open a window.\n"
            "  Debian/Ubuntu : sudo apt-get install python3-tk\n"
            "  Fedora        : sudo dnf install python3-tkinter\n"
            "  Windows/macOS : reinstall Python from python.org (Tk is bundled)"
        )


def check_pyinstaller() -> None:
    if importlib.util.find_spec("PyInstaller") is None:
        raise SystemExit(
            "PyInstaller is not installed. Install it with:\n"
            '  python -m pip install "pyinstaller>=6.0"\n'
            'or:  python -m pip install -e ".[build]"'
        )


def artifact_path() -> Path:
    if sys.platform == "darwin":
        return ROOT / "dist" / "BloodConnect.app"
    if sys.platform == "win32":
        return ROOT / "dist" / "BloodConnect.exe"
    return ROOT / "dist" / "BloodConnect"


def build() -> Path:
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        str(SPEC),
    ]
    print("Running:", " ".join(command))
    subprocess.run(command, cwd=ROOT, check=True)
    target = artifact_path()
    if not target.exists():
        raise SystemExit(f"Build finished but {target} was not produced.")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a standalone Blood Connect app.")
    parser.add_argument(
        "--run",
        action="store_true",
        help="Launch the built application once the build succeeds.",
    )
    args = parser.parse_args()

    check_python()
    check_tkinter()
    check_pyinstaller()
    target = build()
    print(f"\nBuilt: {target}")

    if args.run:
        if sys.platform == "win32":
            subprocess.run([str(target)], check=False)
        elif sys.platform == "darwin":
            subprocess.run(["open", str(target)], check=False)
        else:
            subprocess.run([str(target)], check=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
