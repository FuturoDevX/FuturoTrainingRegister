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
