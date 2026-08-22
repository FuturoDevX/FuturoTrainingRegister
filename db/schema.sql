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
  location_id INTEGER REFERENCES locations(id),  -- hosting centre
  title TEXT NOT NULL,
  session_date TEXT NOT NULL,         -- ISO date
  provider TEXT,
  hours REAL NOT NULL,
  notes TEXT,
  -- When set, educators from any centre may attend, not just the hosting centre's staff.
  -- Attendance is still marked per-centre: each centre manager only ever marks their own
  -- staff's attendance, even for a session hosted elsewhere (see routes/training.js).
  all_centres INTEGER NOT NULL DEFAULT 0,
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

-- Which NQS (National Quality Standard) elements a session is linked to, if any — see
-- services/nqs.js for the reference list element_code validates against. Optional,
-- many-to-many (a session can cover several elements).
CREATE TABLE IF NOT EXISTS training_session_nqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES training_sessions(id),
  element_code TEXT NOT NULL,         -- e.g. '1.1.1'
  UNIQUE(session_id, element_code)
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

-- Who did what, when — accountability trail for anything that changes data (sessions,
-- attendance, logins, exports). Distinct from sync_log, which is EH-sync-specific detail.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_email TEXT,                   -- NULL for unattended actions (e.g. nightly cron sync)
  actor_role TEXT,
  action TEXT NOT NULL,               -- short label, e.g. 'session.create'
  detail TEXT
);

-- ==========================================================================
-- Phase 2: Individual Development Plans (IDPs)
-- Adds structure the training side didn't need: rooms within a centre, a
-- development-role per person (Ed/RL/EL/ACM/CM), and org-level role holders.
-- Together these let the "who supports this person's development" chain be
-- derived automatically rather than entered per IDP. See services/responsibility.js.
-- (The staff.room_id and staff.dev_role columns are added in db/migrate.js.)
-- ==========================================================================

-- Rooms within a centre. Each room designates its Room Leader and Educational
-- Leader (both staff members); an educator's RL/EL are derived from their room.
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  name TEXT NOT NULL,
  room_leader_staff_id INTEGER REFERENCES staff(id),
  ed_leader_staff_id INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(location_id, name)
);

-- Org-wide role holders that aren't centre-scoped (Operations Manager, General
-- Manager, Quality & Compliance) — one designated staff member each, set by Admin.
-- These sit at the top of several responsibility chains (e.g. a CM's supporters
-- are OM + GM). role is the key so there's exactly one holder per role.
CREATE TABLE IF NOT EXISTS org_roles (
  role TEXT PRIMARY KEY CHECK (role IN ('om','gm','qc')),
  staff_id INTEGER REFERENCES staff(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An Individual Development Plan for one staff member. Design decision (confirmed):
-- one "living" IDP per person at a time, reviewed on a cycle (review_date). A person
-- can accumulate completed IDPs over time as history, but only one draft/active at once.
-- Reporting counts only IDPs belonging to ACTIVE staff, so a terminated person's plan
-- naturally drops out of the numbers without extra archival machinery.
CREATE TABLE IF NOT EXISTS idps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed')),
  focus TEXT,                          -- short overall summary of what this plan is about
  review_date TEXT,                    -- next review due (ISO date); drives overdue reporting
  -- 'auto' derives supporters live from room/centre/org structure (the default and the
  -- whole point of the responsibility engine); 'manual' uses the idp_supporters rows
  -- instead, for the occasional case that doesn't fit the standard chain.
  supporters_mode TEXT NOT NULL DEFAULT 'auto' CHECK (supporters_mode IN ('auto','manual')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- SMART goals belonging to an IDP. Each goal carries the five SMART fields, an optional
-- link to an NQS element (reusing services/nqs.js), a running progress note, and its own
-- status independent of the plan's overall status.
CREATE TABLE IF NOT EXISTS idp_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idp_id INTEGER NOT NULL REFERENCES idps(id),
  title TEXT NOT NULL,
  specific TEXT,
  measurable TEXT,
  achievable TEXT,
  relevant TEXT,
  target_date TEXT,                    -- the "time-bound" of SMART
  nqs_element_code TEXT,               -- optional, e.g. '1.3.1'
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','achieved','dropped')),
  progress_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Manual supporter overrides — only consulted when idps.supporters_mode = 'manual'.
CREATE TABLE IF NOT EXISTS idp_supporters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idp_id INTEGER NOT NULL REFERENCES idps(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  UNIQUE(idp_id, staff_id)
);
