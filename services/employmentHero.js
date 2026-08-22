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
// Verified against the live API: `PrimaryLocation` (the report column used here) and
// `primaryLocation` on the full employee record both echo EH's real Location hierarchy
// (GET /business/{id}/location — Futuro Early Learning > Futuro GWH > GWH Room 1, etc.),
// not a payroll cost centre — there is no separate cost-centre field anywhere on the
// employee record. Confirmed 2026-08-07.

const db = require("../db/db");

const LOCATION_MAP = [
  { match: /gwh/i, name: "GWH" },
  { match: /austral/i, name: "Austral" },
  { match: /bardia/i, name: "Bardia" },
  { match: /heath rd/i, name: "LHR" },
  { match: /oran park/i, name: "Oran Park" },
  { match: /cobbitty/i, name: "Cobbitty" },
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

  // includeInactive stays true deliberately — this is how a termination gets picked up
  // at all (see runSync/upsertStaff below for how that turns into status='archived' and
  // drops the person out of every active-staff screen).
  const params = new URLSearchParams();
  params.append("includeActive", "true");
  params.append("includeInactive", "true");
  ["EmployeeId", "FirstName", "Surname", "Email", "PrimaryLocation", "JobTitle", "TerminationDate", "PayRateTemplate"]
    .forEach((col) => params.append("selectedColumns", col));

  const url = `${EH_BASE_URL}/api/v2/business/${EH_BUSINESS_ID}/report/employeedetails?${params.toString()}`;

  const auth = Buffer.from(`${EH_API_KEY}:`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Employment Hero API error: ${res.status} ${res.statusText}`);

  const data = await res.json();
  const records = Array.isArray(data) ? data : data.records || [];
  return records.filter((r) => !looksLikeHeaderRow(r));
}

// Derive permanent/casual from the PayRateTemplate string — the reliable signal (validated
// in PMS-App), e.g. "Permanent CSE Level 5..." vs "Casual CSE Level 5...". Returns null
// when neither word is present, so the caller can leave it unknown rather than guess (an
// unknown is treated as NOT casual — better to include than to wrongly hide from IDPs).
function classifyEmployment(payRateTemplate) {
  const t = payRateTemplate || "";
  if (/casual/i.test(t)) return "casual";
  if (/permanent/i.test(t)) return "permanent";
  return null;
}

function upsertStaff(record) {
  const locationName = mapLocation(record.PrimaryLocation);
  const location = db.prepare("SELECT id FROM locations WHERE name = ?").get(locationName);
  const status = record.TerminationDate ? "archived" : "active";
  const fullName = [record.FirstName, record.Surname].filter(Boolean).join(" ");
  const employmentType = classifyEmployment(record.PayRateTemplate);

  // employment_type uses COALESCE(excluded, existing) so a sync that can't classify someone
  // (null) never wipes a value a previous sync already resolved.
  db.prepare(`
    INSERT INTO staff (employee_id, full_name, email, location_id, position_title, employment_type, status)
    VALUES (@employee_id, @full_name, @email, @location_id, @position_title, @employment_type, @status)
    ON CONFLICT(employee_id) DO UPDATE SET
      full_name = excluded.full_name,
      email = excluded.email,
      location_id = excluded.location_id,
      position_title = excluded.position_title,
      employment_type = COALESCE(excluded.employment_type, staff.employment_type),
      status = excluded.status,
      updated_at = datetime('now')
  `).run({
    employee_id: String(record.EmployeeId),
    full_name: fullName,
    email: record.Email || "",
    location_id: location ? location.id : null,
    position_title: record.JobTitle || null,
    employment_type: employmentType,
    status,
  });

  return status;
}

async function runSync() {
  // Employment Hero's report is fetched with includeInactive=true so a termination is
  // still picked up and the person's status flips to 'archived' (every staff query in
  // routes/training.js and routes/report.js already filters to status='active', so an
  // archived person immediately stops appearing in session/attendance/report screens).
  // What's counted and shown here is active staff only — the raw upsert count (which
  // includes archived/terminated staff still being kept in sync) was misleadingly large.
  let activeSynced = 0;
  let archivedSynced = 0;
  try {
    const records = await fetchEmployeeDetails();
    for (const record of records) {
      if (!record.EmployeeId) continue;
      const status = upsertStaff(record);
      if (status === "active") activeSynced++; else archivedSynced++;
    }
    const detail = `Synced ${activeSynced} active staff record(s)` + (archivedSynced ? ` (${archivedSynced} terminated/archived, excluded from every screen).` : ".");
    db.prepare("INSERT INTO sync_log (source, status, staff_synced, detail) VALUES ('employment_hero', 'success', ?, ?)")
      .run(activeSynced, detail);
    return { ok: true, staffSynced: activeSynced, archivedSynced };
  } catch (err) {
    db.prepare("INSERT INTO sync_log (source, status, staff_synced, detail) VALUES ('employment_hero', 'error', 0, ?)")
      .run(err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { runSync, mapLocation };
