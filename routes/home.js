const express = require("express");
const db = require("../db/db");
const { requireLogin, scopedLocationId } = require("../middleware/auth");

const router = express.Router();

const today = () => new Date().toISOString().slice(0, 10);

// The "latest IDP per person" subquery, reused across the dashboard counts.
const LATEST_IDP = "(SELECT id FROM idps WHERE staff_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1)";
// Non-casual active staff — the population IDPs apply to (matches the reporting rules).
const IDP_POP = "s.status = 'active' AND IFNULL(s.employment_type, '') != 'casual' AND IFNULL(s.dev_role, '') != 'non_contact'";

router.get("/home", requireLogin, (req, res) => {
  const scoped = scopedLocationId(req);
  if (scoped) return renderCentreHome(req, res, scoped);
  return renderAdminHome(req, res);
});

function renderCentreHome(req, res, centreId) {
  const centre = db.prepare("SELECT * FROM locations WHERE id = ?").get(centreId);

  const total = db.prepare(`SELECT COUNT(*) c FROM staff s WHERE s.location_id = ? AND ${IDP_POP}`).get(centreId).c;
  const active = db.prepare(`
    SELECT COUNT(*) c FROM staff s JOIN idps cur ON cur.id = ${LATEST_IDP}
    WHERE s.location_id = ? AND ${IDP_POP} AND cur.status = 'active'
  `).get(centreId).c;
  const overdue = db.prepare(`
    SELECT COUNT(*) c FROM staff s JOIN idps cur ON cur.id = ${LATEST_IDP}
    WHERE s.location_id = ? AND ${IDP_POP} AND cur.status = 'active'
      AND cur.review_date IS NOT NULL AND cur.review_date < ?
  `).get(centreId, today()).c;
  const noPlan = db.prepare(`
    SELECT COUNT(*) c FROM staff s LEFT JOIN idps cur ON cur.id = ${LATEST_IDP}
    WHERE s.location_id = ? AND ${IDP_POP} AND (cur.id IS NULL OR cur.status = 'completed')
  `).get(centreId).c;
  // Draft plans are real work-in-progress but count as neither "active" (coverage) nor
  // "no plan" — surfaced separately so they don't silently vanish from the dashboard.
  const draft = db.prepare(`
    SELECT COUNT(*) c FROM staff s JOIN idps cur ON cur.id = ${LATEST_IDP}
    WHERE s.location_id = ? AND ${IDP_POP} AND cur.status = 'draft'
  `).get(centreId).c;
  const awaitingAttendance = db.prepare(`
    SELECT COUNT(*) c FROM training_sessions t
    WHERE t.location_id = ? AND NOT EXISTS (SELECT 1 FROM training_attendance a WHERE a.session_id = t.id)
  `).get(centreId).c;
  const rooms = db.prepare("SELECT COUNT(*) c FROM rooms WHERE location_id = ?").get(centreId).c;
  const hours = db.prepare(`
    SELECT COALESCE(SUM(t.hours), 0) h FROM training_attendance a
    JOIN training_sessions t ON t.id = a.session_id
    JOIN staff s ON s.id = a.staff_id
    WHERE a.attended = 1 AND s.location_id = ?
  `).get(centreId).h;

  res.render("home-centre", {
    centre,
    stats: { total, active, draft, coverage: total ? Math.round((active / total) * 100) : 0, rooms, hours },
    attention: { overdue, noPlan, draft, awaitingAttendance },
  });
}

function renderAdminHome(req, res) {
  const centres = db.prepare(`
    SELECT l.id, l.name,
      COUNT(s.id) AS total,
      SUM(CASE WHEN cur.status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN cur.status = 'draft' THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN cur.id IS NULL THEN 1 ELSE 0 END) AS none_count
    FROM locations l
    JOIN staff s ON s.location_id = l.id AND ${IDP_POP}
    LEFT JOIN idps cur ON cur.id = ${LATEST_IDP}
    WHERE l.name != 'Other/HQ'
    GROUP BY l.id ORDER BY l.name
  `).all();
  let total = 0, active = 0, draftTotal = 0;
  for (const c of centres) { total += c.total; active += c.active; draftTotal += c.draft; c.pct = c.total ? Math.round((c.active / c.total) * 100) : 0; }

  // Org-wide "what needs attention", mirroring the Centre Manager home so the widest-view
  // user gets at least as useful a dashboard (previously the Admin home had none).
  const attention = {
    overdue: db.prepare(`
      SELECT COUNT(*) c FROM staff s JOIN idps cur ON cur.id = ${LATEST_IDP}
      WHERE ${IDP_POP} AND cur.status = 'active' AND cur.review_date IS NOT NULL AND cur.review_date < ?
    `).get(today()).c,
    draft: draftTotal,
    noPlan: db.prepare(`
      SELECT COUNT(*) c FROM staff s LEFT JOIN idps cur ON cur.id = ${LATEST_IDP}
      WHERE ${IDP_POP} AND (cur.id IS NULL OR cur.status = 'completed')
    `).get().c,
    awaitingAttendance: db.prepare(`
      SELECT COUNT(*) c FROM training_sessions t
      WHERE NOT EXISTS (SELECT 1 FROM training_attendance a WHERE a.session_id = t.id)
    `).get().c,
  };

  // Training pulse — the app is a Training Tracker, so the org home should show training,
  // not only development metrics.
  const training = {
    hours: db.prepare(`
      SELECT COALESCE(SUM(t.hours), 0) h FROM training_attendance a
      JOIN training_sessions t ON t.id = a.session_id WHERE a.attended = 1
    `).get().h,
    sessions: db.prepare("SELECT COUNT(*) c FROM training_sessions").get().c,
    recent: db.prepare(`
      SELECT t.id, t.title, t.session_date, t.hours, l.name AS location_name,
        (SELECT COUNT(*) FROM training_attendance a WHERE a.session_id = t.id AND a.attended = 1) AS attended_count,
        EXISTS (SELECT 1 FROM training_attendance a WHERE a.session_id = t.id) AS marked
      FROM training_sessions t LEFT JOIN locations l ON l.id = t.location_id
      ORDER BY t.session_date DESC, t.id DESC LIMIT 5
    `).all(),
  };

  const lastSync = db.prepare("SELECT * FROM sync_log ORDER BY run_at DESC LIMIT 1").get();

  res.render("home-admin", {
    org: { total, active, draft: draftTotal, coverage: total ? Math.round((active / total) * 100) : 0 },
    centres,
    attention,
    training,
    lastSync,
  });
}

module.exports = router;
