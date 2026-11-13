"""SQLite persistence for Blood Connect.

The ``Database`` owns the connection and the schema; the small repository
classes translate rows into model objects and back. Keeping SQL out of the
model classes means the business objects stay plain Python.
"""

from __future__ import annotations

import sqlite3
from datetime import date
from pathlib import Path

from .models import (
    BloodRequest,
    Donor,
    Notification,
    NotificationKind,
    Person,
    ResponseStatus,
    User,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name          TEXT NOT NULL,
    email              TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone              TEXT NOT NULL,
    city               TEXT NOT NULL,
    password_hash      TEXT NOT NULL,
    password_salt      TEXT NOT NULL,
    role               TEXT NOT NULL CHECK (role IN ('user', 'donor')),
    blood_group        TEXT,
    last_donation      TEXT,
    accepting_requests INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    patient_name TEXT NOT NULL,
    blood_group  TEXT NOT NULL,
    units        INTEGER NOT NULL,
    hospital     TEXT NOT NULL,
    city         TEXT NOT NULL,
    contact      TEXT NOT NULL,
    urgency      TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    actor_id     INTEGER REFERENCES people(id) ON DELETE SET NULL,
    request_id   INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    message      TEXT NOT NULL,
    response     TEXT NOT NULL DEFAULT 'Pending',
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id);
CREATE INDEX IF NOT EXISTS idx_people_role ON people(role);
"""


class Database:
    """Thin owner of the SQLite connection used by every repository."""

    def __init__(self, path: str | Path = "blood_connect.db") -> None:
        self._path = str(path)
        self._connection = sqlite3.connect(self._path)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.executescript(SCHEMA)
        self._connection.commit()

    @property
    def connection(self) -> sqlite3.Connection:
        return self._connection

    @property
    def path(self) -> str:
        return self._path

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()


def _person_from_row(row: sqlite3.Row) -> Person:
    """Factory that returns the subclass matching the stored role."""
    common = dict(
        full_name=row["full_name"],
        email=row["email"],
        phone=row["phone"],
        city=row["city"],
        password_hash=row["password_hash"],
        password_salt=row["password_salt"],
        person_id=row["id"],
    )
    if row["role"] == Donor.ROLE_CODE:
        return Donor(
            blood_group=row["blood_group"],
            last_donation=row["last_donation"],
            is_available=bool(row["accepting_requests"]),
            **common,
        )
    return User(**common)


class PersonRepository:
    """Stores seekers and donors in one table."""

    def __init__(self, database: Database) -> None:
        self._db = database

    def save(self, person: Person) -> Person:
        connection = self._db.connection
        values = (
            person.full_name,
            person.email,
            person.phone,
            person.city,
            person.password_hash,
            person.password_salt,
            person.ROLE_CODE,
            getattr(person, "blood_group", None),
            person.last_donation.isoformat() if getattr(person, "last_donation", None) else None,
            int(getattr(person, "is_available", True)),
            date.today().isoformat(),
        )
        if person.id is None:
            cursor = connection.execute(
                """
                INSERT INTO people (full_name, email, phone, city, password_hash,
                                    password_salt, role, blood_group, last_donation,
                                    accepting_requests, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                values,
            )
            connection.commit()
            new_id = cursor.lastrowid
        else:
            connection.execute(
                """
                UPDATE people
                   SET full_name = ?, email = ?, phone = ?, city = ?,
                       password_hash = ?, password_salt = ?, role = ?,
                       blood_group = ?, last_donation = ?, accepting_requests = ?
                 WHERE id = ?
                """,
                values[:-1] + (person.id,),
            )
            connection.commit()
            new_id = person.id
        stored = self.find_by_id(new_id)
        assert stored is not None
        return stored

    def find_by_id(self, person_id: int) -> Person | None:
        row = self._db.connection.execute(
            "SELECT * FROM people WHERE id = ?", (person_id,)
        ).fetchone()
        return _person_from_row(row) if row else None

    def find_by_email(self, email: str) -> Person | None:
        row = self._db.connection.execute(
            "SELECT * FROM people WHERE email = ?", ((email or "").strip().lower(),)
        ).fetchone()
        return _person_from_row(row) if row else None

    def list_donors(self, blood_group: str | None = None, city: str | None = None) -> list[Donor]:
        query = "SELECT * FROM people WHERE role = 'donor'"
        params: list[str] = []
        if blood_group:
            query += " AND blood_group = ?"
            params.append(blood_group)
        if city:
            query += " AND city LIKE ?"
            params.append(f"%{city.strip()}%")
        query += " ORDER BY full_name COLLATE NOCASE"
        rows = self._db.connection.execute(query, params).fetchall()
        return [_person_from_row(row) for row in rows]

    def count(self) -> int:
        row = self._db.connection.execute("SELECT COUNT(*) AS total FROM people").fetchone()
        return int(row["total"])


