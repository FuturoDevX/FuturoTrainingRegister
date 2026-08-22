const express = require("express");
const db = require("../db/db");
const { requireLogin, scopedLocationId } = require("../middleware/auth");
const nqs = require("../services/nqs");
const { ROLE_LABEL } = require("../services/devRole");

const router = express.Router();

function staffHours(staffId) {
  return db.prepare(`
    SELECT COALESCE(SUM(t.hours), 0) AS total FROM training_attendance a
    JOIN training_sessions t ON t.id = a.session_id WHERE a.staff_id = ? AND a.attended = 1
  `).get(staffId).total;
}

// IDP coverage aggregates. `groupExpr` groups rows (by centre or by room); each row's
// counts are based on that person's CURRENT (latest) IDP status, plus a "none" bucket for
// people with no IDP at all. Returns rows with a computed coverage % (active / total).
function idpAggregate(groupExpr, joinAndWhere, params) {
  const rows = db.prepare(`
    SELECT ${groupExpr} AS group_id, ${groupExpr === "l.id" ? "l.name" : "COALESCE(r.name, '(no room)')"} AS group_name,
      COUNT(s.id) AS total,
      SUM(CASE WHEN cur.status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN cur.status = 'draft' THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN cur.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN cur.id IS NULL THEN 1 ELSE 0 END) AS none_count
    FROM staff s
    ${joinAndWhere}
    LEFT JOIN idps cur ON cur.id = (SELECT id FROM idps WHERE staff_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1)
    WHERE s.status = 'active' AND IFNULL(s.employment_type, '') != 'casual' ${params.extraWhere || ""}
    GROUP BY ${groupExpr}
    ORDER BY group_name
  `).all(...(params.args || []));
  for (const row of rows) row.pct = row.total ? Math.round((row.active / row.total) * 100) : 0;
  return rows;
}

function sumTotals(rows) {
  const t = { total: 0, active: 0, draft: 0, completed: 0, none_count: 0 };
  for (const r of rows) { t.total += r.total; t.active += r.active; t.draft += r.draft; t.completed += r.completed; t.none_count += r.none_count; }
  t.pct = t.total ? Math.round((t.active / t.total) * 100) : 0;
  return t;
}

// Org-level IDP dashboard (Admin: all centres; CM: straight to their own centre).
router.get("/report/idp", requireLogin, (req, res) => {
  const scoped = scopedLocationId(req);
  if (scoped) return res.redirect(`/report/idp/centre/${scoped}`);

  const centres = idpAggregate("l.id", "JOIN locations l ON l.id = s.location_id", { extraWhere: "AND l.name != 'Other/HQ'" });
  const org = sumTotals(centres);
  res.render("report-idp", { centres, org, activeTab: "idp" });
});

// Centre-level IDP dashboard — broken down by room.
router.get("/report/idp/centre/:id", requireLogin, (req, res) => {
  const locationId = parseInt(req.params.id, 10);
  const scoped = scopedLocationId(req);
  if (scoped && scoped !== locationId) {
    return res.status(403).render("error", { message: "You can only view your own centre's report." });
  }
  const location = db.prepare("SELECT * FROM locations WHERE id = ?").get(locationId);
  if (!location) return res.status(404).render("error", { message: "Centre not found." });

  const rooms = idpAggregate("r.id", "LEFT JOIN rooms r ON r.id = s.room_id", { extraWhere: "AND s.location_id = ?", args: [locationId] });
  const centre = sumTotals(rooms);
  res.render("report-idp-centre", { location, rooms, centre, isAdmin: !scoped, activeTab: "idp" });
});

// Room-level drill-down — the individual educators in one room, each with their IDP
// status and a link through to their full report. roomId of "none" is the unassigned bucket.
router.get("/report/idp/centre/:id/room/:roomId", requireLogin, (req, res) => {
  const locationId = parseInt(req.params.id, 10);
  const scoped = scopedLocationId(req);
  if (scoped && scoped !== locationId) {
    return res.status(403).render("error", { message: "You can only view your own centre's report." });
  }
  const location = db.prepare("SELECT * FROM locations WHERE id = ?").get(locationId);
  if (!location) return res.status(404).render("error", { message: "Centre not found." });

  let room = null, roomFilter, args;
  if (req.params.roomId === "none") {
    roomFilter = "AND s.room_id IS NULL";
    args = [locationId];
  } else {
    room = db.prepare("SELECT * FROM rooms WHERE id = ? AND location_id = ?").get(parseInt(req.params.roomId, 10), locationId);
    if (!room) return res.status(404).render("error", { message: "Room not found." });
    roomFilter = "AND s.room_id = ?";
    args = [locationId, room.id];
  }

  const people = db.prepare(`
    SELECT s.id, s.full_name, s.dev_role,
      cur.status AS idp_status, cur.review_date,
      (SELECT COUNT(*) FROM idp_goals g WHERE g.idp_id = cur.id) AS goal_count
    FROM staff s
    LEFT JOIN idps cur ON cur.id = (SELECT id FROM idps WHERE staff_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1)
    WHERE s.location_id = ? AND s.status = 'active' AND IFNULL(s.employment_type, '') != 'casual' ${roomFilter}
    ORDER BY s.full_name
  `).all(...args);
  const today = new Date().toISOString().slice(0, 10);
  for (const p of people) {
    p.role_label = p.dev_role ? ROLE_LABEL[p.dev_role] : null;
    p.overdue = p.idp_status === "active" && p.review_date && p.review_date < today;
  }
  res.render("report-idp-room", { location, roomLabel: room ? room.name : "(no room)", people, isAdmin: !scoped, activeTab: "idp" });
});

