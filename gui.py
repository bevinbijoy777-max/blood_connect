"""Tkinter user interface for Blood Connect.

The interface is built from a few view classes:

* ``LoginView``           -- sign in, create a seeker account, register a donor.
* ``SeekerDashboard``     -- request blood, follow requests, browse donors.
* ``DonorDashboard``      -- answer matching requests, manage donation profile.

Each dashboard is a notebook of small tab classes, so a feature lives in one
place and refreshes itself.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import font as tkfont, messagebox, ttk
from typing import Callable

from .models import (
    BLOOD_GROUPS,
    URGENCY_LEVELS,
    BloodConnectError,
    Donor,
    ValidationError,
)
from .service import BloodConnectService

# --------------------------------------------------------------------------- #
# Palette
# --------------------------------------------------------------------------- #
PRIMARY = "#b3122b"
PRIMARY_DARK = "#7b0c1d"
PRIMARY_LIGHT = "#fbe8ea"
BLUSH = "#fdf6f6"
CARD = "#ffffff"
TEXT = "#2b1a1d"
MUTED = "#7d6a6d"
SUCCESS = "#1c7a4b"
WARNING = "#a76200"
BRAND_SOFT = "#f4c9cf"

TABLE_HEIGHT = 8


# --------------------------------------------------------------------------- #
# Small reusable widgets
# --------------------------------------------------------------------------- #
def add_field(
    parent,
    app: "BloodConnectApp",
    label: str,
    row: int,
    column: int = 0,
    *,
    values: tuple[str, ...] | None = None,
    show: str | None = None,
    default: str = "",
    width: int = 26,
    on_return: Callable[[], None] | None = None,
) -> tk.StringVar:
    """Place a labelled entry (or read-only combobox) and return its variable."""
    ttk.Label(parent, text=label, style="Field.TLabel").grid(
        row=row, column=column, sticky="w", padx=(0, 12), pady=5
    )
    variable = tk.StringVar(value=default)
    if values is None:
        widget = ttk.Entry(parent, textvariable=variable, width=width, show=show or "")
    else:
        variable.set(default or values[0])
        widget = ttk.Combobox(
            parent, textvariable=variable, values=list(values), state="readonly", width=width - 2
        )
    widget.grid(row=row, column=column + 1, sticky="ew", pady=5)
    if on_return is not None:
        widget.bind("<Return>", lambda _event: on_return())
    return variable


class Card(ttk.Frame):
    def __init__(self, master, padding=18):
        super().__init__(master, style="Card.TFrame", padding=padding)


class Table(ttk.Frame):
    """A card styled treeview with a vertical scrollbar."""

    def __init__(self, master, app: "BloodConnectApp", columns, height=TABLE_HEIGHT):
        super().__init__(master, style="Card.TFrame", padding=2)
        self.tree = ttk.Treeview(
            self,
            columns=[column[0] for column in columns],
            show="headings",
            height=height,
            selectmode="browse",
        )
        for key, heading, width, anchor in columns:
            self.tree.heading(key, text=heading)
            self.tree.column(key, width=width, anchor=anchor, stretch=True)
        scroll = ttk.Scrollbar(self, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        self.tree.tag_configure("muted", foreground=MUTED)
        self.tree.tag_configure("good", foreground=SUCCESS)
        self.tree.tag_configure("warn", foreground=WARNING)

    @property
    def selected_id(self) -> int | None:
        selection = self.tree.selection()
        if not selection:
            return None
        try:
            return int(selection[0])
        except ValueError:
            return None

    def clear(self) -> None:
        self.tree.delete(*self.tree.get_children())


def section_label(parent, app, text: str, row=None, column=0, columnspan=1, pady=(0, 8)):
    label = ttk.Label(parent, text=text, style="Section.TLabel")
    if row is None:
        label.pack(anchor="w", pady=pady)
    else:
        label.grid(row=row, column=column, columnspan=columnspan, sticky="w", pady=pady)
    return label


# --------------------------------------------------------------------------- #
# Application window
# --------------------------------------------------------------------------- #
class BloodConnectApp(tk.Tk):
    def __init__(self, service: BloodConnectService):
        super().__init__()
        self.service = service
        self.title("Blood Connect")
        self.geometry("1120x740")
        self.minsize(980, 660)
        self.configure(background=BLUSH)
        self._family = self._pick_font_family()
        self._configure_styles()

        self.container = ttk.Frame(self, style="App.TFrame")
        self.container.pack(fill="both", expand=True)
        self._view: ttk.Frame | None = None
        self.show_login()

    # -- shortcuts --------------------------------------------------------
    def _pick_font_family(self) -> str:
        available = set(tkfont.families(self))
        for name in ("Segoe UI", "SF Pro Text", "Helvetica Neue", "DejaVu Sans", "Helvetica"):
            if name in available:
                return name
        return tkfont.nametofont("TkDefaultFont").actual("family")

    def font(self, size: int = 10, weight: str = "normal"):
        return (self._family, size, weight)

    def _configure_styles(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(".", font=self.font(10), background=BLUSH, foreground=TEXT)

        style.configure("App.TFrame", background=BLUSH)
        style.configure("Card.TFrame", background=CARD)
        style.configure("Card.TLabel", background=CARD, foreground=TEXT, font=self.font(10))
        style.configure("CardTitle.TLabel", background=CARD, foreground=PRIMARY_DARK, font=self.font(15, "bold"))
        style.configure("Field.TLabel", background=CARD, foreground=MUTED, font=self.font(9))
        style.configure("Hint.TLabel", background=CARD, foreground=MUTED, font=self.font(9))
        style.configure("Muted.TLabel", background=BLUSH, foreground=MUTED, font=self.font(9))
        style.configure("Title.TLabel", background=BLUSH, foreground=TEXT, font=self.font(22, "bold"))
        style.configure("Subtitle.TLabel", background=BLUSH, foreground=MUTED, font=self.font(10))
        style.configure("Section.TLabel", background=BLUSH, foreground=TEXT, font=self.font(12, "bold"))

        style.configure("Primary.TButton", background=PRIMARY, foreground="white",
                        font=self.font(10, "bold"), padding=(16, 8), borderwidth=0)
        style.map("Primary.TButton",
                  background=[("pressed", PRIMARY_DARK), ("active", "#951026")],
                  foreground=[("disabled", "#f2dfe2")])
        style.configure("Ghost.TButton", background=CARD, foreground=PRIMARY,
                        font=self.font(10, "bold"), padding=(12, 7), borderwidth=1)
        style.map("Ghost.TButton", background=[("active", PRIMARY_LIGHT)])

        style.configure("TNotebook", background=BLUSH, borderwidth=0)
        style.configure("TNotebook.Tab", background="#f1e2e4", foreground=MUTED,
                        padding=(18, 9), font=self.font(10, "bold"), borderwidth=0)
        style.map("TNotebook.Tab",
                  background=[("selected", CARD)],
                  foreground=[("selected", PRIMARY_DARK)])

        style.configure("TEntry", padding=6, fieldbackground=CARD)
        style.configure("TCombobox", padding=5)
        style.configure("Card.TCheckbutton", background=CARD, foreground=TEXT, font=self.font(10))
        style.map("Card.TCheckbutton", background=[("active", CARD)])

        style.configure("Treeview", background=CARD, fieldbackground=CARD,
                        foreground=TEXT, rowheight=28, font=self.font(10), borderwidth=0)
        style.configure("Treeview.Heading", background=PRIMARY_LIGHT, foreground=PRIMARY_DARK,
                        font=self.font(9, "bold"), relief="flat", padding=(6, 6))
        style.map("Treeview.Heading", background=[("active", "#f6d6da")])
        style.map("Treeview",
                  background=[("selected", "#f7d3d8")],
                  foreground=[("selected", TEXT)])

    # -- view switching ---------------------------------------------------
    def _swap(self, view_class, *args) -> None:
        if self._view is not None:
            self._view.destroy()
        self._view = view_class(self.container, self, *args)
        self._view.pack(fill="both", expand=True)

    def show_login(self) -> None:
        self._swap(LoginView)

    def show_dashboard(self, person) -> None:
        if isinstance(person, Donor):
            self._swap(DonorDashboard, person)
        else:
            self._swap(SeekerDashboard, person)

    def logout(self) -> None:
        self.show_login()


# --------------------------------------------------------------------------- #
# Login / registration
# --------------------------------------------------------------------------- #
class LoginView(ttk.Frame):
    def __init__(self, master, app: BloodConnectApp):
        super().__init__(master, style="App.TFrame")
        self.app = app
        self.rowconfigure(0, weight=1)
        self.columnconfigure(1, weight=1)
        self._build_brand()
        self._build_panel()

    # -- left brand panel -------------------------------------------------
    def _build_brand(self) -> None:
        brand = tk.Frame(self, bg=PRIMARY_DARK, width=430)
        brand.grid(row=0, column=0, sticky="nsew")
        brand.grid_propagate(False)
        panel = tk.Frame(brand, bg=PRIMARY_DARK, padx=42, pady=46)
        panel.pack(fill="both", expand=True)
        panel.columnconfigure(0, weight=1)

        tk.Label(panel, text="🩸", bg=PRIMARY_DARK, fg=BRAND_SOFT,
                 font=self.app.font(34)).grid(row=0, column=0, sticky="w")
        tk.Label(panel, text="Blood Connect", bg=PRIMARY_DARK, fg="white",
                 font=self.app.font(27, "bold")).grid(row=1, column=0, sticky="w", pady=(6, 2))
        tk.Label(panel, text="Every drop finds its way.", bg=PRIMARY_DARK, fg=BRAND_SOFT,
                 font=self.app.font(11)).grid(row=2, column=0, sticky="w")

        tk.Frame(panel, bg="#952036", height=1).grid(row=3, column=0, sticky="ew", pady=22)

        tk.Label(
            panel,
            text="A simple place to ask for blood, and to answer that ask. "
                 "Register once, request when you need to, and hear back from "
                 "donors with a matching blood group.",
            bg=PRIMARY_DARK, fg="#f8dfe3", justify="left", wraplength=330,
            font=self.app.font(10),
        ).grid(row=4, column=0, sticky="w")

        bullets = (
            "Register as a donor in under a minute",
            "Request blood by group, hospital and city",
            "Matching donors get an in-app alert",
            "Donors accept and share their number",
        )
        for index, text in enumerate(bullets):
            tk.Label(panel, text=f"•   {text}", bg=PRIMARY_DARK, fg="white",
                     justify="left", wraplength=330,
                     font=self.app.font(10)).grid(row=5 + index, column=0, sticky="w", pady=(10, 0))

        tk.Label(
            panel,
            text="OOP micro-project  ·  Python, Tkinter and SQLite",
            bg=PRIMARY_DARK, fg="#d38e9a", font=self.app.font(8),
        ).grid(row=12, column=0, sticky="sw", pady=(26, 0))

    # -- right form panel -------------------------------------------------
    def _build_panel(self) -> None:
        panel = ttk.Frame(self, style="App.TFrame", padding=(44, 30))
        panel.grid(row=0, column=1, sticky="nsew")
        panel.columnconfigure(0, weight=1)
        panel.rowconfigure(3, weight=1)

        ttk.Label(panel, text="Welcome to Blood Connect", style="Title.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(
            panel,
            text="Sign in, or create an account to give or request blood.",
            style="Subtitle.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(4, 16))

        self.notebook = ttk.Notebook(panel)
        self.notebook.grid(row=3, column=0, sticky="nsew")
        self.notebook.add(self._sign_in_tab(), text="Sign in")
        self.notebook.add(self._seeker_tab(), text="Create account")
        self.notebook.add(self._donor_tab(), text="Register as donor")

        ttk.Label(
            panel,
            text="Blood Connect only introduces people. A doctor must always confirm "
                 "donor eligibility and blood compatibility before a transfusion.",
            style="Muted.TLabel", wraplength=560, justify="left",
        ).grid(row=4, column=0, sticky="w", pady=(16, 0))

    def _sign_in_tab(self) -> ttk.Frame:
        tab = ttk.Frame(self.notebook, style="Card.TFrame", padding=(26, 22))
        tab.columnconfigure(1, weight=1)
        self.email = add_field(tab, self.app, "Email", 0, on_return=self._sign_in)
        self.password = add_field(tab, self.app, "Password", 1, show="•", on_return=self._sign_in)
        ttk.Button(tab, text="Sign in", style="Primary.TButton", command=self._sign_in).grid(
            row=2, column=0, columnspan=2, sticky="w", pady=(16, 0)
        )
        ttk.Label(
            tab, text="New here? Create an account or register as a donor.",
            style="Hint.TLabel",
        ).grid(row=3, column=0, columnspan=2, sticky="w", pady=(12, 0))
        return tab

    def _seeker_tab(self) -> ttk.Frame:
        tab = ttk.Frame(self.notebook, style="Card.TFrame", padding=(26, 22))
        tab.columnconfigure(1, weight=1)
        self.u_name = add_field(tab, self.app, "Full name", 0)
        self.u_email = add_field(tab, self.app, "Email", 1)
        self.u_phone = add_field(tab, self.app, "Phone", 2)
        self.u_city = add_field(tab, self.app, "City", 3)
        self.u_password = add_field(tab, self.app, "Password", 4, show="•")
        self.u_confirm = add_field(tab, self.app, "Confirm password", 5, show="•",
                                   on_return=lambda: self._register(donor=False))
        ttk.Button(tab, text="Create my account", style="Primary.TButton",
                   command=lambda: self._register(donor=False)).grid(
            row=6, column=0, columnspan=2, sticky="w", pady=(16, 0)
        )
        ttk.Label(tab, text="You will use this email and password to sign in later.",
                  style="Hint.TLabel").grid(row=7, column=0, columnspan=2, sticky="w", pady=(12, 0))
        return tab

    def _donor_tab(self) -> ttk.Frame:
        tab = ttk.Frame(self.notebook, style="Card.TFrame", padding=(26, 22))
        tab.columnconfigure(1, weight=1)
        self.d_name = add_field(tab, self.app, "Full name", 0)
        self.d_email = add_field(tab, self.app, "Email", 1)
        self.d_phone = add_field(tab, self.app, "Phone", 2)
        self.d_city = add_field(tab, self.app, "City", 3)
        self.d_group = add_field(tab, self.app, "Blood group", 4, values=BLOOD_GROUPS)
        self.d_last = add_field(tab, self.app, "Last donation (optional)", 5)
        self.d_password = add_field(tab, self.app, "Password", 6, show="•")
        self.d_confirm = add_field(tab, self.app, "Confirm password", 7, show="•",
                                   on_return=lambda: self._register(donor=True))
        ttk.Button(tab, text="Register as a donor", style="Primary.TButton",
                   command=lambda: self._register(donor=True)).grid(
            row=8, column=0, columnspan=2, sticky="w", pady=(14, 0)
        )
        ttk.Label(
            tab,
            text="Last donation is optional, in YYYY-MM-DD form. Donors are only "
                 "alerted once they are eligible again (90 days after a donation).",
            style="Hint.TLabel", wraplength=520, justify="left",
        ).grid(row=9, column=0, columnspan=2, sticky="w", pady=(12, 0))
        return tab

    # -- actions ----------------------------------------------------------
    def _sign_in(self) -> None:
        try:
            person = self.app.service.sign_in(self.email.get(), self.password.get())
        except BloodConnectError as error:
            messagebox.showerror("Cannot sign in", str(error), parent=self)
            return
        self.app.show_dashboard(person)

    def _register(self, donor: bool) -> None:
        try:
            if donor:
                if self.d_password.get() != self.d_confirm.get():
                    raise ValidationError("The two passwords do not match.")
                person = self.app.service.register_donor(
                    full_name=self.d_name.get(),
                    email=self.d_email.get(),
                    phone=self.d_phone.get(),
                    city=self.d_city.get(),
                    blood_group=self.d_group.get(),
                    last_donation=self.d_last.get(),
                    password=self.d_password.get(),
                )
            else:
                if self.u_password.get() != self.u_confirm.get():
                    raise ValidationError("The two passwords do not match.")
                person = self.app.service.register_seeker(
                    full_name=self.u_name.get(),
                    email=self.u_email.get(),
                    phone=self.u_phone.get(),
                    city=self.u_city.get(),
                    password=self.u_password.get(),
                )
        except BloodConnectError as error:
            messagebox.showerror("Registration failed", str(error), parent=self)
            return

        self.email.set(person.email)
        self.password.set("")
        self.notebook.select(0)
        messagebox.showinfo(
            "Account created",
            f"Welcome, {person.full_name}!\nSign in with {person.email} to continue.",
            parent=self,
        )


# --------------------------------------------------------------------------- #
# Dashboards
# --------------------------------------------------------------------------- #
class DashboardView(ttk.Frame):
    TABS: tuple[type["DashboardTab"], ...] = ()

    def __init__(self, master, app: BloodConnectApp, person):
        super().__init__(master, style="App.TFrame")
        self.app = app
        self.service = app.service
        self.person = person
        self._build_header()

        body = ttk.Frame(self, style="App.TFrame", padding=(22, 16, 22, 18))
        body.pack(fill="both", expand=True)
        self.notebook = ttk.Notebook(body)
        self.notebook.pack(fill="both", expand=True)

        self.tabs: list[DashboardTab] = []
        for tab_class in self.TABS:
            tab = tab_class(self.notebook, self)
            self.notebook.add(tab, text=tab.TITLE)
            self.tabs.append(tab)

        self.notebook.bind("<<NotebookTabChanged>>", self._on_tab_changed)
        self.refresh_all()

    def _build_header(self) -> None:
        header = tk.Frame(self, bg=PRIMARY_DARK)
        header.pack(fill="x")
        inner = tk.Frame(header, bg=PRIMARY_DARK, padx=24, pady=13)
        inner.pack(fill="x")

        tk.Label(inner, text="Blood Connect", bg=PRIMARY_DARK, fg="white",
                 font=self.app.font(15, "bold")).pack(side="left")
        tk.Label(inner, text=f"   {self.person.role_label}", bg=PRIMARY_DARK, fg=BRAND_SOFT,
                 font=self.app.font(10)).pack(side="left")

        tk.Button(
            inner, text="Sign out", command=self.app.logout, bg=PRIMARY, fg="white",
            activebackground="#951026", activeforeground="white", relief="flat", bd=0,
            padx=14, pady=6, cursor="hand2", font=self.app.font(10, "bold"),
        ).pack(side="right")
        tk.Label(inner, text=f"{self.person.full_name}  ·  {self.person.city}",
                 bg=PRIMARY_DARK, fg="white", font=self.app.font(10)).pack(
            side="right", padx=(0, 16)
        )

    def _on_tab_changed(self, _event=None) -> None:
        index = self.notebook.index("current")
        if 0 <= index < len(self.tabs):
            self.tabs[index].refresh()

    def refresh_all(self) -> None:
        for tab in self.tabs:
            tab.refresh()

    def open_tab(self, title: str) -> None:
        for index, tab in enumerate(self.tabs):
            if tab.TITLE == title:
                self.notebook.select(index)
                tab.refresh()
                return


class DashboardTab(ttk.Frame):
    TITLE = ""

    def __init__(self, master, dashboard: DashboardView):
        super().__init__(master, style="App.TFrame", padding=(2, 14, 2, 2))
        self.dash = dashboard
        self.app = dashboard.app
        self.service = dashboard.service
        self.person = dashboard.person
        self.build()

    def build(self) -> None:  # pragma: no cover - overridden by every tab
        raise NotImplementedError

    def refresh(self) -> None:
        pass

    def use_donor(self, donor: Donor) -> None:
        """Keep the session and every tab pointed at the freshly saved donor."""
        self.person = donor
        self.dash.person = donor


# --------------------------------------------------------------------------- #
# Seeker tabs
# --------------------------------------------------------------------------- #
class RequestBloodTab(DashboardTab):
    TITLE = "Request blood"

    def build(self) -> None:
        card = Card(self)
        card.pack(fill="x")
        card.columnconfigure(1, weight=1)
        card.columnconfigure(3, weight=1)

        ttk.Label(card, text="Request blood", style="CardTitle.TLabel").grid(
            row=0, column=0, columnspan=4, sticky="w"
        )
        ttk.Label(
            card,
            text="Registered donors with this blood group are notified inside the app.",
            style="Hint.TLabel",
        ).grid(row=1, column=0, columnspan=4, sticky="w", pady=(2, 12))

        self.patient = add_field(card, self.app, "Patient name", 2, 0)
        self.group = add_field(card, self.app, "Blood group", 2, 2, values=BLOOD_GROUPS)
        self.units = add_field(
            card, self.app, "Units needed", 3, 0,
            values=("1", "2", "3", "4", "5", "6", "7", "8", "9", "10"), default="1",
        )
        self.urgency = add_field(card, self.app, "Urgency", 3, 2, values=URGENCY_LEVELS)
        self.hospital = add_field(card, self.app, "Hospital", 4, 0)
        self.city = add_field(card, self.app, "City", 4, 2, default=self.person.city)
        self.contact = add_field(card, self.app, "Contact number", 5, 0, default=self.person.phone)
        self.note = add_field(card, self.app, "Note (optional)", 5, 2)

        ttk.Button(
            card, text="Submit request and alert donors", style="Primary.TButton",
            command=self._submit,
        ).grid(row=6, column=0, columnspan=4, sticky="w", pady=(18, 2))

        ttk.Label(
            self,
            text=f"Your account is {self.person.full_name} ({self.person.email}). "
                 "Donors see the patient, hospital and city — your contact number is "
                 "only shared with donors who accept.",
            style="Muted.TLabel", wraplength=780, justify="left",
        ).pack(anchor="w", pady=(12, 0))

    def _submit(self) -> None:
        try:
            request, notified = self.service.submit_request(
                self.person,
                patient_name=self.patient.get(),
                blood_group=self.group.get(),
                units=self.units.get(),
                hospital=self.hospital.get(),
                city=self.city.get(),
                contact=self.contact.get(),
                urgency=self.urgency.get(),
                note=self.note.get(),
            )
        except BloodConnectError as error:
            messagebox.showerror("Request not submitted", str(error), parent=self)
            return

        if notified:
            detail = f"{notified} matching donor(s) have been notified."
        else:
            detail = (
                "No matching donor is available right now. Your request stays open, "
                "so check back after new donors register."
            )
        messagebox.showinfo(
            "Request submitted",
            f"Request #{request.id} for {request.blood_group} is now open.\n\n{detail}",
            parent=self,
        )
        self.patient.set("")
        self.hospital.set("")
        self.note.set("")
        self.dash.open_tab("My requests")


class MyRequestsTab(DashboardTab):
    TITLE = "My requests"
    COLUMNS = (
        ("id", "#", 60, "center"),
        ("created", "Date", 90, "center"),
        ("patient", "Patient", 140, "w"),
        ("group", "Group", 70, "center"),
        ("units", "Units", 60, "center"),
        ("hospital", "Hospital", 180, "w"),
        ("city", "City", 110, "w"),
        ("status", "Status", 110, "center"),
    )
    RESPONSE_COLUMNS = (
        ("donor", "Donor", 160, "w"),
        ("donor_group", "Group", 70, "center"),
        ("phone", "Contact", 130, "w"),
        ("response", "Response", 100, "center"),
        ("when", "Date", 90, "center"),
    )

    def build(self) -> None:
        bar = ttk.Frame(self, style="App.TFrame")
        bar.pack(fill="x", pady=(0, 10))
        ttk.Label(bar, text="Your blood requests", style="Section.TLabel").pack(side="left")
        ttk.Button(bar, text="Refresh", style="Ghost.TButton", command=self.refresh).pack(side="right")
        ttk.Button(bar, text="Mark fulfilled", style="Primary.TButton",
                   command=lambda: self._close("fulfil")).pack(side="right", padx=(0, 8))
        ttk.Button(bar, text="Cancel request", style="Ghost.TButton",
                   command=lambda: self._close("cancel")).pack(side="right", padx=(0, 8))

        self.table = Table(self, self.app, self.COLUMNS, height=7)
        self.table.pack(fill="x")
        self.table.tree.bind("<<TreeviewSelect>>", lambda _event: self._load_responses())

        ttk.Label(self, text="Donor responses", style="Section.TLabel").pack(
            anchor="w", pady=(16, 8)
        )
        self.responses = Table(self, self.app, self.RESPONSE_COLUMNS, height=5)
        self.responses.pack(fill="both", expand=True)
        self.empty = ttk.Label(
            self, text="Select a request above to see which donors answered.",
            style="Muted.TLabel",
        )
        self.empty.pack(anchor="w", pady=(6, 0))

    def refresh(self) -> None:
        selected = self.table.selected_id
        self.table.clear()
        for request in self.service.my_requests(self.person):
            tag = "good" if request.status_label == "Fulfilled" else (
                "warn" if request.status_label == "Cancelled" else ""
            )
            self.table.tree.insert(
                "", "end", iid=str(request.id),
                values=(
                    f"#{request.id}", request.created_at.isoformat(), request.patient_name,
                    request.blood_group, request.units, request.hospital, request.city,
                    request.status_label,
                ),
                tags=(tag,) if tag else (),
            )
        if selected is not None and self.table.tree.exists(str(selected)):
            self.table.tree.selection_set(str(selected))
        self._load_responses()

    def _load_responses(self) -> None:
        self.responses.clear()
        request_id = self.table.selected_id
        if request_id is None:
            self.empty.configure(text="Select a request above to see which donors answered.")
            return
        try:
            responses = self.service.responses_for(self.person, request_id)
        except BloodConnectError as error:
            self.empty.configure(text=str(error))
            return
        if not responses:
            self.empty.configure(
                text="No donor has answered yet. Donors are notified as soon as the request opens."
            )
            return
        self.empty.configure(text="Accepted donors shared their number so you can call them.")
        for notification, donor in responses:
            name = donor.full_name if donor else "A donor"
            group = donor.blood_group if donor else "—"
            phone = donor.phone if donor and notification.is_accepted else "Hidden"
            self.responses.tree.insert(
                "", "end",
                values=(name, group, phone, notification.response_label,
                        notification.created_at.isoformat()),
                tags=("good",) if notification.is_accepted else ("muted",),
            )

    def _close(self, action: str) -> None:
        request_id = self.table.selected_id
        if request_id is None:
            messagebox.showinfo("No request selected", "Pick a request in the table first.",
                                parent=self)
            return
        try:
            self.service.update_request_status(self.person, request_id, action)
        except BloodConnectError as error:
            messagebox.showerror("Cannot update request", str(error), parent=self)
            return
        self.refresh()


class FindDonorsTab(DashboardTab):
    TITLE = "Find donors"
    COLUMNS = (
        ("donor", "Donor", 190, "w"),
        ("group", "Blood group", 100, "center"),
        ("city", "City", 150, "w"),
        ("availability", "Availability", 200, "w"),
        ("last", "Last donation", 120, "center"),
    )

    def build(self) -> None:
        card = Card(self)
        card.pack(fill="x")
        card.columnconfigure(1, weight=1)
        card.columnconfigure(3, weight=1)
        ttk.Label(card, text="Search registered donors", style="CardTitle.TLabel").grid(
            row=0, column=0, columnspan=4, sticky="w"
        )
        ttk.Label(
            card,
            text="Filter by blood group and city, then submit a request so donors can answer.",
            style="Hint.TLabel",
        ).grid(row=1, column=0, columnspan=4, sticky="w", pady=(2, 10))
        self.group = add_field(card, self.app, "Blood group", 2, 0,
                               values=("Any",) + BLOOD_GROUPS)
        self.city = add_field(card, self.app, "City", 2, 2, default="")
        ttk.Button(card, text="Search", style="Primary.TButton", command=self.refresh).grid(
            row=2, column=4, padx=(10, 0)
        )

        self.table = Table(self, self.app, self.COLUMNS, height=11)
        self.table.pack(fill="both", expand=True, pady=(14, 8))
        ttk.Label(
            self,
            text="Contact numbers stay private until a donor accepts your request. "
                 "Donors who gave blood in the last 90 days are shown but not alerted.",
            style="Muted.TLabel", wraplength=780, justify="left",
        ).pack(anchor="w")

    def refresh(self) -> None:
        group = self.group.get() if hasattr(self, "group") else "Any"
        city = self.city.get() if hasattr(self, "city") else ""
        donors = self.service.search_donors(None if group == "Any" else group, city or None)
        self.table.clear()
        for donor in donors:
            self.table.tree.insert(
                "", "end",
                values=(
                    donor.full_name, donor.blood_group, donor.city,
                    donor.availability_text(),
                    donor.last_donation.isoformat() if donor.last_donation else "—",
                ),
                tags=() if donor.can_receive_requests else ("muted",),
            )
        if not donors:
            self.table.tree.insert("", "end", values=("No donors found", "", "", "", ""),
                                   tags=("muted",))


# --------------------------------------------------------------------------- #
# Donor tabs
# --------------------------------------------------------------------------- #
class DonorNotificationsTab(DashboardTab):
    TITLE = "Requests for me"
    COLUMNS = (
        ("received", "Received", 90, "center"),
        ("patient", "Patient", 130, "w"),
        ("group", "Group", 70, "center"),
        ("units", "Units", 60, "center"),
        ("hospital", "Hospital", 170, "w"),
        ("city", "City", 110, "w"),
        ("urgency", "Urgency", 90, "center"),
        ("status", "Status", 110, "center"),
    )

    def build(self) -> None:
        bar = ttk.Frame(self, style="App.TFrame")
        bar.pack(fill="x", pady=(0, 10))
        ttk.Label(bar, text="Blood requests that match your blood group",
                  style="Section.TLabel").pack(side="left")
        ttk.Button(bar, text="Refresh", style="Ghost.TButton", command=self.refresh).pack(side="right")
        ttk.Button(bar, text="Accept", style="Primary.TButton",
                   command=lambda: self._respond(True)).pack(side="right", padx=(0, 8))
        ttk.Button(bar, text="Decline", style="Ghost.TButton",
                   command=lambda: self._respond(False)).pack(side="right", padx=(0, 8))
        ttk.Button(bar, text="View details", style="Ghost.TButton",
                   command=self._show_details).pack(side="right", padx=(0, 8))

        self.table = Table(self, self.app, self.COLUMNS, height=12)
        self.table.pack(fill="both", expand=True)

        self.hint = ttk.Label(
            self,
            text="Accepting a request shares your name and phone number with the person "
                 "who asked, and marks the request as “donor found”.",
            style="Muted.TLabel", wraplength=780, justify="left",
        )
        self.hint.pack(anchor="w", pady=(10, 0))
        self._messages: dict[int, str] = {}

    def refresh(self) -> None:
        selected = self.table.selected_id
        self.table.clear()
        self._messages = {}
        for notification, request in self.service.incoming_requests(self.person):
            self._messages[notification.id] = notification.message
            tag = ""
            if notification.is_accepted:
                tag = "good"
            elif not notification.is_pending:
                tag = "muted"
            self.table.tree.insert(
                "", "end", iid=str(notification.id),
                values=(
                    notification.created_at.isoformat(),
                    request.patient_name,
                    request.blood_group,
                    request.units,
                    request.hospital,
                    request.city,
                    request.urgency,
                    notification.response_label,
                ),
                tags=(tag,) if tag else (),
            )
        if selected is not None and self.table.tree.exists(str(selected)):
            self.table.tree.selection_set(str(selected))
        pending = self.service.pending_notification_count(self.person)
        if pending:
            self.hint.configure(text=f"{pending} request(s) still waiting for your answer. "
                                     "Accept only if you are able to donate.")
        else:
            self.hint.configure(text="No pending requests. New matching requests will appear here.")

    def _show_details(self) -> None:
        notification_id = self.table.selected_id
        if notification_id is None:
            messagebox.showinfo("No request selected", "Pick a request in the table first.",
                                parent=self)
            return
        messagebox.showinfo("Request details", self._messages.get(notification_id, ""), parent=self)

    def _respond(self, accepted: bool) -> None:
        notification_id = self.table.selected_id
        if notification_id is None:
            messagebox.showinfo("No request selected", "Pick a request in the table first.",
                                parent=self)
            return
        try:
            message = self.service.respond_to_notification(self.person, notification_id, accepted)
        except BloodConnectError as error:
            messagebox.showerror("Cannot answer request", str(error), parent=self)
            self.refresh()
            return
        messagebox.showinfo("Response sent", message, parent=self)
        self.dash.refresh_all()


class DonorProfileTab(DashboardTab):
    TITLE = "My donor profile"

    def build(self) -> None:
        card = Card(self)
        card.pack(fill="x")
        card.columnconfigure(1, weight=1)
        card.columnconfigure(3, weight=1)
        ttk.Label(card, text="My donor profile", style="CardTitle.TLabel").grid(
            row=0, column=0, columnspan=4, sticky="w"
        )
        ttk.Label(
            card,
            text="Keep this accurate so seekers only see donors who can actually give.",
            style="Hint.TLabel",
        ).grid(row=1, column=0, columnspan=4, sticky="w", pady=(2, 12))

        self._values: dict[str, ttk.Label] = {}
        for row, key in enumerate(("Blood group", "Last donation", "Next eligible date",
                                   "Availability"), start=2):
            ttk.Label(card, text=key, style="Field.TLabel").grid(
                row=row, column=0, sticky="w", pady=5
            )
            value = ttk.Label(card, text="—", style="Card.TLabel")
            value.grid(row=row, column=1, sticky="w", pady=5)
            self._values[key] = value

        ttk.Separator(card, orient="horizontal").grid(
            row=6, column=0, columnspan=4, sticky="ew", pady=14
        )

        self.available = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            card, text="Send me notifications about matching blood requests",
            variable=self.available, style="Card.TCheckbutton", command=self._toggle_availability,
        ).grid(row=7, column=0, columnspan=4, sticky="w")

        self.last = add_field(card, self.app, "Log a donation (YYYY-MM-DD)", 8, 0,
                              default="")
        ttk.Button(card, text="Save donation date", style="Ghost.TButton",
                   command=self._save_last_donation).grid(
            row=9, column=1, sticky="w", pady=(6, 0)
        )

        ttk.Label(
            self,
            text="Donors are eligible again 90 days after a donation. Logging a donation "
                 "pauses notifications until then.",
            style="Muted.TLabel", wraplength=780, justify="left",
        ).pack(anchor="w", pady=(14, 0))

    def refresh(self) -> None:
        try:
            donor = self.service.donor_profile(self.person)
        except BloodConnectError:
            return
        self.use_donor(donor)
        self._values["Blood group"].configure(text=donor.blood_group)
        self._values["Last donation"].configure(
            text=donor.last_donation.isoformat() if donor.last_donation else "Not recorded"
        )
        next_date = donor.next_eligible_date
        self._values["Next eligible date"].configure(
            text=next_date.isoformat() if next_date else "Eligible now"
        )
        self._values["Availability"].configure(text=donor.availability_text())
        self.available.set(donor.is_available)
        self.last.set(donor.last_donation.isoformat() if donor.last_donation else "")

    def _toggle_availability(self) -> None:
        try:
            donor = self.service.set_availability(self.person, self.available.get())
        except BloodConnectError as error:
            messagebox.showerror("Cannot update availability", str(error), parent=self)
            return
        self.use_donor(donor)
        self.refresh()

    def _save_last_donation(self) -> None:
        try:
            donor = self.service.set_last_donation(self.person, self.last.get())
        except BloodConnectError as error:
            messagebox.showerror("Cannot save donation", str(error), parent=self)
            return
        self.use_donor(donor)
        self.refresh()
        next_date = donor.next_eligible_date
        note = f"You can donate again from {next_date.isoformat()}." if next_date else ""
        messagebox.showinfo("Donation recorded", f"Thank you for donating! {note}".strip(),
                            parent=self)


class SeekerDashboard(DashboardView):
    """Everything a person looking for blood can do."""

    TABS = (RequestBloodTab, MyRequestsTab, FindDonorsTab)


class DonorDashboard(DashboardView):
    """Everything a registered donor can do."""

    TABS = (DonorNotificationsTab, DonorProfileTab)
