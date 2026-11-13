# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build recipe for Blood Connect.

Build with:
    python build.py
or directly:
    python -m PyInstaller --noconfirm --clean blood_connect.spec

Produces a single-file, windowed executable:
    Windows : dist/BloodConnect.exe
    macOS   : dist/BloodConnect.app
    Linux   : dist/BloodConnect
"""

import sys

a = Analysis(
    ["run.py"],
    pathex=["."],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "setuptools", "pip"],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="BloodConnect",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    # No console window: this is a GUI application.
    console=False,
    disable_windowed_traceback=False,
    # argv_emulation stays off: we parse no file-open events from Finder.
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# On macOS PyInstaller additionally wraps the executable in a double-clickable
# .app bundle. BUNDLE is only valid on Darwin, so keep it behind a guard.
if sys.platform == "darwin":
    app = BUNDLE(
        exe,
        name="BloodConnect.app",
        icon=None,
        bundle_identifier="com.bloodconnect.app",
        info_plist={
            "CFBundleName": "Blood Connect",
            "CFBundleDisplayName": "Blood Connect",
            "CFBundleShortVersionString": "1.0.0",
            "NSHighResolutionCapable": True,
        },
    )
