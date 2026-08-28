// Derives the "supporting leaders" for a person's development, from the org structure
// rather than manual per-IDP entry. The matrix (from Christo's phase-2 brief):
//
//   Educator (ed)            → Room Leader, Educational Leader, ACM, Centre Manager
//   Room Leader (rl)         → Educational Leader, Centre Manager
//   Assistant CM (acm)       → Operations Manager, Centre Manager
//   Educational Leader (el)  → Quality & Compliance, Centre Manager
//   Centre Manager (cm)      → Operations Manager, General Manager
//
// RL/EL come from the person's ROOM; ACM/CM from their CENTRE; OM/GM/Q&C are org-wide
// (org_roles table). Each slot is returned filled or empty-with-a-reason, so the UI can
// show gaps ("Room Leader: not set") — that's exactly what a CM needs to chase up.

const db = require("../db/db");

const staffById = db.prepare("SELECT id, full_name FROM staff WHERE id = ? AND status = 'active'");
const centreRoleHolder = db.prepare(
  "SELECT id, full_name FROM staff WHERE dev_role = ? AND location_id = ? AND status = 'active' ORDER BY full_name LIMIT 1"
);
const orgRoleHolder = db.prepare(`
  SELECT s.id, s.full_name FROM org_roles o
  JOIN staff s ON s.id = o.staff_id AND s.status = 'active'
  WHERE o.role = ?
`);
const roomById = db.prepare("SELECT * FROM rooms WHERE id = ?");

function slot(label, staff, emptyReason) {
  return staff ? { label, staff } : { label, staff: null, note: emptyReason };
}

// The person's own room's RL / EL. For an RL, "their room" is the one they lead — same
// lookup (they're assigned to their own room via staff.room_id), so this works uniformly.
function roomLeaderSlot(person) {
  if (!person.room_id) return slot("Room Leader", null, "No room assigned");
  const room = roomById.get(person.room_id);
  const rl = room && room.room_leader_staff_id ? staffById.get(room.room_leader_staff_id) : null;
  return slot("Room Leader", rl, "Room has no Room Leader set");
}

function edLeaderSlot(person) {
  if (!person.room_id) return slot("Educational Leader", null, "No room assigned");
  const room = roomById.get(person.room_id);
  const el = room && room.ed_leader_staff_id ? staffById.get(room.ed_leader_staff_id) : null;
  return slot("Educational Leader", el, "Room has no Educational Leader set");
}

function centreSlot(label, roleKey, person) {
  if (!person.location_id) return slot(label, null, "No centre assigned");
  return slot(label, centreRoleHolder.get(roleKey, person.location_id), `No ${label} set for this centre`);
}

function orgSlot(label, roleKey) {
  return slot(label, orgRoleHolder.get(roleKey), `No ${label} designated (set in Admin → Roles & Rooms)`);
}

// person: a staff row (needs dev_role, room_id, location_id). Returns { slots, gaps }.
function deriveSupporters(person) {
  let slots = [];
  switch (person.dev_role) {
    case "ed":
      slots = [roomLeaderSlot(person), edLeaderSlot(person), centreSlot("Assistant Centre Manager", "acm", person), centreSlot("Centre Manager", "cm", person)];
      break;
    case "rl":
      slots = [edLeaderSlot(person), centreSlot("Centre Manager", "cm", person)];
      break;
    case "acm":
      slots = [orgSlot("Operations Manager", "om"), centreSlot("Centre Manager", "cm", person)];
      break;
    case "el":
      slots = [orgSlot("Quality & Compliance", "qc"), centreSlot("Centre Manager", "cm", person)];
      break;
    case "cm":
      slots = [orgSlot("Operations Manager", "om"), orgSlot("General Manager", "gm")];
      break;
    case "non_contact":
      return { slots: [], gaps: [] }; // support/non-contact staff aren't on the development track
    default:
      return { slots: [], gaps: ["No development-role set for this person"] };
  }
  const gaps = slots.filter((s) => !s.staff).map((s) => `${s.label}: ${s.note}`);
  return { slots, gaps };
}

module.exports = { deriveSupporters };
