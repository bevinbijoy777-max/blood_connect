/**
 * D1 schema and repositories. Rows are keyed by the signed-in user's `sub`,
 * which the server takes from the session and never from the request body.
 */

// One statement per entry: D1's exec() cannot run a multi-line script.
export const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS profiles (
  sub                TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  email              TEXT,
  phone              TEXT NOT NULL,
  city               TEXT NOT NULL,
  role               TEXT NOT NULL CHECK (role IN ('seeker', 'donor')),
  blood_group        TEXT,
  last_donation      TEXT,
  accepting_requests INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_sub TEXT NOT NULL,
  patient_name  TEXT NOT NULL,
  blood_group   TEXT NOT NULL,
  units         INTEGER NOT NULL,
  hospital      TEXT NOT NULL,
  city          TEXT NOT NULL,
  contact       TEXT NOT NULL,
  urgency       TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_sub TEXT NOT NULL,
  actor_sub     TEXT,
  request_id    INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('request', 'response')),
  message       TEXT NOT NULL,
  response      TEXT NOT NULL DEFAULT 'Pending',
  created_at    TEXT NOT NULL
)`,
  // One row per browser/device. The endpoint is the push service's URL and is
  // unique, so a device that signs in as somebody else moves to that account.
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
  // One report per donor per request; reporting again replaces the reason.
  `CREATE TABLE IF NOT EXISTS request_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL,
  requester_sub TEXT NOT NULL,
  reporter_sub  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE(request_id, reporter_sub)
)`,
  // A donor's personal block list. The blocked account is never told.
  `CREATE TABLE IF NOT EXISTS blocked_requesters (
  donor_sub   TEXT NOT NULL,
  blocked_sub TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (donor_sub, blocked_sub)
)`,
  `CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(requester_sub)`,
  `CREATE INDEX IF NOT EXISTS idx_request_reports_requester ON request_reports(requester_sub)`,
  `CREATE INDEX IF NOT EXISTS idx_blocked_requesters_blocked ON blocked_requesters(blocked_sub)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_sub)`,
  `CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role)`,
  `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_sub ON push_subscriptions(sub)`,
];

let schemaReady = false;

/** Create the schema once per isolate. */
export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
  schemaReady = true;
}

export class ProfileRepo {
  constructor(db) {
    this.db = db;
  }

  async get(sub) {
    return this.db.prepare("SELECT * FROM profiles WHERE sub = ?").bind(sub).first();
  }

  async save(profile) {
    await this.db
      .prepare(
        `INSERT INTO profiles (sub, name, email, phone, city, role, blood_group,
                               last_donation, accepting_requests, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sub) DO UPDATE SET
           name = excluded.name,
           email = excluded.email,
           phone = excluded.phone,
           city = excluded.city,
           role = excluded.role,
           blood_group = excluded.blood_group,
           last_donation = excluded.last_donation,
           accepting_requests = excluded.accepting_requests`,
      )
      .bind(
        profile.sub,
        profile.name,
        profile.email ?? null,
        profile.phone,
        profile.city,
        profile.role,
        profile.blood_group ?? null,
        profile.last_donation ?? null,
        profile.accepting_requests ? 1 : 0,
        profile.created_at,
      )
      .run();
    return this.get(profile.sub);
  }

  async listDonors({ bloodGroup, city } = {}) {
    let sql = "SELECT * FROM profiles WHERE role = 'donor'";
    const params = [];
    if (bloodGroup) {
      sql += " AND blood_group = ?";
      params.push(bloodGroup);
    }
    if (city) {
      sql += " AND city LIKE ?";
      params.push(`%${city}%`);
    }
    sql += " ORDER BY name COLLATE NOCASE";
    const { results } = await this.db.prepare(sql).bind(...params).all();
    return results ?? [];
  }
}

export class RequestRepo {
  constructor(db) {
    this.db = db;
  }

  async create(request) {
    const result = await this.db
      .prepare(
        `INSERT INTO requests (requester_sub, patient_name, blood_group, units,
                               hospital, city, contact, urgency, note, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        request.requester_sub,
        request.patient_name,
        request.blood_group,
        request.units,
        request.hospital,
        request.city,
        request.contact,
        request.urgency,
        request.note,
        request.status,
        request.created_at,
      )
      .run();
    return this.get(result.meta.last_row_id);
  }

  async get(id) {
    return this.db.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
  }

  async listForRequester(sub) {
    const { results } = await this.db
      .prepare("SELECT * FROM requests WHERE requester_sub = ? ORDER BY id DESC")
      .bind(sub)
      .all();
    return results ?? [];
  }

  /** How many requests this account has already created on one day. */
  async countCreatedOn(sub, isoDate) {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS total FROM requests WHERE requester_sub = ? AND created_at = ?")
      .bind(sub, isoDate)
      .first();
    return Number(row?.total ?? 0);
  }

  async setStatus(id, status) {
    await this.db.prepare("UPDATE requests SET status = ? WHERE id = ?").bind(status, id).run();
  }
}

export class NotificationRepo {
  constructor(db) {
    this.db = db;
  }

