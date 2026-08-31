const express = require("express");
const db = require("../db/db");
const { requireLogin, scopedLocationId } = require("../middleware/auth");
const { setFlash } = require("../middleware/flash");
const { logAction } = require("../services/audit");
const { ROLES, ROLE_LABEL, suggestDevRole, isValidDevRole } = require("../services/devRole");
const { deriveSupporters } = require("../services/responsibility");
const { newToken } = require("../services/contribLinks");
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

// Past completed plans (everything except the current one), newest first, each with its
// goals attached — the person's development history across cycles.
function idpHistory(staffId, excludeId) {
  const plans = db.prepare(`
    SELECT i.*,
      (SELECT COUNT(*) FROM idp_goals g WHERE g.idp_id = i.id) AS goal_count,
      (SELECT COUNT(*) FROM idp_goals g WHERE g.idp_id = i.id AND g.status = 'achieved') AS achieved_count
    FROM idps i
    WHERE i.staff_id = ? AND i.id != ? AND i.status = 'completed'
    ORDER BY COALESCE(i.completed_at, i.created_at) DESC, i.id DESC
  `).all(staffId, excludeId || 0);
  for (const p of plans) {
    p.goals = db.prepare("SELECT title, status, target_date FROM idp_goals WHERE idp_id = ? ORDER BY created_at").all(p.id);
  }
  return plans;
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

// Land on Plans — the day-to-day surface — rather than Rooms (often an empty setup screen).
router.get("/development", requireLogin, (req, res) => res.redirect("/development/plans"));

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
  // Casuals are excluded from the whole development side (they don't get IDPs), though
  // they remain fully in the training side. IFNULL keeps not-yet-classified staff visible.
  const staff = db.prepare(`
    SELECT s.*, r.name AS room_name
    FROM staff s LEFT JOIN rooms r ON r.id = s.room_id
    WHERE s.location_id = ? AND s.status = 'active' AND IFNULL(s.employment_type, '') != 'casual'
    ORDER BY s.full_name
  `).all(ctx.workingCentreId);
  // Attach an auto-suggested dev_role for anyone not yet classified, so the CM sees a
  // sensible default to accept rather than a blank dropdown for 200 people.
  for (const s of staff) s.suggested = suggestDevRole(s.position_title);
  const suggestedCount = staff.filter((s) => !s.dev_role && s.suggested).length;
  const rooms = db.prepare("SELECT id, name FROM rooms WHERE location_id = ? ORDER BY name").all(ctx.workingCentreId);
  res.render("dev-people", { ...ctx, staff, rooms, roleOptions: ROLES, suggestedCount });
});

// Bulk-accept: set dev_role to the auto-suggestion for every not-yet-classified person
// at the working centre — saves a Centre Manager clicking Save on dozens of rows.
router.post("/development/people/accept-suggested", requireLogin, (req, res) => {
  const scoped = scopedLocationId(req);
  const centreId = scoped || (req.query.centre ? parseInt(req.query.centre, 10) : null);
  if (!centreId) return res.status(400).render("error", { message: "A centre is required." });

  const candidates = db.prepare(
    "SELECT id, position_title FROM staff WHERE location_id = ? AND status = 'active' AND IFNULL(employment_type,'') != 'casual' AND dev_role IS NULL"
  ).all(centreId);
  const update = db.prepare("UPDATE staff SET dev_role = ? WHERE id = ?");
  let applied = 0;
  const txn = db.transaction(() => {
    for (const s of candidates) {
      const role = suggestDevRole(s.position_title);
      if (role) { update.run(role, s.id); applied++; }
    }
  });
  txn();

  logAction(req, "staff.dev_role_bulk", `Accepted ${applied} suggested development-role(s)`);
  setFlash(req, "success", applied ? `Accepted ${applied} suggested role${applied === 1 ? "" : "s"}.` : "No suggestions to apply.");
  res.redirect(`/development/people${scoped ? "" : "?centre=" + centreId}`);
});

