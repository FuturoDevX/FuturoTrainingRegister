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
