# Vaanijya

An Indian e-commerce platform with a deep agent on both sides of delivery.

**Before delivery** — a buyer says what they need, in their own language, typed
or spoken. The agent searches the catalogue, fills the cart with a reason for
each item, and scores the parcel for delivery failure before it is dispatched.

**After delivery** — something arrives broken. The buyer reports it in their own
language, with photographs. A vision model reports what is actually in the
frame, a scoring function weighs that against the courier record and the buyer's
claim history, a rule engine decides the remedy, and **an operator approves
before a rupee moves**.

---

## Run it

```bash
npm install
cp .env.example .env.local     # optional — it boots without this
npm run dev                    # http://localhost:3000
```

On first visit the sign-in page offers to build the database. Click it. Every
demo password is `demo123`.

Nothing in `.env.local` is required. With no keys at all the platform still
runs end to end on deterministic paths, and the header says which capabilities
are degraded rather than failing silently.

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
```

`checkEntitlement` is the single most important file in the repository. It
decides eligibility, remedy, amount and deadline from the policy clauses, and
there is no model call inside it. The verifier then rejects any draft whose
numbers, dates or clause citations do not match that verdict — and falls back to
a template that is grounded by construction.

> The model classifies the complaint and writes the letter. A rule engine with
> unit tests does the arithmetic. We don't let a model do arithmetic on
> someone's refund.

## State a constraint and have it honoured

`/find` is the answer to the thing that actually wastes a buyer's time, which
is not price — it is that **you cannot express a constraint and have it
honoured.** Every platform makes you translate a real need into its filters,
then scroll two hundred results to find out whether it worked.

So you state the conditions instead:

> *A pressure cooker for my induction hob, 5 litres at most, under ₹2000, must
> be in stock, and I need it before the 28th.*

A model reads that sentence into a constraint list — and does nothing else.
`solveConstraints()` (pure, 48 unit tests) decides what qualifies:

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

## Nine things to try

1. **Describe a need, not a product.** `/find` → *"I need a gift for my mother
   who has back pain"*. No budget, no spec, no product name — and the
   orthopaedic pillow comes first, above a cheaper face oil, because relevance
   outranks price when you have described a need. Then press the mic and say it
   in Hindi or Kannada — and with an `ELEVENLABS_API_KEY` set, it answers out
   loud in the language you spoke.

2. **Let the agent finish it.** On any result, press *Add the best match to my
   cart*. It adds the top-ranked offer with the reason recorded on the cart
   line, then stops at a confirmation showing the cost broken apart, the
   delivery interval and what it passed over. It cannot place the order.

3. **State a constraint instead of searching.** `/find` → press **The cooker**.
   Five conditions, one winner, and every rejection named with the value that
   failed it. Then drop the induction chip and watch what it was excluding.
   Sign in as Lakshmi (tier-3, COD, one prior failed delivery) and ask for the
   26th: the offer that *looks* like it makes the date is honestly rejected as
   too tight to promise.

4. **Order by conversation.** `/shop` → tell the rail *"2000 ke andar ek accha
   running shoe chahiye"*. It searches, explains each pick, and fills the cart.
   It cannot place the order — you press that button.

5. **Prevention.** Order `ORD-DEMO001` is COD to a tier-3 pincode with no
   landmark and one prior return. It scores HIGH before dispatch and the agent
   asks one cheap, specific question instead of doing something expensive. On a
   clean metro parcel it proposes nothing and says so.

6. **A complaint in another language.** Sign in as Arjun, open `ORD-DEMO002`
   (delivered 3 days ago, 7-day window), report a problem in Kannada or Hindi
   with a photo. Watch triage, the vision read, the authenticity score and the
   clause-cited verdict — then approve it on `/desk`.

7. **Autonomy.** On `/desk`, press **Skip to the deadline** on an approved
   claim. The clock really moves, the watcher finds a genuinely lapsed deadline,
   assembles the evidence pack and escalates with `humanPresent: false`. Nobody
   touched a keyboard.

8. **Adaptation.** On `/desk`, set **break tool** to `get_tracking`, then file a
   complaint. The step fails, the plan rewrites itself without it, and the case
   still reaches a clause-cited verdict. Open the plan on the case card to see
   the failed step struck through and the new route after it.

9. **The evals.** The **Evals** tab runs all 17 scenarios against the live
   pipeline and shows each assertion that passed. Note the `KNOWN LIMIT` row.

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
npm test          # 266 tests, including the 17-scenario eval suite
npm run test:live # the same scenarios again, with a real model in the loop
npm run models    # which models your GROQ_API_KEY can actually reach
```

