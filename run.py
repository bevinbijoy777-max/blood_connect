"""Start the Blood Connect desktop application.

Usage:
    python run.py
    python run.py --database demo.db
"""

from __future__ import annotations

import argparse
import sys
import tkinter as tk

from blood_connect.database import Database
from blood_connect.gui import BloodConnectApp
from blood_connect.service import BloodConnectService


def main() -> int:
    parser = argparse.ArgumentParser(description="Blood Connect -- blood donation app")
    parser.add_argument(
        "--database",
        default="blood_connect.db",
        help="SQLite file used to store accounts, requests and notifications.",
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
