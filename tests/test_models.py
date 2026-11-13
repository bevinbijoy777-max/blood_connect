"""Validation and domain rules for Blood Connect.

Mirrors the web app's validate.js checks: the same input must be accepted or
rejected by both implementations.

Run from the repository root:
    python -m unittest discover -s tests
"""

from __future__ import annotations

import unittest
from datetime import date, timedelta

from blood_connect.models import (
    BloodRequest,
    Donor,
    Notification,
    NotificationKind,
    ResponseStatus,
    ValidationError,
    hash_password,
    normalise_blood_group,
    normalise_email,
    normalise_phone,
    parse_date,
    parse_optional_date,
    validate_password,
)

TODAY = date.today()


def days_ago(days: int) -> str:
    return (TODAY - timedelta(days=days)).isoformat()


def make_donor(last_donation: str | None = None, available: bool = True) -> Donor:
    return Donor(
        full_name="Ravi Kumar",
        email="ravi@example.com",
        phone="9812345678",
        city="Pune",
        password_hash="unused",
        password_salt="unused",
        blood_group="O+",
        last_donation=last_donation,
        is_available=available,
    )


def make_request(**overrides) -> BloodRequest:
    values = dict(
        requester_id=1,
        patient_name="Asha Rao",
        blood_group="O+",
        units=2,
        hospital="Ruby Hall",
        city="Pune",
        contact="9876543210",
        urgency="Urgent",
    )
    values.update(overrides)
    return BloodRequest(**values)


class EmailTests(unittest.TestCase):
    def test_accepts_a_plain_address(self):
        self.assertEqual(normalise_email("  Asha@Example.COM "), "asha@example.com")

    def test_rejects_missing_at_or_domain(self):
        for value in ("asha", "asha@", "asha@example", "@example.com", ""):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                normalise_email(value)


class PhoneTests(unittest.TestCase):
    def test_accepts_seven_to_fifteen_digits(self):
        self.assertEqual(normalise_phone("9876543210"), "9876543210")
        self.assertEqual(normalise_phone("+91 98765 43210"), "+91 98765 43210")

    def test_rejects_too_short_or_too_long(self):
        for value in ("123456", "", "1234567890123456"):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                normalise_phone(value)


class BloodGroupTests(unittest.TestCase):
    def test_normalises_case_and_spaces(self):
        self.assertEqual(normalise_blood_group(" o+ "), "O+")
        self.assertEqual(normalise_blood_group("ab -"), "AB-")

    def test_rejects_unknown_group(self):
        for value in ("X+", "O", "", "C+"):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                normalise_blood_group(value)


class PasswordTests(unittest.TestCase):
    def test_rejects_short_password(self):
        with self.assertRaises(ValidationError):
            validate_password("12345")
        validate_password("123456")

    def test_same_password_gets_a_fresh_salt(self):
        salt_a, digest_a = hash_password("secret123")
        salt_b, digest_b = hash_password("secret123")
        self.assertNotEqual(salt_a, salt_b, "each password needs its own salt")
        self.assertNotEqual(digest_a, digest_b, "the same password must hash differently")

    def test_hash_can_be_verified_but_not_guessed(self):
        donor = Donor.with_password(
            "Ravi Kumar", "ravi@example.com", "9812345678", "Pune", "secret123", blood_group="O+"
        )
        self.assertTrue(donor.verify_password("secret123"))
        self.assertFalse(donor.verify_password("wrong"))
        self.assertFalse(donor.verify_password(""))


class DateTests(unittest.TestCase):
    def test_parses_iso_dates(self):
        self.assertEqual(parse_date("2024-05-01"), date(2024, 5, 1))

    def test_rejects_future_and_malformed_dates(self):
        for value in ("2999-01-01", "01-05-2024", "", "not-a-date"):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                parse_date(value)

    def test_optional_date_allows_blank(self):
        self.assertIsNone(parse_optional_date(None))
        self.assertIsNone(parse_optional_date(""))


class EligibilityTests(unittest.TestCase):
    def test_recent_donation_is_not_eligible(self):
        donor = make_donor(last_donation=days_ago(10))
        self.assertFalse(donor.is_eligible())
        self.assertFalse(donor.can_receive_requests)
        self.assertIn("Eligible again from", donor.availability_text())

    def test_donation_over_90_days_ago_is_eligible(self):
        donor = make_donor(last_donation=days_ago(120))
        self.assertTrue(donor.is_eligible())
        self.assertTrue(donor.can_receive_requests)

    def test_never_donated_is_eligible(self):
        donor = make_donor()
        self.assertTrue(donor.is_eligible())
        self.assertIsNone(donor.next_eligible_date)

    def test_next_eligible_date_is_90_days_after_donation(self):
        donor = make_donor(last_donation=days_ago(30))
        self.assertEqual(donor.next_eligible_date, date.fromisoformat(days_ago(30)) + timedelta(days=90))

    def test_paused_donor_cannot_receive_requests(self):
        donor = make_donor(available=False)
        self.assertFalse(donor.can_receive_requests)
        self.assertEqual(donor.availability_text(), "Not accepting requests")


class RequestTests(unittest.TestCase):
    def test_accepts_a_valid_request(self):
        request = make_request()
        self.assertEqual(request.status_label, "Open")
        self.assertTrue(request.is_active)

    def test_rejects_units_outside_one_to_ten(self):
        for units in (0, 11, -1):
            with self.subTest(units=units), self.assertRaises(ValidationError):
                make_request(units=units)

    def test_rejects_unknown_blood_group_or_urgency(self):
        with self.assertRaises(ValidationError):
            make_request(blood_group="X+")
        with self.assertRaises(ValidationError):
            make_request(urgency="Whenever")

    def test_rejects_blank_patient_name(self):
        with self.assertRaises(ValidationError):
            make_request(patient_name="   ")

    def test_fulfilled_request_cannot_be_cancelled(self):
        request = make_request()
        request.mark_fulfilled()
        with self.assertRaises(ValidationError):
            request.cancel()

    def test_mark_matched_only_applies_to_open_requests(self):
        request = make_request()
        request.mark_matched()
        self.assertEqual(request.status_label, "Donor found")

        cancelled = make_request()
        cancelled.cancel()
        cancelled.mark_matched()
        self.assertEqual(cancelled.status_label, "Cancelled")


class NotificationTests(unittest.TestCase):
    def make(self, kind=NotificationKind.REQUEST):
        return Notification(recipient_id=1, request_id=1, message="O+ needed", kind=kind)

    def test_respond_once(self):
        notification = self.make()
        self.assertTrue(notification.is_pending)
        notification.respond(True)
        self.assertIs(notification.response, ResponseStatus.ACCEPTED)
        with self.assertRaises(ValidationError):
            notification.respond(False)

    def test_response_notifications_cannot_be_answered(self):
        with self.assertRaises(ValidationError):
            self.make(NotificationKind.RESPONSE).respond(True)


if __name__ == "__main__":
    unittest.main()
