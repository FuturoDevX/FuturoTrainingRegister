const crypto = require("crypto");
const db = require("../db/db");

// A link is usable only while it exists, hasn't been revoked, and hasn't expired.
// Checked in SQL so the expiry uses SQLite's own clock, consistently with how it's stamped.
function findValidLink(token) {
  if (!token || !/^[a-f0-9]{16,64}$/.test(token)) return null;
  return db.prepare(
    "SELECT * FROM idp_contrib_links WHERE token = ? AND revoked_at IS NULL AND expires_at > datetime('now')"
  ).get(token);
}

function newToken() {
  return crypto.randomBytes(24).toString("hex"); // 48 hex chars, unguessable
}

module.exports = { findValidLink, newToken };
