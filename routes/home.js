const express = require("express");
const db = require("../db/db");
const { requireLogin, scopedLocationId } = require("../middleware/auth");

const router = express.Router();

const today = () => new Date().toISOString().slice(0, 10);

// The "latest IDP per person" subquery, reused across the dashboard counts.
const LATEST_IDP = "(SELECT id FROM idps WHERE staff_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1)";
// Non-casual active staff — the population IDPs apply to (matches the reporting rules).
const IDP_POP = "s.status = 'active' AND IFNULL(s.employment_type, '') != 'casual'";

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
    stats: { total, active, coverage: total ? Math.round((active / total) * 100) : 0, rooms, hours },
    attention: { overdue, noPlan, awaitingAttendance },
  });
}

function renderAdminHome(req, res) {
  const centres = db.prepare(`
    SELECT l.id, l.name,
      COUNT(s.id) AS total,
      SUM(CASE WHEN cur.status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN cur.id IS NULL THEN 1 ELSE 0 END) AS none_count
    FROM locations l
    JOIN staff s ON s.location_id = l.id AND ${IDP_POP}
    LEFT JOIN idps cur ON cur.id = ${LATEST_IDP}
    WHERE l.name != 'Other/HQ'
    GROUP BY l.id ORDER BY l.name
  `).all();
  let total = 0, active = 0;
  for (const c of centres) { total += c.total; active += c.active; c.pct = c.total ? Math.round((c.active / c.total) * 100) : 0; }

  const lastSync = db.prepare("SELECT * FROM sync_log ORDER BY run_at DESC LIMIT 1").get();

  res.render("home-admin", {
    org: { total, active, coverage: total ? Math.round((active / total) * 100) : 0 },
    centres,
    lastSync,
  });
}

module.exports = router;
