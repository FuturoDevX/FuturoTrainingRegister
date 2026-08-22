const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db/db");
const { requireLogin, requireAdmin } = require("../middleware/auth");
const { setFlash } = require("../middleware/flash");
const { logAction } = require("../services/audit");
const { runSync } = require("../services/employmentHero");

// Render's persistent disk has no automatic backups (unlike its managed Postgres, which
// gets point-in-time recovery) — this is the only backup this app has, so it matters
// that it actually works. WAL mode keeps recent writes in a separate -wal file rather
// than the main .db file; TRUNCATE checkpoints everything back into the main file (and
// empties the wal file) so the single downloaded file is a complete, self-contained
// snapshot rather than missing whatever hasn't been checkpointed yet.
function backupFilePath() {
  const path = require("path");
  db.pragma("wal_checkpoint(TRUNCATE)");
  return path.resolve(process.env.DB_PATH || "./data/training.db");
}

function getUsers() {
  return db.prepare("SELECT u.*, l.name AS location_name FROM users u LEFT JOIN locations l ON l.id = u.location_id ORDER BY u.role, u.full_name").all();
}

const router = express.Router();

// Path-scoped deliberately — an unscoped router.use() here would block every other
// router mounted after this one (see the same gotcha noted in PMS-App/routes/admin.js).
router.use("/admin", requireLogin, requireAdmin);

router.get("/admin", (req, res) => res.redirect("/admin/users"));

router.get("/admin/users", (req, res) => {
  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  res.render("admin-users", { users: getUsers(), locations, activeTab: "users" });
});

router.post("/admin/users", (req, res) => {
  const { email, full_name, role, location_id, password } = req.body;
  if (role === "centre_manager" && !location_id) {
    return res.status(400).render("error", { message: "A centre is required for a Centre Manager login." });
  }
  const hash = bcrypt.hashSync(password || "Demo1234!", 10);
  db.prepare(`
    INSERT INTO users (email, password_hash, role, location_id, full_name)
    VALUES (?, ?, ?, ?, ?)
  `).run(email, hash, role, role === "centre_manager" ? parseInt(location_id, 10) : null, full_name);
  logAction(req, "user.create", `Created ${role} login for ${full_name} (${email})`);
  setFlash(req, "success", `Login created for ${full_name} (${email}).`);
  res.redirect("/admin/users");
});

router.post("/admin/users/:id/toggle", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return res.status(404).render("error", { message: "User not found." });
  db.prepare("UPDATE users SET active = ? WHERE id = ?").run(u.active ? 0 : 1, u.id);
  logAction(req, "user.toggle", `${u.active ? "Deactivated" : "Reactivated"} ${u.full_name} (${u.email})`);
  setFlash(req, "success", `${u.full_name} ${u.active ? "deactivated" : "reactivated"}.`);
  res.redirect("/admin/users");
});

// Lets Admin reset anyone's password (e.g. a Centre Manager forgot theirs) without
// needing the old one — there's no self-service "forgot password" flow, this is it.
router.post("/admin/users/:id/password", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return res.status(404).render("error", { message: "User not found." });

  const password = (req.body.password || "").trim();
  if (password.length < 8) {
    setFlash(req, "error", `Password not updated for ${u.full_name} — must be at least 8 characters.`);
    return res.redirect("/admin/users");
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, u.id);
  logAction(req, "user.password_reset", `Reset password for ${u.full_name} (${u.email})`);
  setFlash(req, "success", `Password updated for ${u.full_name}.`);
  res.redirect("/admin/users");
});

router.get("/admin/users/:id/edit", (req, res) => {
  const editUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!editUser) return res.status(404).render("error", { message: "User not found." });
  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  res.render("admin-user-edit", { editUser, locations, activeTab: "users" });
});

router.post("/admin/users/:id/edit", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return res.status(404).render("error", { message: "User not found." });

  const { email, full_name, role, location_id } = req.body;
  if (role === "centre_manager" && !location_id) {
    return res.status(400).render("error", { message: "A centre is required for a Centre Manager login." });
  }
  const locationId = role === "centre_manager" ? parseInt(location_id, 10) : null;

  try {
    db.prepare("UPDATE users SET email = ?, full_name = ?, role = ?, location_id = ? WHERE id = ?")
      .run(email, full_name, role, locationId, u.id);
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      setFlash(req, "error", `Can't update ${u.full_name} — ${email} is already used by another login.`);
      return res.redirect("/admin/users");
    }
    throw err;
  }

  logAction(req, "user.edit", `Edited ${u.full_name} (${u.email}) → ${full_name} (${email}), ${role}`);
  setFlash(req, "success", `${full_name} updated.`);
  res.redirect("/admin/users");
});