// Centre picker (Admin only — a Centre Manager is redirected straight to their own centre).
router.get("/report", requireLogin, (req, res) => {
  const locationId = scopedLocationId(req);
  if (locationId) return res.redirect(`/report/centre/${locationId}`);

  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  res.render("report-centre-picker", { locations, activeTab: "training" });
});

// Registered before the plain ":id" route below — Express matches routes in registration
// order and ":id" (with no constraint) would otherwise swallow "3.csv" as id="3.csv".
router.get("/report/centre/:id.csv", requireLogin, (req, res) => {
  const locationId = parseInt(req.params.id, 10);
  const scoped = scopedLocationId(req);
  if (scoped && scoped !== locationId) return res.status(403).send("Forbidden");

  const location = db.prepare("SELECT * FROM locations WHERE id = ?").get(locationId);
  if (!location) return res.status(404).send("Not found");

  const staff = db.prepare("SELECT * FROM staff WHERE status = 'active' AND location_id = ? ORDER BY full_name").all(locationId);
  const lines = ["Name,Position,Sessions Attended,Total Hours"];
  staff.forEach((s) => {
    const hours = staffHours(s.id);
    const count = db.prepare("SELECT COUNT(*) AS c FROM training_attendance WHERE staff_id = ? AND attended = 1").get(s.id).c;
    lines.push([s.full_name, s.position_title || "", count, hours].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${location.name}-training-report.csv"`);
  res.send(lines.join("\n"));
});

router.get("/report/centre/:id", requireLogin, (req, res) => {
  const locationId = parseInt(req.params.id, 10);
  const scoped = scopedLocationId(req);
  if (scoped && scoped !== locationId) {
    return res.status(403).render("error", { message: "You can only view your own centre's report." });
  }

  const location = db.prepare("SELECT * FROM locations WHERE id = ?").get(locationId);
  if (!location) return res.status(404).render("error", { message: "Centre not found." });

  const staff = db.prepare("SELECT * FROM staff WHERE status = 'active' AND location_id = ? ORDER BY full_name").all(locationId);
  const rows = staff.map((s) => ({
    ...s,
    total_hours: staffHours(s.id),
    sessions_attended: db.prepare(`
      SELECT COUNT(*) AS c FROM training_attendance a WHERE a.staff_id = ? AND a.attended = 1
    `).get(s.id).c,
  }));

  res.render("report-centre", { location, rows, activeTab: "training" });
});

router.get("/report/person/:id", requireLogin, (req, res) => {
  const staffMember = db.prepare("SELECT s.*, l.name AS location_name FROM staff s LEFT JOIN locations l ON l.id = s.location_id WHERE s.id = ?").get(req.params.id);
  if (!staffMember) return res.status(404).render("error", { message: "Staff member not found." });

  const scoped = scopedLocationId(req);
  if (scoped && staffMember.location_id !== scoped) {
    return res.status(403).render("error", { message: "You can only view staff from your own centre." });
  }

  // Only attended sessions — a session someone was scheduled for but didn't attend
  // isn't training they received, so it doesn't belong in their report.
  const sessions = db.prepare(`
    SELECT t.* FROM training_attendance a
    JOIN training_sessions t ON t.id = a.session_id
    WHERE a.staff_id = ? AND a.attended = 1
    ORDER BY t.session_date DESC
  `).all(staffMember.id);

  if (sessions.length > 0) {
    const ids = sessions.map((s) => s.id);
    const placeholders = ids.map(() => "?").join(",");
    const links = db.prepare(`SELECT session_id, element_code FROM training_session_nqs WHERE session_id IN (${placeholders})`).all(...ids);
    const bySession = new Map();
    for (const link of links) {
      if (!bySession.has(link.session_id)) bySession.set(link.session_id, []);
      bySession.get(link.session_id).push(link.element_code);
    }
    for (const s of sessions) s.nqsCodes = bySession.get(s.id) || [];
  }

  const totalHours = sessions.reduce((sum, s) => sum + s.hours, 0);

  // Phase 2: surface the person's current IDP + goals on the same report, so training
  // and development sit together (the report brief's "IDPs + their training hours").
  const idp = db.prepare("SELECT * FROM idps WHERE staff_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(staffMember.id);
  const goals = idp ? db.prepare("SELECT * FROM idp_goals WHERE idp_id = ? ORDER BY created_at").all(idp.id) : [];

  res.render("report-person", { staffMember, sessions, totalHours, nqs, idp, goals });
});

module.exports = router;
