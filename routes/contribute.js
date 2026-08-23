// Public, NO-LOGIN routes for magic-link contributions. Mounted without requireLogin —
// access is gated entirely by possession of an unguessable, unexpired, un-revoked token
// (see services/contribLinks.js). A valid token grants exactly one thing: submitting a
// note against ONE plan. It never exposes other people's data, and submissions land as
// 'pending' for the Centre Manager to review — they never touch the plan directly.
const express = require("express");
const db = require("../db/db");
const { findValidLink } = require("../services/contribLinks");
const { logEvent } = require("../services/audit");

const router = express.Router();

function context(link) {
  const idp = db.prepare("SELECT * FROM idps WHERE id = ?").get(link.idp_id);
  const person = db.prepare("SELECT full_name FROM staff WHERE id = ?").get(idp.staff_id);
  const inviter = link.created_by ? db.prepare("SELECT full_name FROM users WHERE id = ?").get(link.created_by) : null;
  const goals = db.prepare("SELECT id, title FROM idp_goals WHERE idp_id = ? ORDER BY created_at").all(idp.id);
  return { idp, person, inviter, goals };
}

router.get("/contribute/:token", (req, res) => {
  const link = findValidLink(req.params.token);
  if (!link) return res.status(404).render("contribute-invalid");
  const { person, inviter, goals } = context(link);
  res.render("contribute", { token: req.params.token, person, inviter, goals, done: false, error: null });
});

router.post("/contribute/:token", (req, res) => {
  const link = findValidLink(req.params.token);
  if (!link) return res.status(404).render("contribute-invalid");
  const { idp, person, inviter, goals } = context(link);

  const author = (req.body.author_label || "").trim();
  const body = (req.body.body || "").trim();
  if (!author || !body) {
    return res.render("contribute", { token: req.params.token, person, inviter, goals, done: false, error: "Please add your name and your note." });
  }
  let goalId = null;
  if (req.body.goal_id) {
    const g = db.prepare("SELECT id FROM idp_goals WHERE id = ? AND idp_id = ?").get(parseInt(req.body.goal_id, 10), idp.id);
    if (g) goalId = g.id;
  }
  db.prepare("INSERT INTO idp_contributions (idp_id, link_id, goal_id, author_label, body) VALUES (?, ?, ?, ?, ?)")
    .run(idp.id, link.id, goalId, author, body);
  logEvent(null, null, "contrib.submit", `${author} submitted input for ${person.full_name}'s IDP (via magic link)`);

  res.render("contribute", { token: req.params.token, person, inviter, goals, done: true, error: null });
});

module.exports = router;
