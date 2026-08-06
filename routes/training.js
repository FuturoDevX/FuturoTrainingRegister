const express = require("express");
const db = require("../db/db");
const { requireLogin, scopedLocationId } = require("../middleware/auth");
const { setFlash } = require("../middleware/flash");
const nqs = require("../services/nqs");

const router = express.Router();

// Attaches an `nqs` array (e.g. [{code:'1.1.1', name:'...'}]) to each session, in one
// query rather than N+1 — fine at this app's scale (a handful of sessions per centre).
function attachNqsLinks(sessions) {
  if (sessions.length === 0) return sessions;
  const ids = sessions.map((s) => s.id);
  const placeholders = ids.map(() => "?").join(",");
  const links = db.prepare(`SELECT session_id, element_code FROM training_session_nqs WHERE session_id IN (${placeholders})`).all(...ids);
  const bySession = new Map();
  for (const link of links) {
    if (!bySession.has(link.session_id)) bySession.set(link.session_id, []);
    bySession.get(link.session_id).push({ code: link.element_code, name: nqs.ELEMENTS_BY_CODE.get(link.element_code)?.name || link.element_code });
  }
  for (const s of sessions) s.nqs = bySession.get(s.id) || [];
  return sessions;
}

function saveNqsLinks(sessionId, submitted) {
  const codes = [...new Set([].concat(submitted || []))].filter(nqs.isValidElementCode);
  if (codes.length === 0) return;
  const insert = db.prepare("INSERT OR IGNORE INTO training_session_nqs (session_id, element_code) VALUES (?, ?)");
  const txn = db.transaction(() => { for (const code of codes) insert.run(sessionId, code); });
  txn();
}

router.get("/training", requireLogin, (req, res) => {
  const locationId = scopedLocationId(req);
  // A Centre Manager sees sessions hosted at their own centre, plus any session open to
  // all centres regardless of where it's hosted (they can still be invited to attend/mark
  // their own staff there — see the attendance routes below).
  const sessions = locationId
    ? db.prepare(`
        SELECT t.*, l.name AS location_name FROM training_sessions t
        LEFT JOIN locations l ON l.id = t.location_id
        WHERE t.location_id = ? OR t.all_centres = 1
        ORDER BY t.session_date DESC
      `).all(locationId)
    : db.prepare("SELECT t.*, l.name AS location_name FROM training_sessions t LEFT JOIN locations l ON l.id = t.location_id ORDER BY t.session_date DESC").all();
  attachNqsLinks(sessions);

  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  res.render("training-list", { sessions, scoped: !!locationId, locations, qualityAreas: nqs.QUALITY_AREAS });
});

