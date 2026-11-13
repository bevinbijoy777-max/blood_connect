/* Blood Connect web client. Vanilla JS, no build step, works offline-ish. */

const app = document.getElementById("app");
const tabsEl = document.getElementById("tabs");
const toastEl = document.getElementById("toast");

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const URGENCIES = ["Normal", "Urgent", "Critical"];

const state = {
  user: null,
  profile: null,
  tab: "requests",
  requests: [],
  donors: [],
  inbox: { notifications: [], pending: 0 },
  showRequestForm: false,
  donorFilters: { group: "", city: "" },
  loading: true,
};

// --------------------------------------------------------------------- utils
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

const dateLabel = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString() : "");

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

let toastTimer;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = `toast${isError ? " error" : ""}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, isError ? 6000 : 4000);
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

const urgencyTag = (urgency) =>
  `<span class="tag${urgency === "Critical" ? " critical" : urgency === "Urgent" ? " warn" : ""}">${esc(urgency)}</span>`;

const statusTag = (status) =>
  `<span class="tag${status === "Donor found" ? " ok" : status === "Cancelled" ? " warn" : ""}">${esc(status)}</span>`;

// -------------------------------------------------------------------- loading
async function load() {
  try {
    const data = await api("/api/me");
    state.user = data.user;
    state.profile = data.profile;
    if (state.profile) await refresh();
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.loading = false;
    render();
  }
}

async function refresh() {
  const tasks = [api("/api/requests")];
  if (state.profile?.role === "donor") tasks.push(api("/api/inbox"));
  const [requests, inbox] = await Promise.all(tasks);
  state.requests = requests.requests ?? [];
  if (inbox) state.inbox = inbox;
}

// -------------------------------------------------------------------- renders
function render() {
  if (state.loading) return;
  if (!state.user) return renderSignIn();
  if (!state.profile) return renderOnboarding();

  tabsEl.hidden = false;
  renderTabs();
  if (state.tab === "requests") renderRequests();
  else if (state.tab === "donors") renderDonors();
  else if (state.tab === "inbox") renderInbox();
  else renderProfile();
}

function renderSignIn() {
  tabsEl.hidden = true;
  app.innerHTML = `
    <div class="hero">
      <h1>Blood Connect</h1>
      <p class="muted">Find a matching blood donor, or answer a request near you.</p>
      <p class="small muted">Donor phone numbers stay hidden until the donor accepts.</p>
    </div>
    <a class="button primary" href="/auth/freebuff/signin?returnTo=/">Sign in with Freebuff</a>
    <p class="small muted" style="margin-top:1rem">
      Signing in creates your account. No password is stored by Blood Connect.
    </p>
  `;
}

function renderTabs() {
  const tabs = [
    ["requests", "Requests", "🩸"],
    ["donors", "Donors", "🔍"],
  ];
  if (state.profile.role === "donor") {
    const badge = state.inbox.pending ? `<span class="badge">${state.inbox.pending}</span>` : "";
    tabs.push(["inbox", `Inbox${badge}`, "📥"]);
  }
  tabs.push(["profile", "Profile", "👤"]);

  tabsEl.innerHTML = tabs
    .map(
      ([id, label, icon]) => `
      <button type="button" data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ""}>
        <span class="icon" aria-hidden="true">${icon}</span>
        <span>${label}</span>
      </button>`,
    )
    .join("");

  tabsEl.querySelectorAll("button[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab;
      if (state.tab === "donors") searchDonors();
      else render();
      window.scrollTo({ top: 0 });
    });
  });
}

function renderOnboarding() {
  tabsEl.hidden = true;
  app.innerHTML = `
    <h1>Create your profile</h1>
    <p class="muted small">Signed in as ${esc(state.user.email ?? state.user.name ?? "you")}.</p>
    <form class="card stack" id="profile-form">
      <fieldset>
        <legend>I want to</legend>
        <div class="choices">
          <label><input type="radio" name="role" value="seeker" checked /><span>Request blood</span></label>
          <label><input type="radio" name="role" value="donor" /><span>Donate blood</span></label>
        </div>
      </fieldset>
      <label><span>Full name</span><input name="name" required maxlength="80" value="${esc(state.user.name ?? "")}" /></label>
      <label><span>Phone number</span><input name="phone" required inputmode="tel" placeholder="9876543210" /></label>
      <label><span>City</span><input name="city" required maxlength="60" placeholder="Pune" /></label>
      <div data-donor-fields class="stack" hidden>
        <label><span>Blood group</span>
          <select name="bloodGroup" required>
            ${BLOOD_GROUPS.map((group) => `<option>${group}</option>`).join("")}
          </select>
        </label>
        <label><span>Last donation (optional)</span>
          <input type="date" name="lastDonation" max="${todayIso()}" />
        </label>
      </div>
      <button class="primary" type="submit">Save profile</button>
    </form>
  `;

  const form = document.getElementById("profile-form");
  const donorFields = form.querySelector("[data-donor-fields]");
  form.querySelectorAll('input[name="role"]').forEach((input) => {
    input.addEventListener("change", () => {
      const isDonor = form.querySelector('input[name="role"]:checked').value === "donor";
      donorFields.hidden = !isDonor;
      donorFields.querySelectorAll("input, select").forEach((field) => {
        field.required = isDonor && field.name === "bloodGroup";
      });
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const isDonor = data.role === "donor";
    try {
      await api("/api/profile", {
        method: "POST",
        body: {
          role: data.role,
          name: data.name,
          phone: data.phone,
          city: data.city,
          bloodGroup: isDonor ? data.bloodGroup : null,
          lastDonation: isDonor ? data.lastDonation || null : null,
        },
      });
      toast("Profile saved.");
      await load();
    } catch (error) {
      toast(error.message, true);
    }
  });
}

function renderRequests() {
  const form = state.showRequestForm ? requestFormHtml() : "";
  app.innerHTML = `
    <div class="between">
      <h1>Requests</h1>
      <button class="small ${state.showRequestForm ? "" : "primary"}" id="toggle-form" type="button">
        ${state.showRequestForm ? "Close" : "New request"}
      </button>
    </div>
    <p class="muted small">Matching, available donors are notified in the app straight away.</p>
    ${form}
    <div class="stack" style="margin-top:1rem">
      ${
        state.requests.length
          ? state.requests.map(requestCardHtml).join("")
          : '<p class="empty">No requests yet. Tap “New request” to start one.</p>'
      }
    </div>
  `;

  document.getElementById("toggle-form")?.addEventListener("click", () => {
    state.showRequestForm = !state.showRequestForm;
    render();
  });
  wireRequestForm();
  wireRequestActions();
}

function requestFormHtml() {
  const city = state.profile.city ?? "";
  const phone = state.profile.phone ?? "";
  return `
    <form class="card stack" id="request-form">
      <h2>New blood request</h2>
      <label><span>Patient name</span><input name="patientName" required maxlength="80" /></label>
      <div class="row">
        <label style="flex:1;min-width:8rem"><span>Blood group</span>
          <select name="bloodGroup" required>${BLOOD_GROUPS.map((g) => `<option>${g}</option>`).join("")}</select>
        </label>
        <label style="flex:1;min-width:6rem"><span>Units</span>
          <input type="number" name="units" min="1" max="10" value="1" required />
        </label>
      </div>
      <label><span>Hospital</span><input name="hospital" required maxlength="100" /></label>
      <label><span>City</span><input name="city" required maxlength="60" value="${esc(city)}" /></label>
      <label><span>Contact number</span><input name="contact" required inputmode="tel" value="${esc(phone)}" /></label>
      <label><span>Urgency</span>
        <select name="urgency">${URGENCIES.map((u) => `<option>${u}</option>`).join("")}</select>
      </label>
      <label><span>Note (optional)</span><textarea name="note" maxlength="300"></textarea></label>
      <button class="primary" type="submit">Send request</button>
    </form>
  `;
}

function wireRequestForm() {
  const form = document.getElementById("request-form");
  if (!form) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const result = await api("/api/requests", { method: "POST", body: data });
      toast(
        result.notified
          ? `Request sent. ${result.notified} matching donor(s) notified.`
          : "Request sent, but no matching donor is available right now.",
      );
      state.showRequestForm = false;
      await refresh();
      render();
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  });
}

function requestCardHtml(request) {
  const responses = request.responses ?? [];
  const accepted = responses.filter((response) => response.donor && response.response === "Accepted");
  return `
    <article class="card">
      <div class="between">
        <h3>${esc(request.patientName)} · ${esc(request.bloodGroup)}</h3>
        ${statusTag(request.status)}
      </div>
      <p class="muted small">
        ${request.units} unit(s) · ${esc(request.hospital)}, ${esc(request.city)} ·
        ${urgencyTag(request.urgency)} <span class="muted">${esc(dateLabel(request.createdAt))}</span>
      </p>
      ${request.note ? `<p class="small">${esc(request.note)}</p>` : ""}
      ${
        accepted.length
          ? accepted
              .map(
                (response) => `
        <p class="small tag ok">Donor found: ${esc(response.donor.name)} · ${esc(response.donor.bloodGroup)} · ${esc(response.donor.phone)}</p>`,
              )
              .join("")
          : '<p class="small muted">No donor has accepted yet.</p>'
      }
      ${
        request.isActive
          ? `<div class="row" style="margin-top:0.5rem">
               <button class="small" data-action="fulfil" data-id="${request.id}">Mark fulfilled</button>
               <button class="small danger" data-action="cancel" data-id="${request.id}">Cancel</button>
             </div>`
          : ""
      }
    </article>
  `;
}

function wireRequestActions() {
  app.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api(`/api/requests/${button.dataset.id}`, {
          method: "POST",
          body: { action: button.dataset.action },
        });
        await refresh();
        render();
      } catch (error) {
        toast(error.message, true);
        button.disabled = false;
      }
    });
  });
}

async function searchDonors() {
  try {
    const params = new URLSearchParams();
    if (state.donorFilters.group) params.set("group", state.donorFilters.group);
    if (state.donorFilters.city) params.set("city", state.donorFilters.city);
    const data = await api(`/api/donors?${params}`);
    state.donors = data.donors ?? [];
  } catch (error) {
    toast(error.message, true);
  }
  renderDonors();
}

function renderDonors() {
  app.innerHTML = `
    <h1>Donors</h1>
    <p class="muted small">Phone numbers stay hidden until a donor accepts a request.</p>
    <form class="card row" id="donor-filters" style="align-items:flex-end">
      <label style="flex:1;min-width:8rem;margin:0"><span>Blood group</span>
        <select name="group">
          <option value="">Any</option>
          ${BLOOD_GROUPS.map(
            (group) =>
              `<option${state.donorFilters.group === group ? " selected" : ""}>${group}</option>`,
          ).join("")}
        </select>
      </label>
      <label style="flex:1;min-width:8rem;margin:0"><span>City</span>
        <input name="city" value="${esc(state.donorFilters.city)}" placeholder="Any" />
      </label>
      <button type="submit" class="small primary">Search</button>
    </form>
    <div class="stack" style="margin-top:1rem">
      ${
        state.donors.length
          ? state.donors
              .map(
                (donor) => `
        <article class="card">
          <div class="between">
            <h3>${esc(donor.name)}</h3>
            <span class="tag${donor.canReceiveRequests ? " ok" : " warn"}">${esc(donor.availability)}</span>
          </div>
          <p class="muted small">${esc(donor.bloodGroup)} · ${esc(donor.city)}</p>
        </article>`,
              )
              .join("")
          : '<p class="empty">No donors match these filters yet.</p>'
      }
    </div>
  `;

  const form = document.getElementById("donor-filters");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    state.donorFilters = { group: data.group, city: data.city };
    searchDonors();
  });
}

function renderInbox() {
  const { notifications, pending } = state.inbox;
  app.innerHTML = `
    <div class="between">
      <h1>Inbox</h1>
      ${pending ? `<span class="tag ok">${pending} waiting</span>` : ""}
    </div>
    <p class="muted small">Requests for your blood group. Accepting shares your phone number with the seeker.</p>
    <div class="stack">
      ${
        notifications.length
          ? notifications.map(inboxCardHtml).join("")
          : '<p class="empty">No requests yet. You will be notified when someone needs your blood group.</p>'
      }
    </div>
  `;

  app.querySelectorAll("button[data-respond]").forEach((button) => {
    button.addEventListener("click", async () => {
      const accept = button.dataset.respond === "accept";
      button.disabled = true;
      try {
        const result = await api(`/api/notifications/${button.dataset.id}`, {
          method: "POST",
          body: { accept },
        });
        toast(result.message);
        await refresh();
        render();
      } catch (error) {
        toast(error.message, true);
        button.disabled = false;
      }
    });
  });
}

function inboxCardHtml(notification) {
  const request = notification.request;
  return `
    <article class="card">
      <div class="between">
        <h3>${esc(request.bloodGroup)} · ${esc(request.patientName)}</h3>
        ${urgencyTag(request.urgency)}
      </div>
      <p class="muted small">${request.units} unit(s) · ${esc(request.hospital)}, ${esc(request.city)}</p>
      ${request.note ? `<p class="small">${esc(request.note)}</p>` : ""}
      <p class="small muted">${esc(dateLabel(request.createdAt))} · ${esc(request.status)}</p>
      ${
        notification.isPending
          ? `<div class="row">
               <button class="primary small" data-respond="accept" data-id="${notification.id}">Accept</button>
               <button class="small" data-respond="decline" data-id="${notification.id}">Decline</button>
             </div>`
          : `<p class="small tag ${notification.response === "Accepted" ? "ok" : "warn"}">You ${notification.response.toLowerCase()} this request</p>`
      }
    </article>
  `;
}

function renderProfile() {
  const profile = state.profile;
  const isDonor = profile.role === "donor";
  app.innerHTML = `
    <h1>Profile</h1>
    <div class="card">
      <div class="between">
        <h3>${esc(profile.name)}</h3>
        <span class="tag">${isDonor ? "Donor" : "Blood seeker"}</span>
      </div>
      <p class="muted small">${esc(profile.email ?? "")}</p>
      <p class="muted small">${esc(profile.phone)} · ${esc(profile.city)}${isDonor ? ` · ${esc(profile.bloodGroup)}` : ""}</p>
      ${isDonor ? `<p class="small ${profile.canReceiveRequests ? "tag ok" : "tag warn"}">${esc(profile.availability)}</p>` : ""}
    </div>

    ${
      isDonor
        ? `<div class="card stack">
             <h2>Donor settings</h2>
             <label class="row" style="margin:0">
               <input type="checkbox" id="availability" ${profile.acceptingRequests ? "checked" : ""} style="width:auto;min-height:auto" />
               <span style="margin:0">Accept blood request notifications</span>
             </label>
             <p class="small muted">Last donation: ${profile.lastDonation ? esc(dateLabel(profile.lastDonation)) : "never"}.
               ${profile.nextEligible ? `Eligible again from ${esc(dateLabel(profile.nextEligible))}.` : ""}</p>
             <button class="small" id="log-donation" type="button">Log a donation today</button>
           </div>`
        : ""
    }

    <details class="card">
      <summary>Edit my details</summary>
      <form class="stack" id="edit-form" style="margin-top:0.75rem">
        <label><span>Full name</span><input name="name" value="${esc(profile.name)}" maxlength="80" required /></label>
        <label><span>Phone number</span><input name="phone" value="${esc(profile.phone)}" inputmode="tel" required /></label>
        <label><span>City</span><input name="city" value="${esc(profile.city)}" maxlength="60" required /></label>
        ${
          isDonor
            ? `<label><span>Blood group</span>
                 <select name="bloodGroup">${BLOOD_GROUPS.map(
                   (group) => `<option${profile.bloodGroup === group ? " selected" : ""}>${group}</option>`,
                 ).join("")}</select>
               </label>`
            : ""
        }
        <button class="primary" type="submit">Save changes</button>
      </form>
    </details>

    <form method="POST" action="/auth/freebuff/signout" class="card">
      <button type="submit" class="small">Sign out</button>
    </form>
  `;

  document.getElementById("availability")?.addEventListener("change", async (event) => {
    try {
      const data = await api("/api/donor-profile", {
        method: "POST",
        body: { acceptingRequests: event.target.checked },
      });
      state.profile = data.profile;
      toast(event.target.checked ? "You will receive requests again." : "Requests paused.");
      render();
    } catch (error) {
      toast(error.message, true);
    }
  });

  document.getElementById("log-donation")?.addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      const data = await api("/api/donor-profile", {
        method: "POST",
        body: { lastDonation: todayIso() },
      });
      state.profile = data.profile;
      toast("Donation logged. Thank you!");
      render();
    } catch (error) {
      toast(error.message, true);
      event.target.disabled = false;
    }
  });

  document.getElementById("edit-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    try {
      const result = await api("/api/profile", {
        method: "POST",
        body: { ...data, role: profile.role },
      });
      state.profile = result.profile;
      toast("Details updated.");
      render();
    } catch (error) {
      toast(error.message, true);
    }
  });
}

// --------------------------------------------------------------------- start
load();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
