# A staging copy, and how to put a release on it first

## Read this part first

Right now every shop is on one Vercel project. A bad deploy takes all six down
at once, and there is nowhere to try a release before the shops are on it.

The fix is a **second Vercel project, from the same repository**, with its own
databases. Same code, different data. You deploy there first, look at it, and
only then deploy the live one.

**The trade-off you are accepting:** one more project to keep variables in
sync on, and one more Turso database to pay for. Both are small. What you get
is that a mistake happens to a shop that does not exist.

**The one thing that must never happen:** the staging project pointed at the
live shops' data. That is not a hypothetical — it is one environment variable
copied from the wrong place, and it is the accident this whole document is
arranged around. There is a guard in the code for exactly it; see *"What the
guard says if you get it wrong"* at the end.

Creating the second project is your click, in your Vercel account. Everything
around it is already built.

---

## Step 0 — label the live project. Do this first, today.

Before you create anything, add **one variable** to the project that is live
right now, for **Production**:

| Variable | Value |
|---|---|
| `MM_DEPLOYMENT` | `production` |

Then redeploy.

Do this first for two reasons.

1. Until you do, the live ERP, the live console and the live storefronts will
   carry a yellow-and-black hazard frame and the word **Staging**. That is
   deliberate. A deployment that has not said what it is gets treated as
   staging, because a staging deployment mistaken for the real one is silent
   and expensive, while the real one mistaken for staging is loud and free.
   Nothing breaks; it just looks wrong until you set the variable.
2. Setting it writes "this is production" **into the control-plane database**,
   permanently. That mark is what lets the guard later recognise a staging
   deployment that has been pointed at the live data. Until the live project is
   labelled, there is nothing for the guard to compare against.

Check it worked:

```bash
curl -s https://<your-live-app>/api/health | grep -o '"environment":"[a-z]*"'
# "environment":"production"
```

---

## Step 1 — create the second Vercel project

Vercel dashboard → **Add New… → Project** → the same Git repository → **Import**.