router.post("/training", requireLogin, (req, res) => {
  // A Centre Manager's own centre is used automatically as the hosting centre; Admin
  // must pick one from the form.
  const locationId = scopedLocationId(req) || (req.body.location_id ? parseInt(req.body.location_id, 10) : null);
  if (!locationId) {
    return res.status(400).render("error", { message: "A centre is required to create a training session." });
  }
  const allCentres = req.body.all_centres ? 1 : 0;
  const result = db.prepare(`
    INSERT INTO training_sessions (location_id, title, session_date, provider, hours, notes, created_by, all_centres)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(locationId, req.body.title, req.body.session_date, req.body.provider || null, parseFloat(req.body.hours), req.body.notes || null, req.session.user.id, allCentres);
  saveNqsLinks(result.lastInsertRowid, req.body.nqs_elements);
  setFlash(req, "success", `"${req.body.title}" created.`);
  res.redirect("/training");
});

// Which centre's staff roster is being marked for attendance on this session. A Centre
// Manager always marks their own centre's staff, even when the session is hosted
// elsewhere (all_centres=1) — that's the whole point of "open to all centres": each
// centre's own manager is still the one who marks their own educators. Admin can switch
// between centres via ?centre=/location_id, defaulting to the hosting centre.
function resolveViewLocationId(req, session, scoped) {
  if (scoped) return scoped;
  const requested = req.method === "GET" ? req.query.centre : req.body.location_id;
  return requested ? parseInt(requested, 10) : session.location_id;
}

router.get("/training/:id/attendance", requireLogin, (req, res) => {
  const session = db.prepare("SELECT t.*, l.name AS location_name FROM training_sessions t LEFT JOIN locations l ON l.id = t.location_id WHERE t.id = ?").get(req.params.id);
  if (!session) return res.status(404).render("error", { message: "Training session not found." });

  const scoped = scopedLocationId(req);
  // A single-centre session is locked to its own centre's manager, same as before.
  // An all-centres session is open to every manager — each still only sees/marks their
  // own centre's staff, enforced below by scoping the staff query to viewLocationId.
  if (!session.all_centres && scoped && session.location_id !== scoped) {
    return res.status(403).render("error", { message: "You can only manage attendance for your own centre." });
  }

  const viewLocationId = resolveViewLocationId(req, session, scoped);
  const viewLocation = db.prepare("SELECT * FROM locations WHERE id = ?").get(viewLocationId);

  const staff = db.prepare("SELECT * FROM staff WHERE status = 'active' AND location_id = ? ORDER BY full_name").all(viewLocationId);
  const attendance = db.prepare("SELECT staff_id, attended FROM training_attendance WHERE session_id = ?").all(session.id);
  const attendedSet = new Set(attendance.filter((a) => a.attended).map((a) => a.staff_id));

  // Admin viewing an all-centres session gets a per-centre attendance summary, so they
  // can see at a glance which centres still need to mark their staff.
  let centreSummary = null;
  if (session.all_centres && !scoped) {
    centreSummary = db.prepare(`
      SELECT l.id, l.name,
        COUNT(DISTINCT s.id) AS staff_count,
        COUNT(DISTINCT CASE WHEN a.attended = 1 THEN a.staff_id END) AS attended_count
      FROM locations l
      LEFT JOIN staff s ON s.location_id = l.id AND s.status = 'active'
      LEFT JOIN training_attendance a ON a.staff_id = s.id AND a.session_id = ?
      WHERE l.name != 'Other/HQ'
      GROUP BY l.id
      ORDER BY l.name
    `).all(session.id);
  }

  const locations = db.prepare("SELECT * FROM locations WHERE name != 'Other/HQ' ORDER BY name").all();
  attachNqsLinks([session]);

  res.render("training-attendance", { session, staff, attendedSet, viewLocation, locations, centreSummary, isAdmin: !scoped });
});

router.post("/training/:id/attendance", requireLogin, (req, res) => {
  const session = db.prepare("SELECT * FROM training_sessions WHERE id = ?").get(req.params.id);
  if (!session) return res.status(404).render("error", { message: "Training session not found." });

  const scoped = scopedLocationId(req);
  if (!session.all_centres && scoped && session.location_id !== scoped) {
    return res.status(403).render("error", { message: "You can only manage attendance for your own centre." });
  }

  const viewLocationId = resolveViewLocationId(req, session, scoped);
  const attendedIds = new Set([].concat(req.body.attended || []).map(Number));
  // Scoped to viewLocationId's staff only — this is what keeps a manager's submission
  // from touching another centre's already-recorded attendance on the same session.
  const staff = db.prepare("SELECT id FROM staff WHERE status = 'active' AND location_id = ?").all(viewLocationId);

  const upsert = db.prepare(`
    INSERT INTO training_attendance (session_id, staff_id, attended) VALUES (?, ?, ?)
    ON CONFLICT(session_id, staff_id) DO UPDATE SET attended = excluded.attended
  `);
  let markedCount = 0;
  const txn = db.transaction(() => {
    for (const s of staff) {
      const attended = attendedIds.has(s.id);
      if (attended) markedCount++;
      upsert.run(session.id, s.id, attended ? 1 : 0);
    }
  });
  txn();

  const viewLocation = db.prepare("SELECT name FROM locations WHERE id = ?").get(viewLocationId);
  setFlash(req, "success", `Attendance saved for ${viewLocation ? viewLocation.name : "this centre"} (${markedCount} of ${staff.length} marked attended).`);

  if (session.all_centres && !scoped) {
    return res.redirect(`/training/${session.id}/attendance?centre=${viewLocationId}`);
  }
  res.redirect("/training");
});

module.exports = router;
