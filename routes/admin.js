const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db/db");
const { requireLogin, requireAdmin } = require("../middleware/auth");
const { setFlash } = require("../middleware/flash");
const { runSync } = require("../services/employmentHero");

const router = express.Router();

// Path-scoped deliberately — an unscoped router.use() here would block every other
// router mounted after this one (see the same gotcha noted in PMS-App/routes/admin.js).
router.use("/admin", requireLogin, requireAdmin);

router.get("/admin", (req, res) => {
  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  const users = db.prepare("SELECT u.*, l.name AS location_name FROM users u LEFT JOIN locations l ON l.id = u.location_id ORDER BY u.role, u.full_name").all();
  const syncLog = db.prepare("SELECT * FROM sync_log ORDER BY run_at DESC LIMIT 10").all();
  res.render("admin", { locations, users, syncLog, syncResult: null });
});

router.post("/admin/sync", async (req, res) => {
  const result = await runSync();
  const locations = db.prepare("SELECT * FROM locations ORDER BY name").all();
  const users = db.prepare("SELECT u.*, l.name AS location_name FROM users u LEFT JOIN locations l ON l.id = u.location_id ORDER BY u.role, u.full_name").all();
  const syncLog = db.prepare("SELECT * FROM sync_log ORDER BY run_at DESC LIMIT 10").all();
  res.render("admin", { locations, users, syncLog, syncResult: result });
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
  setFlash(req, "success", `Login created for ${full_name} (${email}).`);
  res.redirect("/admin");
});

router.post("/admin/users/:id/toggle", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return res.status(404).render("error", { message: "User not found." });
  db.prepare("UPDATE users SET active = ? WHERE id = ?").run(u.active ? 0 : 1, u.id);
  setFlash(req, "success", `${u.full_name} ${u.active ? "deactivated" : "reactivated"}.`);
  res.redirect("/admin");
});

// Lets Admin reset anyone's password (e.g. a Centre Manager forgot theirs) without
// needing the old one — there's no self-service "forgot password" flow, this is it.
router.post("/admin/users/:id/password", (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!u) return res.status(404).render("error", { message: "User not found." });

  const password = (req.body.password || "").trim();
  if (password.length < 8) {
    setFlash(req, "error", `Password not updated for ${u.full_name} — must be at least 8 characters.`);
    return res.redirect("/admin");
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, u.id);
  setFlash(req, "success", `Password updated for ${u.full_name}.`);
  res.redirect("/admin");
});

module.exports = router;