// Hard delete — distinct from toggle (deactivate), which just blocks login while
// preserving history. Blocked by the training_sessions.created_by foreign key if this
// user has created sessions; deactivating is the right call for someone with real
// history, so that's surfaced as guidance rather than a raw SQL error.
router.post("/admin/users/:id/delete", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return res.status(404).render("error", { message: "User not found." });

  if (req.session.user.id === u.id) {
    setFlash(req, "error", "You can't delete your own login while logged in as it.");
    return res.redirect("/admin/users");
  }

  try {
    db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
    logAction(req, "user.delete", `Deleted ${u.role} login for ${u.full_name} (${u.email})`);
    setFlash(req, "success", `${u.full_name} deleted.`);
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      setFlash(req, "error", `Can't delete ${u.full_name} — they've created training session(s) tied to this login. Deactivate instead to keep that history intact.`);
    } else {
      throw err;
    }
  }
  res.redirect("/admin/users");
});

router.get("/admin/sync", (req, res) => {
  const syncLog = db.prepare("SELECT * FROM sync_log ORDER BY run_at DESC LIMIT 10").all();
  res.render("admin-sync", { syncLog, activeTab: "sync" });
});

router.post("/admin/sync", async (req, res) => {
  const result = await runSync();
  if (result.ok) {
    logAction(req, "sync.run", `Employment Hero sync: ${result.staffSynced} active staff synced`);
    setFlash(req, "success", `Synced ${result.staffSynced} staff record(s).`);
  } else {
    logAction(req, "sync.run", `Employment Hero sync failed: ${result.error}`);
    setFlash(req, "error", `Sync failed: ${result.error}`);
  }
  res.redirect("/admin/sync");
});

router.get("/admin/backup", (req, res) => {
  res.render("admin-backup", { activeTab: "backup" });
});

router.get("/admin/export", (req, res) => {
  const filePath = backupFilePath();
  const stamp = new Date().toISOString().slice(0, 10);
  logAction(req, "backup.export", "Downloaded a database backup");
  res.download(filePath, `training-tracker-backup-${stamp}.db`);
});

router.get("/admin/audit", (req, res) => {
  const entries = db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200").all();
  res.render("admin-audit", { entries, activeTab: "audit" });
});

// Org-wide role holders (Operations Manager, General Manager, Quality & Compliance) that
// sit at the top of the IDP responsibility chains. One staff member each, org-wide, so
// the picker isn't centre-scoped. See services/responsibility.js for how these are used.
const ORG_ROLE_DEFS = [
  { key: "om", label: "Operations Manager" },
  { key: "gm", label: "General Manager" },
  { key: "qc", label: "Quality & Compliance" },
];

router.get("/admin/org-roles", (req, res) => {
  const holders = {};
  for (const { key } of ORG_ROLE_DEFS) {
    holders[key] = db.prepare("SELECT staff_id FROM org_roles WHERE role = ?").get(key)?.staff_id || null;
  }
  const staff = db.prepare("SELECT s.id, s.full_name, s.position_title, l.name AS location_name FROM staff s LEFT JOIN locations l ON l.id = s.location_id WHERE s.status = 'active' ORDER BY s.full_name").all();
  res.render("admin-org-roles", { orgRoleDefs: ORG_ROLE_DEFS, holders, staff, activeTab: "org-roles" });
});

router.post("/admin/org-roles", (req, res) => {
  const upsert = db.prepare(`
    INSERT INTO org_roles (role, staff_id, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(role) DO UPDATE SET staff_id = excluded.staff_id, updated_at = datetime('now')
  `);
  const txn = db.transaction(() => {
    for (const { key } of ORG_ROLE_DEFS) {
      const staffId = req.body[key] ? parseInt(req.body[key], 10) : null;
      upsert.run(key, staffId);
    }
  });
  txn();
  logAction(req, "org_roles.update", "Updated org-wide role holders (OM/GM/Q&C)");
  setFlash(req, "success", "Org roles updated.");
  res.redirect("/admin/org-roles");
});

module.exports = router;