- `tests/engines.test.ts` — 62 unit tests over the pure functions, both guards
  (verifier and grounding) and the state machine: purity,
  the money invariant (`amount ≤ order value`, enforced even for an operator
  override), window arithmetic, the confidence floor, verifier rejections.
- `tests/finder.test.ts` — 48 unit tests over the constraint solver and the
  offer economics: that a rejection names the constraint *and* the value that
  failed it, that a deadline is judged against the confident date rather than
  the optimistic one, that ranking is by expected total rather than sticker,
  and that the relaxation hint only counts candidates it would genuinely admit.
- `tests/finder-db.test.ts` — 10 integration tests against the seeded
  catalogue: that a SKU expands into one candidate per seller, that each
  seller's real defect rate reaches the cost, and that **the worked example
  printed on `/find` still produces the result the page claims.** A demo whose
  headline example quietly breaks is worse than no demo.
- `tests/needs.test.ts` — 20 tests over need-based matching: that eight
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
- `tests/speech.test.ts` — 39 tests over what the agent says aloud: that
  rupees are spoken ungrouped, that markdown and emoji never reach the voice,
  that a tight delivery date is not spoken as a promise, that "nothing is
  ordered yet" is always in the cart message, and that every narration already
  survives the sanitiser unchanged — if those two disagree, the audio says
  something the screen never showed.
- `tests/pipeline.test.ts` — 31 integration tests against a real MongoDB,
  walking the whole platform: seed, multilingual search, the mandate, the gate,
  ordering, fulfilment, four complaint scenarios, approval, and autonomous
  escalation. **No model key required** — these exercise the floor.
- `tests/evals.test.ts` — the 17-scenario eval suite, also runnable from the
  **Evals** tab on the desk. One scenario is reported as `KNOWN LIMIT` rather
  than passed or hidden; see below.
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

17 scenarios, on the **Evals** tab of the desk or via `npm test`. Each one
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
| A limitation we report rather than hide | 16 |

Two invariants are asserted on **every** claim scenario, not just the ones
about money: the payout never exceeds the order value, and the letter was
verified before anyone could see it.

Running the suite reseeds the database. That is deliberate — an eval whose
result depends on what the last person clicked is not a regression suite.

### The known limitation

Scenario 16 is reported as `KNOWN LIMIT`, separately from passes and failures:

> Triage returns a single `issueType`. A complaint carrying two distinct issues
> is classified as the stronger one only, so *"the earbuds are dead **and** the
> charging case is missing"* yields one remedy. Triage records the second issue;
> the claim model cannot remedy it. Fixing this properly needs multi-issue case
> splitting, which would change the claim model.

A suite that reports 100% by omitting its hard case is not telling you anything.

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
    agent/          orchestrator (plan→execute→verify→replan)
                    grounding (checks replies against tool results)
                    shopping · triage · claims · verifier · approval
                    constraint-extractor (sentence → constraints; also rule-only)
                    watcher · tools (the registry + gate) · mandate
    mail/           mailer (Nodemailer) · templates
    groq/           the one place a language model is called
    speech/         eleven (ElevenLabs TTS) · narrate (what it says, PURE)
    events.ts       the append-only stream everything projects from
    clock.ts        simulated clock, so deadlines can actually lapse
    finder.ts       need matching + candidate gathering, then the solver
    refunds.ts      the refund ledger: how much, to where, by when
    sellers.ts      records claim outcomes against the seller who caused them
    orders.ts       placing an order and the delivery lifecycle
    seed.ts         the database and the seven demo scenarios
    evals.ts        the 17 scenarios · eval-runner.ts  runs them for real
  models/           Mongoose schemas + lean read types
  app/
    page.tsx        the front door
    find/           state a need → what satisfies it, and why the rest did not
    shop/           storefront with the agent rail
    orders/         buyer timeline, tracking, complaints
    desk/           the approval gate and demo controls
    api/            23 routes
  components/       AgentRail · ComplaintForm · PlanTrace · EvalPanel · ui
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
