"""Domain model for Blood Connect.

Object oriented ideas used in this module
-----------------------------------------
* Abstraction   -- ``Person`` is an abstract base class that only defines the
                   contract every person in the system has to fulfil.
* Inheritance   -- ``Donor`` extends ``User`` which extends ``Person``.
* Polymorphism  -- ``role_label()`` and ``describe()`` behave differently for a
                   seeker and a donor, and the row factory in ``database.py``
                   builds the right subclass from a single ``people`` table.
* Encapsulation -- all state is private and reached through validated,
                   read-only properties, so an object can never hold invalid
                   data (an unknown blood group, a blank name, a future
                   donation date, ...).
"""

from __future__ import annotations

import hashlib
import re
import secrets
from abc import ABC, abstractmethod
from datetime import date, datetime, timedelta
from enum import Enum

BLOOD_GROUPS = ("A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-")
URGENCY_LEVELS = ("Normal", "Urgent", "Critical")
DONATION_INTERVAL_DAYS = 90
MIN_PASSWORD_LENGTH = 6
MAX_UNITS_PER_REQUEST = 10

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")
_PASSWORD_ITERATIONS = 120_000


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #
class BloodConnectError(Exception):
    """Base class for every error raised by the domain layer."""


class ValidationError(BloodConnectError):
    """Raised when data supplied by the user is not acceptable."""


class AuthenticationError(BloodConnectError):
    """Raised when a sign in attempt fails."""


# --------------------------------------------------------------------------- #
# Validation helpers
# --------------------------------------------------------------------------- #
def _clean_text(value: str, label: str, max_length: int = 120) -> str:
    text = " ".join((value or "").split())
    if not text:
        raise ValidationError(f"{label} is required.")
    if len(text) > max_length:
        raise ValidationError(f"{label} must be at most {max_length} characters.")
    return text


def normalise_email(value: str) -> str:
    text = (value or "").strip().lower()
    if not _EMAIL_PATTERN.match(text):
        raise ValidationError("Enter a valid email address, for example name@example.com.")
    return text


def normalise_phone(value: str) -> str:
    text = (value or "").strip()
    if not text:
        raise ValidationError("Phone number is required.")
    digits = re.sub(r"\D", "", text)
    if not 7 <= len(digits) <= 15:
        raise ValidationError("Enter a valid phone number with 7 to 15 digits.")
    return text


def normalise_blood_group(value: str) -> str:
    group = (value or "").strip().upper().replace(" ", "")
    if group not in BLOOD_GROUPS:
        raise ValidationError("Choose a valid blood group.")
    return group


def validate_password(value: str) -> None:
    if not value or len(value) < MIN_PASSWORD_LENGTH:
        raise ValidationError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters long."
        )


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    """Return ``(salt, digest)`` for ``password``. Plain passwords are never stored."""
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), _PASSWORD_ITERATIONS
    ).hex()
    return salt, digest


def parse_date(value: str | date | datetime, label: str = "Date") -> date:
    if isinstance(value, datetime):
        parsed = value.date()
    elif isinstance(value, date):
        parsed = value
    else:
        text = (value or "").strip()
        if not text:
            raise ValidationError(f"{label} is required. Use the format YYYY-MM-DD.")
        try:
            parsed = date.fromisoformat(text)
        except ValueError:
            raise ValidationError(f"{label} must look like YYYY-MM-DD.") from None
    if parsed > date.today():
        raise ValidationError(f"{label} cannot be in the future.")
    return parsed


def parse_optional_date(value: str | date | datetime | None, label: str = "Date") -> date | None:
    if value in (None, ""):
        return None
    return parse_date(value, label)


# --------------------------------------------------------------------------- #
# People
# --------------------------------------------------------------------------- #
class Person(ABC):
    """Abstract base class for anybody stored in Blood Connect."""

    ROLE_CODE = "person"

    def __init__(
        self,
        full_name: str,
        email: str,
        phone: str,
        city: str,
        password_hash: str,
        password_salt: str,
        person_id: int | None = None,
    ) -> None:
        self._id = person_id
        self._full_name = _clean_text(full_name, "Full name", 80)
        self._email = normalise_email(email)
        self._phone = normalise_phone(phone)
        self._city = _clean_text(city, "City", 60)
        self._password_hash = password_hash
        self._password_salt = password_salt

    # -- construction helper -------------------------------------------------
    @classmethod
    def with_password(cls, full_name, email, phone, city, password, **extra):
        """Build a person, hashing ``password`` with a fresh random salt."""
        validate_password(password)
        salt, digest = hash_password(password)
        return cls(
            full_name=full_name,
            email=email,
            phone=phone,
            city=city,
            password_hash=digest,
            password_salt=salt,
            **extra,
        )

    # -- read-only state -----------------------------------------------------
    @property
    def id(self) -> int | None:
        return self._id

    @property
    def full_name(self) -> str:
        return self._full_name

    @property
    def email(self) -> str:
        return self._email

    @property
    def phone(self) -> str:
        return self._phone

    @property
    def city(self) -> str:
        return self._city

    @property
    def password_hash(self) -> str:
        return self._password_hash

    @property
    def password_salt(self) -> str:
        return self._password_salt

    # -- behaviour -----------------------------------------------------------
    @property
    @abstractmethod
    def role_label(self) -> str:
        """Human readable role, provided by each concrete subclass."""

    def verify_password(self, password: str) -> bool:
        if not password:
            return False
        _, digest = hash_password(password, self._password_salt)
        return secrets.compare_digest(digest, self._password_hash)

    def set_password(self, password: str) -> None:
        validate_password(password)
        self._password_salt, self._password_hash = hash_password(password)

    def update_contact(self, phone: str, city: str) -> None:
        self._phone = normalise_phone(phone)
        self._city = _clean_text(city, "City", 60)

    def describe(self) -> str:
        return f"{self._full_name} ({self.role_label}, {self._city})"

    def __str__(self) -> str:
        return self.describe()


