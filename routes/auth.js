const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("../db/db");
const { logEvent } = require("../services/audit");

const router = express.Router();

// Throttle password guessing. Keyed by IP; only FAILED attempts count toward the limit
// (skipSuccessfulRequests skips 2xx/3xx, and a failed login below returns 401), so a
// legitimate user logging in normally is never locked out — only an attacker hammering
// wrong passwords hits the wall after 10 tries in 15 minutes.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logEvent(req.body && req.body.email ? req.body.email : null, null, "auth.login_ratelimited", `Rate-limited login from ${req.ip}`);
    res.status(429).render("login", { error: "Too many attempts. Please wait a few minutes and try again." });
  },
});

router.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/home");
  res.render("login", { error: null });
});

router.post("/login", loginLimiter, (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ? AND active = 1").get(email);

  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    // Logged even when the email doesn't match any account — repeated failures against
    // one address is exactly what you'd want to notice (e.g. someone guessing passwords).
    // 401 (not 200) so the rate-limiter above counts this as a failed attempt.
    logEvent(email || null, null, "auth.login_failure", `Failed login attempt from ${req.ip}`);
    return res.status(401).render("login", { error: "Incorrect email or password." });
  }

  // Regenerate the session on login (new session ID) to close the session-fixation window —
  // a session ID handed to the browser before login can't be reused once authenticated.
  req.session.regenerate((err) => {
    if (err) {
      logEvent(email, user.role, "auth.login_error", `Session regenerate failed: ${err.message}`);
      return res.status(500).render("login", { error: "Something went wrong signing you in. Please try again." });
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
});

router.post("/logout", (req, res) => {
  const user = req.session.user;
  if (user) logEvent(user.email, user.role, "auth.logout", null);
  req.session.destroy(() => res.redirect("/login"));
});

module.exports = router;
