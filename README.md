# Vaanijya

An Indian e-commerce platform with a deep agent on both sides of delivery.

**Before delivery** — a buyer says what they need, in their own language, typed
or spoken. The agent searches the catalogue, fills the cart with a reason for
each item, and scores the parcel for delivery failure before it is dispatched.

**In flight** — a parcel visibly in trouble is reached for before the buyer has
to complain. The agent recalculates the risk, judges the promise against the
date it is actually confident about, and takes the cheapest reversible action —
or asks a person, when the fix would reach the buyer.

**After delivery** — something arrives broken. The buyer reports it in their own
language, with photographs. A vision model reports what is actually in the
frame, a scoring function weighs that against the courier record and the buyer's
claim history, a rule engine decides the remedy — one per distinct issue, capped
in total at the order value — and **an operator approves before a rupee moves**.

**To see all of that in two minutes**, go to `/walkthrough`: five scripted
journeys over the real routes and the real engines, with every event tagged by
the actor that caused it and by whether that actor was a language model or a
pure function.

## Vaanijya Architecture Diagrams

### Executive Summary: Full Platform Agent Architecture
A comprehensive view of the Vaanijya platform, highlighting the clear separation between LLMs (for intent parsing) and Pure Functions (for strict policy enforcement and math).
![Vaanijya E-Commerce Agent Architecture](architecture_diagrams/Vaanijya%20E-Commerce%20Agent%20Architecture.png)

### 1. High-Level Platform Overview
The core architecture connecting the Buyer UI and Operator Desk to the orchestrator and the three main phases of the platform.
![Vaanijya Architecture Overview](architecture_diagrams/Detailed%20Vaanijya%20Architecture.png)

### 2. Shopping & Discovery Phase
How the agent parses a natural language request, uses pure rules to filter constraints, calculates true costs, and adds to the cart without hallucination.
![Shopping Phase Sequence](architecture_diagrams/Vaanijya%20Shopping%20&%20Discovery%20Flow.png)

### 3. Proactive Order Rescue (In-Flight)
The automated watcher that evaluates failure risks using mathematical engines and routes reversible actions (autonomous) vs. sensitive actions (operator-gated).
![Order Rescue Sequence](architecture_diagrams/Vaanijya%20Proactive%20Order%20Rescue%20(In-Flight).png)

### 4. Complaint Adjudication & Claims Phase
The flow of triage, multi-issue splitting, vision model analysis, pure-rule payout calculation (Entitlement Engine), and the Grounding Guard verifier before human approval.
![Claims Phase Sequence](architecture_diagrams/Vaanijya%20Complaint%20&%20Claims%20Adjudication.png)

---

## What's New

Three changes, in the order they matter to someone opening the site.

### Anyone can use it

It used to be reachable only through five seeded demo accounts, and `/shop`
redirected a signed-out visitor to the sign-in page — so the catalogue was
invisible until you had an account, which is backwards. Nobody registers to
find out whether a shop stocks anything.

- **[`/register`](src/app/register/page.tsx) is the primary way in.** Name,
  email, password, confirm. The delivery address is optional and collapsed:
  requiring one at sign-up makes a buyer invent a pincode before they can see
  a price, and an address typed under that pressure is the one that later
  produces a confidently wrong delivery date. Checkout asks for it, where
  `DestinationBlock` shows it before the button that commits.
- **Browsing needs no account.** `/shop` and `/` are public. The cart and
  checkout still require a session and say so where they need one.
- **Every account created there is a buyer**, and the role is set by the
  server. A request carrying `"role": "operator"` is ignored — verified live
  below. Operators are provisioned with `npm run setup -- --operator <email>`
  from the machine that owns the database; there is no UI control that grants
  it.
- **Brute force is limited.** Six sign-in attempts a minute per email *and*
  per IP, then a fifteen-minute lockout; five registrations an hour per
  address. A success clears the counter, a failure does not.
- **Demo accounts remain, as a convenience rather than the door.** They sit
  behind a disclosure below the form and the server omits them entirely in a
  production build — the password used to be hardcoded into the page bundle,
  so it shipped to every browser in every environment.

### The catalogue is a real catalogue

**31 products in 6 categories → 72 products in 10 categories**, with 56
competing seller offers across 12 sellers and 10 category policies.

### The light-theme UI is consistent

