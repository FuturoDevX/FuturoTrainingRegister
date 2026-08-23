require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cron = require("node-cron");
const path = require("path");

const db = require("./db/db"); // ensures data/ dir exists and base schema is created
require("./db/migrate"); // idempotent — patches databases created before a schema change
const { runSync } = require("./services/employmentHero");
const { flashMiddleware } = require("./middleware/flash");
const { logAction } = require("./services/audit");

const authRoutes = require("./routes/auth");
const contributeRoutes = require("./routes/contribute");
const homeRoutes = require("./routes/home");
const trainingRoutes = require("./routes/training");
const developmentRoutes = require("./routes/development");
const reportRoutes = require("./routes/report");
const adminRoutes = require("./routes/admin");

const app = express();

// Render sits in front of the app as a reverse proxy — without this, req.ip always
// returns Render's internal proxy address instead of the real visitor IP, which would
// make the login audit's IP field useless (every entry showing the same address).
app.set("trust proxy", true);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Futuro Training Tracker running on http://localhost:${PORT}`));
