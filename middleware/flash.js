// One-shot flash messages across a redirect (session-based — survives the redirect,
// cleared on the next render). setFlash before a res.redirect(); the flash middleware
// below exposes it to the view as res.locals.flash and clears it immediately after.
function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function flashMiddleware(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
}

module.exports = { setFlash, flashMiddleware };