Shared form, filter, account-menu and product-card styling instead of inline
styles per route, a real storefront on the front door, and category/price/stock
filters that are all genuine query parameters. No dark mode, no theme switch —
[details below](#ui-and-design).

---

## Implementation updates

Two capabilities were added, and one of them was previously reported in this
file as a limitation.

### 1. Multi-issue complaint resolution — the known limitation is fixed

This README used to carry a `KNOWN LIMIT` eval scenario saying that a complaint
with two problems in it got one remedy. *"The earbuds are not working, and the
charging case is missing"* was classified as the stronger issue only; triage
recorded the second and the claim model had nowhere to put it.

It now adjudicates each issue separately, through **the same entitlement
engine**, and caps the total.

```
CLM-7F3K2A91   "The earbuds are dead and the charging case is missing"

  I1-DOA           DOA           REPLACEMENT    ELIGIBLE     VJ-ELEC-2.1
  I2-MISSING_PART  MISSING_PART  PART_SHIPMENT  ELIGIBLE     VJ-ELEC-2.4

  2 issues read · 2 adjudicated · total ₹0 against a ₹2,499 cap
```

What makes it safe is that the new module can only ever **reduce** a payout:

- **Each issue is priced by `checkEntitlement`**, once per issue, and its
  verdict is stored verbatim. No number in the output came from anywhere else.
  The model splits prose into issues — it decides no eligibility, no remedy and
  no amount, exactly as before.
- **Nothing is owed on top of a whole-order remedy.** A FULL_REFUND already
  returns the entire order value, so a second cash remedy alongside it is
  duplicate compensation by definition. The second issue is marked `SUBSUMED`
  and still shown, so the operator sees it was read and accounted for.
- **One fault described twice is one remedy.** "It arrived smashed and now it
  will not switch on" is one broken unit, not a DAMAGED claim plus a DOA claim.
  The splitter is told not to split it, and a dedupe rule catches it if the
  splitter does anyway — two guards, because paying twice for one fault is the
  expensive failure.
- **The aggregate is capped at the order value**, applied in a declared
  severity order so that *which* issue gets trimmed never depends on the order
  the model happened to list them in. The cap is re-asserted in code, and
  `adjudicateIssues` throws rather than returning a total that exceeds it.
- **An operator override is re-capped too.** A person may overrule the engine;
  they may not approve ₹2,499 on each of two issues against a ₹2,499 order.

**Issues are resolved independently.** The approval gate takes a per-issue map,
so an operator can pay a genuine dead unit and reject a missing-accessory claim
they do not believe, in one decision:

```
POST /api/desk/approve
{ "claimNo": "CLM-7F3K2A91", "approve": true,
  "issueDecisions": { "I1-DOA": { "approve": true },
                      "I2-MISSING_PART": { "approve": false, "note": "not evidenced" } } }
```

Approving a claim while rejecting every issue on it is recorded as a rejection,
because it pays nothing and the state must not disagree with the rows.

**The gate is unchanged.** A multi-issue claim stops at `AWAITING_APPROVAL`
like any other, and any single issue the engine could not decide safely routes
the *whole* claim to a person — approving the rest and quietly dropping that one
is the failure this work exists to prevent.

**Backward compatible.** `issueType` and `verdict` are still written for every
claim and remain the headline answer. A single-issue claim gets one row,
`multiIssue: false`, and a `verdict.amountInr` identical to that row's. A claim
written before this field existed has an empty `issues` array and reads exactly
as it always did — no migration is required.

### 2. The Proactive Order Rescue Agent

The platform had two lanes: it helped a buyer order, and it adjudicated the
complaint when the order went wrong. The gap between them is where the failure
actually happens — a parcel going to a tier-3 pincode with no landmark and a COD
tag is visibly in trouble days before the buyer writes in, and nothing was
reaching for it.

`/desk` → **Order rescue** watches orders still in flight and tries to make the
complaint unnecessary.

```
ORD-DEMO001   INTERVENE   incomplete details · cod refusal risk
              risk 90/100 (HIGH) · 3d of runway

  +30  cash on delivery can be refused at the door
  +20  no landmark recorded
  +20  pincode tier 3
  +15  1 prior return-to-origin by this buyer

  Likely 2026-10-28, 80% confident by 2026-10-31 against a promise of 2026-10-30
  → too tight to promise

  QUEUED FOR APPROVAL   ask buyer
  "resolves the address gap worth 20 risk points before the first attempt"
```

It **composes the engines that already exist** rather than scoring anything
itself: `riskScore()` for how likely the delivery is to fail and why,
`deliveryForecast()` for when it will realistically arrive. A second risk
implementation that could disagree with the one on the Parcels tab would make
both untrustworthy.

Three judgements it adds, each needing both engines:

| | |
|---|---|
| **Is the promise at risk?** | Judged against the **confident** date, never the optimistic one — the same rule `/find` uses when it refuses a deadline it cannot make. A risky parcel that is comfortably early is not an emergency. |
| **Is intervening justified?** | A LOW-risk parcel with a safe forecast gets nothing, and the decline is **recorded as its own event**. An agent that only logs when it acts looks like one that always acts. |
| **Is there still time?** | An action that lands after the parcel was due prevents nothing. Past that point the honest output is a handoff, not a courier call. |

#### What it may do alone, and what it may not

Authority comes from the **existing** `RiskAgent` mandate — it was not widened.

| | |
|---|---|
| **Alone** | `reschedule_delivery`, `redirect_to_pickup`, `hold_shipment` — reversible, and they move no money |
| **Needs an operator** | `ask_buyer`, `convert_cod_to_prepaid` — these reach the buyer or change how they pay |
| **Cannot reach at all** | `issue_refund`, `place_order`, `submit_claim`, `send_message` — the RiskAgent does not hold the capability, so the registry refuses it before any work is done |

That last row is a property of the code, not a promise. `tests/rescue-db.test.ts`
asserts it directly, and **every** rescue eval scenario re-asserts it: the
scenario calls `issue_refund` as the RiskAgent and fails if it succeeds.

One subtlety worth stating, because it surfaced during implementation. The
intervention policy can propose `ask_buyer`, which needs the `draft` capability
the RiskAgent deliberately does not hold. Calling it anyway produces a mandate
refusal — the registry working correctly, but the wrong thing to record: the
proposal is legitimate and belongs in front of an operator, not in the audit log
as an agent overreaching. So a proposal the agent may not perform is **queued
for approval directly**, with the same `claim.approval_requested` event the
registry emits. The authority model is unchanged; the agent still cannot execute
it.

#### Stopping

- **Idempotent per action.** `order.rescueActions` records what has been done,
  including a request still waiting at the gate, so a second sweep never
  re-asks a buyer a question they are already looking at. Prevention that
  repeats itself is harassment.
- **A failed tool is not recorded as done**, so a retry is still possible once
  it recovers — but the order goes to a person, because a failed action
  prevented nothing and recording it as rescued would be a lie.
- **Three attempts per order, then a person.** Past the budget it hands off
  with the reason attached, never a fourth attempt.
- **It re-scores after acting** and reports the result honestly, including a
  risk that went *up*. The comparison is on the score rather than the band: a
  parcel that went from 75 to 62 is still HIGH, and calling that "no
  improvement" would hide a real reduction.

It runs on the watcher tick, so it shares the simulated clock that makes the
rest of the autonomy demonstrable, and `humanPresent: false` is recorded on
every sweep.

> **The courier is simulated.** There is no courier integration here and
> nothing pretends otherwise. `reschedule_delivery`, `redirect_to_pickup` and
> `hold_shipment` write the shipment state change a real courier API would
> cause; every event they emit carries `simulatedCourier: true`, the desk panel
> says so, and so does `/system`. The reasoning, the mandate, the gate and the
> audit trail are real. The van is not.

### What changed, by file

| | |
|---|---|
| `lib/engines/multi-issue.ts` | **new.** Pure. Adjudicates a set of issues via `checkEntitlement`, dedupes one-fault-two-names, caps the aggregate |
| `lib/engines/rescue.ts` | **new.** Pure. Composes `riskScore` + `deliveryForecast` into a rescue decision |
| `lib/agent/issue-splitter.ts` | **new.** One complaint → distinct issues; model path plus a conjunction split in 8 languages |
| `lib/agent/rescue.ts` | **new.** Drives the rescue through `callTool`, idempotency, retry limits, re-scoring |
| `components/RescuePanel.tsx` | **new.** The operator view: problem, factors, forecast, action, outcome |
| `app/api/desk/rescue/route.ts` | **new.** `GET` the queue, `POST` to sweep or assess one order. Operator-only |
| `models/index.ts` | `Claim.issues[]`, `multiIssue`, `totalPayableInr`; `Order.rescueAttempts/rescueActions/rescueState`. All additive and defaulted |
| `lib/agent/claims.ts` | splits issues after triage, adjudicates each, writes the rows; `multi.reviewRequired` joins the handoff conditions |
| `lib/agent/approval.ts` | per-issue settlement, re-capped aggregate, `effectiveApprove` |
| `lib/agent/triage.ts` | exports `matchIssue` so the splitter uses one keyword table; added the natural Hindi word order for a missing part |
| `lib/agent/watcher.ts` | runs the rescue sweep last, after the observe-only steps |
| `lib/engines/states.ts` | **unchanged.** The claim machine needed no new states |
| `lib/agent/mandate.ts` | **unchanged.** No capability was added or widened |
| `lib/events.ts` | 3 claim event types, 7 rescue event types |
| `lib/evals.ts`, `lib/eval-runner.ts` | scenario 16 becomes a real pass; 18–19 multi-issue, 20–25 rescue; a `rescue` scenario kind |
| `lib/seed.ts` | `ORD-DEMO008`: the only in-flight order with a complete address |
| `app/api/system/route.ts` | both engines, their constants, and the simulated-courier caveat |

One behaviour change outside the two features, found by a test: the
MISSING_PART keyword list held `"nahi tha box me"` but not `"box me nahi tha"`,
which is how the phrase is actually written. A Hindi-writing buyer with no API
key silently got one issue of two. Fixed in the shared table, so both triage and
the splitter benefit.

### Demonstrating it

```bash
npm install
npm run setup -- --seed    # build the catalogue and the demo scenarios
npm run dev                # http://localhost:3000
```

Sign in at `/signin` with a demo account (every demo password is `demo123`), or
register your own at `/register` — a registered buyer can do everything in the
multi-issue walkthrough below, though the pre-built demo orders belong to the
seeded buyers.

**Multi-issue** — sign in as `arjun@example.in`, open `ORD-DEMO002` on
`/orders`, and report:

> *The earbuds are not working, and the charging case is missing.*

Expect: a `claim.issues_split` event naming both issues, a
`claim.issues_adjudicated` event **credited to `EntitlementEngine`** showing a
remedy and a clause per issue with the total against the cap, then the claim
waiting at the gate. On `/desk` the case card lists both issues with a checkbox
each — untick one and approve to pay one and reject the other.

Try also *"The earbuds arrived smashed and now they will not switch on"* — one
issue, one remedy, because that is one broken unit described twice.

**Rescue** — sign in as the operator and open `/desk` → **Order rescue** →
*Run a rescue sweep*. Expect:

- `ORD-DEMO001` (COD, tier-3, no landmark) → **intervene**, `ask_buyer`
  **queued for approval** — it reaches the buyer, so the agent may not.
- `ORD-DEMO008` (complete address, one failed attempt) → **intervene**,
  `redirect_to_pickup` **executed**, then re-scored. Reversible, so it acts
  alone, and the buyer is emailed because the pickup point changes where they
  must go.
- the delivered orders → **left alone**, with the count shown.

Run the sweep twice: the second pass proposes nothing new, because the actions
are already recorded. Press **Skip to the deadline** on the demo controls first
to watch runway shrink until the agent hands a parcel to a person instead.

**The evals** — `/desk` → **Evals** runs all 25 scenarios against the real
pipeline. Scenarios 16, 18–19 are multi-issue; 20–25 are rescue.

---

## Getting started

```bash
npm install
npm run setup -- --seed        # build the catalogue and the demo scenarios
npm run dev                    # http://localhost:3000
```

Then **create an account** at `/register`, or open `/signin` and pick a demo
account (every demo password is `demo123`).

`npm run setup` with no flags changes nothing and reports what is configured —
run it first if something is not working:

```
Environment
        NODE_ENV           development
        MONGODB_URI        NOT SET (in-process database)
        AUTH_SECRET        DEFAULT — insecure, change for production
        GROQ_API_KEY       not set (deterministic fallback path)
        SMTP_HOST          not set (mail captured to the Outbox)
```

**Seeding is a command, not a button.** It used to be offered from the sign-in
page to anyone while the user table was empty. `seed()` deletes every
collection, so an unauthenticated endpoint that can do that is not something to
leave reachable — see [Database safety](#database-safety).

Nothing in `.env` is required for local development. With no keys at all the
platform runs end to end on deterministic paths, and the header says which
capabilities are degraded rather than failing silently.

| Capability | Without a key | With one |
|---|---|---|
| Shopping agent | keyword catalogue search, budget extracted from the text | full tool-calling conversation in 8 languages |
| Complaint triage | keyword map over 8 languages, native script and transliteration | real comprehension, translation, evidence flags |
| Photo analysis | photo stored and shown to the operator | vision model reports what is in the frame |
| Voice complaints | typed only | Whisper, language auto-detected |
| Database | in-process MongoDB, resets on restart | your Atlas or local MongoDB |
| Email | captured to the Outbox tab, fully rendered | sent via Nodemailer |

### Keys

```bash
# Groq — free at https://console.groq.com/keys
GROQ_API_KEY=gsk_...

# ElevenLabs — optional, for spoken replies. Blank keeps the agent silent.
ELEVENLABS_API_KEY=

# MongoDB — Atlas free tier or a local mongod. Blank runs in-process.
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/vaanijya

# Gmail: use a 16-char App Password, not your account password
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx
OPS_EMAIL=ops@vaanijya.in
```

---

## Accounts and authentication

### Registering

Anyone can create an account at `/register`. Name, email, password and a
confirmation; the delivery address is optional. The account is signed in
immediately and lands on `/shop`.

Validation is mirrored, not delegated: the form checks for instant feedback and
[the route](src/app/api/auth/register/route.ts) checks the same rules again,
because a client-side check is a convenience and never a guarantee. Where the
two could drift, the server's answer is the one shown.

| Rule | Enforced where |
|---|---|
| At least 8 characters | both; the server is authoritative |
| Password must not contain the email's local part | server |
| Passwords must match | both |
| Email normalised to lowercase and trimmed | server |
| Duplicate email → 409, "Sign in instead" | server |
| Pincode is six digits, city/state/tier **derived** from it | server |
| Role is always `buyer` | server only — never read from the request |

### How sessions work

A signed JWT (`jose`, HS256) in an **httpOnly** cookie, `sameSite=lax`,
`secure` in production, seven-day expiry. Passwords are hashed with `bcryptjs`
at cost 10 — `tests/auth.test.ts` asserts the hash is salted (two hashes of the
same password differ), that no account carries a plaintext field, and that
verification rejects a near miss.

There is no CSRF token, and that is a deliberate statement rather than an
omission: every mutating route is `POST`/`PATCH`/`DELETE` with a JSON body, and
`sameSite=lax` stops a cross-site form posting one. A real deployment adding
form-encoded endpoints would need tokens, and this README should be updated
then rather than implying they already exist.

### Operator access

Operators are **not** created through any form. Provision one from the machine
that owns the database:

```bash
# Promote an account that registered normally — the preferred path, because it
# leaves only one account-creation flow to keep secure.
npm run setup -- --operator you@example.com

# Or create one outright (needs a password of at least 10 characters).
npm run setup -- --operator ops@example.com --password '…'

# And to take it away again.
npm run setup -- --demote you@example.com
```

Authorization is enforced on the server by `requireOperator()`, on all **10**
`/api/desk/*` routes. The account menu hides the desk link from a buyer; that
is presentation. These are the checks:

```
POST /api/desk/approve    403    the approval gate
POST /api/desk/rescue     403    the rescue agent
POST /api/desk/tick       403    the watcher
POST /api/desk/seed       403    destructive seed
GET  /api/desk            403    the queue itself
```

Verified live against a freshly registered account — all four returned 403, and
a registration carrying `"role": "operator"` produced `"role":"buyer"`.

### Buyer data isolation

Every buyer route scopes its query by the id in the session and never by an id
from the request. Three things are asserted in `tests/auth.test.ts`:

- an order listing returns only that buyer's orders;
- `openClaim` refuses an order belonging to someone else, so a guessed `ORD-…`
  reaches nothing;
- `/api/events` filters are **AND**-combined, so passing another buyer's
  `claimId` alongside your own session narrows to nothing rather than widening
  access.

### Demo accounts

Still seeded, still useful for a demonstration and for the regression suite,
and no longer the way in. `GET /api/auth/entry` decides on the server whether
to list them: outside production **and** only when the seeded accounts actually
exist. In production the list and the password are empty, so neither reaches
the browser.

---

## Database safety

`seed()` deletes every collection. That is right for a demo and catastrophic
against a database holding real registrations, so the destructive path is gated
in one place ([`lib/seed-guard.ts`](src/lib/seed-guard.ts)) rather than at each
call site:

1. **Never in production without an explicit opt-in.** `NODE_ENV` alone is not
   enough — a staging box runs a production build too — so it requires
   `ALLOW_DESTRUCTIVE_SEED=true`.
2. **Never over registered accounts.** If any account exists that the seed did
   not create, the database belongs to real people. This is a check on the
   *data*, so it holds on a laptop pointed at a shared cluster.
3. **Never silently.** The refusal names the rule and what to do:

```
Refusing to seed: 1 account(s) here were created by registration, not by the
seed. Seeding would delete them and every order, claim and refund attached to
them. Re-run with --force if this is a scratch database.
```

`seed()` itself throws on a refusal, not just the advisory check, so no call
path can bypass it. The test suites pass `force: true` because the test setup
already guarantees a throwaway in-process database and **refuses to use
`MONGODB_URI`** at all.

**Persistence is reported rather than assumed.** Without `MONGODB_URI` the
platform starts an in-process MongoDB — ideal locally, a trap in production,
where registration would appear to work and every account would vanish on the
next restart. In a production build that is a **fatal** configuration error:
`npm run setup` exits non-zero, and registration answers 503 with the reason
instead of accepting an account it cannot keep.

---

## When it says "running without a model"

That badge means a model call failed, and **a retired model name fails exactly
like a missing key**. Groq removes model ids without notice, so the first thing
to check is which models your key can actually reach:

```bash
npm run models
```

It lists every reachable model and probes each for the three things the agent
needs, then prints the lines to paste into `.env`:

```
  model                            chat   tools  json   vision
  --------------------------------------------------------------
  allam-2-7b                       yes    400    yes    no
  openai/gpt-oss-120b              empty  yes    400    no
  qwen/qwen3.8-27b                 yes    yes    yes    yes

Recommended for .env:
  GROQ_TEXT_MODEL=qwen/qwen3.8-27b
```

All three columns are load-bearing: `chat` must return prose (a reasoning model
that reports `empty` cannot write a reply to a buyer, however well it calls
tools), `tools` drives the shopping loop, and `json` is what triage, planning
and requirement extraction depend on.

`GET /api/health?deep=1` makes one real call and reports the truth, including
the model name in any error.

### Model failover

Groq's quotas are **per model and per day** (200,000 tokens on the free tier),
so one model can be exhausted while others have headroom. `chat()` therefore
tries `GROQ_TEXT_MODEL` and then `GROQ_FALLBACK_MODELS` in order, and only for
failures another model could fix — a quota error, a retired model name, an
outage. A malformed request is our bug and fails identically everywhere, so it
is not retried.

`tests/failover.test.ts` covers this with the SDK stubbed, because whether the
real failover triggers depends on quota that varies by the hour — so testing it
live tests nothing.

### Rate limits look like degradation too

Groq's free tier allows roughly **2,000 tokens per minute**. A multi-turn agent
conversation can cross that, and the 429 that follows presents as the agent
silently dropping to its deterministic path. The client now retries with the
`retry-after` the API sends, and the per-turn ceiling is 500 tokens rather than
900, so an ordinary conversation fits. If you are testing hard and see
intermittent degradation, this is why.

## The one principle

Every meaningful step emits a typed event through `events.emit()`. The buyer
timeline, the operator desk, the audit log and the dashboard counters are all
**projections of that one append-only stream**. Nothing writes to a screen
directly, so the audit trail cannot drift from what the screens showed.

## Where the model stops

```
  LANGUAGE MODEL                      PURE FUNCTIONS (unit-tested, no model)
  ───────────────                     ─────────────────────────────────────
  reads the complaint                 checkEntitlement()  → remedy, amount, deadline
  writes the letter                   riskScore()         → delivery failure score
  searches the catalogue              assessAuthenticity()→ how well evidence supports
  reads a need into constraints       verifyDraft()       → rejects ungrounded prose
  decides nothing about money         solveConstraints()  → which offers qualify, and why not
                                      trueCost()          → sticker + fees + priced-in risk
                                      deliveryForecast()  → a date interval, not a promise
                                      sellerStanding()    → what a fault costs the seller
  splits one complaint                adjudicateIssues()  → a remedy per issue, total capped
  into its distinct issues            assessRescue()      → is a promise at risk, and in time
```

`checkEntitlement` is the single most important file in the repository. It
decides eligibility, remedy, amount and deadline from the policy clauses, and
there is no model call inside it. The verifier then rejects any draft whose
numbers, dates or clause citations do not match that verdict — and falls back to
a template that is grounded by construction.

> The model classifies the complaint and writes the letter. A rule engine with
> unit tests does the arithmetic. We don't let a model do arithmetic on
> someone's refund.

## Product catalogue

**72 products across 10 categories**, with **56** competing seller offers from
**12** sellers, under **10** category policies. Every one is fictional
demonstration data, and the footer of every page says so.

| Category | Products | Example |
|---|---|---|
| electronics | 8 | earbuds, power bank, smartwatch, 4K TV, 5G phone |
| computers | 7 | keyboard, silent mouse, IPS monitor, portable SSD, webcam |
| kitchen | 10 | pressure cookers, mixer grinder, air fryer, kadai, knife set |
| home | 9 | bedsheet, memory-foam pillow, cabin trolley, tiffin, umbrella |
| books | 7 | textbook, workbook, gel pens, colour pencils, language primer |
| hardware | 7 | tool kit, LED bulbs, storage boxes, extension board, tap filter |
| apparel | 8 | silk saree, kurta, jeans, formal shirt, rain jacket, belt |
| sports | 6 | yoga mat, dumbbells, speed rope, badminton racquet, trek pack |
| footwear | 4 | running shoes, Kolhapuri chappal, hiking boots, sneakers |
| beauty | 6 | face oil, shampoo, sunscreen, face wash, trimmer, hair oil |

### What a product record carries

Every field below is populated for every product, and
[`tests/catalogue.test.ts`](tests/catalogue.test.ts) asserts it:

- SKU, title, brand, description, category and **subcategory**
- `priceInr` and `mrpInr` — and the price is never above the MRP, because a
  "discount" that is really a markup is the one pricing claim a buyer can check
  at a glance
- `attributes` — **category-appropriate**, not filler. A cooker has
  `capacity_l` and `induction`; a monitor has `resolution` and `refresh_hz`. The
  constraint solver matches against these.
- `solves` — the needs it answers **in a buyer's words**, which is what makes
  someone who describes a problem able to find it at all
- `tags` in English and Indic scripts, so keyword search works with no model
- `stock`, `codEligible`, `boxContents` (what a MISSING_PART claim is
  adjudicated against), `policyId`, `sellerId`

### How it stays consistent with the engines

The catalogue expansion is wired into the **existing** engines rather than
given its own path. Checks that hold:

- **Prices are never trusted from the browser.** `/api/checkout` and
  `placeOrder` both re-read the product by SKU and recompute the total.
- **Stock is enforced server-side** in `add_to_cart` and again in `placeOrder`,
  so an out-of-stock product cannot be ordered even if the page says otherwise.
- **Every product resolves to a real seller and a real policy.** A product
  pointing at a missing policy would reach the entitlement engine with no
  clauses, score below the confidence floor and route every claim to a human —
  which looks like caution and is actually missing data. Asserted.
- **Every policy carries the clause tags the engine matches on** (`window`,
  `doa`, `damaged`, `wrong_item`, `missing_part`, `not_delivered`). Asserted.
- **Sellers span the reliability range** (1% to 18% declared defect rate), so
  `trueCost` has something to price in rather than a uniform field.

### What the expansion broke, and what that taught

Adding 41 products regressed **five** need-matching tests, and each failure was
a real ranking bug rather than a flaky test:

1. A `solves` phrase is matched as a **substring** at +24, the heaviest need
   signal there is. `"something to read"` on a history book therefore matched
   the n-gram `"something to"` out of *"I need something to carry hot tea to the
   office"*, and the book outranked the vacuum flask.
2. `"oil my hair weekly"` contains `"my hair"`, so a hair oil won *"my hair is
   falling a lot"* on a possessive pronoun, beating the shampoo the catalogue
   positions for it.
3. A rain jacket claiming `"trekking in wet weather"` outranked actual hiking
   **boots** for *"trekking in the monsoon, need footwear"*.

All three are fixed in the data, and the lesson is encoded as two assertions so
it cannot come back: a `solves` phrase may not begin with a generic opener a
buyer uses for anything, and may not name a product type belonging to another
category. A fourth finding was a gap in the **synonym table** rather than the
new data — `"hair fall"` was a key but `"hair falling"` was not, so the
sentence people actually write expanded to nothing. Both phrasings are keys now.

### Browsing

`/shop` and the front door are public. Filters are all real query parameters on
`/api/catalogue` — there are no decorative controls:

- **search** across title, brand, tags, description, subcategory and `solves`,
  so typing a need finds something here too
- **category** navigation with live counts, so a category never turns out empty
- **sort** by popularity, rating, price either way, or biggest discount
- **price bands** as one-click chips, because two fields for a range is two
  decisions before seeing anything
- **in stock only** — a real filter, since an out-of-stock product that looks
  purchasable is the commonest way a storefront wastes someone's time
- **clear all**, and a live `n of 72 shown` count

The front door now shows the catalogue instead of describing it: ten category
tiles with real counts, a *most reviewed* strip and a *biggest discounts*
strip, read on the server straight from the database. If the database is
unseeded those sections render **empty rather than inventing placeholder
products** — a storefront showing fake stock is the one thing this project does
not do.

---

## UI and design

**Light theme only.** There is no dark mode, no theme switch, no
`prefers-color-scheme` branch and no dark-background variant. The palette is
indigo ink on warm paper with haldi gold as the single accent, defined as
tokens on `:root` in [`globals.css`](src/app/globals.css).

| Token | Value | Used for |
|---|---|---|
| `--paper` / `--paper-raised` | `#faf8f5` / `#ffffff` | page and card backgrounds |
| `--ink` / `--ink-soft` / `--ink-faint` | `#1a1f36` / `#4a5068` / `#8b8fa3` | the type scale |
| `--neel` / `--neel-wash` | `#3d4a9e` / `#eef0fb` | interactive, active nav, focus |
| `--haldi` / `--haldi-wash` | `#e8a33d` / `#fdf4e3` | highlights worth noticing |
| `--brick` | — | errors and refusals only |

Green appears only on a resolved state chip, never as a UI colour.

### What was redesigned

| Route | Change |
|---|---|
| `/` | real category tiles and two product strips from the database, plus a discovery prompt placed where browsing is already failing |
| `/register` | **new.** Four fields, optional collapsed address, mirrored validation, per-field errors |
| `/signin` | registration is the primary path; demo accounts behind a disclosure and absent in production; no "build the database" button |
| `/shop` | public, price/stock/category filter chips with counts, consistent cards |
| `/desk` | the **Order rescue** tab, and per-issue checkboxes on a multi-issue claim |
| `/system` | the two new engines, their constants, and the simulated-courier caveat |
| shell | a real **account menu** — avatar, name, role, orders, addresses, operator link where applicable, sign out — replacing a bare first name beside a Sign out button |

### Shared components, not per-route styling

The styling that existed only as inline styles scattered across routes is now
shared classes, so two forms look the same and a validation message is
recognisable from one screen to the next: `.field-label`, `.field-hint`,
`.field-error`, `.field[aria-invalid]`, `.filter-chip`, `.acct-*`,
`.mini-card`, `.cat-tile`, `.auth-*`.

### Accessibility and interaction

- Every input has a `<label for>`; errors carry `role="alert"` and
  `aria-invalid`, and are marked with a glyph as well as colour so the message
  does not depend on hue.
- The account menu closes on outside click, on `Escape` and on navigation, and
  carries `aria-expanded` / `aria-haspopup`.
- Filter chips are `aria-pressed` buttons, reachable and operable by keyboard.
- Focus is a visible 2px `--neel` outline, never removed.
- Product titles clamp to two lines and cards use a fixed `4/3` art ratio, so a
  long title cannot shove a price out of line with its neighbours.
- Grids are `auto-fit` with a 16px gutter; there is no horizontal page scroll
  at phone width.
- `prefers-reduced-motion` disables every animation and transform through a
  universal `!important` rule, so it wins wherever it sits in the file.

---

## State a constraint and have it honoured

`/find` is the answer to the thing that actually wastes a buyer's time, which
is not price — it is that **you cannot express a constraint and have it
honoured.** Every platform makes you translate a real need into its filters,
then scroll two hundred results to find out whether it worked.

So you state the conditions instead:

> *A pressure cooker for my induction hob, 5 litres at most, under ₹2000, must
> be in stock, and I need it before the 28th.*

A model reads that sentence into a constraint list — and does nothing else.
`solveConstraints()` (pure, 55 unit tests) decides what qualifies:

```
4 of 12 offers satisfy all 6 constraints.
Rejected: 7 failed induction is yes · 1 failed capacity (l) is 5.

  ✓ induction is yes          — induction: yes
  ✓ capacity (l) is 5         — capacity (l): 5
  ✓ price at or under ₹2,000  — ₹1,649
  ✓ in stock now              — 54 in stock
  ✓ arrives by 2026-10-28     — 80% confident by 2026-10-24

  ✕ Aluminium Pressure Cooker, 3L  failed induction is yes — induction is no
  ✕ Induction Cooker, 7.5L         failed capacity (l) is 5 — capacity (l) is 7.5
```

**The rejections are the feature.** No platform tells you why something was
excluded, so you can never tell whether the filter did what you asked. Each
rejection names the constraint it failed *and the value it had instead*, so the
claim is checkable rather than trusted. Drop any constraint chip on screen and
it re-solves, so you can see exactly what that condition was costing you.

Two engines sit behind the cards:

**`trueCost()` — price comparison compares the wrong number.** The sticker is
one of four. A COD fee, a tier delivery charge, and the expected cost of the
seller failing are all real money:

```
  Sticker                        ₹1,499
  Delivery (tier-2)                 ₹40
  Return risk    ₹99 × 18%          ₹18   ← seller's historical defect rate
                                ───────
  True expected cost             ₹1,557
```

Metro Discount Mart undercuts everyone and fails 18% of its orders. That is a
decision a buyer currently cannot make, because nobody puts the two numbers
next to each other. Every line is itemised with the sentence that justifies it.

**`deliveryForecast()` — "will it arrive in time?" as a real filter.** Delivery
date is the first thing buyers care about and the last thing any platform lets
you filter on, because a single optimistic date is all they have. This returns
two: a likely date, and a date it is 80% confident about, with every day of
padding traced to a named risk (tier-3 pincode, a prior failed delivery, a COD
parcel that can be refused at the door).

A deadline is judged against the **confident** date, never the optimistic one.
For a tier-3 COD buyer with one prior failed delivery, asking for a 26 Oct
arrival:

```
  ✕ Prime Fulfilled Depot — likely 2026-10-25 but only 80% confident by
    2026-10-28 — too tight to promise
```

Every other platform shows that as a green tick. An honest interval is more
useful to someone with a deadline than a confident wrong date.

The conversational agent holds the same tool (`solve_constraints`), so asking
the rail the same question gets the same enforced answer and the same rejection
tally — not a second implementation that can disagree.

### On cross-platform comparison

The comparison here is between **sellers inside this catalogue**, and every one
of them is fictional — the UI says so on every results page. That is deliberate.
Flipkart's terms bar automated access, and its affiliate API is gated, capped
and carries no reliable delivery-date field, which would gut the forecast. So
the agent demonstrates the full reasoning honestly on data we own. If an
affiliate feed is ever approved it populates the `Offer` collection and nothing
in the solver changes.

### You do not have to know what the product is called

The constraint solver only helped a buyer who already knew they wanted a
pressure cooker. Ask for what you actually want — *"a gift for my mother who
has back pain"* — and the literal keyword sweep returned **nothing**, with the
orthopaedic pillow sitting in the catalogue the whole time. That sends you
straight back to guessing product names, which is the behaviour this feature
exists to remove.

So every product now declares the needs it answers, in the buyer's words
(`solves`), and matching happens three ways, widest first: the phrase you said
against that vocabulary, a synonym table for phrasings nobody seeded, then the
literal text. All of it only ever *widens* what is considered — every exclusion
still comes from the solver, with its reason attached.

```
"I need a gift for my mother who has back pain"   → Memory Foam Pillow
"want to listen to music while running"           → SonicBuds Air Pro
"my phone dies on long train journeys"            → PowerCore 20000mAh
"I want to watch cricket on a big screen"         → Vision 43-inch 4K TV
"my hair is falling a lot"                        → Onion & Bhringraj Shampoo
```

Relevance is ranked **relative to the best match**, not against a fixed score.
That detail is the difference between working and not: with an absolute cutoff,
"a gift for my mother who has back pain" scored the pillow 78 and a face oil 27,
both cleared the threshold, and the *cheaper face oil* was recommended. Tiering
against the leader puts the pillow first; within a tier, cost still decides.

**Say it instead of typing it.** `/find` takes voice through Whisper, which
detects the language itself. This matters most for exactly the buyers the
feature is for: describing a need is a whole sentence, and the people least
likely to type that in English are the ones who most need to describe a need
rather than guess a SKU. The transcript is shown before it is acted on, so a
mis-hearing is visible rather than silently shaping the search.

**And it finishes the job.** Press *Add the best match to my cart* and the agent
adds the top-ranked offer with the reason attached, then **stops and asks** — the
cost taken apart, the delivery interval, the conditions it satisfied, and the
offers it passed over. It cannot place the order: `place_order` is in
`BUYER_CONFIRM_REQUIRED` and the tool registry refuses it from any agent turn.
The agent fills the cart; a human presses the button that spends the money.

## It answers out loud

The agent already listened — Whisper takes a spoken need in eight languages.
Now it answers, through ElevenLabs (`eleven_v4_turbo`, the low-latency model
that covers Hindi, Kannada, Tamil, Telugu, Marathi, Bengali and Gujarati; the
cheaper Flash and Multilingual models carry only Hindi and Tamil, which is not
most of the buyers this is built for).

It speaks at the stages where hearing beats reading:

```
search     "4 options satisfy everything you asked for. The best is the 5L
            Stainless Steel Pressure Cooker from Metro Discount Mart,
            1517 rupees all in, including this seller's 18 percent failure
            rate. It arrives by 27 October, comfortably before your date.
            8 others were rejected, mostly because they did not have induction."

cart       "I have put the Memory Foam Pillow in your cart — 899 rupees at
            checkout. Expected by 26 October. Nothing is ordered yet."
```

Three rules it follows:

1. **It never reads the screen aloud.** Each line is written for a voice by a
   pure function in `speech/narrate.ts` — the decision first, then the single
   most useful caveat. Reading a cost table out would be worse than silence.
2. **No model writes those lines.** A model asked to "summarise the result"
   eventually voices a number nobody computed, and a wrong price spoken aloud
   is worse than a wrong price written down: nobody can re-read it.
3. **It turns itself on when you speak to it.** Nothing autoplays on load —
   browsers block it and it startles people. Use the mic and replies are spoken
   from then on, which is a better signal than a setting nobody finds.

Small things that matter aloud: `₹1,649` is spoken as "1649 rupees" (ungrouped,
or the comma becomes a pause mid-number), markdown and emoji are stripped, and
"induction is yes" becomes "induction" — a checklist predicate read in a
sentence is what makes a voice feature sound broken.

Entirely optional. With no `ELEVENLABS_API_KEY` the endpoint answers 503, the
control hides itself, and everything else is unchanged.

## A fault costs the seller something

Buyers were already paying for a seller's failure rate in the true-cost
comparison — but that rate was static seed data. A seller could ship fault after
fault and their number never moved, so the one party able to prevent the problem
felt nothing while buyers paid for it.

`sellerStanding()` closes that loop. An upheld claim is recorded against the
seller who caused it, and the defect rate buyers see becomes **observed, not
declared**:

```
SEL-07 Metro Discount Mart  18.1%  UNACCEPTABLE  → suspension referred to a person
SEL-04 Deccan Home          10.7%  POOR          → listings throttled
SEL-05 Ganga Kitchenware     7.1%  ACCEPTABLE    → watched, and priced into comparisons
SEL-08 Prime Fulfilled       1.0%  GOOD          → wins comparisons on reliability
```

Two limits, for the same reason the fraud analyst has them:

1. **Only upheld claims count.** A claim an operator rejected is not evidence
   against the seller — counting filings rather than findings would let one
   determined buyer destroy a good seller. Dismissed claims are still shown to
   the seller, so they can see the platform reviewed the allegation.
2. **A small sample never restricts listings.** Two faults in three orders is
   not a 67% defect rate, it is three orders. Below 20 orders the rate is
   blended toward the declared one and the seller is watched, not throttled.

Suspension is *recommended*, never applied automatically. The consequence of
being wrong about a seller is their livelihood.

## Fake refund requests

The authenticity engine read one claim at a time, and organised refund abuse
does not look wrong one claim at a time — it looks wrong in the pattern. A
perfectly evidenced claim can still be the fourth this month.

So the engine now also scores cross-order history: a second claim on an order
already refunded, several claims in thirty days, the same hard-to-disprove
allegation repeated, refunds far out of proportion to lifetime spend, and the
clearest signal of all — **goods that were refunded and never came back**.

A claim whose per-claim signals are all clean but whose pattern is wrong is
routed to a human. What has not changed is the hard limit: this engine can
demand review, it can **never** reject a buyer or decide an amount. And an
*upheld* claim is never held against the buyer — someone genuinely wronged
three times is not a fraudster, and treating them as one is how a platform
loses its honest customers.

## Where is my refund

`paymentStatus: "REFUNDED"` was true and useless: it does not say how much, to
where, or by when, which is the entire content of every "where is my money"
message a support desk receives. Every movement now gets a ledger row:

```
RFD-X1BPCLTJ   ₹2,499   to the card or UPI account you paid with
               Expected by 25 Oct — amount set by clause VJ-ELEC-2.2
```

The settlement date comes from the same `refundSlaDays` the claim deadline uses,
so the two can never quote the buyer different dates. A COD order is refunded by
bank transfer and says so, because there is no card payment to reverse — that
one sentence is the difference between a clear refund and a fortnight of
confusion. Store credit settles instantly. Advancing the clock settles anything
due, so the demo carries the money all the way to the buyer rather than leaving
every refund stuck at "processing".

## A claim cannot skip the gate

Claim state is not a free-form string. `lib/engines/states.ts` declares every
legal transition and `transitionClaim()` is the single write path, so a stray
update cannot move a claim from TRIAGED straight to APPROVED. This is what makes
the approval gate mean anything: if a claim could reach APPROVED without
passing through the state where a human decides, the gate would prove nothing.

```
INTAKE → TRIAGED → ADJUDICATED → AWAITING_APPROVAL ⟵ the gate
                                      ↓         ↓
                                  APPROVED   REJECTED
                                      ↓
                        EXECUTING → RESOLVED   (terminal)
```

Escalation (`ESCALATED_T1` → `ESCALATED_T2`) is the autonomous branch:
reversible, internal, and it moves no money, which is why the tracker may do it
alone at 2am. The full machine is rendered at `/system`.

## Bounded authority

Each agent's mandate is data in `src/lib/agent/mandate.ts`, displayed on the
desk and **enforced in `callTool()`** — not requested in a prompt. A rule in a
prompt is a request; a model can be talked out of it.

| | |
|---|---|
| **Unapproved** | reads, both engines, cart writes, and reversible courier actions (`reschedule`, `redirect_to_pickup`, `hold_shipment`) |
| **Autonomous** | internal escalation — reversible, moves no money, so nobody is woken at 2am for it |
| **Operator must approve** | `ask_buyer`, `convert_cod_to_prepaid`, `submit_claim`, `send_message`, `issue_refund` |
| **Buyer must confirm** | `place_order` — the agent fills the cart; a human spends the money |

Two of the gated actions are *messaging the buyer* and *moving money*, so the
person approving is neither the buyer nor the seller. They sit between them,
which is the only position from which the decision is fair.

Budgets: 12 steps, 2 replans, 2 escalation tiers. Exhausting any of them routes
to `HUMAN_HANDOFF` with the reasons attached — never to a loop.

## The orchestrator: the plan is a first-class object

Ported from Rakshak, which got the important thing right. Before the agent
gathers a single fact it writes a plan, and that plan is **stored and shown on
screen** — the route it intended to take, the step it is on, and the point where
it had to rewrite itself.

```
1 ✓ read the order            Triage
2 ✕ read the courier record   Triage      ← get_tracking died here
3 ✓ retrieve the policy       Policy
4 ✓ compute entitlement       Policy      ← the rule engine
5 ✓ write the letter          Action
6 ✓ check the letter          Verifier
7 ⏸ file the claim            Action      gated — waiting for you
```

Three properties are enforced in code, not asked for in the prompt:

- **A plan is validated, not trusted.** Unknown tools are dropped, the approval
  flag is forced on for gated tools whatever the model claimed, and a plan that
  would reach a remedy without `get_policy` *and* `check_entitlement` is thrown
  away whole. An invalid plan falls back to a fixed sequence rather than running
  something unchecked.
- **Each step runs as the agent that owns the tool**, not as the Orchestrator.
  Widening the Orchestrator's mandate to cover everything it can plan would make
  the mandate meaningless.
- **It pauses; it does not fail.** Reaching the gate marks the step
  `awaiting_approval` and stops. The plan is on the claim, so an approval posted
  ten minutes later resumes at exactly that step.

Budgets: 12 steps, 2 replans. Exhausting either routes to `HUMAN_HANDOFF` with
the reason attached — never to a loop.

### Watch it replan

On the desk, pick a tool in **break tool** and file a complaint. The tool fails,
the plan visibly rewrites without it, and the case still reaches a clause-cited
verdict. There is an eval for exactly this (scenario 14).

## The grounding guard

The claim pipeline has a verifier, because a model writing about someone's
refund cannot be trusted on its word. A model writing about *products* has the
same problem in a smaller way, so shopping replies get the same treatment.

`lib/agent/grounding.ts` checks every reply against what the tools actually
returned, and rejects it for:

- **an invented product** — a name the catalogue never returned, or one named
  with no search at all, which is the worse case
- **an invented price** — any rupee figure that is not a catalogue price or a
  number the buyer themselves said
- **an unsourced policy** — a return window stated without reading one
- **the wrong language** — an Indic-script reply to a buyer who wrote English

A failed reply is sent back to the model once with the specific reasons. If the
second attempt still fails, the answer goes out with an honest note naming what
could not be substantiated — a buyer is never silently handed a made-up price.

This caught real failures: the fallback model confidently offered "Nike Air Max
270 — ₹12,999", "Adidas Ultraboost 21 — ₹13,499" and a 30-day electronics
return window. None of those exist. A prompt rule is a request; this is a check.

## Where it is actually going

The address schema existed from the first commit and there was no way to add
one. A buyer got whatever registration captured and was stuck with it, which is
not cosmetic: `pinTier` feeds `deliveryForecast()` and `scoreRisk()`, so a stale
address produces a **confident, wrong delivery date**. Both checkout paths were
worse — `/find` hid the destination behind a collapsed disclosure and `/shop`
sent no address at all, so both silently shipped to `addresses[0]`.

Three rules, in `lib/addresses.ts` rather than in either route, because two
routes and the agent all write addresses and they have to agree about what a
saved address looks like:

1. **The city, state and tier are derived from the pincode, never taken from
   the client.** A form that lets the browser post `pinTier: 1` lets it buy
   itself a three-day delivery promise to a village.
2. **Advice is quantified, not nagged about.** A missing landmark on a tier-3
   pincode is named as *the commonest reason a courier gives up*; on a metro
   pincode it is a mild suggestion. Only two things are `blocking` — a pincode
   that is not six Indian digits, and a street line too short to deliver to.
   A missing landmark or phone never blocks a sale.
3. **The destination is stated before the button.** `DestinationBlock` shows
   where it is going on both paths; switching address stays behind a
   disclosure, because changing it is the uncommon case and a picker open by
   default pushes the button that commits off the screen.

Delivery instructions are free text and dictatable on purpose: the cases that
actually matter — a guard, a gate code, a time window, a dog, a broken lift —
are exactly the ones no dropdown has an option for.

### Say the address once

`POST /api/addresses/dictate` takes one spoken or typed sentence and fills the
form:

```
"send it to flat 402, Sai Residency, 12th Cross near Axis Bank,
 Jayanagar, Bangalore 560041"

  line      Flat 402, Sai Residency, 12th Cross
  landmark  Axis Bank          <- preposition stripped, stopped at the comma
  city      Bengaluru          <- normalised; "Bombay" and "Calcutta" too
  state     Karnataka          <- derived
  pincode   560041  (tier 1)   <- derived
```

The lead-in verb is not part of the street, and the name a buyer actually uses
for their own town is accepted and normalised rather than rejected — a prefix
table knows the metro, but people know where they live.

Same division of labour as the constraint extractor: a deterministic parser
runs first and is enough for most addresses, because an Indian address contains
a pincode and a pincode decides the city, the state and the tier. The model is
asked only to split the remainder into street and landmark — the one judgement
a regex is bad at — and if it is unavailable the deterministic result stands
rather than the feature failing.

**It deliberately does not save.** It parses, says what it understood, and hands
that back for the buyer to confirm. A misheard pincode is the one input error
nothing downstream can catch — the forecast and the risk score will both be
confidently wrong about a parcel going to the wrong city — so the confirmation
step is the feature, not friction to be optimised away. It never invents a
landmark, and it reports what it could not fill rather than guessing.

Pincodes dictated as words are joined (`"five six zero zero four one"`),
including Hindi digit words, and a half-remembered phone number is refused
rather than stored. `tests/address.test.ts` has 40 tests over exactly these.

## Watch it work, one step at a time

The event stream records everything. What it does not do is explain itself: a
reader going through three hundred chronological rows cannot see that **the
model which read the complaint is not the thing that decided the refund**, which
is the claim the whole architecture rests on.

So `/walkthrough` runs five scripted journeys of real API calls against the real
engines, each step paired with the claim it is meant to prove:

| Journey | The question it answers |
|---|---|
| **find** | State a condition and have it honoured |
| **gate** | The agent cannot pay you, and cannot order for you |
| **claim** | A complaint becomes a cited decision |
| **risk** | It stops a parcel failing, and asks before it costs you |
| **seller** | A fault costs the seller something |

The route records the stream's high-water mark before each step and reads the
gap afterwards, so every event is tied to the step that caused it. Each event is
shown beside its actor and **whether that actor was a language model or a pure
function** — classified once in `lib/actors.ts` and read by every surface. The
classification is deliberately not inferred from the name: a rule like "ends in
Agent" would be wrong for `GroundingGuard` and would silently misclassify
anything added later.

```
model    reads, writes prose, classifies, extracts.  Never decides money.
engine   pure function. Decides eligibility, remedies, amounts, deadlines.
person   a human pressed something.
system   the platform itself: the clock, the seeder, the mailer.
```

That is the one visual decision that matters: models and engines never share a
colour, so you can see without reading a word that every event touching money
is the same colour as every other engine.

Three rules it holds to:

1. **It calls the platform's own HTTP routes**, not the libraries underneath. A
   demonstration that bypasses the routes also bypasses the gates, and the gates
   are most of what is being demonstrated. The one step that proves the tool
   refusal calls `callTool()` in-process with the same agent identity a real
   turn uses — there is deliberately no public endpoint that invokes an
   arbitrary tool, since that would be the hole the gate exists to close.
2. **A step may fail, and several are supposed to.** Each step declares what it
   expects, and a step whose outcome differs is reported rather than hidden. A
   demonstration that cannot fail proves nothing. The **gate** journey includes
   *being told to do it anyway* — and nothing changes.
3. **Nothing is special-cased for the demo.** Every call is one a buyer or
   operator makes through the ordinary UI. If a walkthrough needed a code path
   that existed only for it, that would be a reason to fix the product.

`tests/walkthrough.test.ts` asserts the scripts against the system they
describe: that every step names a tool that exists, that a step claiming a
refusal is one the mandate actually refuses, that no decision-making engine is
ever labelled a model, and that `usesModel` is taken from `AGENTS` rather than
restated beside it. A walkthrough that narrates behaviour the code no longer has
is worse than no walkthrough.

## The fraud question, handled carefully

`assessAuthenticity()` scores *suspicion* 0–100 from signals that are each
checkable by a person: whether the photo shows the stated defect, whether the
courier record agrees, how quickly the claim arrived after delivery, whether it
landed at the very edge of the return window, and the buyer's claim history.

Three deliberate limits:

1. **It never decides the remedy or the amount.** That is `checkEntitlement`.
2. **It never rejects a buyer.** A high score sets `reviewRequired`, which routes
   the case to an operator. Accusing a customer of fraud is not a decision a
   scoring function makes on its own.
3. **The vision model is one capped signal among many**, so a single misread
   cannot condemn a claim.

The vision prompt asks for *observation*, not adjudication — what is in the
frame, not whether the buyer is lying. Asking a model "is this fraud?" invites
it to guess intent from pixels.

---

## Fourteen things to try

1. **Create an account and shop.** `/register` → name, email, password. You
   land on `/shop` as a buyer. Browse by category, filter to *Under ₹500* and
   *In stock only*, add something to the cart. Then try `/desk` — it refuses
   you, because public registration never grants operator access.

2. **Have it explain itself.** `/walkthrough` → pick **The agent cannot pay
   you, and cannot order for you** and run it. Five real calls, each one
   refused where it should be, with every event tagged by the actor that caused
   it and coloured by whether that actor was a model or a pure function. The
   last step tells the agent to do it anyway; nothing changes.

3. **Describe a need, not a product.** `/find` → *"I need a gift for my mother
   who has back pain"*. No budget, no spec, no product name — and the
   orthopaedic pillow comes first, above a cheaper face oil, because relevance
   outranks price when you have described a need. Then press the mic and say it
   in Hindi or Kannada — and with an `ELEVENLABS_API_KEY` set, it answers out
   loud in the language you spoke.

4. **Let the agent finish it.** On any result, press *Add the best match to my
   cart*. It adds the top-ranked offer with the reason recorded on the cart
   line, then stops at a confirmation showing the cost broken apart, the
   delivery interval and what it passed over. It cannot place the order.

5. **State a constraint instead of searching.** `/find` → press **The cooker**.
   Five conditions, one winner, and every rejection named with the value that
   failed it. Then drop the induction chip and watch what it was excluding.
   Sign in as Lakshmi (tier-3, COD, one prior failed delivery) and ask for the
   26th: the offer that *looks* like it makes the date is honestly rejected as
   too tight to promise.

6. **Order by conversation.** `/shop` → tell the rail *"2000 ke andar ek accha
   running shoe chahiye"*. It searches, explains each pick, and fills the cart.
   It cannot place the order — you press that button.

7. **Prevention.** Order `ORD-DEMO001` is COD to a tier-3 pincode with no
   landmark and one prior return. It scores HIGH before dispatch and the agent
   asks one cheap, specific question instead of doing something expensive. On a
   clean metro parcel it proposes nothing and says so.

8. **A complaint in another language.** Sign in as Arjun, open `ORD-DEMO002`
   (delivered 3 days ago, 7-day window), report a problem in Kannada or Hindi
   with a photo. Watch triage, the vision read, the authenticity score and the
   clause-cited verdict — then approve it on `/desk`.

9. **Autonomy.** On `/desk`, press **Skip to the deadline** on an approved
   claim. The clock really moves, the watcher finds a genuinely lapsed deadline,
   assembles the evidence pack and escalates with `humanPresent: false`. Nobody
   touched a keyboard.

10. **Adaptation.** On `/desk`, set **break tool** to `get_tracking`, then file a
   complaint. The step fails, the plan rewrites itself without it, and the case
   still reaches a clause-cited verdict. Open the plan on the case card to see
   the failed step struck through and the new route after it.

11. **The evals.** The **Evals** tab runs all 17 scenarios against the live
   pipeline and shows each assertion that passed. Note the `KNOWN LIMIT` row.

12. **Two problems, two remedies.** Sign in as Arjun, open `ORD-DEMO002` and
   report *"the earbuds are not working, and the charging case is missing"*.
   Both issues are adjudicated by the same rule engine, each citing its own
   clause, with the total capped at the order value. On `/desk` the case card
   gives each issue a checkbox — untick one to pay the other and reject it in
   the same decision. Then try *"it arrived smashed and now it will not switch
   on"*: one issue, because that is one broken unit described twice.

13. **Prevention, before the complaint.** `/desk` → **Order rescue** → *Run a
   rescue sweep*. `ORD-DEMO001` gets `ask_buyer` **queued for approval** —
   it reaches the buyer, so the agent may not do it alone. `ORD-DEMO008` gets
   `redirect_to_pickup` **executed and re-scored**, because that is reversible.
   The delivered orders are left alone and counted. Run it twice: the second
   pass proposes nothing, because the actions are already recorded.

14. **Dictate where it goes.** On `/orders` open the address book and say
   *"flat 402, Sai Residency, 12th Cross near Axis Bank, Jayanagar, Bangalore
   560041"*. The tier, city and state are derived from the pincode rather than
   taken from the form — and nothing is saved until you confirm what it heard.
   Then check out and watch the destination change the delivery promise.

Also on the desk: the **Sellers** tab, where an upheld claim has moved a
seller's observed defect rate and throttled or referred them — and the
**Refunds** tab, where every rupee owed carries the date the buyer was promised
and whether it is overdue.

Also worth seeing: `ORD-DEMO004` (courier says delivered, buyer says it never
came → `HUMAN_HANDOFF`, because both may be honest), `ORD-DEMO005` (delivered 35
days ago → an honest, clause-cited no) and `ORD-DEMO007` (delivered late on a
Rs 21,999 order → store credit, capped at Rs 200 rather than 5%).

---

## Tests

```bash
npm install
npm run setup             # report configuration, change nothing
npm run setup -- --seed   # build the catalogue and demo scenarios
npm test                  # 506 tests, including the 25-scenario eval suite
npm run typecheck         # tsc --noEmit
npm run build             # production build
npm run test:live         # the eval scenarios again, with a real model
npm run models            # which models your GROQ_API_KEY can reach
```

**There is no lint script in this repository**, so no linter was run. The
commands above are the full set that exist.

Last full run: **506 passed, 1 skipped, 0 failed** across 21 suites. That run
had a reachable `GROQ_API_KEY`, so the live-model suites executed too and the
real-model paths are covered as well as the deterministic ones. Without a key
those suites self-skip (9 skipped instead of 1) and everything else still
passes — the deterministic path is what a buyer gets when the model is
unreachable, and it is exercised either way.

- `tests/engines.test.ts` — 62 unit tests over the pure functions, both guards
  (verifier and grounding) and the state machine: purity,
  the money invariant (`amount ≤ order value`, enforced even for an operator
  override), window arithmetic, the confidence floor, verifier rejections.
- `tests/finder.test.ts` — 55 unit tests over the constraint solver and the
  offer economics: that a rejection names the constraint *and* the value that
  failed it, that a deadline is judged against the confident date rather than
  the optimistic one, that ranking is by expected total rather than sticker,
  and that the relaxation hint only counts candidates it would genuinely admit.
- `tests/finder-db.test.ts` — 10 integration tests against the seeded
  catalogue: that a SKU expands into one candidate per seller, that each
  seller's real defect rate reaches the cost, and that **the worked example
  printed on `/find` still produces the result the page claims.** A demo whose
  headline example quietly breaks is worse than no demo.
- `tests/needs.test.ts` — 17 tests over need-based matching: that eight
  described needs each find the right product without naming it, that relevance
  outranks price (the pillow above the cheaper face oil), and that a category
  the extractor *inferred* never scores relevance — it leaked once and ranked a
  ₹2,617 mixer above a ₹647 bottle for a buyer who had said nothing but
  "kitchen".
- `tests/seller-standing.test.ts` — 29 tests over seller accountability and
  refund-abuse patterns: that ten dismissed claims cannot move a seller's
  standing, that a three-order sample never restricts listings, that an
  organised pattern is caught even when every per-claim signal is clean, and
  that an upheld claim is never held against the buyer.
- `tests/speech.test.ts` — 58 tests over what the agent says aloud: that
  rupees are spoken ungrouped, that markdown and emoji never reach the voice,
  that a tight delivery date is not spoken as a promise, that "nothing is
  ordered yet" is always in the cart message, and that every narration already
  survives the sanitiser unchanged — if those two disagree, the audio says
  something the screen never showed.
- `tests/auth.test.ts` — 30 tests over authentication, authorization and buyer
  isolation, weighted toward the negative assertions: that a hash is salted and
  no account carries a plaintext password, that a new account is a buyer and the
  schema rejects an invented role, that one buyer's order listing excludes
  another's, that `openClaim` refuses an order belonging to someone else, that
  `/api/events` filters are AND-combined so a forged `claimId` narrows to
  nothing, that sign-in locks out after six attempts and counts two emails
  separately, and that the seed guard refuses once a registered account exists.
- `tests/catalogue.test.ts` — 20 tests over catalogue integrity: that it holds
  at least 50 products in at least 10 categories with no category below two,
  that every product resolves to a real seller and a real policy, that no SKU
  is duplicated and no policy unused, that every policy carries the clause tags
  the entitlement engine matches on, that no price exceeds its own MRP, and the
  two ranking rules the expansion taught — no `solves` phrase may begin with a
  generic opener, and none may name another category's product type.
- `tests/multi-issue.test.ts` — 38 tests over multi-issue adjudication, most of
  them about money that must **not** move: that two names for one fault collapse
  to one remedy, that nothing is owed on top of a full refund, that the
  aggregate is capped at the order value even on a tiny order, that which issue
  gets trimmed does not depend on the order the model listed them in, that the
  engine can only ever reduce a payout, and that a single issue behaves exactly
  as it did before this existed.
- `tests/rescue.test.ts` — 30 tests over the rescue engine, weighted toward
  restraint: that a clean parcel is left alone and the decline is explained,
  that a delivered or cancelled order is never rescued, that an action already
  taken is not proposed again, that the promise is judged against the confident
  date, that the attempt budget and the runway floor both hand off rather than
  loop, and that a reduction inside the same band still counts as an
  improvement.
- `tests/rescue-db.test.ts` — 27 integration tests against a real MongoDB and
  the real registry: that a two-issue complaint persists two rows, that one
  issue can be rejected while another pays, that an operator amount is
  re-capped, that a gated rescue is queued rather than performed, that a broken
  courier tool produces a handoff rather than a claimed success, and that
  **the rescue agent is refused when it reaches for money** — the claim that
  makes it safe to run unattended.
- `tests/address.test.ts` — 40 tests over destinations: that a pincode decides
  the tier, city and state rather than the form doing it, that only an
  undeliverable address blocks a sale while a missing landmark merely advises,
  that a dictated sentence splits into street and landmark without the
  preposition, that a pincode spoken as words is joined (in Hindi digits too),
  and that a half-remembered phone number is refused rather than stored.
- `tests/walkthrough.test.ts` — 23 tests asserting the scripted journeys
  against the system they describe: that every step names a tool that exists,
  that a step claiming a refusal is one the mandate actually refuses, that no
  decision-making engine is ever labelled a model nor a model an engine, and
  that `usesModel` is read from `AGENTS` rather than restated. A walkthrough
  that narrates behaviour the code no longer has is worse than none.
- `tests/pipeline.test.ts` — 33 integration tests against a real MongoDB,
  walking the whole platform: seed, multilingual search, the mandate, the gate,
  ordering, fulfilment, four complaint scenarios, approval, and autonomous
  escalation. **No model key required** — these exercise the floor.
- `tests/evals.test.ts` — the 25-scenario eval suite, also runnable from the
  **Evals** tab on the desk. It additionally asserts that **no** scenario
  declares a `knownLimitation` and that every scenario asserted at least one
  check — a scenario with no checks reports PASS while testing nothing.
- `tests/fallback.test.ts` — the deterministic path, pinned with the key
  removed. These exist because the fallback is what a buyer actually gets when
  the model is unreachable, so it has to be correct rather than merely present.
- `tests/live-llm.test.ts`, `tests/live-agent.test.ts` — real calls to Groq.
  They skip themselves with no key, and cover the one thing unit tests cannot:
  that a **model-written plan still cannot get past the approval gate**.

Two suites deliberately remove `GROQ_API_KEY` for their duration
(`pipeline`, `evals`) because they assert exact remedies and amounts, which a
model in the loop would make legitimately vary. The test setup also **refuses
to use `MONGODB_URI`**: every suite seeds destructively, so pointing it at a
real cluster would delete that data.

---

## The eval suite

25 scenarios, on the **Evals** tab of the desk or via `npm test`. Each one
asserts a claim about the system that you would otherwise have to take on
trust, and each runs against the **real pipeline** — the same engines, registry
and gate the storefront uses, not mocks.

| Covers | Scenarios |
|---|---|
| The remedy ladder, and buyer priority deciding between goods and cash | 1–5, 17 |
| Honest refusals: out of window, and a courier record that contradicts the buyer | 6, 7 |
| Native script and transliteration (Kannada, Tamil, Hinglish) | 3, 8, 9 |
| Authenticity: a repeat claimant, and a corroborated first claim | 10, 11 |
| Prevention, including the agent declining to act on a low-risk parcel | 12, 13 |
| Adaptation: a tool dies and the plan rewrites around it | 14 |
| Autonomy: a deadline lapses and the tracker escalates alone | 15 |
| Multi-issue: two issues each adjudicated, one fault not paid twice, three issues capped | 16, 18, 19 |
| Rescue: acting, declining to act, the reversible action, the retry limit, idempotency | 20–25 |

Four invariants are asserted on **every** relevant scenario, not just the ones
they are about:

- the payout never exceeds the order value;
- the letter was verified before anyone could see it;
- the aggregate across every issue is within the order value, and no issue pays
  more than the engine allowed it (every claim scenario);
- **the rescue agent cannot move money** — each rescue scenario calls
  `issue_refund` as the RiskAgent and fails if it is not refused.

Running the suite reseeds the database. That is deliberate — an eval whose
result depends on what the last person clicked is not a regression suite.

### The limitation that used to be here

Scenario 16 was reported as `KNOWN LIMIT` and said this:

> Triage returns a single `issueType`. A complaint carrying two distinct issues
> is classified as the stronger one only, so *"the earbuds are dead **and** the
> charging case is missing"* yields one remedy. Triage records the second issue;
> the claim model cannot remedy it. Fixing this properly needs multi-issue case
> splitting, which would change the claim model.

**That is now implemented** — see [Implementation updates](#implementation-updates).
The claim model gained a per-issue array, each issue is adjudicated by the same
entitlement engine, and the aggregate is capped. Scenario 16 is an ordinary
passing scenario, and 18 and 19 cover the two cases that make it safe: one fault
described twice, and three issues that must not sum past the order value.

The suite still asserts the *reporting mechanism*, inverted: if any future
scenario declares a `knownLimitation`, `tests/evals.test.ts` fails and forces a
decision about whether to fix it or document it. That is what the original
assertion existed to protect, and a suite that reports 100% by omitting its hard
case is still not telling you anything.

Remaining limitations are listed under [Notes](#notes) rather than hidden
here.

### What the evals caught

They earned their keep immediately. Writing them surfaced three real bugs:

1. The Orchestrator could not call `check_entitlement` — it lacked the `compute`
   capability, so the mandate refused its own plan's steps. Fixed by running
   each step as the agent that owns the tool.
2. `get_policy` could not be asked for "the policy for this order", which is
   what a planner naturally reaches for.
3. The verifier rejected its own fallback template, because it treated *every*
   date in a letter as a deadline claim. A window-expiry date the engine itself
   stated is a verifiable fact, so the permitted set is now "any date the engine
   produced".

## Layout

```
src/
  lib/
    engines/        entitlement · risk · authenticity · states   PURE, unit-tested
                    constraints (solves a stated need, explains every rejection)
                    offers (trueCost · deliveryForecast)          PURE, unit-tested
                    seller-standing (what a fault costs a seller)  PURE, unit-tested
                    pincode (tier, city and state from six digits) PURE, unit-tested
                    multi-issue (a remedy per issue, aggregate capped) PURE
                    rescue (is a promise at risk, and is there time)   PURE
    agent/          orchestrator (plan→execute→verify→replan)
                    grounding (checks replies against tool results)
                    shopping · triage · claims · verifier · approval
                    constraint-extractor (sentence → constraints; also rule-only)
                    address-extractor (one spoken sentence → a destination)
                    issue-splitter (one complaint → its distinct issues)
                    rescue (drives a rescue through the registry and the gate)
                    watcher · tools (the registry + gate) · mandate
    mail/           mailer (Nodemailer) · templates
    groq/           the one place a language model is called
    speech/         eleven (ElevenLabs TTS) · narrate (what it says, PURE)
    events.ts       the append-only stream everything projects from
    clock.ts        simulated clock, so deadlines can actually lapse
    finder.ts       need matching + candidate gathering, then the solver
    addresses.ts    normalising a destination; advice worth acting on
    seed-guard.ts   refuses a destructive seed over real accounts
    auth/throttle   in-process rate limiting for sign-in and registration
    actors.ts       model vs. engine vs. person, classified once
    walkthrough.ts  five scripted journeys over the real routes
    refunds.ts      the refund ledger: how much, to where, by when
    sellers.ts      records claim outcomes against the seller who caused them
    orders.ts       placing an order and the delivery lifecycle
    seed.ts         72 products, 12 sellers, 10 policies, 8 demo orders
    evals.ts        the 25 scenarios · eval-runner.ts  runs them for real
  models/           Mongoose schemas + lean read types
  app/
    page.tsx        the front door
    register/       public sign-up — every account here is a buyer
    find/           state a need → what satisfies it, and why the rest did not
    walkthrough/    scripted journeys, with the actor behind every event
    shop/           storefront with the agent rail
    orders/         buyer timeline, tracking, complaints
    desk/           the approval gate and demo controls
    api/            30 routes
  components/       AgentRail · ComplaintForm · PlanTrace · EvalPanel · ui
                    AddressBook · DestinationBlock · Shell · RescuePanel
scripts/
  setup.ts          seeding and operator provisioning, from the CLI only
  app/system/       "How it works" — the engines, gates and machine on screen
```

## What this replaced

There was an earlier Python/FastAPI prototype in this repository called
`rakshak`. It has been **removed** — everything it did now lives here, and
running two apps that both claimed to be the system was the main source of
confusion.

| From rakshak | Where it is now |
|---|---|
| `engines/entitlement.py` | `lib/engines/entitlement.ts` |
| `engines/risk.py` | `lib/engines/risk.ts` |
| `engines/states.py` | `lib/engines/states.ts` — now *enforced* on every write |
| `agents/orchestrator.py` | `lib/agent/orchestrator.ts` |
| `agents/verifier.py` | `lib/agent/verifier.ts` |
| `agents/triage.py` | `lib/agent/triage.ts` |
| `agents/mandate.py` | `lib/agent/mandate.ts` |
| `agents/llm.py` | `lib/groq/client.ts` — plus model failover |
| `agents/runner.py` | `lib/agent/claims.ts` |
| `tools/registry.py` | `lib/agent/tools.ts` |
| `events.py` | `lib/events.ts` |
| `clock.py`, `chaos.py` | `lib/clock.ts` |
| `watcher.py` | `lib/agent/watcher.ts` |
| `marketplace/mock_api.py` | `lib/agent/tools.ts` (named pickup points) |
| `evals/` | `lib/evals.ts`, `lib/eval-runner.ts` |
| `db.py`, `auth.py`, `config.py` | `models/`, `lib/auth/`, `lib/env.ts` |

Added on top: the whole pre-delivery lane (conversational ordering, cart,
catalogue, fulfilment), the authenticity engine, vision analysis of defect
photographs, Whisper voice intake, Nodemailer, and the grounding guard.

**All of it is visible at `/system`**, which renders the engines, their
constants, each agent's authority, the gates, the state machine, the fallback
plan and the eval list — every value imported from the module that uses it, so
the page cannot drift from the behaviour.

## Notes

- **Evidence storage.** Photographs are stored inline as data URLs so the
  platform needs no object store. `claim.evidence[].dataUrl` is the one field to
  change for S3 or GridFS.
- **The simulated clock** exists because deadline-driven autonomy cannot be
  demonstrated in real time. Every component asks `now()` rather than
  `new Date()`, so advancing it genuinely breaches deadlines — the escalation is
  real, not an animation.
- **Light theme throughout.** There is no dark mode: the palette is indigo ink
  on warm paper with haldi gold as the single accent. Motion is used for two
  jobs only — showing that something arrived, and confirming what you just did.
  There are no scroll-triggered reveals. Everything is disabled under
  `prefers-reduced-motion`, which is the last rule in the stylesheet so it wins.
- **Fictional data.** Every seller, price, buyer and parcel here is invented.

## Environment and deployment

### Local development

Nothing is required. `npm run setup -- --seed && npm run dev` works on a clean
checkout: the database is in-process, the model path falls back to
deterministic rules, and mail is captured to the Outbox tab.

### Production

```bash
# Required.
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/vaanijya
AUTH_SECRET=<32+ random bytes>      # signs every session cookie

# Optional; each one is reported as live or degraded in the header.
GROQ_API_KEY=gsk_...                 # the conversational and vision paths
ELEVENLABS_API_KEY=...               # spoken replies
SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASS=...
OPS_EMAIL=ops@example.com
APP_BASE_URL=https://example.com

# Deliberately NOT set in normal operation. Setting it permits a seed that
# deletes every collection, including registered accounts.
# ALLOW_DESTRUCTIVE_SEED=true
```

Two of these are **fatal** if wrong, and `npm run setup` exits non-zero rather
than letting them pass:

- **`MONGODB_URI` missing in production** — the in-process database loses every
  account and order on restart, so registration would appear to work and
  silently not persist. Registration answers 503 with the reason instead.
- **`AUTH_SECRET` left at the development default** — every session cookie
  would be signed with a value published in this repository.

```bash
npm ci
npm run build
npm start
npm run setup -- --operator you@example.com   # once, to get into /desk
```

**This is not deployed anywhere.** There is no hosting, no CDN, no payment
provider and no courier integration configured. The build is a standard Next.js
standalone output and nothing here has been verified against a real host.

### Accounts in production

Public registration creates buyers. Operators are promoted by the CLI above,
which requires shell access to the machine that owns the database — there is no
HTTP path to the operator role. Demo accounts are hidden by the server in a
production build, so the published `demo123` never reaches a browser there; if
you do not want them in the database at all, do not run the seed.

---

## Limitations, honestly

What is simulated, what is assumed, and what is not built. Nothing here is
claimed to be an integration that is not one.

**Simulated, not integrated**

- **The courier.** `reschedule_delivery`, `redirect_to_pickup` and
  `hold_shipment` write the shipment state a real courier API would cause. No
  request leaves the process. Every event carries `simulatedCourier: true`, and
  the desk panel and `/system` both say so.
- **Payments and refunds.** No payment provider is called. A refund writes a
  ledger row with an amount, a destination and a settlement date derived from
  the policy SLA; advancing the clock settles it. Store credit is a counter on
  the user.
- **Email.** Real when SMTP is configured, captured to the Outbox tab
  otherwise. Both paths are visible.
- **The clock.** Simulated so deadline-driven autonomy can be demonstrated.
  Every component asks `now()`, so advancing it genuinely breaches deadlines.

**Not measured**

- **No claim that delivery failures have fallen.** The rescue agent's precision
  is asserted on fixed scenarios — it intervenes on the parcels it should and
  declines on the ones it should not, deterministically. That is a correctness
  property, not an effectiveness one. Measuring whether interventions actually
  reduce failures needs real parcels and a control group, and neither exists
  here. The eval suite reports interventions, handoffs, declines and risk
  points removed; it does not report delivery outcomes, because it cannot.
- **Intervention benefit is modelled, not observed.** "Removes the 30-point COD
  refusal risk" is what the risk engine's own weights say, not a measured
  effect.
- **The re-score often reports no change, and says so.** `riskScore` reads the
  payment mode, the pincode tier, the address quality and the *failed attempt
  count* — not the shipment status. So a pickup redirect, which removes the
  remaining doorstep attempts, does not lower the score: `redirect_to_pickup`
  on `ORD-DEMO008` reports *"risk unchanged at 39/100 (MEDIUM)"*. That is
  honest rather than broken — the parcel's underlying risk factors genuinely
  have not changed — but it means the score is not a measure of whether the
  rescue worked. Making it one would need the risk engine to read shipment
  status, which would change a scoring function the rest of the platform
  depends on, so it is reported instead.

**Multi-issue limits**

- **Four issues per complaint.** Beyond that, extra issues are dropped rather
  than adjudicated. A complaint with five genuinely distinct problems is a
  conversation, not a form.
- **Issue splitting depends on the model for hard cases.** The deterministic
  path splits on conjunctions in eight languages and classifies each fragment
  with the shared keyword table, which handles the common shapes. A complaint
  whose two issues share no conjunction and no distinguishing keyword will come
  back as one issue on the fallback path. It is never *worse* than the previous
  single-issue behaviour, but it is not as good as the model path.
- **Issue-level evidence is not attributed per issue.** A photograph is
  associated with the whole claim and bears on every issue; the vision model is
  not asked which of two issues a given image supports. Fixing that properly
  needs per-issue evidence upload in the complaint form.
- **One letter per claim.** The buyer gets a single verified letter headed by
  the primary issue, with the aggregate amount — not one letter per issue.

**Authentication and accounts**

- **Rate limiting is in-process.** The counters live in one Node process, so
  several instances behind a load balancer each enforce their own share, and a
  restart forgets them. That is the honest cost of adding no infrastructure for
  it; a real deployment belongs in a shared store, and this is a limit rather
  than an airtight control.
- **No CSRF tokens.** Every mutating route is `POST`/`PATCH`/`DELETE` with a
  JSON body and the cookie is `sameSite=lax`, which stops a cross-site form
  post. Adding a form-encoded endpoint would need tokens.
- **No email verification, no password reset, no 2FA.** An address is never
  confirmed, so a typo locks someone out with no recovery path. These are real
  gaps for a production storefront, not oversights being glossed: the flows do
  not exist.
- **`x-forwarded-for` is trusted for rate limiting only**, never for
  authorization. It is spoofable by anyone who can reach the app directly.
- **Sessions cannot be revoked server-side.** A JWT is valid until it expires,
  so a sign-out clears the cookie but does not invalidate a copied token.

**Catalogue**

- **A guest's cart read returns an empty cart, not a 401.** Making `/shop` and
  `/find` public initially left both the shell and the page fetching the cart
  on mount, so a signed-out first load emitted two 401s. `GET /api/cart` now
  answers `{count: 0, signedIn: false}` for nobody — reading your own empty
  cart is not an error — while `POST` still requires a session, so the
  relaxation is read-only. Both callers also wait until identity is known
  before asking at all.
- **All 72 products are fictional**, including every price, rating, stock level,
  seller and defect rate. Nothing here is real marketplace data, and the
  comparison is between sellers inside this catalogue only.
- **Images are emoji on a tinted tile**, not photography. That is deliberate
  over fragile external image URLs, and it means the product cards do not look
  like a real storefront's.
- **Keyword search matches each term independently**, so a two-word query
  returns loose hits — "home gym" matches 24 products. `/find` is the precise
  path; this is browse-and-scan.
- **No product detail route.** A card links to a filtered `/shop` search rather
  than `/product/[sku]`, so specifications are visible on the card and in
  `/find`, not on a dedicated page.
- **No pagination UI.** The grid requests up to 72 at once, which covers the
  whole catalogue today. The API supports `offset`/`limit` and reports
  `hasMore`; the control is not built.

**Required setup**

- **No migration is needed.** Every new field is additive and defaulted:
  `Claim.issues` to `[]`, `Order.rescueState` to `"NONE"`, `User.addresses` to
  `[]`. A claim or account written before this work reads exactly as it did.
- **Re-seed to pick up the catalogue expansion.** An existing database still
  holds the 31-product catalogue; `npm run setup -- --seed` rebuilds it, and the
  guard will refuse if real accounts would be lost (use `--force` only on a
  scratch database).
- **No new dependencies.** Nothing was added to `package.json` for any of this
  work — the only change is two new scripts, `setup` and a `seed` that now
  points at it. The previous `npm run seed` referenced `scripts/seed.ts`, which
  did not exist, so that command was broken before this.

**Not independently verified**

- The live-model suites (`live-llm`, `live-agent`, `evals-live`) self-skip
  without a reachable `GROQ_API_KEY` and were **skipped** on the run reported
  above. Everything else is exercised on the deterministic path, which is what
  a buyer actually gets when the model is unreachable.
- There is no lint script in this repository, so no linter was run. `npm run
  typecheck` and `npm run build` both pass.
- **The UI was verified by rendering, not by a browser test suite.** The dev
  server was run and the pages fetched: the front door returns 12 category
  tiles and 24 product cards from real rows, the catalogue API returns correct
  counts for every filter combination, registration returns `role: "buyer"`,
  all four operator routes return 403 for a buyer, and sign-in returns six 401s
  then a 429. There are no automated visual, interaction or screen-reader
  tests, so the accessibility claims above are from the markup and the
  stylesheet rather than from an audit tool.
- **No deployment was performed**, and no production database or host was
  configured or tested.
