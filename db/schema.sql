-- Futuro Training Tracker — standalone light app schema.
-- Deliberately small: just enough to track who ran what training, who attended,
-- and to pull a report per centre or per person. No pay, no check-ins, no reward logic
-- — that all lives in the separate PMS-App.

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,          -- e.g. 'GWH', 'Bardia', 'Austral', 'LHR'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- All active staff (not just permanent) — training/compliance sessions generally apply
-- to casuals too, unlike PMS-App's permanent-only scope. See services/employmentHero.js.
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL UNIQUE,   -- Employment Hero Employee ID (join key)
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  location_id INTEGER REFERENCES locations(id),
  position_title TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Login accounts: Admin (all centres) or Centre Manager (own centre only).
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','centre_manager')),
  location_id INTEGER REFERENCES locations(id), -- required for centre_manager, NULL for admin
  full_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER REFERENCES locations(id),
  title TEXT NOT NULL,
  session_date TEXT NOT NULL,         -- ISO date
  provider TEXT,
  hours REAL NOT NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES training_sessions(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  attended INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, staff_id)
);

-- Records each Employment Hero sync run, so Admin can see when it last ran and whether it worked.
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,               -- 'employment_hero'
  status TEXT NOT NULL,               -- 'success' | 'error'
  staff_synced INTEGER DEFAULT 0,
  detail TEXT
);
