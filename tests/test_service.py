"""Use cases of the desktop app: register, sign in, request, match, respond.

Mirrors the web app's test-service.mjs checks against an in-memory SQLite
database, so both implementations are held to the same rules.

Run from the repository root:
    python -m unittest discover -s tests
"""

from __future__ import annotations

import unittest
from datetime import date, timedelta

from blood_connect.database import Database
from blood_connect.models import (
    AuthenticationError,
    Donor,
    ValidationError,
)
from blood_connect.service import BloodConnectService


def days_ago(days: int) -> str:
    return (date.today() - timedelta(days=days)).isoformat()


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

    def test_another_donor_cannot_answer_someone_elses_notification(self):
        self.submit(self.seeker)
        other = self.register_donor(email="meena@example.com", name="Meena Shah")
        notification, _ = self.service.incoming_requests(self.donor)[0]
        with self.assertRaises(ValidationError):
            self.service.respond_to_notification(other, notification.id, True)

    def test_seeker_cannot_answer_as_a_donor(self):
        self.submit(self.seeker)
        notification, _ = self.service.incoming_requests(self.donor)[0]
        with self.assertRaises(ValidationError):
            self.service.respond_to_notification(self.seeker, notification.id, True)


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
        updated = self.service.set_last_donation(self.donor, date.today().isoformat())
        self.assertFalse(updated.is_eligible())
        self.assertFalse(updated.can_receive_requests)
        self.assertIsNotNone(updated.next_eligible_date)

    def test_future_donation_date_is_rejected(self):
        with self.assertRaises(ValidationError):
            self.service.set_last_donation(self.donor, "2999-01-01")

    def test_seeker_has_no_donor_profile(self):
        seeker = self.register_seeker()
        with self.assertRaises(ValidationError):
            self.service.donor_profile(seeker)


class ValidationTests(ServiceTestCase):
    def setUp(self):
        super().setUp()
        self.seeker = self.register_seeker()

    def test_request_field_validation(self):
        cases = [
            ("units", 0),
            ("units", 11),
            ("blood_group", "X+"),
            ("contact", "123"),
            ("patient_name", "   "),
            ("urgency", "Whenever"),
            ("hospital", ""),
        ]
        for field, value in cases:
            with self.subTest(field=field, value=value), self.assertRaises(ValidationError):
                self.submit(self.seeker, **{field: value})


if __name__ == "__main__":
    unittest.main()
