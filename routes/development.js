const express = require("express");
const db = require("../db/db");
const { requireLogin, scopedLocationId } = require("../middleware/auth");
const { setFlash } = require("../middleware/flash");
const { logAction } = require("../services/audit");
const { ROLES, ROLE_LABEL, suggestDevRole, isValidDevRole } = require("../services/devRole");
const { deriveSupporters } = require("../services/responsibility");
const nqs = require("../services/nqs");

const router = express.Router();

// A CM may only touch staff/IDPs at their own centre; Admin anywhere.
function canManagePerson(req, person) {
  const scoped = scopedLocationId(req);
  return !scoped || person.location_id === scoped;
}

// The person's current "living" IDP — most recent by creation. Null if none yet.
function currentIdp(staffId) {
  return db.prepare("SELECT * FROM idps WHERE staff_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(staffId);
}

// Which centre the user is working within. A Centre Manager is locked to their own; an
// Admin picks one via ?centre= (defaulting to the first), mirroring the attendance screens.
function resolveWorkingCentre(req) {
  const scoped = scopedLocationId(req);
  if (scoped) return scoped;
  const requested = req.query.centre ? parseInt(req.query.centre, 10) : null;
  if (requested) return requested;
  const first = db.prepare("SELECT id FROM locations WHERE name != 'Other/HQ' ORDER BY name LIMIT 1").get();
  return first ? first.id : null;
}

function centreContext(req, activeTab) {
  const scoped = scopedLocationId(req);
  const workingCentreId = resolveWorkingCentre(req);
  return {
    activeTab,
    isAdmin: !scoped,
    workingCentreId,
    workingCentre: db.prepare("SELECT * FROM locations WHERE id = ?").get(workingCentreId),
    // Admin gets a centre switcher; CM doesn't need one.
    centres: scoped ? [] : db.prepare("SELECT * FROM locations WHERE name != 'Other/HQ' ORDER BY name").all(),
  };
}

router.get("/development", requireLogin, (req, res) => res.redirect("/development/rooms"));

// ---- Rooms ----------------------------------------------------------------
router.get("/development/rooms", requireLogin, (req, res) => {
  const ctx = centreContext(req, "rooms");
  const rooms = db.prepare(`
    SELECT r.*, rl.full_name AS rl_name, el.full_name AS el_name,
      (SELECT COUNT(*) FROM staff s WHERE s.room_id = r.id AND s.status = 'active') AS staff_count
    FROM rooms r
    LEFT JOIN staff rl ON rl.id = r.room_leader_staff_id
    LEFT JOIN staff el ON el.id = r.ed_leader_staff_id
    WHERE r.location_id = ?
    ORDER BY r.name
  `).all(ctx.workingCentreId);
  // Staff at this centre populate the RL/EL pickers.
  const centreStaff = db.prepare("SELECT id, full_name, position_title FROM staff WHERE location_id = ? AND status = 'active' ORDER BY full_name").all(ctx.workingCentreId);
  res.render("dev-rooms", { ...ctx, rooms, centreStaff });
});

router.post("/development/rooms", requireLogin, (req, res) => {
  const ctx = centreContext(req, "rooms");
  const name = (req.body.name || "").trim();
  if (!name) {
    setFlash(req, "error", "Room name is required.");
    return res.redirect(`/development/rooms?centre=${ctx.workingCentreId}`);
  }
  try {
    db.prepare("INSERT INTO rooms (location_id, name) VALUES (?, ?)").run(ctx.workingCentreId, name);
    logAction(req, "room.create", `Created room "${name}" at ${ctx.workingCentre.name}`);
    setFlash(req, "success", `Room "${name}" created.`);
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") setFlash(req, "error", `${ctx.workingCentre.name} already has a room called "${name}".`);
    else throw err;
  }
  res.redirect(`/development/rooms?centre=${ctx.workingCentreId}`);
});

router.post("/development/rooms/:id", requireLogin, (req, res) => {
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).render("error", { message: "Room not found." });
  const scoped = scopedLocationId(req);
  if (scoped && room.location_id !== scoped) return res.status(403).render("error", { message: "You can only manage your own centre's rooms." });

  const rl = req.body.room_leader_staff_id ? parseInt(req.body.room_leader_staff_id, 10) : null;
  const el = req.body.ed_leader_staff_id ? parseInt(req.body.ed_leader_staff_id, 10) : null;
  db.prepare("UPDATE rooms SET room_leader_staff_id = ?, ed_leader_staff_id = ? WHERE id = ?").run(rl, el, room.id);
  logAction(req, "room.update", `Updated leaders for room "${room.name}"`);
  setFlash(req, "success", `"${room.name}" updated.`);
  res.redirect(`/development/rooms?centre=${room.location_id}`);
});

