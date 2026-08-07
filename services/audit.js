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

module.exports = { logAction };