  async create(notification) {
    const result = await this.db
      .prepare(
        `INSERT INTO notifications (recipient_sub, actor_sub, request_id, kind, message, response, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        notification.recipient_sub,
        notification.actor_sub ?? null,
        notification.request_id,
        notification.kind,
        notification.message,
        notification.response,
        notification.created_at,
      )
      .run();
    return this.get(result.meta.last_row_id);
  }

  async get(id) {
    return this.db.prepare("SELECT * FROM notifications WHERE id = ?").bind(id).first();
  }

  async listForRecipient(sub, kind) {
    let sql = "SELECT * FROM notifications WHERE recipient_sub = ?";
    const params = [sub];
    if (kind) {
      sql += " AND kind = ?";
      params.push(kind);
    }
    sql += " ORDER BY id DESC";
    const { results } = await this.db.prepare(sql).bind(...params).all();
    return results ?? [];
  }

  /** Donor responses for one request, with the donor's contact details. */
  async listResponsesForRequest(requestId) {
    const { results } = await this.db
      .prepare(
        `SELECT n.id, n.request_id, n.kind, n.message, n.response, n.created_at,
                p.name AS actor_name, p.blood_group AS actor_group,
                p.city AS actor_city, p.phone AS actor_phone
           FROM notifications n
           LEFT JOIN profiles p ON p.sub = n.actor_sub
          WHERE n.request_id = ? AND n.kind = 'response'
          ORDER BY n.id DESC`,
      )
      .bind(requestId)
      .all();
    return results ?? [];
  }

  async setResponse(id, response) {
    await this.db
      .prepare("UPDATE notifications SET response = ? WHERE id = ?")
      .bind(response, id)
      .run();
  }
}

export class PushRepo {
  constructor(db) {
    this.db = db;
  }

  async save(sub, subscription) {
    await this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, sub, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           sub = excluded.sub,
           p256dh = excluded.p256dh,
           auth = excluded.auth,
           created_at = excluded.created_at`,
      )
      .bind(
        subscription.endpoint,
        sub,
        subscription.p256dh,
        subscription.auth,
        subscription.created_at,
      )
      .run();
    return this.get(subscription.endpoint);
  }

  async get(endpoint) {
    return this.db.prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).first();
  }

  async listForSubs(subs) {
    if (!subs.length) return [];
    const placeholders = subs.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(`SELECT * FROM push_subscriptions WHERE sub IN (${placeholders})`)
      .bind(...subs)
      .all();
    return results ?? [];
  }

  /** Only the signed-in owner may remove a device. */
  async remove(sub, endpoint) {
    await this.db
      .prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND sub = ?")
      .bind(endpoint, sub)
      .run();
  }

  /** Used when a push service reports the subscription is gone. */
  async removeByEndpoint(endpoint) {
    await this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  }
}

export class ReportRepo {
  constructor(db) {
    this.db = db;
  }

  /** Reporting the same request twice keeps one row and the newest reason. */
  async save(report) {
    await this.db
      .prepare(
        `INSERT INTO request_reports (request_id, requester_sub, reporter_sub, reason, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(request_id, reporter_sub) DO UPDATE SET
           reason = excluded.reason,
           created_at = excluded.created_at`,
      )
      .bind(
        report.request_id,
        report.requester_sub,
        report.reporter_sub,
        report.reason,
        report.created_at,
      )
      .run();
    const row = await this.db
      .prepare("SELECT * FROM request_reports WHERE request_id = ? AND reporter_sub = ?")
      .bind(report.request_id, report.reporter_sub)
      .first();
    return row ?? null;
  }

  /** Everything filed against one account, for whoever looks at reports. */
  async listForRequester(requesterSub) {
    const { results } = await this.db
      .prepare("SELECT * FROM request_reports WHERE requester_sub = ? ORDER BY id DESC")
      .bind(requesterSub)
      .all();
    return results ?? [];
  }
}

export class BlockRepo {
  constructor(db) {
    this.db = db;
  }

  async block(donorSub, blockedSub, createdAt) {
    await this.db
      .prepare(
        `INSERT INTO blocked_requesters (donor_sub, blocked_sub, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(donor_sub, blocked_sub) DO UPDATE SET created_at = excluded.created_at`,
      )
      .bind(donorSub, blockedSub, createdAt)
      .run();
  }

  async unblock(donorSub, blockedSub) {
    await this.db
      .prepare("DELETE FROM blocked_requesters WHERE donor_sub = ? AND blocked_sub = ?")
      .bind(donorSub, blockedSub)
      .run();
  }

  /** The accounts this donor no longer wants to hear from. */
  async blockedSubs(donorSub) {
    const { results } = await this.db
      .prepare("SELECT blocked_sub FROM blocked_requesters WHERE donor_sub = ?")
      .bind(donorSub)
      .all();
    return (results ?? []).map((row) => row.blocked_sub);
  }

  /** The donors who blocked one account, so nothing is sent to them. */
  async donorSubsBlocking(blockedSub) {
    const { results } = await this.db
      .prepare("SELECT donor_sub FROM blocked_requesters WHERE blocked_sub = ?")
      .bind(blockedSub)
      .all();
    return (results ?? []).map((row) => row.donor_sub);
  }

  /** The block list as the donor sees it, with the names they recognise. */
  async listForDonor(donorSub) {
    const { results } = await this.db
      .prepare(
        `SELECT b.blocked_sub, b.created_at, p.name, p.city
           FROM blocked_requesters b
           LEFT JOIN profiles p ON p.sub = b.blocked_sub
          WHERE b.donor_sub = ?
          ORDER BY b.created_at DESC, b.blocked_sub`,
      )
      .bind(donorSub)
      .all();
    return results ?? [];
  }
}

