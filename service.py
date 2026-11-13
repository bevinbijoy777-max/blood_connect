"""Application service for Blood Connect.

This layer holds the rules of the application (who gets notified, when a
request becomes "donor found", what a seeker is allowed to see) and keeps the
Tkinter interface free of SQL and business logic.
"""

from __future__ import annotations

from .database import (
    Database,
    NotificationRepository,
    PersonRepository,
    RequestRepository,
)
from .models import (
    BloodRequest,
    Donor,
    Notification,
    NotificationKind,
    Person,
    ResponseStatus,
    User,
    ValidationError,
    AuthenticationError,
)


class BloodConnectService:
    """The use cases of Blood Connect: register, request, match, respond."""

    def __init__(self, database: Database) -> None:
        self._db = database
        self._people = PersonRepository(database)
        self._requests = RequestRepository(database)
        self._notifications = NotificationRepository(database)

    # ------------------------------------------------------------------ #
    # Registration and sign in
    # ------------------------------------------------------------------ #
    def register_seeker(self, full_name, email, phone, city, password) -> User:
        self._ensure_email_is_free(email)
        seeker = User.with_password(
            full_name=full_name, email=email, phone=phone, city=city, password=password
        )
        return self._people.save(seeker)

    def register_donor(
        self, full_name, email, phone, city, blood_group, last_donation, password
    ) -> Donor:
        self._ensure_email_is_free(email)
        donor = Donor.with_password(
            full_name=full_name,
            email=email,
            phone=phone,
            city=city,
            blood_group=blood_group,
            last_donation=last_donation,
            password=password,
        )
        return self._people.save(donor)

    def _ensure_email_is_free(self, email: str) -> None:
        if self._people.find_by_email(email):
            raise ValidationError("An account with this email address already exists.")

    def sign_in(self, email: str, password: str) -> Person:
        person = self._people.find_by_email(email)
        if person is None or not person.verify_password(password):
            raise AuthenticationError("Email or password is incorrect.")
        return person

    # ------------------------------------------------------------------ #
    # Blood requests and donor matching
    # ------------------------------------------------------------------ #
    def submit_request(
        self,
        seeker: Person,
        patient_name,
        blood_group,
        units,
        hospital,
        city,
        contact,
        urgency="Normal",
        note="",
    ) -> tuple[BloodRequest, int]:
        request = BloodRequest(
            requester_id=seeker.id,
            patient_name=patient_name,
            blood_group=blood_group,
            units=units,
            hospital=hospital,
            city=city,
            contact=contact,
            urgency=urgency,
            note=note,
        )
        request = self._requests.save(request)
        notified = self._notify_matching_donors(request, seeker.id)
        return request, notified

    def _notify_matching_donors(self, request: BloodRequest, requester_id: int) -> int:
        message = (
            f"{request.urgency} request: {request.units} unit(s) of "
            f"{request.blood_group} needed for {request.patient_name} at "
            f"{request.hospital}, {request.city}."
        )
        if request.note:
            message = f"{message} Note: {request.note}"
        notified = 0
        for donor in self._people.list_donors(blood_group=request.blood_group):
            if donor.id == requester_id or not donor.can_receive_requests:
                continue
            self._notifications.save(
                Notification(
                    recipient_id=donor.id,
                    request_id=request.id,
                    message=message,
                    kind=NotificationKind.REQUEST,
                )
            )
            notified += 1
        return notified

    def my_requests(self, seeker: Person) -> list[BloodRequest]:
        return self._requests.list_for_requester(seeker.id)

    def update_request_status(self, seeker: Person, request_id: int, action: str) -> BloodRequest:
        request = self._owned_request(seeker, request_id)
        if action == "fulfil":
            request.mark_fulfilled()
        elif action == "cancel":
            request.cancel()
        else:
            raise ValidationError("Unknown action for this request.")
        return self._requests.save(request)

    def _owned_request(self, seeker: Person, request_id: int) -> BloodRequest:
        request = self._requests.find_by_id(request_id)
        if request is None or request.requester_id != seeker.id:
            raise ValidationError("That request does not belong to your account.")
        return request

    # ------------------------------------------------------------------ #
    # Donor search and responses
    # ------------------------------------------------------------------ #
    def search_donors(self, blood_group: str | None = None, city: str | None = None) -> list[Donor]:
        donors = self._people.list_donors(blood_group=blood_group or None, city=city or None)
        return sorted(donors, key=lambda d: (not d.can_receive_requests, d.full_name.lower()))

    def responses_for(self, seeker: Person, request_id: int) -> list[tuple[Notification, Person | None]]:
        self._owned_request(seeker, request_id)
        responses = self._notifications.list_for_request(
            request_id, kind=NotificationKind.RESPONSE
        )
        result: list[tuple[Notification, Person | None]] = []
        for notification in responses:
            donor = self._people.find_by_id(notification.actor_id) if notification.actor_id else None
            result.append((notification, donor))
        return result

    def incoming_requests(self, donor: Person) -> list[tuple[Notification, BloodRequest]]:
        """Matching notifications for a donor, paired with their blood request."""
        self._ensure_donor(donor)
        result: list[tuple[Notification, BloodRequest]] = []
        for notification in self._notifications.list_for_recipient(
            donor.id, kind=NotificationKind.REQUEST
        ):
            request = self._requests.find_by_id(notification.request_id)
            if request is not None:
                result.append((notification, request))
        return result

    def pending_notification_count(self, donor: Person) -> int:
        self._ensure_donor(donor)
        return self._notifications.count_pending(donor.id)

    def respond_to_notification(self, donor: Donor, notification_id: int, accepted: bool) -> str:
        self._ensure_donor(donor)
        notification = self._notifications.find_by_id(notification_id)
        if notification is None or notification.recipient_id != donor.id:
            raise ValidationError("That request notification is not available.")
        if not notification.is_pending:
            raise ValidationError("You have already responded to this request.")

        request = self._requests.find_by_id(notification.request_id)
        if request is None:
            raise ValidationError("The blood request is no longer available.")
        if accepted and not request.is_active:
            raise ValidationError("This request has already been closed.")

        notification.respond(accepted)
        self._notifications.save(notification)

        if not notification.is_accepted:
            return "You declined this request. Thank you for letting the seeker know."

        request.mark_matched()
        self._requests.save(request)
        seeker = self._people.find_by_id(request.requester_id)
        seeker_name = seeker.full_name if seeker else "the person who requested blood"
        self._notifications.save(
            Notification(
                recipient_id=request.requester_id,
                request_id=request.id,
                kind=NotificationKind.RESPONSE,
                actor_id=donor.id,
                response=ResponseStatus.ACCEPTED,
                message=(
                    f"{donor.full_name} ({donor.blood_group}, {donor.city}) accepted your "
                    f"request and can be reached on {donor.phone}."
                ),
            )
        )
        return (
            f"Thank you, {donor.full_name.split()[0]}! {seeker_name} has been sent your "
            f"contact number and will call you."
        )

    # ------------------------------------------------------------------ #
    # Donor profile
    # ------------------------------------------------------------------ #
    def set_availability(self, donor: Person, available: bool) -> Donor:
        stored = self._reload_donor(donor)
        stored.set_availability(available)
        return self._people.save(stored)

    def set_last_donation(self, donor: Person, value: str) -> Donor:
        stored = self._reload_donor(donor)
        stored.record_donation(value or None)
        return self._people.save(stored)

    def _reload_donor(self, donor: Person) -> Donor:
        self._ensure_donor(donor)
        stored = self._people.find_by_id(donor.id)
        if not isinstance(stored, Donor):
            raise ValidationError("Your donor account could not be found.")
        return stored

    def donor_profile(self, donor: Person) -> Donor:
        return self._reload_donor(donor)

    @staticmethod
    def _ensure_donor(person: Person) -> None:
        if not isinstance(person, Donor):
            raise ValidationError("Only registered donors can do that.")
