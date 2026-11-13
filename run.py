"""Start the Blood Connect desktop application.

Usage:
    python run.py
    python run.py --database demo.db
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import tkinter as tk

from blood_connect.database import Database
from blood_connect.gui import BloodConnectApp
from blood_connect.service import BloodConnectService

APP_FOLDER_NAME = "BloodConnect"
DATABASE_FILE_NAME = "blood_connect.db"


def user_data_dir() -> Path:
    """Return this user's application data folder for the app, per platform."""
    if sys.platform == "win32":
        roaming = os.environ.get("APPDATA")
        root = Path(roaming) if roaming else Path.home() / "AppData" / "Roaming"
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support"
    else:
        xdg_data_home = os.environ.get("XDG_DATA_HOME")
        root = Path(xdg_data_home) if xdg_data_home else Path.home() / ".local" / "share"
    return root / APP_FOLDER_NAME


def default_database_path() -> str:
    """Pick the default SQLite file.

    A double-clicked macOS .app starts in "/" and cannot write there, and an
    installed .exe may sit in a read-only directory, so the packaged app keeps
    its database in the per-user application data folder instead of the
    working directory. Running from source keeps the simpler behaviour of a
    file next to the project.
    """
    if not getattr(sys, "frozen", False):
        return DATABASE_FILE_NAME

    folder = user_data_dir()
    folder.mkdir(parents=True, exist_ok=True)
    return str(folder / DATABASE_FILE_NAME)


def main() -> int:
    parser = argparse.ArgumentParser(description="Blood Connect -- blood donation app")
    parser.add_argument(
        "--database",
        default=default_database_path(),
        help=(
            "SQLite file used to store accounts, requests and notifications. "
            f"Defaults to {DATABASE_FILE_NAME} in the working directory, or to "
            "the per-user application data folder when running as a packaged app."
        ),
    )
    args = parser.parse_args()

    database = Database(args.database)
    try:
        app = BloodConnectApp(BloodConnectService(database))
    except tk.TclError:
        database.close()
        print(
            "Blood Connect needs a graphical display to open its window.\n"
            "Run it from a desktop session (on Windows, macOS or a Linux desktop)."
        )
        return 1

    try:
        app.mainloop()
    finally:
        database.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
