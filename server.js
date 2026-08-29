require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cron = require("node-cron");
const path = require("path");

const db = require("./db/db"); // ensures data/ dir exists and base schema is created
require("./db/migrate"); // idempotent — patches databases created before a schema change
const { runSync } = require("./services/employmentHero");
const { runBackup } = require("./services/backup");
const { flashMiddleware } = require("./middleware/flash");
const { logAction } = require("./services/audit");
const SqliteStore = require("better-sqlite3-session-store")(session);

const authRoutes = require("./routes/auth");
const contributeRoutes = require("./routes/contribute");
const homeRoutes = require("./routes/home");
const trainingRoutes = require("./routes/training");
const developmentRoutes = require("./routes/development");
const reportRoutes = require("./routes/report");
const adminRoutes = require("./routes/admin");

const app = express();

// Render sits in front of the app as a single reverse-proxy hop (TLS termination) — without
// this, req.ip is always Render's internal proxy address, making the login audit's IP field
// useless. Set to 1 (trust exactly one hop), NOT true: `true` trusts any X-Forwarded-For a
// client sends, which would let an attacker spoof their IP past the login rate-limiter and
// forge audit entries.
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Refuse to boot in production on the dev fallback secret — a known secret means anyone can
// forge a session cookie. (Render sets SESSION_SECRET via render.yaml's generateValue.)
const isProd = process.env.NODE_ENV === "production";
if (isProd && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production — refusing to start on the dev fallback.");
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    // Persist sessions in the app's own SQLite database (reusing the better-sqlite3
    // connection) instead of the default in-memory store — so a deploy or restart no longer
    // logs everyone out, and there's no MemoryStore leak. `expired.clear` sweeps stale rows.
    store: new SqliteStore({
      client: db,
      expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    cookie: {
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
      httpOnly: true,
      sameSite: "lax", // don't send the cookie on cross-site POSTs — the app's CSRF defence
      secure: isProd, // HTTPS-only cookie in production; off locally so http://localhost works
    },
  })
);

app.use(flashMiddleware);

app.get("/", (req, res) => res.redirect(req.session.user ? "/home" : "/login"));

app.use(authRoutes);
app.use(contributeRoutes); // public, no-login magic-link routes
app.use(homeRoutes);
app.use(trainingRoutes);
app.use(developmentRoutes);
app.use(reportRoutes);
app.use(adminRoutes);

app.use((req, res) => res.status(404).render("error", { message: "Page not found." }));

// Nightly Employment Hero sync at 5:50am — 5 minutes after PMS-App's own sync, so both
// stay close in timing without hitting the EH API at the exact same second.
cron.schedule("50 5 * * *", () => {
  console.log("Running scheduled Employment Hero sync...");
  runSync().then((r) => {
    console.log("Sync result:", r);
    // req is null — this is unattended, no logged-in user to attribute it to.
    logAction(null, "sync.run", r.ok ? `Nightly Employment Hero sync: ${r.staffSynced} active staff synced` : `Nightly Employment Hero sync failed: ${r.error}`);
  });
});

// Nightly rotating snapshot at 2:30am — a point-in-time backup of the database, so a bad
// deploy, an accidental delete, or logical corruption is recoverable (Render's disk has no
// automatic point-in-time recovery). Snapshots currently land on the same persistent disk;
// shipping them off the machine (object storage / email) is a follow-up — see services/backup.js.
cron.schedule("30 2 * * *", () => {
  runBackup().then((r) => {
    console.log("Backup result:", r);
    logAction(null, "backup.auto", r.ok ? `Nightly backup written: ${r.file}` : `Nightly backup failed: ${r.error}`);
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Futuro Training Tracker running on http://localhost:${PORT}`));
