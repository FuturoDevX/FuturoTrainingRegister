function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  res.locals.user = req.session.user; // available in every view
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).render("error", { message: "Admin access required." });
  }
  next();
}

// Restricts a Centre Manager's view to their own location. Admin sees everything
// (undefined = no filter).
function scopedLocationId(req) {
  const user = req.session.user;
  if (!user) return undefined;
  return user.role === "centre_manager" ? user.location_id : undefined;
}

module.exports = { requireLogin, requireAdmin, scopedLocationId };
