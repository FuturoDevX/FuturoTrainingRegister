// Employment Hero (KeyPay-based payroll API) sync — staff/centre roster only.
//
// Deliberately lighter than Dashboard/PMS-App/services/employmentHero.js: no pay-rate
// lookups, and casual staff are NOT excluded (training/compliance sessions generally
// apply to everyone at a centre, unlike PMS-App's permanent-only people-management scope).
//
// Follows the same auth/endpoint pattern already validated in
// Dashboard/_pipeline/employment_hero/eh_payroll_client.py and Dashboard/PMS-App:
//   - HTTP Basic Auth, API key as username, password left blank
//   - GET {base_url}/api/v2/business/{business_id}/report/employeedetails
//   - The first record in the response is a fake "header echo" row — skip it
//
// Not run against the live API from this session (no network access to Employment Hero
// here) — test against a real EH sandbox/business before relying on it in production.

const db = require("../db/db");

const LOCATION_MAP = [
  { match: /gwh/i, name: "GWH" },
  { match: /austral/i, name: "Austral" },
  { match: /bardia/i, name: "Bardia" },
  { match: /heath rd/i, name: "LHR" },
];

function mapLocation(primaryLocation) {
  if (!primaryLocation) return "Other/HQ";
  const hit = LOCATION_MAP.find((m) => m.match.test(primaryLocation));
  return hit ? hit.name : "Other/HQ";
}

function pascalToSpaced(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function looksLikeHeaderRow(record) {
  const entries = Object.entries(record);
  if (entries.length === 0) return false;
  const matches = entries.filter(
    ([key, value]) => typeof value === "string" && value.trim().toLowerCase() === pascalToSpaced(key).trim()
  ).length;
  return matches >= Math.max(1, Math.floor(entries.length / 2));
}

async function fetchEmployeeDetails() {
  const { EH_API_KEY, EH_BASE_URL, EH_BUSINESS_ID } = process.env;
  if (!EH_API_KEY || !EH_BASE_URL || !EH_BUSINESS_ID) {
    throw new Error("Missing EH_API_KEY / EH_BASE_URL / EH_BUSINESS_ID in .env — see .env.example");
  }

  const params = new URLSearchParams();
  params.append("includeActive", "true");
  params.append("includeInactive", "true");
  ["EmployeeId", "FirstName", "Surname", "Email", "PrimaryLocation", "JobTitle", "TerminationDate"]
    .forEach((col) => params.append("selectedColumns", col));

  const url = `${EH_BASE_URL}/api/v2/business/${EH_BUSINESS_ID}/report/employeedetails?${params.toString()}`;

  const auth = Buffer.from(`${EH_API_KEY}:`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Employment Hero API error: ${res.status} ${res.statusText}`);

  const data = await res.json();
  const records = Array.isArray(data) ? data : data.records || [];
  return records.filter((r) => !looksLikeHeaderRow(r));
}

function upsertStaff(record) {
  const locationName = mapLocation(record.PrimaryLocation);
  const location = db.prepare("SELECT id FROM locations WHERE name = ?").get(locationName);
  const status = record.TerminationDate ? "archived" : "active";
  const fullName = [record.FirstName, record.Surname].filter(Boolean).join(" ");

  db.prepare(`
    INSERT INTO staff (employee_id, full_name, email, location_id, position_title, status)
    VALUES (@employee_id, @full_name, @email, @location_id, @position_title, @status)
    ON CONFLICT(employee_id) DO UPDATE SET
      full_name = excluded.full_name,
      email = excluded.email,
      location_id = excluded.location_id,
      position_title = excluded.position_title,
      status = excluded.status,
      updated_at = datetime('now')
  `).run({
    employee_id: String(record.EmployeeId),
    full_name: fullName,
    email: record.Email || "",
    location_id: location ? location.id : null,
    position_title: record.JobTitle || null,
    status,
  });
}

async function runSync() {
  let staffSynced = 0;
  try {
    const records = await fetchEmployeeDetails();
    for (const record of records) {
      if (!record.EmployeeId) continue;
      upsertStaff(record);
      staffSynced++;
    }
    db.prepare("INSERT INTO sync_log (source, status, staff_synced, detail) VALUES ('employment_hero', 'success', ?, ?)")
      .run(staffSynced, `Synced ${staffSynced} staff record(s).`);
    return { ok: true, staffSynced };
  } catch (err) {
    db.prepare("INSERT INTO sync_log (source, status, staff_synced, detail) VALUES ('employment_hero', 'error', 0, ?)")
      .run(err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { runSync, mapLocation };