router.post("/development/rooms/:id/delete", requireLogin, (req, res) => {
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(req.params.id);
  if (!room) return res.status(404).render("error", { message: "Room not found." });
  const scoped = scopedLocationId(req);
  if (scoped && room.location_id !== scoped) return res.status(403).render("error", { message: "You can only manage your own centre's rooms." });

  // Detach staff from the room first so the FK doesn't block deletion (their dev_role
  // and other data stay intact — they just no longer sit in this now-deleted room).
  const txn = db.transaction(() => {
    db.prepare("UPDATE staff SET room_id = NULL WHERE room_id = ?").run(room.id);
    db.prepare("DELETE FROM rooms WHERE id = ?").run(room.id);
  });
  txn();
  logAction(req, "room.delete", `Deleted room "${room.name}" at ${room.location_id}`);
  setFlash(req, "success", `"${room.name}" deleted.`);
  res.redirect(`/development/rooms?centre=${room.location_id}`);
});

// ---- People (dev-role + room assignment) ----------------------------------
router.get("/development/people", requireLogin, (req, res) => {
  const ctx = centreContext(req, "people");
  const staff = db.prepare(`
    SELECT s.*, r.name AS room_name
    FROM staff s LEFT JOIN rooms r ON r.id = s.room_id
    WHERE s.location_id = ? AND s.status = 'active'
    ORDER BY s.full_name
  `).all(ctx.workingCentreId);
  // Attach an auto-suggested dev_role for anyone not yet classified, so the CM sees a
  // sensible default to accept rather than a blank dropdown for 200 people.
  for (const s of staff) s.suggested = suggestDevRole(s.position_title);
  const rooms = db.prepare("SELECT id, name FROM rooms WHERE location_id = ? ORDER BY name").all(ctx.workingCentreId);
  res.render("dev-people", { ...ctx, staff, rooms, roleOptions: ROLES });
});

router.post("/development/people/:id", requireLogin, (req, res) => {
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.params.id);
  if (!person) return res.status(404).render("error", { message: "Staff member not found." });
  const scoped = scopedLocationId(req);
  if (scoped && person.location_id !== scoped) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  const devRole = req.body.dev_role && isValidDevRole(req.body.dev_role) ? req.body.dev_role : null;
  const roomId = req.body.room_id ? parseInt(req.body.room_id, 10) : null;
  db.prepare("UPDATE staff SET dev_role = ?, room_id = ? WHERE id = ?").run(devRole, roomId, person.id);
  logAction(req, "staff.dev_role", `Set ${person.full_name}: role=${devRole || "—"}, room=${roomId || "—"}`);
  setFlash(req, "success", `${person.full_name} updated.`);
  res.redirect(`/development/people?centre=${person.location_id}`);
});

// ---- Plans (IDP overview list) --------------------------------------------
router.get("/development/plans", requireLogin, (req, res) => {
  const ctx = centreContext(req, "plans");
  const rows = db.prepare(`
    SELECT s.id, s.full_name, s.dev_role, r.name AS room_name,
      i.id AS idp_id, i.status AS idp_status, i.review_date,
      (SELECT COUNT(*) FROM idp_goals g WHERE g.idp_id = i.id) AS goal_count
    FROM staff s
    LEFT JOIN rooms r ON r.id = s.room_id
    LEFT JOIN idps i ON i.id = (SELECT id FROM idps WHERE staff_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1)
    WHERE s.location_id = ? AND s.status = 'active'
    ORDER BY s.full_name
  `).all(ctx.workingCentreId);
  const today = new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    row.role_label = row.dev_role ? ROLE_LABEL[row.dev_role] : null;
    row.overdue = row.idp_status === "active" && row.review_date && row.review_date < today;
  }
  res.render("dev-plans", { ...ctx, rows });
});

// ---- Per-person IDP detail ------------------------------------------------
function idpSupporters(idp, person) {
  if (idp && idp.supporters_mode === "manual") {
    const people = db.prepare(`
      SELECT s.id, s.full_name, s.dev_role FROM idp_supporters isup
      JOIN staff s ON s.id = isup.staff_id WHERE isup.idp_id = ?
      ORDER BY s.full_name
    `).all(idp.id);
    return { mode: "manual", manual: people, derived: null };
  }
  return { mode: "auto", manual: null, derived: deriveSupporters(person) };
}

router.get("/development/idp/:staffId", requireLogin, (req, res) => {
  const person = db.prepare("SELECT s.*, l.name AS location_name, r.name AS room_name FROM staff s LEFT JOIN locations l ON l.id = s.location_id LEFT JOIN rooms r ON r.id = s.room_id WHERE s.id = ?").get(req.params.staffId);
  if (!person) return res.status(404).render("error", { message: "Staff member not found." });
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  const idp = currentIdp(person.id);
  const goals = idp ? db.prepare("SELECT * FROM idp_goals WHERE idp_id = ? ORDER BY created_at").all(idp.id) : [];
  const supporters = idpSupporters(idp, person);
  // Centre staff for the manual-override picker (scoped to the person's own centre).
  const centreStaff = db.prepare("SELECT id, full_name FROM staff WHERE location_id = ? AND status = 'active' AND id != ? ORDER BY full_name").all(person.location_id, person.id);
  const manualIds = idp && supporters.mode === "manual" ? new Set(supporters.manual.map((s) => s.id)) : new Set();

  res.render("dev-idp", {
    person, idp, goals, supporters, centreStaff, manualIds,
    roleLabel: person.dev_role ? ROLE_LABEL[person.dev_role] : null,
    qualityAreas: nqs.QUALITY_AREAS,
    nqs,
  });
});

