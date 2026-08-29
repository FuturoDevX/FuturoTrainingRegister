// Rotating point-in-time snapshots of the database. Run nightly by the cron in server.js,
// and available for a manual trigger from Admin. Guards against a bad deploy, an accidental
// delete, or logical corruption — none of which the single live .db file protects against.
//
// SCOPE: snapshots are written to a `backups/` folder on the same persistent disk as the
// live database (configurable via BACKUP_DIR). That covers everything except total loss of
// the disk itself. Shipping snapshots OFF the machine — object storage, or emailing the
// file — is the remaining step for true off-site safety; it needs a destination credential,
// so it's deliberately left as a follow-up. runBackup() returns the file it wrote, which an
// uploader could hand straight to that destination when it's added.

const fs = require("fs");
const path = require("path");
const db = require("../db/db");

// How many snapshots to keep. At one a night, 14 is a fortnight of restore points.
const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || "14", 10));

function backupDir() {
  const dbPath = process.env.DB_PATH || "./data/training.db";
  const dir = process.env.BACKUP_DIR || path.join(path.dirname(path.resolve(dbPath)), "backups");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Delete all but the newest KEEP snapshots (by modified time).
function prune(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("training-") && f.endsWith(".db"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(KEEP)) fs.unlinkSync(path.join(dir, f));
}

async function runBackup() {
  try {
    const dir = backupDir();
    // e.g. training-2026-08-29-0230.db — sortable, one-per-minute granularity is plenty.
    const stamp = new Date().toISOString().slice(0, 16).replace(/:/g, "").replace("T", "-");
    const dest = path.join(dir, `training-${stamp}.db`);
    // better-sqlite3's online backup — safe to run against a live, WAL-mode database and
    // guaranteed consistent, unlike a raw fs.copyFile which can miss un-checkpointed WAL writes.
    await db.backup(dest);
    prune(dir);
    return { ok: true, file: path.basename(dest), dir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { runBackup, backupDir };
