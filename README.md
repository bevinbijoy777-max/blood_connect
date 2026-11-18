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

Mobile web app
app/ is the same app built for phones and browsers. It keeps the desktop rules: only available and eligible donors are notified, and contact numbers stay hidden until a donor accepts. Data lives in a D1 database and sign-in is handled by Freebuff, so no password is stored.

Live app: https://site-69e3da5752364c3d893d669df627c833.freebuff.page

cd app
npm install
npm run build
npm run dev                     # local Worker + local database on http://localhost:8787

Publishing the web app to Freebuff Sites starts from the repository root: package.json builds app/ and deploy.json points at its output. Keeping those at the root is what lets the Publish button find the app; the desktop files are not part of that build.

Add it to a phone's home screen with "Add to Home Screen" for a full-screen app, or install the Android app described below.

Notifications (Web Push)
A donor gets a real notification when a matching request arrives, even with the app closed. The browser subscribes through its own push service, the Worker stores each device in D1 (push_subscriptions) and signs the message with VAPID; the encryption lives in app/src/push.js, so there is no web-push dependency. Turn it on per device from Profile -> Notifications.

It needs three settings on the deployed Worker. Generate a pair once:

npx web-push generate-vapid-keys --json

then add these in Sites -> Secrets (or the equivalent variables for another host):

VAPID_PUBLIC_KEY    the "publicKey" it prints (87 characters, a P-256 point)
VAPID_PRIVATE_KEY   the "privateKey" it prints (43 characters)
VAPID_SUBJECT       a contact for push services, e.g. mailto:you@example.com

Deploy again after setting them; secrets are bound at deployment. Without these three the app still works and falls back to the inbox refresh while it is open, and the notification switch stays hidden. Keep the keys: a subscription is tied to the public key, so replacing it means each device has to turn notifications on again from Profile.

Android app (.apk)
android/ wraps the live web app in a single-screen WebView, so Android users install one file instead of finding "Add to Home Screen" in their browser. The built APK is served at /BloodConnect.apk from the web app, and the landing page downloads it from there. It needs Android 7 (API 24) or newer and an internet connection; sign-in is the same Freebuff account as the web app.

cd android
./build.sh          # writes app/public/BloodConnect.apk

The script drives the SDK directly (aapt2, javac, d8, zipalign, apksigner), so no Gradle download is involved. It needs a JDK 17+ and an Android SDK with build-tools;34.0.0 and platforms;android-34; set JAVA_HOME and ANDROID_SDK_ROOT if they are not found. MainActivity.java is the whole app: it loads the production URL, keeps other sites in the browser, and shows an offline message instead of a blank screen.

The first build creates the signing key at android/keystore.jks. It is gitignored and is not in the repository: keep it somewhere safe, because Android only installs an update over an existing app when it is signed with the same key. Without it you must uninstall the app before installing a new build. The store and key passwords are the ones in build.sh (bloodconnect) — fine for a self-signed sideload build, and the reason this APK is not on Google Play. Delete both keystore and app to start over with a new identity.

Landing page
The download page lives in site/ and is a plain Vite site. It reports Core Web Vitals with @vercel/speed-insights once deployed to Vercel.

cd site
npm install
npm run dev      # local preview on http://localhost:5173
npm run build    # static output in site/dist

Tests
Both sides have a suite for the rules that matter most — who is notified, who may answer, who may close a request — and neither needs a dependency installed or a display.

python -m unittest discover -s tests -v   # desktop: validation, matching, responses, ownership
cd app && npm test                        # web: service rules, then the HTTP routes

GitHub Actions runs both suites on every push and pull request, so a broken rule shows up before anything is released.

Project layout
run.py                  start the application
build.py                build a standalone executable with PyInstaller
blood_connect.spec      PyInstaller recipe for the standalone app
pyproject.toml          Python 3.10+ floor, stdlib-only dependencies, build extra
site/                   download landing page (Vite + @vercel/speed-insights)
app/                    mobile web app (Worker + D1 + Sign in with Freebuff)
android/                Android WebView app and the APK build script
deploy.json             Sites deploy manifest for app/ (used by Publish)
package.json            root build script that builds app/
blood_connect/
  models.py             domain classes: Person, User, Donor, BloodRequest, Notification
  database.py           SQLite schema plus Person / Request / Notification repositories
  service.py            use cases: register, sign in, request, match, notify, respond
  gui.py                Tkinter views: login, seeker dashboard, donor dashboard
