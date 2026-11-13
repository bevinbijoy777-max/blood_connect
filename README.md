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
Running it
Requires Python 3.10+ with Tkinter (included with the standard Windows and macOS installers; on Debian/Ubuntu install python3-tk).

python run.py
python run.py --database demo.db    # optional: use a different database file

run.py                  start the application
blood_connect/
  models.py             domain classes: Person, User, Donor, BloodRequest, Notification
  database.py           SQLite schema plus Person / Request / Notification repositories
  service.py            use cases: register, sign in, request, match, notify, respond
  gui.py                Tkinter views: login, seeker dashboard, donor dashboard
