# Deploying M&M Accessories ERP to Vercel

## Read this part first

Vercel runs your code as functions with **no durable disk**. Vercel's own
documentation says plainly that *"SQLite can't be used with Vercel"*, because
storage does not survive between invocations and two instances do not share it.

So the hosted deployment does not use the SQLite file at all. It talks to
**Turso** — SQLite spoken over the network. `schema.sql` is reused
byte-for-byte; only the transport changes.

**The trade-off you are accepting:** the shop can no longer sell without
internet. The local install (`START.bat`) keeps working and stays offline-capable
— keep it on the counter PC as the fallback, because a dead connection at 6pm on
a Thursday should not mean a dead till.

The two installs have **separate data**. They do not sync.

---

## Settings to enter in Vercel

| Setting | Value |
|---|---|
| **Framework Preset** | **Other** (if `Express` is offered, pick that) |
| Build Command | *leave empty* |
| Output Directory | *leave empty* |
| Install Command | `npm install` |
| Root Directory | *leave empty* |
| Node.js Version | 22.x or 24.x |

**Not Nuxt.** Nothing here is Nuxt, Next, or any framework — it is an Express
server plus plain ES-module files, with no build step.

## Environment variables

Two come from the Turso integration, two you set yourself.

| Variable | Where it comes from | Required |
|---|---|---|
| `TURSO_DATABASE_URL` | Turso integration, automatically | yes |
| `TURSO_AUTH_TOKEN` | Turso integration, automatically | yes |
| `MM_JWT_SECRET` | you generate it (below) | **yes** |
| `MM_OPEN_BROWSER` | set to `false` | recommended |

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`MM_JWT_SECRET` is not optional on a hosted deployment. Locally the app
generates one and keeps it in `data/.session-secret`; with many instances and no
shared disk each would mint its own and sign users out at random. The app refuses
to start without it rather than fail mysteriously later.

Do **not** set `MM_DATA_DIR` or `MM_DB_FILE`. Setting `TURSO_DATABASE_URL` is
what switches the driver — there is no separate flag to remember.

## Steps

1. **Add the database.** Vercel dashboard → Storage → Marketplace → **Turso
   Cloud** → create a database and connect it to this project. That injects
   `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. (CLI equivalent:
   `vc i tursocloud/database`.)

2. **Add `MM_JWT_SECRET`** and `MM_OPEN_BROWSER=false` in Project Settings →
   Environment Variables, for Production, Preview and Development.

3. **Create the tables and the first user.** This runs once, from your own
   machine, against the hosted database — not on every cold start, because a
   serverless instance should not be running DDL while a customer waits:

   ```bash
   vercel link
   vercel env pull .env.local

   # then, with those two variables in your shell:
   npm run db:migrate
   npm run db:seed          # baseline only
   npm run db:seed -- --demo   # baseline + one worked example
   ```

4. **Deploy.** Push to the connected branch, or `vercel --prod`.

5. **Sign in** at your Vercel URL with `admin` / `admin123` and change the
   password immediately. It is a public URL now, not a shop LAN.

## After deploying

- **Change the admin password first.** The seeded one is documented publicly.
- **Set `secure: true` on the session cookie** if you keep this permanently.
  `src/api/routes/index.js` sets `secure: false` because the local install runs
  on plain-HTTP localhost.
- **Backups are Turso's job now.** The Settings → Backups screen refuses to run
  on a hosted database instead of writing a file that would vanish; use Turso's
  point-in-time restore.
- **The printer and scanner still work.** Both are driven from the browser on the
  machine the user is sitting at, so Settings → Devices behaves the same.

## Things that will bite you

- **`npm install` failing on a native module** — it should not; this project has
  zero dependencies that need a compiler. If it happens, check nothing new was
  added to `dependencies`.
- **A blank page but a working `/api/health`** — Vercel serves `public/**` from
  its CDN and ignores `express.static()`. The SPA uses hash routing, so no
  rewrites are needed; if assets 404, confirm `public/` was not excluded.
- **`MM_JWT_SECRET must be set`** in the build or function logs — step 2 was
  skipped, or the variable was not added to the environment being deployed.
- **Empty screens after a successful deploy** — step 3 was skipped, so the
  database has no tables.