class User(Person):
    """A registered person who looks for blood."""

    ROLE_CODE = "user"

    @property
    def role_label(self) -> str:
        return "Blood seeker"


class Donor(User):
    """A registered person who is willing to donate blood.

    A donor is a user, so it inherits every behaviour of ``User`` and adds the
    donation specific information on top of it.
    """

    ROLE_CODE = "donor"

    def __init__(
        self,
        full_name,
        email,
        phone,
        city,
        password_hash,
        password_salt,
        blood_group,
        last_donation=None,
        is_available: bool = True,
        person_id: int | None = None,
    ) -> None:
        super().__init__(
            full_name=full_name,
            email=email,
            phone=phone,
            city=city,
            password_hash=password_hash,
            password_salt=password_salt,
            person_id=person_id,
        )
        self._blood_group = normalise_blood_group(blood_group)
        self._last_donation = parse_optional_date(last_donation, "Last donation date")
        self._is_available = bool(is_available)

    @property
    def role_label(self) -> str:
        return "Donor"

    @property
    def blood_group(self) -> str:
        return self._blood_group

    @property
    def last_donation(self) -> date | None:
        return self._last_donation

    @property
    def is_available(self) -> bool:
        """Whether the donor currently accepts blood request notifications."""
        return self._is_available

    @property
    def next_eligible_date(self) -> date | None:
        if self._last_donation is None:
            return None
        return self._last_donation + timedelta(days=DONATION_INTERVAL_DAYS)

    def is_eligible(self, on: date | None = None) -> bool:
        next_date = self.next_eligible_date
        return next_date is None or (on or date.today()) >= next_date

    @property
    def can_receive_requests(self) -> bool:
        return self._is_available and self.is_eligible()

    def availability_text(self, on: date | None = None) -> str:
        if not self._is_available:
            return "Not accepting requests"
        next_date = self.next_eligible_date
        if not self.is_eligible(on):
            return f"Eligible again from {next_date.isoformat()}"
        return "Available to donate"

    def set_availability(self, available: bool) -> None:
        self._is_available = bool(available)

    def record_donation(self, on: date | None = None) -> None:
        self._last_donation = parse_date(on or date.today(), "Donation date")

    def describe(self) -> str:
        return f"{self._full_name} ({self._blood_group} donor, {self._city})"


# --------------------------------------------------------------------------- #
# Blood requests
# --------------------------------------------------------------------------- #
class RequestStatus(Enum):
    OPEN = "Open"
    MATCHED = "Donor found"
    FULFILLED = "Fulfilled"
    CANCELLED = "Cancelled"