router.post("/development/idp/:staffId/create", requireLogin, (req, res) => {
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.params.staffId);
  if (!person) return res.status(404).render("error", { message: "Staff member not found." });
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  // One living IDP at a time: if the latest isn't completed, just open it rather than
  // creating a duplicate.
  const existing = currentIdp(person.id);
  if (existing && existing.status !== "completed") {
    return res.redirect(`/development/idp/${person.id}`);
  }
  const result = db.prepare("INSERT INTO idps (staff_id, status, created_by) VALUES (?, 'draft', ?)").run(person.id, req.session.user.id);
  logAction(req, "idp.create", `Started an IDP for ${person.full_name}`);
  setFlash(req, "success", `IDP started for ${person.full_name}.`);
  res.redirect(`/development/idp/${person.id}`);
});

router.post("/development/idp/:id", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  const status = ["draft", "active", "completed"].includes(req.body.status) ? req.body.status : idp.status;
  const supportersMode = req.body.supporters_mode === "manual" ? "manual" : "auto";
  db.prepare("UPDATE idps SET focus = ?, status = ?, review_date = ?, supporters_mode = ?, updated_at = datetime('now') WHERE id = ?")
    .run(req.body.focus || null, status, req.body.review_date || null, supportersMode, idp.id);

  // Replace manual supporters only when in manual mode; leaving auto clears none but
  // simply stops consulting the table.
  if (supportersMode === "manual") {
    const ids = [...new Set([].concat(req.body.supporters || []).map(Number).filter(Boolean))];
    const txn = db.transaction(() => {
      db.prepare("DELETE FROM idp_supporters WHERE idp_id = ?").run(idp.id);
      const ins = db.prepare("INSERT OR IGNORE INTO idp_supporters (idp_id, staff_id) VALUES (?, ?)");
      for (const sid of ids) ins.run(idp.id, sid);
    });
    txn();
  }
  logAction(req, "idp.update", `Updated ${person.full_name}'s IDP (status: ${status})`);
  setFlash(req, "success", "IDP updated.");
  res.redirect(`/development/idp/${person.id}`);
});

router.post("/development/idp/:id/goals", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  const title = (req.body.title || "").trim();
  if (!title) {
    setFlash(req, "error", "A goal needs a title.");
    return res.redirect(`/development/idp/${person.id}`);
  }
  const nqsCode = req.body.nqs_element_code && nqs.isValidElementCode(req.body.nqs_element_code) ? req.body.nqs_element_code : null;
  db.prepare(`
    INSERT INTO idp_goals (idp_id, title, specific, measurable, achievable, relevant, target_date, nqs_element_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(idp.id, title, req.body.specific || null, req.body.measurable || null, req.body.achievable || null, req.body.relevant || null, req.body.target_date || null, nqsCode);
  logAction(req, "idp.goal_add", `Added goal "${title}" to ${person.full_name}'s IDP`);
  setFlash(req, "success", `Goal "${title}" added.`);
  res.redirect(`/development/idp/${person.id}`);
});

router.post("/development/goals/:id", requireLogin, (req, res) => {
  const goal = db.prepare("SELECT * FROM idp_goals WHERE id = ?").get(req.params.id);
  if (!goal) return res.status(404).render("error", { message: "Goal not found." });
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(goal.idp_id);
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  const status = ["not_started", "in_progress", "achieved", "dropped"].includes(req.body.status) ? req.body.status : goal.status;
  const nqsCode = req.body.nqs_element_code && nqs.isValidElementCode(req.body.nqs_element_code) ? req.body.nqs_element_code : null;
  db.prepare(`
    UPDATE idp_goals SET title = ?, specific = ?, measurable = ?, achievable = ?, relevant = ?,
      target_date = ?, nqs_element_code = ?, status = ?, progress_notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.body.title || goal.title, req.body.specific || null, req.body.measurable || null, req.body.achievable || null,
    req.body.relevant || null, req.body.target_date || null, nqsCode, status, req.body.progress_notes || null, goal.id);
  logAction(req, "idp.goal_update", `Updated goal "${goal.title}" (${status}) on ${person.full_name}'s IDP`);
  setFlash(req, "success", "Goal updated.");
  res.redirect(`/development/idp/${person.id}`);
});

router.post("/development/goals/:id/delete", requireLogin, (req, res) => {
  const goal = db.prepare("SELECT * FROM idp_goals WHERE id = ?").get(req.params.id);
  if (!goal) return res.status(404).render("error", { message: "Goal not found." });
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(goal.idp_id);
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  db.prepare("DELETE FROM idp_goals WHERE id = ?").run(goal.id);
  logAction(req, "idp.goal_delete", `Deleted goal "${goal.title}" from ${person.full_name}'s IDP`);
  setFlash(req, "success", "Goal deleted.");
  res.redirect(`/development/idp/${person.id}`);
});

module.exports = router;