// Save every row at once — the whole People table posts role_<id> / room_<id> fields.
router.post("/development/people/save-all", requireLogin, (req, res) => {
  const scoped = scopedLocationId(req);
  const centreId = scoped || (req.query.centre ? parseInt(req.query.centre, 10) : null);
  if (!centreId) return res.status(400).render("error", { message: "A centre is required." });

  const staff = db.prepare("SELECT id FROM staff WHERE location_id = ? AND status = 'active' AND IFNULL(employment_type,'') != 'casual'").all(centreId);
  const roomOk = db.prepare("SELECT 1 FROM rooms WHERE id = ? AND location_id = ?");
  const update = db.prepare("UPDATE staff SET dev_role = ?, room_id = ? WHERE id = ?");
  let saved = 0;
  const txn = db.transaction(() => {
    for (const s of staff) {
      const rawRole = req.body["role_" + s.id];
      const rawRoom = req.body["room_" + s.id];
      if (rawRole === undefined && rawRoom === undefined) continue; // row wasn't in the form
      const devRole = rawRole && isValidDevRole(rawRole) ? rawRole : null;
      const roomId = rawRoom && roomOk.get(parseInt(rawRoom, 10), centreId) ? parseInt(rawRoom, 10) : null;
      update.run(devRole, roomId, s.id);
      saved++;
    }
  });
  txn();

  logAction(req, "staff.dev_role_saveall", `Saved development role/room for ${saved} staff`);
  setFlash(req, "success", `Saved — ${saved} staff updated.`);
  res.redirect(`/development/people${scoped ? "" : "?centre=" + centreId}`);
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
    WHERE s.location_id = ? AND s.status = 'active' AND IFNULL(s.employment_type, '') != 'casual' AND IFNULL(s.dev_role, '') != 'non_contact'
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
// Returns the given dev-area id only if it's a real area on THIS plan, else null — so a
// goal can never point at another plan's area (or a stale/blank value).
function validAreaId(raw, idpId) {
  if (!raw) return null;
  const a = db.prepare("SELECT id FROM idp_dev_areas WHERE id = ? AND idp_id = ?").get(parseInt(raw, 10), idpId);
  return a ? a.id : null;
}

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
  const locked = !!(idp && idp.status === "completed");
  const goals = idp ? db.prepare("SELECT * FROM idp_goals WHERE idp_id = ? ORDER BY created_at").all(idp.id) : [];
  // Areas for development named on this plan, and the goals grouped under the area each
  // one addresses (goals with no area fall into a trailing "Other goals" group). This is
  // what makes a goal read as "how we'll act on area X" rather than a floating item.
  const devAreas = idp ? db.prepare("SELECT * FROM idp_dev_areas WHERE idp_id = ? ORDER BY sort_order, id").all(idp.id) : [];
  const goalGroups = devAreas.map((a) => ({ area: a, goals: goals.filter((g) => g.dev_area_id === a.id) }));
  const orphanGoals = goals.filter((g) => !devAreas.some((a) => a.id === g.dev_area_id));
  if (orphanGoals.length) goalGroups.push({ area: null, goals: orphanGoals });
  const supporters = idpSupporters(idp, person);
  const notes = idp ? db.prepare("SELECT * FROM idp_notes WHERE idp_id = ? ORDER BY created_at DESC, id DESC").all(idp.id) : [];
  const history = idpHistory(person.id, idp ? idp.id : 0);
  // Magic-link contributions: active links (with full copy-paste URL) + anything awaiting review.
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const links = idp ? db.prepare("SELECT * FROM idp_contrib_links WHERE idp_id = ? AND revoked_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC").all(idp.id) : [];
  for (const l of links) l.url = `${baseUrl}/contribute/${l.token}`;
  const pending = idp ? db.prepare("SELECT * FROM idp_contributions WHERE idp_id = ? AND status = 'pending' ORDER BY created_at").all(idp.id) : [];
  // Centre staff for the manual-override picker (scoped to the person's own centre).
  const centreStaff = db.prepare("SELECT id, full_name FROM staff WHERE location_id = ? AND status = 'active' AND id != ? ORDER BY full_name").all(person.location_id, person.id);
  const manualIds = idp && supporters.mode === "manual" ? new Set(supporters.manual.map((s) => s.id)) : new Set();

  res.render("dev-idp", {
    person, idp, locked, goals, devAreas, goalGroups, supporters, notes, history, centreStaff, manualIds, links, pending,
    roleLabel: person.dev_role ? ROLE_LABEL[person.dev_role] : null,
    goalNameById: Object.fromEntries(goals.map((g) => [g.id, g.title])),
    qualityAreas: nqs.QUALITY_AREAS,
    nqs,
  });
});