class BloodRequest:
    """A request for a number of blood units of one group at one hospital."""

    def __init__(
        self,
        requester_id: int,
        patient_name: str,
        blood_group: str,
        units: int,
        hospital: str,
        city: str,
        contact: str,
        urgency: str = "Normal",
        note: str = "",
        request_id: int | None = None,
        status: RequestStatus | str = RequestStatus.OPEN,
        created_at: date | datetime | str | None = None,
    ) -> None:
        self._id = request_id
        self._requester_id = int(requester_id)
        self._patient_name = _clean_text(patient_name, "Patient name", 80)
        self._blood_group = normalise_blood_group(blood_group)
        try:
            numeric_units = int(units)
        except (TypeError, ValueError):
            raise ValidationError("Units must be a whole number.") from None
        if not 1 <= numeric_units <= MAX_UNITS_PER_REQUEST:
            raise ValidationError(
                f"A request can ask for 1 to {MAX_UNITS_PER_REQUEST} units."
            )
        self._units = numeric_units
        self._hospital = _clean_text(hospital, "Hospital", 100)
        self._city = _clean_text(city, "City", 60)
        self._contact = normalise_phone(contact)
        if urgency not in URGENCY_LEVELS:
            raise ValidationError("Choose an urgency level.")
        self._urgency = urgency
        self._note = " ".join((note or "").split())[:300]
        self._status = status if isinstance(status, RequestStatus) else RequestStatus(status)
        if created_at is None:
            self._created_at = date.today()
        elif isinstance(created_at, (date, datetime)):
            self._created_at = created_at.date() if isinstance(created_at, datetime) else created_at
        else:
            self._created_at = date.fromisoformat(created_at)

    # -- read-only state -----------------------------------------------------
    @property
    def id(self) -> int | None:
        return self._id

    @property
    def requester_id(self) -> int:
        return self._requester_id

    @property
    def patient_name(self) -> str:
        return self._patient_name

    @property
    def blood_group(self) -> str:
        return self._blood_group

    @property
    def units(self) -> int:
        return self._units

    @property
    def hospital(self) -> str:
        return self._hospital

    @property
    def city(self) -> str:
        return self._city

    @property
    def contact(self) -> str:
        return self._contact

    @property
    def urgency(self) -> str:
        return self._urgency

    @property
    def note(self) -> str:
        return self._note

    @property
    def status(self) -> RequestStatus:
        return self._status

    @property
    def status_label(self) -> str:
        return self._status.value

    @property
    def created_at(self) -> date:
        return self._created_at

    @property
    def is_active(self) -> bool:
        return self._status in (RequestStatus.OPEN, RequestStatus.MATCHED)

    def mark_matched(self) -> None:
        if self._status is RequestStatus.OPEN:
            self._status = RequestStatus.MATCHED

    def mark_fulfilled(self) -> None:
        if not self.is_active:
            raise ValidationError("This request is already closed.")
        self._status = RequestStatus.FULFILLED

    def cancel(self) -> None:
        if not self.is_active:
            raise ValidationError("This request is already closed.")
        self._status = RequestStatus.CANCELLED

    def summary(self) -> str:
        return (
            f"Request #{self._id}: {self._units} unit(s) of {self._blood_group} "
            f"for {self._patient_name} at {self._hospital}, {self._city}"
        )

    def __str__(self) -> str:
        return self.summary()


# --------------------------------------------------------------------------- #
# Notifications and responses
# --------------------------------------------------------------------------- #
class NotificationKind(Enum):
    REQUEST = "request"   # sent to a matching donor
    RESPONSE = "response"  # sent to the seeker when a donor answers


class ResponseStatus(Enum):
    PENDING = "Pending"
    ACCEPTED = "Accepted"
    DECLINED = "Declined"


class Notification:
    """A message about a blood request, plus the answer given to it."""

    def __init__(
        self,
        recipient_id: int,
        request_id: int,
        message: str,
        kind: NotificationKind | str = NotificationKind.REQUEST,
        response: ResponseStatus | str = ResponseStatus.PENDING,
        actor_id: int | None = None,
        notification_id: int | None = None,
        created_at: date | datetime | str | None = None,
    ) -> None:
        self._id = notification_id
        self._recipient_id = int(recipient_id)
        self._request_id = int(request_id)
        self._message = _clean_text(message, "Message", 400)
        self._kind = kind if isinstance(kind, NotificationKind) else NotificationKind(kind)
        self._response = (
            response if isinstance(response, ResponseStatus) else ResponseStatus(response)
        )
        self._actor_id = actor_id
        if created_at is None:
            self._created_at = date.today()
        elif isinstance(created_at, (date, datetime)):
            self._created_at = created_at.date() if isinstance(created_at, datetime) else created_at
        else:
            self._created_at = date.fromisoformat(created_at)

    @property
    def id(self) -> int | None:
        return self._id

    @property
    def recipient_id(self) -> int:
        return self._recipient_id

    @property
    def request_id(self) -> int:
        return self._request_id

    @property
    def message(self) -> str:
        return self._message

    @property
    def kind(self) -> NotificationKind:
        return self._kind

    @property
    def response(self) -> ResponseStatus:
        return self._response

    @property
    def response_label(self) -> str:
        return self._response.value

    @property
    def actor_id(self) -> int | None:
        return self._actor_id

    @property
    def created_at(self) -> date:
        return self._created_at

    @property
    def is_pending(self) -> bool:
        return self._response is ResponseStatus.PENDING

    @property
    def is_accepted(self) -> bool:
        return self._response is ResponseStatus.ACCEPTED

    def respond(self, accepted: bool) -> None:
        """Answer a blood request notification exactly once."""
        if self._kind is not NotificationKind.REQUEST:
            raise ValidationError("Only blood request notifications can be answered.")
        if not self.is_pending:
            raise ValidationError("You have already responded to this request.")
        self._response = ResponseStatus.ACCEPTED if accepted else ResponseStatus.DECLINED

    def __str__(self) -> str:
        return f"{self._message} [{self._response.value}]"
