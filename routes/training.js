const express = require("express");
const db = require("../db/db");
const { requireLogin, scopedLocationId } = require("../middleware/auth");

const router = express.Router();

router.get("/training", requireLogin, (req, res) => {
  const locationId = scopedLocationId(req);
  const sessions = locationId
    ? db.prepare("SELECT t.*, l.name AS location_name FROM training_sessions t LEFT JOIN locations l ON l.id = t.location_id WHERE t.location_id = ? ORDER BY t.session_date DESC").all(locationId)
    : db.prepare("SELECT t.*, l.name AS location_name FROM training_sessions t LEFT JOIN locations l ON l.id = t.location_id ORDER BY t.session_date DESC").all();

  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  res.render("training-list", { sessions, scoped: !!locationId, locations });
});

router.post("/training", requireLogin, (req, res) => {
  // A Centre Manager's own centre is used automatically; Admin must pick one from the form.
  const locationId = scopedLocationId(req) || (req.body.location_id ? parseInt(req.body.location_id, 10) : null);
  if (!locationId) {
    return res.status(400).render("error", { message: "A centre is required to create a training session." });
  }
  db.prepare(`
    INSERT INTO training_sessions (location_id, title, session_date, provider, hours, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(locationId, req.body.title, req.body.session_date, req.body.provider || null, parseFloat(req.body.hours), req.body.notes || null, req.session.user.id);
  res.redirect("/training");
});

router.get("/training/:id/attendance", requireLogin, (req, res) => {
  const session = db.prepare("SELECT t.*, l.name AS location_name FROM training_sessions t LEFT JOIN locations l ON l.id = t.location_id WHERE t.id = ?").get(req.params.id);
  if (!session) return res.status(404).render("error", { message: "Training session not found." });

  const locationId = scopedLocationId(req);
  if (locationId && session.location_id !== locationId) {
    return res.status(403).render("error", { message: "You can only manage attendance for your own centre." });
  }

  const staff = db.prepare("SELECT * FROM staff WHERE status = 'active' AND location_id = ? ORDER BY full_name").all(session.location_id);
  const attendance = db.prepare("SELECT staff_id, attended FROM training_attendance WHERE session_id = ?").all(session.id);
  const attendedSet = new Set(attendance.filter((a) => a.attended).map((a) => a.staff_id));

  res.render("training-attendance", { session, staff, attendedSet });
});

router.post("/training/:id/attendance", requireLogin, (req, res) => {
  const session = db.prepare("SELECT * FROM training_sessions WHERE id = ?").get(req.params.id);
  if (!session) return res.status(404).render("error", { message: "Training session not found." });

  const locationId = scopedLocationId(req);
  if (locationId && session.location_id !== locationId) {
    return res.status(403).render("error", { message: "You can only manage attendance for your own centre." });
  }

  const attendedIds = new Set([].concat(req.body.attended || []).map(Number));
  const staff = db.prepare("SELECT id FROM staff WHERE status = 'active' AND location_id = ?").all(session.location_id);

  const upsert = db.prepare(`
    INSERT INTO training_attendance (session_id, staff_id, attended) VALUES (?, ?, ?)
    ON CONFLICT(session_id, staff_id) DO UPDATE SET attended = excluded.attended
  `);
  const txn = db.transaction(() => {
    for (const s of staff) upsert.run(session.id, s.id, attendedIds.has(s.id) ? 1 : 0);
  });
  txn();

  res.redirect("/training");
});

module.exports = router;