Use the same settings the live project uses (`DEPLOY-VERCEL.md`, *"Settings to
enter in Vercel"*): Framework Preset **Other**, no build command, no output
directory, Node 22.x or 24.x.

Give it a name you cannot misread at a glance — `mm-staging`, not `mm-erp-2`.

**Do not deploy it yet.** It has no variables, so it would come up on nothing.

---

## Step 2 — the variables

Three groups. The middle one is the group that matters.

### Different on each project — set both, and never copy one to the other

| Variable | Live project | Staging project |
|---|---|---|
| `MM_DEPLOYMENT` | `production` | `staging` |
| `MM_PLATFORM_DB_URL` | the live control plane | **its own** (Step 3) |
| `MM_PLATFORM_DB_TOKEN` | the live control plane's token | **its own** |
| `TURSO_DATABASE_URL` | the live default shop database | **its own** |
| `TURSO_AUTH_TOKEN` | that database's token | **its own** |
| `MM_JWT_SECRET` | the live one | **a new one** (generate it again) |
| `CRON_SECRET` | the live one | **a new one**, or leave it off staging |

### Must never be shared, and there is no exception

`MM_PLATFORM_DB_URL`, `MM_PLATFORM_DB_TOKEN`, `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN`. These four are what a deployment writes to. Copying any of
them from the live project into the staging project is the accident. If you
find yourself pasting from one browser tab to the other, stop.

`MM_JWT_SECRET` is on the same list for a different reason: it signs sessions.
Sharing it means a session minted on staging is accepted by production.

`TURSO_API_TOKEN` — if you have connected Turso in KJ Admin so the console can
create databases for you — must not be shared either. It can create and destroy
every database in your Turso organisation.

Generate the two new secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # MM_JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # CRON_SECRET
```

### Safe to be the same on both

| Variable | Value |
|---|---|
| `MM_OPEN_BROWSER` | `false` |
| `MM_PLATFORM_OWNER_PASSWORD` | your console password — a different one on staging is better, but sharing it costs nothing |
| `MM_DEFAULT_TENANT` | the slug of the shop that answers at `/` |

### Set every variable for Production, Preview **and** Development

Same as the live project. One thing to know about Preview: **a Vercel Preview
deployment can never be production**, whatever `MM_DEPLOYMENT` says. Preview
deployments inherit the project's variables, so a branch push on the live
project would otherwise produce a throwaway deployment writing to the live
control plane. The code forces those to staging, and the guard then refuses
them — which is what you want. If a preview deployment shows the refusal below,
that is not a bug; it is the hole being closed.

---

## Step 3 — a control plane for staging

The control plane is the database that holds the list of shops, your console
account, and every backup. Staging needs its **own**. There are two ways, and
both are fine.

### (a) A fresh, empty one — five minutes, nothing in it

Vercel dashboard → the **staging** project → Storage → Marketplace → **Turso
Cloud** → create a database → connect it to the staging project.

Then in the staging project's Environment Variables, set `MM_PLATFORM_DB_URL`
and `MM_PLATFORM_DB_TOKEN` to that database's URL and token, and deploy.

An empty control plane is labelled `staging` on the first request and that is
the end of it. You then create test shops in KJ Admin as normal. Nothing is
blocked, and the shops you make are yours to break.

### (b) A copy of production — realistic data, one extra variable

Sometimes you want the real shape of the data. In the Turso dashboard, fork or
restore the live control-plane database into a new one, and point the staging
project at the copy.

The copy arrives carrying production's label, so **the first deploy will refuse
to start** — correctly, because from the outside a copy of production and
production itself look identical. Say out loud that you meant it:

| Variable | Value |
|---|---|
| `MM_CONTROL_PLANE_REPURPOSE` | `staging` |

Deploy once. The database is re-labelled `staging`, a row is written to the
console's audit trail recording that it used to be production, and the log says
so. **Then delete the variable** and deploy again. Leaving it set would let the
same thing happen by accident next time.

The value has to be the word `staging`, not `1` or `true`. A variable somebody
sets without reading must not be enough to re-label a production database.

> Whichever way you go: the shop databases behind those tenant rows are still
> the **live** ones. A copied control plane copies the *register*, not the
> shops. Before you touch anything on staging, open KJ Admin → Shops and repoint
> or delete every tenant that names a real database. Or use (a) and avoid the
> question.

---

## Step 4 — how a release goes out from now on

1. **Push to a branch.** Deploy that branch to the **staging** project
   (Vercel → staging project → Deployments → Deploy, or set the staging project
   to auto-deploy your `staging` branch).
2. **Look at it.** Open the staging URL. You will know it is staging: hazard
   frame, the word on screen, `[Staging]` in the browser tab. Sign in, ring up
   a sale, place an order on the storefront, take a backup.
3. **Merge to the branch the live project deploys** (`main`). The live project
   builds and goes out.
4. **Check the live one is still labelled:**
   ```bash
   curl -s https://<your-live-app>/api/health | grep -o '"environment":"[a-z]*"'
   ```
   `"production"`, and no frame on any screen.
5. **If it went wrong:** Vercel → live project → Deployments → the previous one
   → **Promote to Production**. That is instant and needs nothing from this
   repository. Nothing about a rollback touches a shop's data.

Nothing is copied from staging to production but the code. Data never moves
between them in either direction — that is the whole point.

---

## What the guard says if you get it wrong

The guard runs once, when a deployment first opens its control plane, and it
stops the deployment rather than warning it. You will see this in the Vercel
function logs, and every request answers with it.

**If the staging project is pointed at the live control plane:**

```
  ✖ REFUSING TO START — this deployment says it is STAGING, but the
    control-plane database it opened says it is PRODUCTION.

    One of the two is wrong, and a deployment that guesses here writes to
    the wrong shops.

  What to do — one of these, and nothing else is needed:
    · If this deployment really is STAGING, it is pointed at the wrong
      database. Fix MM_PLATFORM_DB_URL / MM_PLATFORM_DB_TOKEN on this project.
    · If this deployment is NOT STAGING, say so: set MM_DEPLOYMENT to
      production, staging or local, and redeploy.
    · If you meant to turn this database into a STAGING one — a staging
      control plane copied from production is a normal thing to have — set
      MM_CONTROL_PLANE_REPURPOSE=staging once, redeploy, then remove it.

  Nothing was read from this database and nothing was written to it.
```

Almost always the first line of the remedy is the right one: fix
`MM_PLATFORM_DB_URL` on the staging project.

**If you skipped Step 0 and pointed staging at the live control plane before it
was ever labelled:**

```
  ✖ REFUSING TO START — this deployment says it is STAGING, but the
    control-plane database it opened already holds 6 shop(s) and has
    never been labelled.

    A control plane with shops in it that nobody has labelled is production
    until somebody says otherwise. A STAGING deployment will not adopt
    one.
```

Same three ways out. Same first answer.

**If the live project loses `MM_DEPLOYMENT`:** it will refuse to start with the
first message, the other way round — *says it is STAGING, database says it is
PRODUCTION*. Put the variable back and redeploy, or promote the previous
deployment while you do. It is one variable, and Vercel does not lose them on
its own; this happens when somebody edits the wrong project.

---

## Things that will bite you

- **The live shops sprout a staging banner after a deploy.** `MM_DEPLOYMENT` is
  not set on the environment being served. Usually it was added to Preview and
  not to Production. Step 0.

- **A preview deployment refuses to start.** Expected, and correct — see Step 2.
  Previews inherit the live project's variables, so they are staging code with
  production's control plane. If you need a preview to run properly, give it its
  own control plane in the Preview scope of the variables.

- **Staging shows the real shops' names and takings.** You used option (b) and
  did not repoint the tenants. The control plane was copied; the shop databases
  it names were not. Open KJ Admin → Shops on staging and fix every row before
  you do anything else.

- **`MM_CONTROL_PLANE_REPURPOSE` still set weeks later.** Remove it. While it is
  there, that project will silently re-label whatever control plane it is
  pointed at, which is the guard switched off.

- **Sessions dropping at random on staging.** `MM_JWT_SECRET` was not set on the
  new project. It is required on any hosted deployment (see `DEPLOY-VERCEL.md`).

- **Backups running twice a day on staging and filling a database with copies of
  nothing.** Leave `CRON_SECRET` unset on the staging project; the cron route
  refuses everything without it, which is the correct behaviour there.

- **The shop PC.** Nothing here applies to it. `START.bat` on the counter
  machine is not a deployment: it has no `MM_DEPLOYMENT`, it gets no banner, and
  the guard is not armed for a control plane that is a file on the machine you
  are standing at. Do not add these variables to it.
