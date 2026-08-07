const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
require("dotenv").config();

const dbPath = process.env.DB_PATH || "./data/training.db";
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Base schema is created here — not just in db/init.js's seed script — so any fresh
// database (e.g. a brand new Render disk on first boot, before anyone's had a chance to
// run `npm run seed`) always has its tables before db/migrate.js's ALTER TABLE-style
// patches run against it. All CREATE TABLE statements in schema.sql are IF NOT EXISTS,
// so this is safe to re-run on an already-seeded database too.
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

module.exports = db;