router.post("/development/idp/:staffId/create", requireLogin, (req, res) => {
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(req.params.staffId);
  if (!person) return res.status(404).render("error", { message: "Staff member not found." });
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });
  if (person.employment_type === "casual") {
    setFlash(req, "error", `${person.full_name} is casual — IDPs don't apply to casual staff.`);
    return res.redirect("/development/plans");
  }

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
  if (idp.status === "completed") {
    setFlash(req, "error", "This plan is completed and locked. Reopen it to make changes.");
    return res.redirect(`/development/idp/${person.id}`);
  }

  // Status is its own set of actions now (activate / unpublish / complete / reopen), not a
  // dropdown here. The reflection (focus/strengths/aspirations) also has its own route, so
  // this settings form and that one never overwrite each other's fields with blanks.
  const supportersMode = req.body.supporters_mode === "manual" ? "manual" : "auto";
  db.prepare("UPDATE idps SET review_date = ?, supporters_mode = ?, updated_at = datetime('now') WHERE id = ?")
    .run(req.body.review_date || null, supportersMode, idp.id);

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

// Activate a draft plan — a first-class action (not just the Edit-plan status dropdown), so
// the step that makes a plan count toward coverage is obvious rather than buried. Reporting
// counts only active plans, so a plan left in draft is invisible until this runs.
router.post("/development/idp/:id/activate", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });
  if (idp.status !== "draft") return res.redirect(`/development/idp/${person.id}`);

  db.prepare("UPDATE idps SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(idp.id);
  logAction(req, "idp.activate", `Activated ${person.full_name}'s IDP`);
  setFlash(req, "success", "Plan activated — it now counts toward IDP coverage.");
  res.redirect(`/development/idp/${person.id}`);
});

// Move an active plan back to draft (rarely needed — e.g. activated by mistake).
router.post("/development/idp/:id/unpublish", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });
  if (idp.status !== "active") return res.redirect(`/development/idp/${person.id}`);

  db.prepare("UPDATE idps SET status = 'draft', updated_at = datetime('now') WHERE id = ?").run(idp.id);
  logAction(req, "idp.unpublish", `Moved ${person.full_name}'s IDP back to draft`);
  setFlash(req, "success", "Plan moved back to draft.");
  res.redirect(`/development/idp/${person.id}`);
});

// The reflection foundation — the plan's headline plus the person's strengths and
// aspirations. Kept separate from settings so goals flow from a considered starting point
// (see /areas for the named development areas that sit alongside these).
router.post("/development/idp/:id/reflection", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });
  if (idp.status === "completed") {
    setFlash(req, "error", "This plan is completed and locked. Reopen it to edit the reflection.");
    return res.redirect(`/development/idp/${person.id}`);
  }

  db.prepare("UPDATE idps SET focus = ?, strengths = ?, aspirations = ?, updated_at = datetime('now') WHERE id = ?")
    .run(req.body.focus || null, req.body.strengths || null, req.body.aspirations || null, idp.id);
  logAction(req, "idp.reflection", `Updated the reflection on ${person.full_name}'s IDP`);
  setFlash(req, "success", "Development focus saved.");
  res.redirect(`/development/idp/${person.id}#focus`);
});

// Add an area for development to a plan — the growth areas that goals then address.
router.post("/development/idp/:id/areas", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });
  if (idp.status === "completed") {
    setFlash(req, "error", "This plan is completed and locked. Reopen it to change development areas.");
    return res.redirect(`/development/idp/${person.id}`);
  }

  const title = (req.body.title || "").trim();
  if (!title) {
    setFlash(req, "error", "An area for development needs a title.");
    return res.redirect(`/development/idp/${person.id}#focus`);
  }
  const nextOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM idp_dev_areas WHERE idp_id = ?").get(idp.id).n;
  db.prepare("INSERT INTO idp_dev_areas (idp_id, title, sort_order) VALUES (?, ?, ?)").run(idp.id, title, nextOrder);
  logAction(req, "idp.area_add", `Added development area "${title}" to ${person.full_name}'s IDP`);
  setFlash(req, "success", `Area for development "${title}" added.`);
  res.redirect(`/development/idp/${person.id}#focus`);
});

// Remove an area — its goals aren't deleted, they just detach (dev_area_id -> NULL) and
// fall into the "Other goals" group, so nothing on the plan is lost with the area.
router.post("/development/areas/:id/delete", requireLogin, (req, res) => {
  const area = db.prepare("SELECT * FROM idp_dev_areas WHERE id = ?").get(req.params.id);
  if (!area) return res.status(404).render("error", { message: "Area not found." });
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(area.idp_id);
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });
  if (idp.status === "completed") {
    setFlash(req, "error", "This plan is completed and locked. Reopen it to change development areas.");
    return res.redirect(`/development/idp/${person.id}`);
  }

  const txn = db.transaction(() => {
    db.prepare("UPDATE idp_goals SET dev_area_id = NULL WHERE dev_area_id = ?").run(area.id);
    db.prepare("DELETE FROM idp_dev_areas WHERE id = ?").run(area.id);
  });
  txn();
  logAction(req, "idp.area_delete", `Removed development area "${area.title}" from ${person.full_name}'s IDP`);
  setFlash(req, "success", `Area "${area.title}" removed. Any goals under it kept, now ungrouped.`);
  res.redirect(`/development/idp/${person.id}#focus`);
});

