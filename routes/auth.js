const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db/db");
const { logEvent } = require("../services/audit");

const router = express.Router();

router.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/training");
  res.render("login", { error: null });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ? AND active = 1").get(email);

  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    // Logged even when the email doesn't match any account — repeated failures against
    // one address is exactly what you'd want to notice (e.g. someone guessing passwords).
    logEvent(email || null, null, "auth.login_failure", `Failed login attempt from ${req.ip}`);
    return res.render("login", { error: "Incorrect email or password." });
  }

  req.session.user = {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    location_id: user.location_id,
  };
  logEvent(user.email, user.role, "auth.login_success", `Logged in from ${req.ip}`);
  res.redirect("/home");
});

router.post("/logout", (req, res) => {
  const user = req.session.user;
  if (user) logEvent(user.email, user.role, "auth.logout", null);
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
