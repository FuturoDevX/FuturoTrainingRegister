const express = require("express");
const db = require("../db/db");
const { requireLogin, scopedLocationId } = require("../middleware/auth");
const { setFlash } = require("../middleware/flash");
const { logAction } = require("../services/audit");
const { ROLES, suggestDevRole, isValidDevRole } = require("../services/devRole");

const router = express.Router();

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

module.exports = router;
