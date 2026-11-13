/**
 * Validation shared by every route. These rules mirror the Python models so
 * the web app accepts exactly what the desktop app accepts.
 */

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
export const URGENCIES = ["Normal", "Urgent", "Critical"];
export const DONATION_INTERVAL_DAYS = 90;
export const MAX_UNITS = 10;

/** An error the API turns into a JSON response with a status code. */
export class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function cleanText(value, label, maxLength = 120) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) throw new ApiError(`${label} is required.`);
  if (text.length > maxLength) {
    throw new ApiError(`${label} must be at most ${maxLength} characters.`);
  }
  return text;
}

export function normalisePhone(value) {
  const text = String(value ?? "").trim();
  const digits = text.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    throw new ApiError("Enter a valid phone number with 7 to 15 digits.");
  }
  return text;
}

export function normaliseBloodGroup(value) {
  const group = String(value ?? "").trim().toUpperCase().replace(/\s/g, "");
  if (!BLOOD_GROUPS.includes(group)) throw new ApiError("Choose a valid blood group.");
  return group;
}

export function normaliseUnits(value) {
  const units = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(units) || units < 1 || units > MAX_UNITS) {
    throw new ApiError(`A request can ask for 1 to ${MAX_UNITS} units.`);
  }
  return units;
}

export function normaliseUrgency(value) {
  const urgency = String(value ?? "Normal").trim();
  if (!URGENCIES.includes(urgency)) throw new ApiError("Choose an urgency level.");
  return urgency;
}

export function normaliseRole(value) {
  const role = String(value ?? "").trim();
  if (role !== "seeker" && role !== "donor") throw new ApiError("Choose a role.");
  return role;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function parseDate(value, label = "Date") {
  const text = String(value ?? "").trim();
  if (!text) throw new ApiError(`${label} is required. Use the format YYYY-MM-DD.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ApiError(`${label} must look like YYYY-MM-DD.`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new ApiError(`${label} must look like YYYY-MM-DD.`);
  if (text > todayIso()) throw new ApiError(`${label} cannot be in the future.`);
  return text;
}

export function parseOptionalDate(value, label = "Date") {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return parseDate(value, label);
}

/** ISO date `days` after `iso`, or null. */
export function addDays(iso, days) {
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A donor is eligible when they have never donated or the interval has passed. */
export function eligibility(lastDonation, on = todayIso()) {
  const nextEligible = addDays(lastDonation, DONATION_INTERVAL_DAYS);
  const eligible = !nextEligible || on >= nextEligible;
  return { eligible, nextEligible };
}