class RequestRepository:
    def __init__(self, database: Database) -> None:
        self._db = database

    def save(self, request: BloodRequest) -> BloodRequest:
        connection = self._db.connection
        if request.id is None:
            cursor = connection.execute(
                """
                INSERT INTO requests (requester_id, patient_name, blood_group, units,
                                      hospital, city, contact, urgency, note, status,
                                      created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request.requester_id,
                    request.patient_name,
                    request.blood_group,
                    request.units,
                    request.hospital,
                    request.city,
                    request.contact,
                    request.urgency,
                    request.note,
                    request.status.value,
                    request.created_at.isoformat(),
                ),
            )
            connection.commit()
            new_id = cursor.lastrowid
        else:
            connection.execute(
                """
                UPDATE requests
                   SET patient_name = ?, blood_group = ?, units = ?, hospital = ?,
                       city = ?, contact = ?, urgency = ?, note = ?, status = ?
                 WHERE id = ?
                """,
                (
                    request.patient_name,
                    request.blood_group,
                    request.units,
                    request.hospital,
                    request.city,
                    request.contact,
                    request.urgency,
                    request.note,
                    request.status.value,
                    request.id,
                ),
            )
            connection.commit()
            new_id = request.id
        stored = self.find_by_id(new_id)
        assert stored is not None
        return stored

    def _row_to_request(self, row: sqlite3.Row) -> BloodRequest:
        return BloodRequest(
            requester_id=row["requester_id"],
            patient_name=row["patient_name"],
            blood_group=row["blood_group"],
            units=row["units"],
            hospital=row["hospital"],
            city=row["city"],
            contact=row["contact"],
            urgency=row["urgency"],
            note=row["note"],
            request_id=row["id"],
            status=row["status"],
            created_at=row["created_at"],
        )

    def find_by_id(self, request_id: int) -> BloodRequest | None:
        row = self._db.connection.execute(
            "SELECT * FROM requests WHERE id = ?", (request_id,)
        ).fetchone()
        return self._row_to_request(row) if row else None

    def list_for_requester(self, requester_id: int) -> list[BloodRequest]:
        rows = self._db.connection.execute(
            "SELECT * FROM requests WHERE requester_id = ? ORDER BY id DESC",
            (requester_id,),
        ).fetchall()
        return [self._row_to_request(row) for row in rows]

    def list_open(self, blood_group: str | None = None) -> list[BloodRequest]:
        query = "SELECT * FROM requests WHERE status IN ('Open', 'Donor found')"
        params: list[str] = []
        if blood_group:
            query += " AND blood_group = ?"
            params.append(blood_group)
        query += " ORDER BY id DESC"
        rows = self._db.connection.execute(query, params).fetchall()
        return [self._row_to_request(row) for row in rows]


class NotificationRepository:
    def __init__(self, database: Database) -> None:
        self._db = database

    def _row_to_notification(self, row: sqlite3.Row) -> Notification:
        return Notification(
            recipient_id=row["recipient_id"],
            request_id=row["request_id"],
            message=row["message"],
            kind=row["kind"],
            response=row["response"],
            actor_id=row["actor_id"],
            notification_id=row["id"],
            created_at=row["created_at"],
        )

    def save(self, notification: Notification) -> Notification:
        connection = self._db.connection
        if notification.id is None:
            cursor = connection.execute(
                """
                INSERT INTO notifications (recipient_id, actor_id, request_id, kind,
                                           message, response, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    notification.recipient_id,
                    notification.actor_id,
                    notification.request_id,
                    notification.kind.value,
                    notification.message,
                    notification.response.value,
                    notification.created_at.isoformat(),
                ),
            )
            connection.commit()
            new_id = cursor.lastrowid
        else:
            connection.execute(
                "UPDATE notifications SET response = ? WHERE id = ?",
                (notification.response.value, notification.id),
            )
            connection.commit()
            new_id = notification.id
        row = connection.execute(
            "SELECT * FROM notifications WHERE id = ?", (new_id,)
        ).fetchone()
        return self._row_to_notification(row)

    def find_by_id(self, notification_id: int) -> Notification | None:
        row = self._db.connection.execute(
            "SELECT * FROM notifications WHERE id = ?", (notification_id,)
        ).fetchone()
        return self._row_to_notification(row) if row else None

    def list_for_recipient(
        self, recipient_id: int, kind: NotificationKind | None = None
    ) -> list[Notification]:
        query = "SELECT * FROM notifications WHERE recipient_id = ?"
        params: list[object] = [recipient_id]
        if kind is not None:
            query += " AND kind = ?"
            params.append(kind.value)
        query += " ORDER BY id DESC"
        rows = self._db.connection.execute(query, params).fetchall()
        return [self._row_to_notification(row) for row in rows]

    def list_for_request(
        self, request_id: int, kind: NotificationKind | None = None
    ) -> list[Notification]:
        query = "SELECT * FROM notifications WHERE request_id = ?"
        params: list[object] = [request_id]
        if kind is not None:
            query += " AND kind = ?"
            params.append(kind.value)
        query += " ORDER BY id DESC"
        rows = self._db.connection.execute(query, params).fetchall()
        return [self._row_to_notification(row) for row in rows]

    def count_pending(self, recipient_id: int) -> int:
        row = self._db.connection.execute(
            """
            SELECT COUNT(*) AS total FROM notifications
             WHERE recipient_id = ? AND kind = 'request' AND response = 'Pending'
            """,
            (recipient_id,),
        ).fetchone()
        return int(row["total"])
