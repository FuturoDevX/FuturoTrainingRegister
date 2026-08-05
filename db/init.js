// Creates the schema (if not already present) and seeds:
//  - Futuro's 4 known centres + an Other/HQ bucket
//  - One Admin login (from .env — change the password after first login)
//  - One demo Centre Manager login per centre, for testing location-scoping
//  - A handful of clearly-fake DEMO staff and training sessions, so the app is usable
//    before the real Employment Hero sync is wired up with live credentials.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const db = require("./db");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

const locations = ["GWH", "Bardia", "Austral", "LHR", "Other/HQ"];
const insertLocation = db.prepare("INSERT OR IGNORE INTO locations (name) VALUES (?)");
for (const loc of locations) insertLocation.run(loc);

const getLocationId = (name) => db.prepare("SELECT id FROM locations WHERE name = ?").get(name).id;

// Admin account
const adminEmail = process.env.ADMIN_EMAIL || "admin@futuro.nsw.edu.au";
const existingAdmin = db.prepare("SELECT id FROM users WHERE email = ?").get(adminEmail);
if (!existingAdmin) {
  const hash = bcrypt.hashSync(process.env.ADMIN_DEFAULT_PASSWORD || "ChangeMe123!", 10);
  db.prepare(
    "INSERT INTO users (email, password_hash, role, location_id, full_name) VALUES (?, ?, 'admin', NULL, ?)"
  ).run(adminEmail, hash, "Christo Kruger");
  console.log(`Created Admin account: ${adminEmail} — CHANGE THE DEFAULT PASSWORD AFTER FIRST LOGIN.`);
} else {
  console.log(`Admin account already exists: ${adminEmail}`);
}

// One demo Centre Manager per centre, so location-scoping can be tested immediately.
const demoManagerPassword = bcrypt.hashSync("Demo1234!", 10);
const insertUser = db.prepare(
  "INSERT OR IGNORE INTO users (email, password_hash, role, location_id, full_name) VALUES (?, ?, 'centre_manager', ?, ?)"
);
for (const loc of ["GWH", "Bardia", "Austral", "LHR"]) {
  insertUser.run(
    `cm.${loc.toLowerCase()}@futuro.nsw.edu.au`,
    demoManagerPassword,
    getLocationId(loc),
    `${loc} Centre Manager (demo)`
  );
}

// DEMO staff only — clearly fictional, standing in until the real Employment Hero sync
// (services/employmentHero.js) is run with live credentials.
const demoStaff = [
  ["GWH", "Ava Thompson", "Qualified Educator"],
  ["GWH", "Noah Bennett", "Advanced Educator"],
  ["GWH", "Mia Chen", "Room Leader"],
  ["Bardia", "Liam Carter", "Room Leader"],
  ["Bardia", "Zoe Nguyen", "Qualified Educator"],
  ["Austral", "Ethan Walker", "Experienced Educator"],
  ["Austral", "Grace Patel", "Assistant Director"],
  ["LHR", "Jack Wilson", "Introductory Educator"],
  ["LHR", "Sophie Martin", "Advanced Educator"],
];

const insertStaff = db.prepare(`
  INSERT OR IGNORE INTO staff (employee_id, full_name, email, location_id, position_title, status)
  VALUES (@employee_id, @full_name, @email, @location_id, @position_title, 'active')
`);

demoStaff.forEach(([loc, name, title], i) => {
  const emailName = name.toLowerCase().replace(/\s+/g, ".");
  insertStaff.run({
    employee_id: `DEMO-${1000 + i}`,
    full_name: name,
    email: `${emailName}@futuro.nsw.edu.au`,
    location_id: getLocationId(loc),
    position_title: title,
  });
});

// A couple of demo training sessions with attendance, so reports have something to show.
const existingSession = db.prepare("SELECT id FROM training_sessions LIMIT 1").get();
if (!existingSession) {
  const insertSession = db.prepare(`
    INSERT INTO training_sessions (location_id, title, session_date, provider, hours, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertAttendance = db.prepare(`
    INSERT INTO training_attendance (session_id, staff_id, attended) VALUES (?, ?, 1)
  `);

  const gwhId = getLocationId("GWH");
  const s1 = insertSession.run(gwhId, "First Aid & CPR Refresher", "2026-06-10", "Australian Red Cross", 4, "Annual requirement").lastInsertRowid;
  const gwhStaff = db.prepare("SELECT id FROM staff WHERE location_id = ?").all(gwhId);
  gwhStaff.forEach((s) => insertAttendance.run(s1, s.id));

  const s2 = insertSession.run(gwhId, "Child Protection Update", "2026-07-02", "ECEC Compliance Team", 1.5, null).lastInsertRowid;
  gwhStaff.slice(0, 2).forEach((s) => insertAttendance.run(s2, s.id));

  console.log("Seeded 2 demo training sessions with attendance for GWH.");
}

console.log("Database initialised and seeded with demo data.");
console.log("Demo Centre Manager logins: cm.gwh@futuro.nsw.edu.au / cm.bardia@... / cm.austral@... / cm.lhr@... — password: Demo1234!");
