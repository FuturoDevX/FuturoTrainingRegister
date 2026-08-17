const db = require("../db/db");

const insert = db.prepare(`
  INSERT INTO audit_log (actor_email, actor_role, action, detail)
  VALUES (?, ?, ?, ?)
`);

// req is optional — pass null for unattended actions (e.g. the nightly EH sync cron,
// which isn't triggered by any logged-in user).
function logAction(req, action, detail) {
  const user = req && req.session && req.session.user;
  insert.run(user ? user.email : null, user ? user.role : null, action, detail || null);
}

// Lower-level primitive for cases with no req.session.user to pull from — e.g. a failed
// login attempt (no session yet) or a login success (session isn't set until after).
function logEvent(actorEmail, actorRole, action, detail) {
  insert.run(actorEmail || null, actorRole || null, action, detail || null);
}

module.exports = { logAction, logEvent };
