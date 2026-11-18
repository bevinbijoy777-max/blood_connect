"""Use cases of the desktop app: register, sign in, request, match, respond.

Mirrors the web app's test-service.mjs checks against an in-memory SQLite
database, so both implementations are held to the same rules.

Run from the repository root:
    python -m unittest discover -s tests
"""

from __future__ import annotations

import unittest
from datetime import timedelta

from blood_connect.database import Database, RequestRepository
from blood_connect.models import (
    AuthenticationError,
    Donor,
    ValidationError,
    utc_today,
)
from blood_connect.service import BloodConnectService


def days_ago(days: int) -> str:
    """A date ``days`` before today, in the UTC days the rules use."""
    return (utc_today() - timedelta(days=days)).isoformat()


class ServiceTestCase(unittest.TestCase):
    def setUp(self):
        self.database = Database(":memory:")
        self.service = BloodConnectService(self.database)

    def tearDown(self):
        self.database.close()

    # -- helpers ---------------------------------------------------------
    def register_seeker(self, email="asha@example.com", name="Asha Rao"):
        return self.service.register_seeker(name, email, "9876543210", "Pune", "secret123")

    def register_donor(
        self,
        email="ravi@example.com",
        name="Ravi Kumar",
        city="Pune",
        group="O+",
        last_donation=None,
    ):
        return self.service.register_donor(name, email, "9812345678", city, group, last_donation, "secret123")

    def backdate_requests(self, days: int) -> None:
        """Pretend every stored request was created ``days`` ago."""
        self.database.connection.execute(
            "UPDATE requests SET created_at = ?", (days_ago(days),)
        )
        self.database.connection.commit()

    def submit(self, seeker, **overrides):
        values = dict(
            patient_name="Asha Rao",
            blood_group="O+",
            units=2,
            hospital="Ruby Hall",
            city="Pune",
            contact="9876543210",
            urgency="Urgent",
        )
        values.update(overrides)
        return self.service.submit_request(seeker, **values)


class RegistrationTests(ServiceTestCase):
    def test_register_and_sign_in(self):
        self.register_seeker()
        person = self.service.sign_in("ASHA@example.com", "secret123")
        self.assertEqual(person.email, "asha@example.com")
        self.assertEqual(person.role_label, "Blood seeker")

    def test_registered_donor_is_a_donor(self):
        donor = self.register_donor(last_donation=days_ago(120))
        self.assertIsInstance(donor, Donor)
        self.assertEqual(donor.blood_group, "O+")
        self.assertTrue(donor.is_eligible())

    def test_wrong_password_is_rejected(self):
        self.register_seeker()
        with self.assertRaises(AuthenticationError):
            self.service.sign_in("asha@example.com", "nope")

    def test_unknown_email_is_rejected(self):
        with self.assertRaises(AuthenticationError):
            self.service.sign_in("nobody@example.com", "secret123")

    def test_duplicate_email_is_rejected(self):
        self.register_seeker()
        with self.assertRaises(ValidationError):
            self.register_donor(email="ASHA@example.com")

    def test_short_password_is_rejected(self):
        with self.assertRaises(ValidationError):
            self.service.register_seeker("Asha", "asha@example.com", "9876543210", "Pune", "123")


class MatchingTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.seeker = self.register_seeker()

    def test_only_eligible_available_donors_are_notified(self):
        donor = self.register_donor()
        self.register_donor(email="meena@example.com", name="Meena Shah", last_donation=days_ago(10))
        paused = self.register_donor(email="sam@example.com", name="Sam Rao", city="Mumbai")
        self.service.set_availability(paused, False)
        self.register_donor(email="other@example.com", name="Other Group", group="A+")

        request, notified = self.submit(self.seeker)
        self.assertEqual(notified, 1, "only the eligible, available O+ donor")
        self.assertEqual(request.status_label, "Open")
        self.assertEqual(self.service.pending_notification_count(donor), 1)
        self.assertEqual(self.service.pending_notification_count(paused), 0)

    def test_request_details_reach_the_donor(self):
        donor = self.register_donor()
        self.submit(self.seeker, note="Platelets needed")
        notification, request = self.service.incoming_requests(donor)[0]
        self.assertEqual(request.hospital, "Ruby Hall")
        self.assertIn("Platelets needed", notification.message)

    def test_requester_is_not_notified_of_their_own_request(self):
        donor_seeker = self.register_donor()
        _request, notified = self.submit(donor_seeker, contact="9812345678")
        self.assertEqual(notified, 0)


class ResponseTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.seeker = self.register_seeker()
        self.donor = self.register_donor()

    def test_accepting_marks_the_request_and_shares_the_number(self):
        request, _ = self.submit(self.seeker)
        notification, _ = self.service.incoming_requests(self.donor)[0]
        message = self.service.respond_to_notification(self.donor, notification.id, True)

        self.assertIn("has been sent your contact number", message)
        self.assertEqual(self.service.my_requests(self.seeker)[0].status_label, "Donor found")

        responses = self.service.responses_for(self.seeker, request.id)
        self.assertEqual(len(responses), 1)
        stored_notification, responder = responses[0]
        self.assertEqual(responder.id, self.donor.id)
        self.assertIn("9812345678", stored_notification.message)

    def test_declining_leaves_the_request_open(self):
        request, _ = self.submit(self.seeker)
        notification, _ = self.service.incoming_requests(self.donor)[0]
        self.service.respond_to_notification(self.donor, notification.id, False)

        self.assertEqual(self.service.my_requests(self.seeker)[0].status_label, "Open")
        self.assertEqual(self.service.responses_for(self.seeker, request.id), [])

    def test_a_request_cannot_be_answered_twice(self):
        self.submit(self.seeker)
        notification, _ = self.service.incoming_requests(self.donor)[0]
        self.service.respond_to_notification(self.donor, notification.id, True)
        with self.assertRaises(ValidationError):
            self.service.respond_to_notification(self.donor, notification.id, True)

    def test_only_the_notified_donor_can_answer(self):
        self.submit(self.seeker)
        other = self.register_donor(email="meena@example.com", name="Meena Shah")
        notification, _ = self.service.incoming_requests(self.donor)[0]
        for outsider in (other, self.seeker):
            with self.subTest(who=outsider.role_label), self.assertRaises(ValidationError):
                self.service.respond_to_notification(outsider, notification.id, True)


class OwnershipTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.seeker = self.register_seeker()
        self.other = self.register_seeker(email="other@example.com", name="Other Person")
        self.request, _ = self.submit(self.seeker)

    def test_another_user_cannot_close_your_request(self):
        with self.assertRaises(ValidationError):
            self.service.update_request_status(self.other, self.request.id, "cancel")

    def test_seeker_can_fulfil_then_cannot_cancel(self):
        updated = self.service.update_request_status(self.seeker, self.request.id, "fulfil")
        self.assertEqual(updated.status_label, "Fulfilled")
        with self.assertRaises(ValidationError):
            self.service.update_request_status(self.seeker, self.request.id, "cancel")

    def test_unknown_action_is_rejected(self):
        with self.assertRaises(ValidationError):
            self.service.update_request_status(self.seeker, self.request.id, "explode")

    def test_another_user_cannot_read_responses(self):
        with self.assertRaises(ValidationError):
            self.service.responses_for(self.other, self.request.id)


class SearchTests(ServiceTestCase):
    def test_filters_by_group_and_city(self):
        self.register_donor()
        self.register_donor(email="sam@example.com", name="Sam Rao", city="Mumbai")
        self.register_donor(email="asha@example.com", name="Asha Kulkarni", group="A+")

        pune_o = self.service.search_donors(blood_group="O+", city="Pune")
        self.assertEqual([donor.full_name for donor in pune_o], ["Ravi Kumar"])

        all_o = self.service.search_donors(blood_group="O+")
        self.assertEqual(len(all_o), 2)

    def test_available_donors_sort_first(self):
        available = self.register_donor(name="Amit Available")
        resting = self.register_donor(
            email="meena@example.com", name="Meena Resting", last_donation=days_ago(5)
        )
        donors = self.service.search_donors(blood_group="O+")
        self.assertEqual(donors[0].id, available.id)
        self.assertEqual(donors[-1].id, resting.id)

    def test_seekers_are_not_in_donor_search(self):
        self.register_seeker()
        self.assertEqual(self.service.search_donors(), [])


class DonorProfileTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.donor = self.register_donor()

    def test_pausing_and_resuming_notifications(self):
        paused = self.service.set_availability(self.donor, False)
        self.assertFalse(paused.can_receive_requests)
        resumed = self.service.set_availability(self.donor, True)
        self.assertTrue(resumed.can_receive_requests)

    def test_logging_a_donation_makes_the_donor_ineligible(self):
        updated = self.service.set_last_donation(self.donor, utc_today().isoformat())
        self.assertFalse(updated.is_eligible())
        self.assertFalse(updated.can_receive_requests)
        self.assertIsNotNone(updated.next_eligible_date)

    def test_future_donation_date_is_rejected(self):
        with self.assertRaises(ValidationError):
            self.service.set_last_donation(self.donor, "2999-01-01")

    def test_a_donation_dated_tomorrow_in_utc_is_rejected(self):
        tomorrow = (utc_today() + timedelta(days=1)).isoformat()
        with self.assertRaises(ValidationError):
            self.service.set_last_donation(self.donor, tomorrow)

    def test_a_new_account_is_stored_on_the_utc_day(self):
        row = self.database.connection.execute(
            "SELECT created_at FROM people WHERE id = ?", (self.donor.id,)
        ).fetchone()
        self.assertEqual(row[0], utc_today().isoformat())

    def test_seeker_has_no_donor_profile(self):
        seeker = self.register_seeker()
        with self.assertRaises(ValidationError):
            self.service.donor_profile(seeker)


class ValidationTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.seeker = self.register_seeker()

    def test_a_rejected_request_is_not_saved_and_notifies_nobody(self):
        # Which values are rejected is covered by test_models; here the point is
        # that the service lets the error through and stores nothing.
        donor = self.register_donor()
        with self.assertRaises(ValidationError):
            self.submit(self.seeker, units=0, hospital="")
        self.assertEqual(self.service.my_requests(self.seeker), [])
        self.assertEqual(self.service.pending_notification_count(donor), 0)


class RequestHygieneTests(ServiceTestCase):
    """Three-day expiry and three requests a day, the same rules as the web app."""

    def setUp(self):
        super().setUp()
        self.seeker = self.register_seeker()
        self.donor = self.register_donor()

    # -- expiry ------------------------------------------------------------
    def test_a_two_day_old_request_is_still_open(self):
        self.submit(self.seeker)
        self.backdate_requests(2)
        stored = self.service.my_requests(self.seeker)[0]
        self.assertTrue(stored.is_active)
        self.assertEqual(stored.status_label, "Open")
        # Two days used, so it closes tomorrow (UTC, like the web app).
        self.assertEqual(stored.expires_on, utc_today() + timedelta(days=1))

    def test_a_three_day_old_request_has_expired(self):
        self.submit(self.seeker)
        self.backdate_requests(3)
        stored = self.service.my_requests(self.seeker)[0]
        self.assertFalse(stored.is_active)
        self.assertTrue(stored.is_expired())
        self.assertEqual(stored.status_label, "Expired")

    def test_donor_cannot_accept_an_expired_request(self):
        self.submit(self.seeker)
        self.backdate_requests(3)
        notification, request = self.service.incoming_requests(self.donor)[0]
        self.assertEqual(request.status_label, "Expired")
        with self.assertRaises(ValidationError) as error:
            self.service.respond_to_notification(self.donor, notification.id, True)
        self.assertIn("expired", str(error.exception))

    def test_expired_requests_are_not_counted_as_waiting(self):
        self.submit(self.seeker)
        self.assertEqual(self.service.pending_notification_count(self.donor), 1)
        self.backdate_requests(3)
        self.assertEqual(self.service.pending_notification_count(self.donor), 0)

    def test_seeker_cannot_close_an_expired_request(self):
        request, _notified = self.submit(self.seeker)
        self.backdate_requests(3)
        with self.assertRaises(ValidationError) as error:
            self.service.update_request_status(self.seeker, request.id, "cancel")
        self.assertIn("expired", str(error.exception))

    def test_open_requests_leave_out_expired_ones(self):
        self.submit(self.seeker)
        repository = RequestRepository(self.database)
        self.assertEqual(len(repository.list_open()), 1)
        self.backdate_requests(3)
        self.assertEqual(repository.list_open(), [])

    # -- daily cap ---------------------------------------------------------
    def test_three_requests_a_day_are_allowed(self):
        for _attempt in range(3):
            self.submit(self.seeker)
        self.assertEqual(len(self.service.my_requests(self.seeker)), 3)

    def test_the_fourth_request_in_a_day_is_refused(self):
        for _attempt in range(3):
            self.submit(self.seeker)
        with self.assertRaises(ValidationError) as error:
            self.submit(self.seeker)
        self.assertIn("3 requests a day", str(error.exception))
        self.assertEqual(len(self.service.my_requests(self.seeker)), 3)

    def test_the_cap_is_per_account(self):
        for _attempt in range(3):
            self.submit(self.seeker)
        other = self.register_seeker(email="other@example.com", name="Other Seeker")
        request, _notified = self.submit(other)
        self.assertIsNotNone(request.id)

    def test_a_new_day_brings_a_new_allowance(self):
        for _attempt in range(3):
            self.submit(self.seeker)
        self.backdate_requests(1)
        request, _notified = self.submit(self.seeker)
        self.assertIsNotNone(request.id)


if __name__ == "__main__":
    unittest.main()
