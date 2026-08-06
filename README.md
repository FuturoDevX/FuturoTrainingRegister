# Futuro Training Tracker

A small standalone app for Centre Managers to record and report on team training —
separate from `Dashboard/PMS-App` (which handles check-ins, PD-hours-as-a-Pillar-input,
pay, and the reward framework). This app is just: run a training session, mark who
attended, and pull a report.

## What it does

- **Login with 2 roles**: Admin sees every centre; Centre Manager only ever sees their
  own centre's staff and sessions, enforced server-side.
- **Training sessions**: a Centre Manager creates a session (title, date, provider,
  hours, optional notes) and marks attendance against their centre's active staff.
- **Open to all centres**: a session can be marked "open to all centres" at creation, so
  educators from any centre can attend a session hosted elsewhere. Each centre's own
  manager still only ever marks their own staff's attendance — never another centre's —
  regardless of which centre is hosting. Admin gets a per-centre summary on the
  attendance page (staff count + how many marked attended) with a link to switch between
  centres. Reports are unaffected either way, since hours/attendance are tracked per
  person, not per hosting centre.
- **Reports**:
  - By centre — Admin picks a centre (a Centre Manager goes straight to their own);
    see every active staff member with sessions-attended count and total hours, plus
    a CSV export.
  - By person — click through to one person's full training history and hours total,
    with a print button for a clean printable report.
- **Employment Hero sync**: keeps the staff/centre roster current. Unlike PMS-App, this
  does **not** exclude casual staff — training/compliance requirements generally apply
  to everyone at a centre, not just permanent staff. No pay data is touched. Centre
  assignment uses EH's real **Location** hierarchy (`primaryLocation` on the employee
  record, sourced from `GET /business/{id}/location`) — verified live that there is no
  separate cost-centre field on the employee record, so there's no ambiguity here.
  Centres: GWH, Bardia, Austral, LHR, Oran Park, Cobbitty, plus an Other/HQ catch-all for
  anyone not at a physical centre.
- **Admin**: run the EH sync manually, see the sync log, create/deactivate Centre
  Manager (or Admin) logins.

## Running it locally

```bash
npm install
cp .env.example .env    # then edit .env
npm run seed             # creates the database and demo data
npm start                 # http://localhost:3001
```

**Note on `DB_PATH`:** this folder lives inside OneDrive, which behaves like a
network-mounted filesystem — SQLite's WAL mode can throw `disk I/O error` there. Point
`DB_PATH` at a real local path instead (e.g. `/tmp/tt-data/training.db`, or anywhere
outside the OneDrive-synced folder) rather than the `./data/training.db` default. Not an
issue once this is actually deployed to a normal server.

After seeding, log in as:

- **Admin**: whatever email/password you set in `.env`
  (`ADMIN_EMAIL` / `ADMIN_DEFAULT_PASSWORD`) — change this password via the Admin
  panel's user list after first login (deactivate + recreate, since there's no
  in-app password-reset yet).
- **Demo Centre Managers** (one per centre): `cm.gwh@futuro.nsw.edu.au`,
  `cm.bardia@...`, `cm.austral@...`, `cm.lhr@...` — password `Demo1234!`

Seeded demo staff and training sessions are clearly fictional — run a real Employment
Hero sync from the Admin page to replace them.

## Connecting Employment Hero

`.env`'s `EH_API_KEY` / `EH_BASE_URL` / `EH_BUSINESS_ID` are already filled in with the
same credentials used elsewhere in this Dashboard
(`Dashboard/_pipeline/employment_hero/eh_payroll_credentials.json`). **Verified working**
against the live API during setup — a real sync pulled 353 staff records across all 4
centres + Other/HQ. Click **"Run sync now"** on the Admin page any time, or wait for the
nightly cron (5:50am).

## Deploying to Render

Render is the confirmed hosting choice (same as PMS-App). `render.yaml` in this folder
is a Blueprint — Render reads it and creates the web service + persistent disk
automatically, you don't need to click through the settings by hand.

1. **Push this folder to a GitHub repo.** From inside `TrainingTracker-App/`:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```
   Then create an empty repo on GitHub (via github.com — "New repository", don't
   initialise it with a README) and follow GitHub's "push an existing repository"
   instructions it shows you, e.g.:
   ```bash
   git remote add origin https://github.com/<your-username>/futuro-training-tracker.git
   git branch -M main
   git push -u origin main
   ```
2. **On [render.com](https://render.com)**: New → Blueprint → connect your GitHub
   account → select the repo you just pushed. Render will detect `render.yaml` and
   show you the service + disk it's about to create.
3. Render will prompt for the env vars marked secret in `render.yaml`
   (`EH_API_KEY`, `EH_BUSINESS_ID`, `ADMIN_DEFAULT_PASSWORD`) — copy these from your
   local `.env`. Everything else (`SESSION_SECRET`, `DB_PATH`, etc.) is already set.
4. Deploy. Once it's live, open the Render service's **Shell** tab and run
   `npm run seed` once to initialise the database (creates the Admin login and demo
   Centre Manager logins).
5. Log in as Admin and change the default password via the Admin page's user list
   (deactivate the seeded account, create a new one with a real password) — same
   caveat as local: no in-app password-reset yet.
6. From the Admin page, click **"Run sync now"** to pull the real staff roster, then
   create the real Centre Manager logins (Admin → New login) and deactivate/remove the
   demo ones.

**Never commit your `.env` file** — it's already gitignored, and `render.yaml`
deliberately leaves the secret values blank (`sync: false`) so they only ever live in
Render's dashboard, not in the repo.

## Project structure

```
render.yaml                — Render Blueprint (web service + persistent disk)
server.js                  — app entry point, session setup, nightly EH sync cron
db/schema.sql               — table definitions
db/init.js                  — creates schema + seeds locations/admin/demo data
db/db.js                    — SQLite connection
services/employmentHero.js  — EH staff/centre roster sync (no pay data, casuals included)
middleware/auth.js          — login requirement, admin check, centre scoping
routes/                     — auth, training sessions/attendance, reports, admin
views/                      — EJS templates
public/style.css            — all styling, no framework
```

## Known follow-ups (not blockers, just noted)

- Password reset has no UI yet — an Admin can deactivate a login and create a new one
  from the Admin page as a workaround.
- No automated test suite — this was smoke-tested manually (login for both roles,
  cross-centre access blocking, session creation, attendance save/update, centre and
  person reports, CSV export, EH sync error path with no credentials set).
- If this app and PMS-App are ever meant to share one staff roster instead of syncing
  from Employment Hero independently, that's a bigger design decision (shared DB vs.
  an API between the two) — deliberately not attempted here since the brief was for a
  standalone app.
