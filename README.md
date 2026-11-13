Blood Connect
A blood donation desktop application built with Python, Tkinter and SQLite. It connects people who need blood with registered donors of the same blood group.

Features
User registration – create a seeker account or register as a donor with blood group and last donation date.
Sign in – email and salted PBKDF2 password hashing; plain passwords are never stored.
Blood requests – submit a request with patient, blood group, units, hospital, city, contact and urgency.
Blood group matching – every matching, available and currently eligible donor receives an in-app notification.
Notifications and responses – donors accept or decline a request; accepting marks the request "Donor found" and sends the seeker the donor's contact number.
Donor search – seekers can filter registered donors by blood group and city. Numbers stay private until a donor accepts.
Donor profile – pause notifications, log a donation, and see the next eligible date (90 days after a donation).
The app only introduces people. Final donor eligibility and blood compatibility must always be confirmed by qualified medical staff.
Download and run (no Python needed)
Download BloodConnect.exe for Windows or BloodConnect.app for macOS, then open it.

Windows: double-click BloodConnect.exe. If SmartScreen shows a warning, click "More info" and then "Run anyway" — the app is unsigned.
macOS: drag BloodConnect.app into Applications. The first time, right-click the app and choose Open, then confirm.

The packaged app keeps everything in a single file called blood_connect.db in your per-user application data folder, so it works no matter where the app is launched from:

Windows: %APPDATA%\BloodConnect\blood_connect.db
macOS: ~/Library/Application Support/BloodConnect/blood_connect.db
Linux: ~/.local/share/BloodConnect/blood_connect.db

Keep that file to keep your accounts and requests, delete it to start over, and do not share it: it contains names, phone numbers and password hashes. Running from source still uses blood_connect.db in the current directory, and --database <path> overrides either default.

Running from source
Requires Python 3.10+ with Tkinter (included with the standard Windows and macOS installers; on Debian/Ubuntu install python3-tk). No third-party packages are needed.

python run.py
python run.py --database demo.db    # optional: use a different database file

Running from source writes blood_connect.db to the current directory; the packaged app described above writes to the per-user application data folder instead.

Building the standalone app
Build on the platform you want to ship for: a .exe must be built on Windows and a .app on macOS, because PyInstaller cannot cross-compile.

python -m pip install "pyinstaller>=6.0"
python build.py                     # writes dist/BloodConnect.exe, .app or plain binary
python build.py --run               # build, then launch the result

The build recipe is blood_connect.spec; the Python version floor and the PyInstaller extra are declared in pyproject.toml.

Every push to main also builds both bundles in GitHub Actions and uploads them as run artifacts, so a broken Windows or macOS build shows up before you release anything. Only a v* tag (or a manual run) publishes a GitHub release; re-running one for an existing tag replaces the attached files.

Landing page
The download page lives in site/ and is a plain Vite site. It reports Core Web Vitals with @vercel/speed-insights once deployed to Vercel.

cd site
npm install
npm run dev      # local preview on http://localhost:5173
npm run build    # static output in site/dist

Project layout
run.py                  start the application
build.py                build a standalone executable with PyInstaller
blood_connect.spec      PyInstaller recipe for the standalone app
pyproject.toml          Python 3.10+ floor, stdlib-only dependencies, build extra
site/                   download landing page (Vite + @vercel/speed-insights)
blood_connect/
  models.py             domain classes: Person, User, Donor, BloodRequest, Notification
  database.py           SQLite schema plus Person / Request / Notification repositories
  service.py            use cases: register, sign in, request, match, notify, respond
  gui.py                Tkinter views: login, seeker dashboard, donor dashboard
