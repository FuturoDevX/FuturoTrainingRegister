// Idempotent — patches databases created before a schema change was added. Safe to
// require on every boot (db/init.js and server.js both do).
const db = require("./db");

const sessionCols = db.prepare("PRAGMA table_info(training_sessions)").all().map((c) => c.name);
if (!sessionCols.includes("all_centres")) {
  db.exec("ALTER TABLE training_sessions ADD COLUMN all_centres INTEGER NOT NULL DEFAULT 0");
  console.log("Migrated: added training_sessions.all_centres");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS training_session_nqs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES training_sessions(id),
    element_code TEXT NOT NULL,
    UNIQUE(session_id, element_code)
  )
`);

// Oran Park and Cobbitty turned up as real centres in Employment Hero's Location
// hierarchy (not present when this app was first seeded) — added to LOCATION_MAP in
// services/employmentHero.js. Insert them here too so a database created before that
// fix picks them up without a full reseed.
const insertLocation = db.prepare("INSERT OR IGNORE INTO locations (name) VALUES (?)");
for (const loc of ["Oran Park", "Cobbitty"]) insertLocation.run(loc);

// Phase 2 (IDPs): a person's room, and their development-role in the responsibility
// hierarchy. dev_role is separate from the free-text position_title synced from EH —
// it's the normalised Ed/RL/EL/ACM/CM classification the responsibility engine keys off,
// auto-suggested from position_title but confirmed by the CM (see services/devRole.js).
const staffCols = db.prepare("PRAGMA table_info(staff)").all().map((c) => c.name);
if (!staffCols.includes("room_id")) {
  db.exec("ALTER TABLE staff ADD COLUMN room_id INTEGER REFERENCES rooms(id)");
  console.log("Migrated: added staff.room_id");
}
if (!staffCols.includes("dev_role")) {
  db.exec("ALTER TABLE staff ADD COLUMN dev_role TEXT"); // 'ed','rl','el','acm','cm' or NULL until set
  console.log("Migrated: added staff.dev_role");
}
// employment_type distinguishes casuals (who are excluded from IDPs/IDP reporting, though
// still included in training) from permanent staff. Derived from EH PayRateTemplate on sync.
if (!staffCols.includes("employment_type")) {
  db.exec("ALTER TABLE staff ADD COLUMN employment_type TEXT");
  console.log("Migrated: added staff.employment_type");
}

// idp_goals.resources — added after idp_goals shipped, so existing databases (which
// already created the table via schema.sql) need the column patched in. schema.sql also
// carries it now for fresh databases; PRAGMA guards this from running twice.
const goalCols = db.prepare("PRAGMA table_info(idp_goals)").all().map((c) => c.name);
if (goalCols.length && !goalCols.includes("resources")) {
  db.exec("ALTER TABLE idp_goals ADD COLUMN resources TEXT");
  console.log("Migrated: added idp_goals.resources");
}

// idps completion/lineage columns — added with the multi-cycle IDP work. Fresh databases
// get them from schema.sql's CREATE; existing ones need the ALTERs. idp_notes is a brand
// new table so schema.sql's CREATE TABLE IF NOT EXISTS covers it everywhere (no ALTER).
const idpCols = db.prepare("PRAGMA table_info(idps)").all().map((c) => c.name);
if (idpCols.length && !idpCols.includes("completed_at")) {
  db.exec("ALTER TABLE idps ADD COLUMN completed_at TEXT");
  console.log("Migrated: added idps.completed_at");
}
if (idpCols.length && !idpCols.includes("carried_from_id")) {
  db.exec("ALTER TABLE idps ADD COLUMN carried_from_id INTEGER REFERENCES idps(id)");
  console.log("Migrated: added idps.carried_from_id");
}
// Reflection-first foundation — a plan captures the person's strengths and aspirations
// alongside its named areas for development (idp_dev_areas, a new table covered by
// schema.sql's CREATE TABLE IF NOT EXISTS), and goals link to an area they address.
if (idpCols.length && !idpCols.includes("strengths")) {
  db.exec("ALTER TABLE idps ADD COLUMN strengths TEXT");
  console.log("Migrated: added idps.strengths");
}
if (idpCols.length && !idpCols.includes("aspirations")) {
  db.exec("ALTER TABLE idps ADD COLUMN aspirations TEXT");
  console.log("Migrated: added idps.aspirations");
}
if (goalCols.length && !goalCols.includes("dev_area_id")) {
  db.exec("ALTER TABLE idp_goals ADD COLUMN dev_area_id INTEGER REFERENCES idp_dev_areas(id)");
  console.log("Migrated: added idp_goals.dev_area_id");
}
if (goalCols.length && !goalCols.includes("horizon")) {
  db.exec("ALTER TABLE idp_goals ADD COLUMN horizon TEXT");
  console.log("Migrated: added idp_goals.horizon");
}
