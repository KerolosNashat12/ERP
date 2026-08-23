# M&M Accessories — Offline ERP

A complete, offline-first ERP and point-of-sale system for an accessories retail
business. It runs as a single Node process on one machine, stores everything in
a local SQLite file, and serves a bilingual (English / العربية) web interface at
`http://localhost:4000`. No internet connection is needed after installation.

---

## 1. Run it

**Prerequisites:** Node.js **22 or newer** ([nodejs.org](https://nodejs.org)). Nothing else —
no database server, no build tools, no Visual Studio, no Python.

### On Windows — just double-click

| File | What it does |
|---|---|
| **`START.bat`** | Installs dependencies the first time, creates the database if it's missing, then starts the system and opens your browser. This is the one you use every day. |
| **`RESET-DATABASE.bat`** | Wipes the database and rebuilds it fresh (keeping a timestamped backup). Use it after updating to a new version, or to clear the example data before entering your real catalogue. |

Keep the black window open while you're using the system; closing it stops the
server. Press `Ctrl+C` in it to stop.

### Any platform — from a terminal

```bash
npm install        # installs dependencies (one time, needs internet)
npm run setup      # creates the database + demo data
npm start          # starts the server and opens your browser
```

Then open **http://localhost:4000** if it did not open by itself.

| Username      | Password      | Role                |
|---------------|---------------|---------------------|
| `admin`   | `admin123`   | Administrator |
| `cashier` | `cashier123` | Cashier — so you can see the role restrictions working |

The other roles (Store Manager, Inventory Clerk, Accountant) exist and are ready
to use; add people to them under **Users & Roles**.

The example data is deliberately small: **one** supplier, brand, category,
product (with its size × colour variants), client and promo code, plus one
received purchase order and one sale. Enough to see every screen populated,
quick to delete when your real catalogue goes in.

You will be asked to change the admin password on first sign-in. **Do that before
going live.**

### Updating to a newer version

The database schema changes between versions, so an old database file will not
work with new code. After replacing the source files:

1. Double-click **`RESET-DATABASE.bat`** (or run `npm run db:reset && npm run setup`).
2. Double-click **`START.bat`**.

Your previous database is archived to `data/backups/` first, so nothing is lost.

### Starting clean (no example data)

```bash
npm run db:reset     # archives the current database
npm run db:migrate   # rebuilds the empty schema
npm run db:seed      # roles, permissions, admin user, settings, attributes only
npm start
```

### Other commands

| Command             | What it does                                                     |
|---------------------|------------------------------------------------------------------|
| `npm run dev`       | Start with auto-restart while editing code                       |
| `npm run backup`    | Write a consistent copy of the database file to `data/backups/` (`VACUUM INTO`, safe while trading; file driver only — a hosted shop uses *Settings → Backups → Download a copy of my data*) |
| `npm run backup:shop -- --all` | On a fleet: back up every active shop into the control plane |
| `npm run backup:shop -- mm --out ./mm.zip` | …and also write that shop's file to disk |
| `npm run restore:shop -- mm --list` | List a shop's backups; `--backup <id>` puts one back |
| `npm run db:demo`   | Add the demo dataset to an existing database                     |
| `npm test`          | Run the end-to-end API test suite (starts the app itself)         |

### Configuration

Everything has a sensible default. Override with environment variables:

```bash
MM_PORT=8080 MM_HOST=0.0.0.0 npm start     # serve to other PCs on the shop LAN
MM_DATA_DIR=/media/usb/mm-data npm start   # keep the database on a USB drive
MM_OPEN_BROWSER=false npm start            # don't auto-open a browser
```

Setting `MM_HOST=0.0.0.0` lets a second till or the back-office PC use the same
database over the local network — still with no internet involved.

### Hosting it online as well

The same code runs against either of two databases, chosen by environment:

| Driver | What it is | Where it is used |
|---|---|---|
| `sqlite` (default) | a local file, `data/mm-accessories.db` | the shop counter — offline, no account |
| `libsql` | SQLite over the network (Turso) | serverless hosts, which give a function no disk |

Setting `TURSO_DATABASE_URL` is all it takes to switch. `schema.sql` is shared
byte-for-byte, because libSQL *is* SQLite — only the transport changes.

**Read `DEPLOY-VERCEL.md` before deploying.** The short version: hosting it
online means the shop cannot sell without internet, so keep the local install as
the fallback. The two have separate data and do not sync.

**Read `DEPLOY-STAGING.md` before the second deployment.** A staging copy is a
second Vercel project on its own databases, so a release can be tried before the
shops are on it. Every deployment knows which one it is (`MM_DEPLOYMENT`,
defaulting to `staging` on anything hosted and to `local` on a shop PC — where
nothing changes); every screen says so when it is not production; and a
deployment whose control-plane database disagrees with it refuses to start
rather than writing to the wrong shops.

### Your scanner and printers

Everything those two devices need is under **Settings → Devices**, with a live
test beside each section — see §4.

---

## 2. What's in it

### The ten requested modules

| # | Module | Where |
|---|--------|-------|
| 1 | **Supplier management** | Suppliers — full contact, payment terms, lead time, credit limit, purchase history and outstanding balance |
| 2 | **Brand management** | Brands — linked to a default supplier, used across the catalogue and reports |
| 3 | **Product catalogue** | Products — attributes (size, colour, material…), a generated variant matrix, a **separate SKU, barcode and price per combination**, and a full product details page (§5) |
| 4 | **Inventory** | Stock on hand, an immutable movement ledger, stock counts and corrections |
| 5 | **QR integration** | Configurable hardware scanner support on every screen, QR label designer with calibration, QR on receipts |
| 6 | **Client management** | Clients with retail/wholesale/VIP pricing groups, credit limits, balances and loyalty points |
| 7 | **Promotions** | Percentage and fixed discount codes, category/brand/product scoping, and single-use gift vouchers |
| 8 | **Reports** | 21 reports across inventory, sales, returns, purchasing, costs, payroll, clients, promotions and audit — each printable and exportable to CSV |
| 9 | **Multi-user** | Five built-in roles, 50+ granular permissions, editable per role |
| 10 | **Audit logs** | Every mutation recorded with user, timestamp, IP and a before/after field diff |

### Additional features I added, and why

These weren't in the brief but an accessories shop runs badly without them. Each
is fully implemented, not a stub.

**Costs and payroll — صفحة التكاليف.** Everything the shop spends that is not
stock: electricity, water, taxes, rent, equipment, maintenance and wages, filed
under bilingual categories the owner extends himself, against a branch, with a
photograph of the bill. Rent and the monthly bills are set up once as a
*repeating cost*, which never posts anything by itself — the months it owes wait
at the top of the screen to be confirmed, so six weeks away leaves a list to
check rather than entries nobody saw. Employees are a list of their own,
separate from the ERP's login users, because a delivery man has a salary and no
login; each has an amount and a period (day, week or month), and a payment
recorded against one **is a cost row** — filed beside the rent, counted once,
and coming off the same profit. Which is the point: **Reports → Profit after
costs** is what a shop owner means by the word, and the older reports that show
goods margin now say so on their face.

**Purchase orders with goods receipt.** Draft → sent to supplier → partial or
full receipt. Receiving is the only way stock enters the system, so "where did
this stock come from?" always has an answer, and the moving-average cost updates
automatically — which is what makes the profit figures in the sales reports real
rather than guesses.

**Point of sale.** The brief asked for inventory and QR scanning, but stock only
stays accurate if selling is *inside* the system. The POS prices the basket
server-side, blocks overselling, applies promo codes, and prints an 80mm receipt.

**A full returns desk.** See §4 — this is the part of retail that quietly loses
money when it is done by hand.

**Stock counts (physical inventory).** Load a count sheet pre-filled with system
quantities, enter what was actually counted, review the value impact, then post.
Every difference lands in the ledger with a reason code.

**Low-stock alerts and reorder suggestions.** The dashboard flags items at or
below their reorder level; one click groups them by supplier into a ready-made
purchase order. This is the difference between reordering on a hunch and
reordering on data.

**Slow-moving / dead stock report.** In accessories, capital tied up in the wrong
colour is the main way money disappears. This report shows exactly which variants
haven't sold and how much cash they're holding.

**Customer credit and receivables.** Wholesale buyers rarely pay cash. Credit
limits are enforced at checkout, balances tracked, and an ageing report shows
what's overdue.

**Loyalty points.** Earn rate and redemption value are configurable; points are
earned and redeemed at the till.

**Bulk price updates.** Select variants, apply a percentage or fixed change.
Essential when a supplier raises prices across a range.

**Held sales.** Park a basket, serve the next customer, resume it later.

**Your data is yours.** *Settings → Backups → Download a copy of my data* builds
one `.zip` holding the whole shop: two Excel workbooks (Arabic and English,
fifteen tabs, foreign keys resolved into names) that anybody can open, and a
complete snapshot a computer can restore from. It works on every deployment —
a shop PC or a hosted database — and it is the same file the platform console
hands over, built by the same code. Passwords are the one thing it leaves out:
a file kept on a laptop should not carry them. An administrator may take one;
the right cannot be given to a role, and it is limited to one copy every ten
minutes and six a day, because building one reads the whole shop.

**Backup and restore, on a shop PC.** Offline means *you* are the only backup.
One click makes a consistent copy of the database file (SQLite's online backup
API — safe while trading), and restore keeps a safety copy of what it replaced.
A hosted shop has no file to copy and says so; its data still comes out through
the download above.

**Cashier shift summary.** What should be in the drawer, broken down by payment
method.

---

## 3. Architecture

```
src/
├── config/                  runtime configuration (paths, port, secrets)
├── shared/                  pure, dependency-free helpers
│   ├── errors.js            typed errors → HTTP status codes
│   ├── money.js             2-decimal arithmetic, line maths, moving average
│   └── permissions.js       the single source of truth for RBAC
├── infrastructure/          ← DATA LAYER
│   ├── database/
│   │   ├── schema.sql       the whole schema in one reviewable file
│   │   └── connection.js    connection, WAL/durability pragmas, transactions
│   └── repositories/        one gateway per aggregate, all extending BaseRepository
├── services/                ← BUSINESS LOGIC LAYER (no HTTP, no SQL strings)
│   ├── AuthService          sign-in, lockout, sessions, password rules
│   ├── CrudService          reusable create/update/delete with audit + soft delete
│   ├── CatalogService       products, the variant matrix, SKU generation
│   ├── InventoryService     postMovement — the single entry point for stock
│   ├── PurchaseService      PO lifecycle and goods receipt
│   ├── SalesService         checkout, void, payments
│   ├── ReturnService        receipted and no-receipt returns, refunds, store credit
│   ├── PromotionService     code validation and discount calculation
│   ├── ReportService        every report definition
│   ├── AuditService         the audit trail
│   └── AdminService         users, roles, settings, backups
└── api/                     ← PRESENTATION LAYER
    ├── middleware/          auth, RBAC, validation, error mapping
    ├── validators.js        Zod schemas — the API contract in one file
    └── routes/              thin controllers; crudRouter builds the repetitive ones

public/                      the UI — plain ES modules, no build step
├── css/app.css              one stylesheet, logical properties for RTL
└── js/
    ├── core/                api client, i18n, router, DOM toolkit, scanner
    └── views/               one module per screen
```

**Dependency direction is strictly one-way:** `api → services → repositories →
database`. A service never imports Express; a repository never contains business
rules; the UI never talks to SQLite. That's what makes each layer replaceable —
swapping SQLite for PostgreSQL means rewriting `infrastructure/`, and nothing else.

### Design decisions worth knowing

**One entry point for stock.** `InventoryService.postMovement()` is the only code
in the system that changes a stock balance. Purchases, sales, returns, transfers
and counts all call it. It writes the ledger row and the balance in the same
transaction, so the two can never disagree, and every movement carries its source
document and user.

**The variant model is open for extension.** Attributes are data, not columns.
Adding "strap length" or "plating" is a UI action, not a schema migration. A
variant is a product plus one value per declared attribute, and it carries its
own SKU, barcode, cost, retail price, wholesale price and reorder level.

**Order-level discounts are allocated back to lines.** When a promo code takes
10% off a basket, that discount is spread proportionally across the qualifying
lines before VAT is calculated — so tax is charged on what the customer actually
paid, which is what an Egyptian tax auditor expects to see.

**Master data is soft-deleted when referenced.** Deleting a supplier that appears
on last year's purchase orders would orphan history, so the system deactivates it
instead and says so.

**One shop, but the door is left open.** The business trades from a single
location, so there is no location picker anywhere in the UI. The `warehouses`
table still exists with exactly one row, and documents still carry a
`warehouse_id`. That costs nothing today and means adding a second shop later is
a settings change, not a migration of every historic invoice.

**Durability over speed.** SQLite runs with `synchronous = FULL`: a power cut at
the shop must not lose a completed sale.

**No native dependencies, on purpose.** The database uses Node's built-in
`node:sqlite` module rather than an npm driver. Native drivers must be compiled
for each Node version, and when no prebuilt binary exists for the version on the
machine, `npm install` tries to compile from source and fails on anything without
a C++ toolchain. For software installed on shop counter PCs by non-developers,
that is a real failure mode — so the project ships with nothing that needs
building. `npm install` is seconds, and it cannot fail for lack of a compiler.
The cost is the Node 22+ floor; the benefit is that installing on a new till is
"install Node, double-click START.bat".

### The fleet, when the control plane blinks

On a multi-shop deployment every request resolves its shop through one
control-plane database. Two things follow from that, and both are worth knowing
before changing `src/api/middleware/tenant.js` or `src/platform/FleetSummaryService.js`.

**A shop that resolved a minute ago keeps trading if the control plane goes
away.** A descriptor that was read successfully is kept in memory and used —
only when a read actually *fails* — for up to `MM_TENANT_GRACE_MS` (15 minutes)
after the last successful read of that shop. Inside that window the till, the
ERP and the storefront carry on. Outside it they stop. Three things are never
decided from a remembered descriptor, at any age:

- **a 404.** "There is no shop here" is a claim an instance that cannot read the
  control plane is not entitled to make, so an unknown slug during an outage is
  `503 CONTROL_PLANE_UNAVAILABLE` with a `Retry-After`, not a 404;
- **a shop this instance has never resolved.** There is nothing to remember, and
  a cold serverless instance remembers nothing — also a 503;
- **overturning a refusal.** A suspended shop stays suspended when the refusal
  cannot be confirmed. Refusals never expire; permissions do.

You can always tell whether an answer came from the control plane or from
memory, from outside, without a login:

```bash
curl -sI http://host/t/mm/api/shop/config | grep -i x-mm-      # per request
curl -s  http://host/api/health | jq .controlPlane            # per instance
```

`X-MM-Tenant-Source` is `fresh`, `cached` or `remembered`; a remembered answer
also carries `X-MM-Control-Plane: degraded` and `X-MM-Tenant-Age` in seconds.
Every outage leaves one `CONTROL_PLANE_RECOVERED` row in `platform_audit`,
written on recovery — because during the outage the table it would go in is the
thing that is unreachable.

**The owner's overview is read, not computed.** It used to open every shop's
database on every page load; at eighty shops that is eighty connections per load
on a metered database. Each shop's figures are now written into one
control-plane table (`tenant_summaries`) by three writers — the hourly sweep
(`/api/cron/summaries`), a shop's own traffic when its summary has gone stale,
and the owner pressing "Refresh now" — and the console reads that table.

The split that makes it safe: **statistics** come from the summary and always
travel with the moment they were read; **decisions** — a shop's status, its
website switch, its modules, its limits, how many shops exist — are read live
from `tenants` on the same page load and can never be stale. A summary older
than `MM_FLEET_SUMMARY_STALE_MS` (3 hours) is flagged on the row and named in a
banner; a shop nobody has measured shows dashes and "not measured yet", never a
zero. `GET /api/platform/overview?live=1` still does the old fan-out, for the
day somebody does not believe the table.

| Variable | Default | What it bounds |
|---|---|---|
| `MM_TENANT_CACHE_MS` | `15000` | how long a good descriptor is reused while the control plane is healthy |
| `MM_TENANT_GRACE_MS` | `900000` | how long a remembered descriptor stands in for one that cannot be read |
| `MM_TENANT_REMEMBER_MAX` | `200` | how many descriptors one instance keeps |
| `MM_FLEET_SUMMARY_STALE_MS` | `10800000` | when the console starts calling a figure old |
| `MM_FLEET_BACKFILL_MAX` | `8` | most never-measured shops one page load may read |
| `MM_FLEET_SUMMARY_ON_REQUEST` | on | set `0` to stop shop traffic refreshing summaries |
| `MM_SUMMARY_MIN_AGE_MS` | `2700000` | how fresh a summary the hourly sweep will skip |

### Database

32 tables. The core relationships:

```
suppliers ──< brands ──< products ──< product_variants ──< variant_attribute_values
                            │              │                        │
                     categories            │                 attribute_values
                                           │                        │
                                           │                   attributes
                                           ├──< stock_levels
                                           ├──< stock_movements  ← the ledger
                                           ├──< purchase_order_lines >── purchase_orders >── suppliers
                                           ├──< sale_lines >── sales >── customers
                                           └──< sales_return_lines >── sales_returns

promotions ──< promotion_targets          users >── roles >── role_permissions >── permissions
promotions ──< promotion_redemptions >── sales                    │
                                                            audit_logs

cost_categories ──< costs >── warehouses      recurring_costs ──< costs
                      │                        (a template, never a cost)
                      └── employees            attachments (owner_type, owner_id)
                          (a salary payment IS a costs row)
```

Two views (`v_variant_details`, `v_stock_on_hand`) keep the read paths simple.

---

## 4. The two things you asked about

### Your scanner and printers — Settings → Devices

Nothing about either device is hard-coded. **Settings → Devices** has three
sections, each with a live test:

**Barcode / QR scanner.** Any USB or Bluetooth scanner that behaves as a keyboard
works — that is nearly all of them, and no driver is needed. What you can set:

| Setting | What it's for |
|---|---|
| Listen for scans anywhere | Turn the global capture off if you only want the scan boxes to work |
| Speed threshold (ms) | How fast counts as "a scanner, not a human". Raise it if scans are missed; lower it if fast typing is mistaken for a scan |
| Minimum code length | Ignores stray keystrokes |
| Strip prefix / suffix | Many scanners are factory-set to wrap the payload in an extra character — put it here and it is removed |
| Beep on scan | A confirmation tone for scanners without a buzzer |

Underneath is **Test your scanner**: pull the trigger and the table shows the raw
keystrokes, the code after stripping, its length, how many milliseconds the burst
took, and whether it was accepted — so you tune the settings from what your
scanner actually sends instead of guessing.

**Receipt printer.** Paper width (58 mm / 80 mm / A4), copies per sale, text
size, auto-print after each sale, whether to print the invoice QR and the tax
lines, the footer message and the return-policy line. A live preview sits beside
the settings and **Print a test receipt** sends it to the printer.

**Label printer.** Label width, height, gap, QR size and which fields to print,
all in millimetres and printed at true scale. Two **nudge** values shift the
print a fraction across or down — that is how you fix a label printer whose
output sits off-centre. **Print 3 test labels**, hold one against a real label,
adjust, repeat.

The QR payload is the variant barcode, which defaults to its SKU — so a label
printed today scans correctly at the till and at the returns desk.

### Returns

Returns are their own screen (**Returns → New return**) and follow what actually
happens at the counter.

**1 · Find the sale.** Scan the QR printed on the receipt, or type the invoice
number. The screen shows how old the invoice is and flags it if it falls outside
your return window. If the customer has no receipt, switch to **No receipt** and
scan the items instead — that mode requires the `sales.return_no_receipt`
permission, so a cashier cannot use it without a manager.

**2 · What is coming back.** Tick quantities line by line — you can never return
more than was sold, and anything already returned is deducted. For each line
choose the condition:

- **Good — back on the shelf**: received into stock and sellable again.
- **Damaged — write off**: received *and then written off* in the same
  transaction. The ledger shows both movements, so the loss appears in your
  reports instead of quietly vanishing.

**3 · Money back.** Pick a reason (the *Why Items Come Back* report groups by it
— that's your evidence when talking to a supplier), then how the refund goes
back: cash, card, transfer, wallet, **store credit**, or credited against the
customer's account. Store credit issues a single-use voucher code that is printed
on the credit note and spends like any promo code at the till.

What the system handles for you, because these are the parts that go wrong by hand:

- **The refund is what was actually paid** — net of every line discount and the
  share of any promotion allocated to that line. Refunding list price on a
  discounted item hands back more than you took.
- **Loyalty points are reversed** in proportion to the returned value, so nobody
  can farm points by buying and returning.
- **Restocking fees are refused when the fault is yours.** Faulty, wrong item,
  not-as-described and damaged-before-sale never carry a fee, whatever is typed
  in the box.
- **A credit note prints** with the items, condition, reason, totals and the
  store-credit code.

The policy itself — return window, whether no-receipt returns are allowed, the
default restocking fee, whether a reason is mandatory, and how long store credit
lasts — is under **Settings → Returns policy**.

## 5. The product details page

Clicking a product opens its **details** page — read-only, so looking something
up mid-rush can never accidentally change it. Editing is a separate screen
behind the **Edit** button (`products/:id` views, `products/:id/edit` edits).

It answers the four questions someone actually opens a product to ask:

**What is it** — names in both languages, SKU prefix, brand, category, supplier,
unit, tax rate, which attributes it uses, description, and when it was created
and last changed.

**What is on the shelf** — a KPI row (units on hand, stock value at cost, retail
value and the margin sitting in it, price range) and a variant table showing each
combination's SKU, barcode, cost/retail/wholesale price, margin %, quantity,
reorder level and stock value — with out-of-stock and below-reorder variants
flagged in colour. Per variant you can pop up its **QR code** (and print that one
label), adjust its stock, or jump to its movement ledger.

**Is it making money** — units sold, invoices, revenue, profit and margin over
the last 90 days, plus when it last sold and how many units have come back.

**Where it has been** — sales history, purchase history, returns (with the
condition each item came back in) and the stock movement ledger, each row
clicking through to the source document.

Down the side: sell it, reorder it (pre-fills a purchase order for its supplier
with the quantities it needs), print labels for every variant at once with the
copies you choose, or deactivate it.

---

## 6. Daily operating notes

- **Back up.** *Settings → Backups → Create backup now*, or `npm run backup` on a
  schedule. Copy `data/backups/` to a USB stick or cloud drive periodically.
- **Take your data with you.** *Settings → Backups → Download a copy of my data*
  gives you the whole shop in one file — spreadsheets you can open and a
  snapshot that can put the shop back. It works on any deployment, hosted or
  not. Keep it the way you keep the shop's books: it holds every cost, every
  client's phone number and every salary.
- **The database is one file:** `data/mm-accessories.db`. Copying it copies the
  whole business. Stop the server before copying it by hand (or use the backup
  button, which is safe while running).
- **Multiple tills:** run the server on one machine with `MM_HOST=0.0.0.0` and
  point the others at `http://<that-machine-ip>:4000`. Device settings are stored
  in the database, so every till shares the same scanner and printer setup.
- **Restore requires a restart** — the running process holds the old file open.

---

## 7. Testing

`tests/smoke.test.js` drives the full commercial cycle over HTTP:
create a product with a size×colour matrix → raise a purchase order → receive it →
sell with a promo code → look the receipt back up by scanning it → return a good
item and a damaged one → check the fee rules → issue store credit → try a
no-receipt return as a cashier and as a manager → run a stock count → void a sale
→ run every report → verify the audit trail → check that a cashier is blocked
from admin screens → download the shop's own data as a `.zip` and watch the
second press be rate-limited. 31 tests, all passing on a clean install.

```bash
npm run setup      # a seeded database is all the suite needs
npm test           # starts the app on a free port and drives it
```

Set `MM_TEST_URL` to run the same suite against an instance that is already
serving — a staging host, or a hosted database.

`tests/ui-check.mjs` is a headless browser pass over every screen in both
languages; it needs Playwright (`npm i -D playwright`) and is a development aid
rather than part of the product. `tests/backup-ui-check.mjs` is the same idea
for the fleet's backups: it stands up four shops, takes a backup through KJ
Admin, downloads it, opens the archive and the workbook inside it, and restores
it — in Arabic and in English. `tests/shop-export-ui-check.mjs` does the shop's
half: it stands up one shop on the hosted driver, signs in as that shop's own
administrator, presses *Download a copy of my data* in both languages, opens
what came out, and presses it again to see the rate limit refuse in Arabic.