// Delete a plan entirely — for a mistake (wrong person, accidental create). Distinct
// from Complete (which keeps it as history). Cascades to everything hanging off the plan
// so nothing is orphaned. Confirmed with a two-step reveal in the UI, not a dialog.
router.post("/development/idp/:id/delete", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  const txn = db.transaction(() => {
    db.prepare("DELETE FROM idp_notes WHERE idp_id = ?").run(idp.id);
    db.prepare("DELETE FROM idp_contributions WHERE idp_id = ?").run(idp.id);
    db.prepare("DELETE FROM idp_contrib_links WHERE idp_id = ?").run(idp.id);
    db.prepare("DELETE FROM idp_supporters WHERE idp_id = ?").run(idp.id);
    db.prepare("DELETE FROM idp_goals WHERE idp_id = ?").run(idp.id);
    db.prepare("DELETE FROM idp_dev_areas WHERE idp_id = ?").run(idp.id);
    // Any later cycle that carried forward from this one loses only the lineage pointer.
    db.prepare("UPDATE idps SET carried_from_id = NULL WHERE carried_from_id = ?").run(idp.id);
    db.prepare("DELETE FROM idps WHERE id = ?").run(idp.id);
  });
  txn();

  logAction(req, "idp.delete", `Deleted an IDP for ${person.full_name}`);
  setFlash(req, "success", `Plan deleted for ${person.full_name}.`);
  res.redirect("/development/plans");
});

// Complete a plan: stamp the date and lock it read-only into history.
router.post("/development/idp/:id/complete", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  db.prepare("UPDATE idps SET status = 'completed', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(idp.id);
  logAction(req, "idp.complete", `Completed ${person.full_name}'s IDP`);
  setFlash(req, "success", "Plan completed and moved to history. Start the next cycle when ready.");
  res.redirect(`/development/idp/${person.id}`);
});

// Reopen a completed plan back to active — for corrections.
router.post("/development/idp/:id/reopen", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  // Only the person's latest plan can be reopened — reopening an older one would create two
  // live plans at once, breaking the "one living IDP" rule.
  if (currentIdp(person.id).id !== idp.id) {
    setFlash(req, "error", "A newer plan exists — only the current plan can be reopened.");
    return res.redirect(`/development/idp/${person.id}`);
  }
  db.prepare("UPDATE idps SET status = 'active', completed_at = NULL, updated_at = datetime('now') WHERE id = ?").run(idp.id);
  logAction(req, "idp.reopen", `Reopened ${person.full_name}'s IDP`);
  setFlash(req, "success", "Plan reopened.");
  res.redirect(`/development/idp/${person.id}`);
});

// Start the next cycle from a completed plan, carrying forward unfinished goals.
router.post("/development/idp/:id/start-next", requireLogin, (req, res) => {
  const prev = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!prev) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(prev.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  if (prev.status !== "completed" || currentIdp(person.id).id !== prev.id) {
    setFlash(req, "error", "Complete the current plan before starting the next cycle.");
    return res.redirect(`/development/idp/${person.id}`);
  }

  // Carry forward the goals that weren't finished (not achieved, not dropped), resetting
  // them into the new cycle so progress continues rather than restarting from scratch.
  const carry = db.prepare("SELECT * FROM idp_goals WHERE idp_id = ? AND status IN ('not_started','in_progress') ORDER BY created_at").all(prev.id);
  const prevAreas = db.prepare("SELECT * FROM idp_dev_areas WHERE idp_id = ? ORDER BY sort_order, id").all(prev.id);
  let newId;
  const txn = db.transaction(() => {
    // Strengths/aspirations carry over as a starting point for the review conversation; the
    // reflection evolves rather than starting blank each cycle.
    newId = db.prepare("INSERT INTO idps (staff_id, status, strengths, aspirations, supporters_mode, carried_from_id, created_by) VALUES (?, 'draft', ?, ?, ?, ?, ?)")
      .run(person.id, prev.strengths, prev.aspirations, prev.supporters_mode, prev.id, req.session.user.id).lastInsertRowid;
    // Copy the development areas into the new cycle, keeping a map old->new so carried goals
    // keep pointing at the right area (the new plan owns fresh area rows).
    const areaMap = new Map();
    const insArea = db.prepare("INSERT INTO idp_dev_areas (idp_id, title, sort_order) VALUES (?, ?, ?)");
    for (const a of prevAreas) areaMap.set(a.id, insArea.run(newId, a.title, a.sort_order).lastInsertRowid);
    const ins = db.prepare(`
      INSERT INTO idp_goals (idp_id, dev_area_id, horizon, title, specific, measurable, achievable, relevant, target_date, nqs_element_code, resources, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const g of carry) {
      ins.run(newId, g.dev_area_id ? areaMap.get(g.dev_area_id) || null : null, g.horizon, g.title, g.specific, g.measurable, g.achievable, g.relevant, g.target_date, g.nqs_element_code, g.resources, g.status);
    }
  });
  txn();
  logAction(req, "idp.start_next", `Started a new IDP cycle for ${person.full_name}, carrying ${carry.length} goal(s) forward`);
  setFlash(req, "success", `New plan started${carry.length ? ` — ${carry.length} unfinished goal(s) carried forward` : ""}.`);
  res.redirect(`/development/idp/${person.id}`);
});

// Add a dated entry to the plan's progress log (optionally about a specific goal).
router.post("/development/idp/:id/notes", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });
  if (idp.status === "completed") {
    setFlash(req, "error", "This plan is completed and locked. Reopen it to add notes.");
    return res.redirect(`/development/idp/${person.id}`);
  }

  const note = (req.body.note || "").trim();
  if (!note) {
    setFlash(req, "error", "The note is empty.");
    return res.redirect(`/development/idp/${person.id}`);
  }
  // Only accept a goal_id that actually belongs to this plan.
  let goalId = null;
  if (req.body.goal_id) {
    const g = db.prepare("SELECT id FROM idp_goals WHERE id = ? AND idp_id = ?").get(parseInt(req.body.goal_id, 10), idp.id);
    if (g) goalId = g.id;
  }
  db.prepare("INSERT INTO idp_notes (idp_id, goal_id, note, author_label, created_by) VALUES (?, ?, ?, ?, ?)")
    .run(idp.id, goalId, note, req.session.user.full_name, req.session.user.id);
  logAction(req, "idp.note_add", `Added a progress note to ${person.full_name}'s IDP`);
  setFlash(req, "success", "Progress note added.");
  res.redirect(`/development/idp/${person.id}#log`);
});

// Generate a magic link (default 14-day expiry) for the educator or a supporting leader.
router.post("/development/idp/:id/links", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  const audience = req.body.audience === "leader" ? "leader" : "educator";
  const days = Math.min(90, Math.max(1, parseInt(req.body.days, 10) || 14));
  db.prepare(`INSERT INTO idp_contrib_links (idp_id, token, audience, expires_at, created_by)
    VALUES (?, ?, ?, datetime('now', ?), ?)`).run(idp.id, newToken(), audience, `+${days} days`, req.session.user.id);
  logAction(req, "idp.link_create", `Created a ${audience} contribution link for ${person.full_name}'s IDP (${days}d)`);
  setFlash(req, "success", "Contribution link created — copy it and send it on.");
  res.redirect(`/development/idp/${person.id}#contributions`);
});

router.post("/development/links/:id/revoke", requireLogin, (req, res) => {
  const link = db.prepare("SELECT * FROM idp_contrib_links WHERE id = ?").get(req.params.id);
  if (!link) return res.status(404).render("error", { message: "Link not found." });
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(link.idp_id);
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  db.prepare("UPDATE idp_contrib_links SET revoked_at = datetime('now') WHERE id = ?").run(link.id);
  logAction(req, "idp.link_revoke", `Revoked a contribution link for ${person.full_name}'s IDP`);
  setFlash(req, "success", "Link revoked.");
  res.redirect(`/development/idp/${person.id}#contributions`);
});

// Accept a pending contribution — copies it into the progress log, attributed "via <name>".
router.post("/development/contributions/:id/accept", requireLogin, (req, res) => {
  const c = db.prepare("SELECT * FROM idp_contributions WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).render("error", { message: "Contribution not found." });
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(c.idp_id);
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });
  if (c.status !== "pending") return res.redirect(`/development/idp/${person.id}#contributions`);

  const txn = db.transaction(() => {
    db.prepare("INSERT INTO idp_notes (idp_id, goal_id, note, author_label, created_by) VALUES (?, ?, ?, ?, ?)")
      .run(idp.id, c.goal_id, c.body, `via ${c.author_label}`, req.session.user.id);
    db.prepare("UPDATE idp_contributions SET status = 'accepted', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
      .run(req.session.user.id, c.id);
  });
  txn();
  logAction(req, "idp.contrib_accept", `Accepted ${c.author_label}'s contribution into ${person.full_name}'s IDP log`);
  setFlash(req, "success", "Added to the progress log.");
  res.redirect(`/development/idp/${person.id}#log`);
});

router.post("/development/contributions/:id/dismiss", requireLogin, (req, res) => {
  const c = db.prepare("SELECT * FROM idp_contributions WHERE id = ?").get(req.params.id);
  if (!c) return res.status(404).render("error", { message: "Contribution not found." });
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(c.idp_id);
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });

  db.prepare("UPDATE idp_contributions SET status = 'dismissed', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(req.session.user.id, c.id);
  logAction(req, "idp.contrib_dismiss", `Dismissed a contribution on ${person.full_name}'s IDP`);
  setFlash(req, "success", "Contribution dismissed.");
  res.redirect(`/development/idp/${person.id}#contributions`);
});

router.post("/development/idp/:id/goals", requireLogin, (req, res) => {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(req.params.id);
  if (!idp) return res.status(404).render("error", { message: "IDP not found." });
  const person = db.prepare("SELECT * FROM staff WHERE id = ?").get(idp.staff_id);
  if (!canManagePerson(req, person)) return res.status(403).render("error", { message: "You can only manage your own centre's staff." });
  if (idp.status === "completed") {
    setFlash(req, "error", "This plan is completed and locked. Reopen it to add goals.");
    return res.redirect(`/development/idp/${person.id}`);
  }

  const title = (req.body.title || "").trim();
  if (!title) {
    setFlash(req, "error", "A goal needs a title.");
    return res.redirect(`/development/idp/${person.id}`);
  }
  const nqsCode = req.body.nqs_element_code && nqs.isValidElementCode(req.body.nqs_element_code) ? req.body.nqs_element_code : null;
  const areaId = validAreaId(req.body.dev_area_id, idp.id);
  const horizon = ["short", "developmental"].includes(req.body.horizon) ? req.body.horizon : null;
  db.prepare(`
    INSERT INTO idp_goals (idp_id, dev_area_id, horizon, title, specific, measurable, achievable, relevant, target_date, nqs_element_code, resources)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(idp.id, areaId, horizon, title, req.body.specific || null, req.body.measurable || null, req.body.achievable || null, req.body.relevant || null, req.body.target_date || null, nqsCode, req.body.resources || null);
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
  if (idp.status === "completed") {
    setFlash(req, "error", "This plan is completed and locked. Reopen it to edit goals.");
    return res.redirect(`/development/idp/${person.id}`);
  }

  const status = ["not_started", "in_progress", "achieved", "dropped"].includes(req.body.status) ? req.body.status : goal.status;
  const nqsCode = req.body.nqs_element_code && nqs.isValidElementCode(req.body.nqs_element_code) ? req.body.nqs_element_code : null;
  const areaId = validAreaId(req.body.dev_area_id, idp.id);
  const horizon = ["short", "developmental"].includes(req.body.horizon) ? req.body.horizon : null;
  db.prepare(`
    UPDATE idp_goals SET dev_area_id = ?, horizon = ?, title = ?, specific = ?, measurable = ?, achievable = ?, relevant = ?,
      target_date = ?, nqs_element_code = ?, status = ?, progress_notes = ?, resources = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(areaId, horizon, req.body.title || goal.title, req.body.specific || null, req.body.measurable || null, req.body.achievable || null,
    req.body.relevant || null, req.body.target_date || null, nqsCode, status, req.body.progress_notes || null, req.body.resources || null, goal.id);
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
  if (idp.status === "completed") {
    setFlash(req, "error", "This plan is completed and locked. Reopen it to delete goals.");
    return res.redirect(`/development/idp/${person.id}`);
  }

  db.prepare("DELETE FROM idp_goals WHERE id = ?").run(goal.id);
  logAction(req, "idp.goal_delete", `Deleted goal "${goal.title}" from ${person.full_name}'s IDP`);
  setFlash(req, "success", "Goal deleted.");
  res.redirect(`/development/idp/${person.id}`);
});

module.exports = router;
