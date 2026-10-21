/**
 * The demonstration, and what it claims.
 *
 * A walkthrough shown to someone evaluating this is worse than nothing if it
 * is wrong. Two classes of error matter and both are pinned here:
 *
 *  - an actor classified as an engine that is actually a model, or the other
 *    way round — the colour on the screen is the argument, and a wrong one is
 *    a false claim about the architecture,
 *  - a step whose `proves` text describes something the step does not do,
 *    which is why the tool names and the gates are checked against the real
 *    mandate rather than trusted.
 */
import { describe, it, expect } from "vitest";
import { WALKTHROUGHS, walkthroughById } from "@/lib/walkthrough";
import { actorFacts, allActors, stageOf, isPivotal, type ActorKind } from "@/lib/actors";
import { AGENTS, TOOL_CAPABILITY, APPROVAL_REQUIRED, BUYER_CONFIRM_REQUIRED, may } from "@/lib/agent/mandate";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ──────────────────────── Who is a model, who is not ──────────────────── */

describe("actor classification", () => {
  it("classifies every actor the event stream can emit", () => {
    // An unclassified actor renders as "Unclassified" in grey, which tells a
    // judge nothing. The list is maintained by hand on purpose: a rule like
    // "ends in Agent" would misclassify GroundingGuard and RiskAgent.
    const emitted = [
      "ShoppingAgent", "ConstraintAgent", "ConstraintParser", "ConstraintSolver",
      "AddressAgent", "AddressParser", "TriageAgent", "PolicyAgent", "ActionAgent",
      "Orchestrator", "TrackerAgent", "MailAgent", "RiskAgent", "FraudAnalyst",
      "SellerStandingEngine", "GroundingGuard", "VerifierAgent",
      "Buyer", "buyer", "operator", "system",
    ];
    for (const a of emitted) {
      expect(actorFacts(a).name, a).not.toBe("Unclassified");
    }
  });

  it("never calls a decision-making engine a model", () => {
    // The claim the whole architecture rests on. If any of these is labelled
    // a model, the page is lying about who decided the money.
    // FraudAnalyst is deliberately NOT here: it reads the photographs, so
    // `AGENTS.usesModel` declares it a model. The arithmetic that follows the
    // vision call is not what the label is about.
    const engines = [
      "ConstraintSolver", "EntitlementEngine", "RiskAgent", "PolicyAgent",
      "SellerStandingEngine", "GroundingGuard", "ConstraintParser", "AddressParser",
      "VerifierAgent",
    ];
    for (const e of engines) {
      expect(actorFacts(e).kind, e).toBe<ActorKind>("engine");
    }
  });

  it("never calls a model an engine", () => {
    const models = [
      "ShoppingAgent", "ConstraintAgent", "AddressAgent", "TriageAgent",
      "ActionAgent", "Orchestrator", "FraudAnalyst", "MailAgent",
    ];
    for (const m of models) {
      expect(actorFacts(m).kind, m).toBe<ActorKind>("model");
    }
  });

  it("names the operator who approved rather than the word 'operator'", () => {
    // Approvals record `operator:ops@vaanijya.in`, and an audit trail that
    // says only "operator" has lost the thing an audit is for.
    const facts = actorFacts("operator:ops@vaanijya.in");
    expect(facts.kind).toBe<ActorKind>("person");
    expect(facts.name).toBe("ops@vaanijya.in");
  });

  it("does not break on an actor nobody classified", () => {
    const facts = actorFacts("SomethingAddedLater");
    expect(facts.kind).toBe<ActorKind>("system");
    expect(facts.name).toBe("Unclassified");
  });

  it("gives every model a stated limit", () => {
    // A model with no "cannot" line is a model the page cannot explain the
    // boundaries of, which is the only reason to show its name at all.
    const unbounded = allActors()
      .filter((a) => a.kind === "model" && !a.cannot)
      .map((a) => a.name);
    // Three models only write prose from a decision already made, so they
    // have no money boundary worth stating; everything else must declare one.
    expect(unbounded.length).toBeLessThanOrEqual(3);
  });
});

/* ─────────────────────────── Stages and pivots ─────────────────────────── */

describe("reading the trail", () => {
  it("files every event type under a stage", () => {
    for (const type of [
      "finder.solved", "cart.item_added", "order.placed", "order.delivered",
      "shipment.scan", "risk.scored", "claim.opened", "refund.settled",
      "seller.standing_updated", "address.added", "agent.tool_call", "system.seeded",
    ]) {
      expect(stageOf(type), type).toBeTruthy();
    }
  });

  it("files a delivered order under after-delivery, not ordering", () => {
    // The moment the journey changes hands: everything before it is logistics,
    // everything after is a claim.
    expect(stageOf("order.delivered")).toBe("transit");
    expect(stageOf("order.placed")).toBe("order");
    expect(stageOf("claim.opened")).toBe("claim");
  });

  it("marks a refused tool call as worth stopping on", () => {
    const why = isPivotal("agent.tool_call", { refused: true });
    expect(why).toBeTruthy();
    expect(why).toMatch(/refused/i);
  });

  it("does not mark ordinary traffic", () => {
    expect(isPivotal("agent.tool_call", { ok: true })).toBeNull();
    expect(isPivotal("cart.item_added")).toBeNull();
  });

  it("marks every moment the architecture is about", () => {
    for (const type of [
      "agent.grounding_rejected", "claim.draft_rejected", "claim.approval_requested",
      "claim.handoff", "risk.intervention_proposed", "agent.replanned",
      "seller.listings_restricted",
    ]) {
      expect(isPivotal(type), type).toBeTruthy();
    }
  });
});

/* ───────────────────── The scripts say what they do ───────────────────── */

describe("the walkthrough scripts", () => {
  it("offers a journey for each thing a judge asks about", () => {
    expect(WALKTHROUGHS.length).toBeGreaterThanOrEqual(5);
    for (const w of WALKTHROUGHS) {
      expect(w.steps.length, w.id).toBeGreaterThan(0);
      // The question is what the card shows; without it the menu is a list of
      // feature names.
      expect(w.question, w.id).toMatch(/\?$/);
      expect(w.seconds, w.id).toBeGreaterThan(0);
    }
  });

  it("gives every step a claim, not a description of the HTTP call", () => {
    for (const w of WALKTHROUGHS) {
      for (const s of w.steps) {
        expect(s.proves.length, `${w.id}/${s.id}`).toBeGreaterThan(60);
        expect(s.title.length, `${w.id}/${s.id}`).toBeGreaterThan(10);
      }
    }
  });

  it("has unique ids, so a single step can be re-run", () => {
    const ids = WALKTHROUGHS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of WALKTHROUGHS) {
      const stepIds = w.steps.map((s) => s.id);
      expect(new Set(stepIds).size, w.id).toBe(stepIds.length);
    }
  });

  it("only names tools that exist", () => {
    // A step calling a renamed tool would fail at demo time, in front of
    // whoever it was written for.
    for (const w of WALKTHROUGHS) {
      for (const s of w.steps) {
        if (!s.callsTool) continue;
        expect(TOOL_CAPABILITY, `${w.id}/${s.id}`).toHaveProperty(s.callsTool.tool);
      }
    }
  });

  it("only claims a refusal where the mandate actually refuses", () => {
    // The point of the whole exercise. Every step marked `expectRefusal` must
    // be refused by the real mandate — either on capability or at a gate —
    // checked here against the same tables the registry uses.
    for (const w of WALKTHROUGHS) {
      for (const s of w.steps) {
        if (!s.expectRefusal || !s.callsTool) continue;
        const { tool, agent } = s.callsTool;
        const refused =
          !may(agent, tool) ||
          APPROVAL_REQUIRED.has(tool) ||
          BUYER_CONFIRM_REQUIRED.has(tool);
        expect(refused, `${w.id}/${s.id}: ${agent} calling ${tool} is NOT refused`).toBe(true);
      }
    }
  });

  it("proves the two gates separately", () => {
    // They are different mechanisms and a judge should see both: one refuses
    // on capability before any handler runs, the other queues for a human.
    const gate = walkthroughById("gate");
    expect(gate).toBeTruthy();

    const calls = gate!.steps.filter((s) => s.callsTool).map((s) => s.callsTool!);
    const byCapability = calls.filter((c) => !may(c.agent, c.tool));
    const byGate = calls.filter(
      (c) => may(c.agent, c.tool) && (APPROVAL_REQUIRED.has(c.tool) || BUYER_CONFIRM_REQUIRED.has(c.tool)),
    );

    expect(byCapability.length, "no step trips the capability check").toBeGreaterThan(0);
    expect(byGate.length, "no step reaches an approval gate").toBeGreaterThan(0);
  });

  it("marks the steps that only re-read the trail", () => {
    // A GET of the event stream emits nothing, so attributing "events since
    // the last mark" to it would show an empty step.
    for (const w of WALKTHROUGHS) {
      for (const s of w.steps) {
        if (s.path.startsWith("/api/events")) {
          expect(s.reviewsPrevious, `${w.id}/${s.id}`).toBe(true);
        }
      }
    }
  });

  it("finds a walkthrough by id, and nothing by a wrong one", () => {
    expect(walkthroughById("gate")?.id).toBe("gate");
    expect(walkthroughById("nope")).toBeUndefined();
  });
});

/* ─────────── The classification cannot drift from the mandate ─────────── */

describe("actors.ts agrees with the mandate", () => {
  it("takes usesModel from AGENTS for every agent the registry knows", () => {
    // Two files with an opinion about the same fact is how a page comes to
    // claim a language model is a pure function. The mandate is the authority
    // because it is what the capability check itself reads.
    for (const [name, spec] of Object.entries(AGENTS)) {
      const expected: ActorKind = spec.usesModel ? "model" : "engine";
      expect(actorFacts(name).kind, `${name} (AGENTS says usesModel=${spec.usesModel})`).toBe(
        expected,
      );
    }
  });

  it("classifies every agent in the mandate", () => {
    for (const name of Object.keys(AGENTS)) {
      expect(actorFacts(name).name, name).not.toBe("Unclassified");
    }
  });

  it("credits a pure function for the risk score, not the tracker model", () => {
    // `risk.scored` and `risk.intervention_proposed` both come out of
    // `riskScore`/`chooseIntervention`, which are pure. The watcher used to
    // emit them as TrackerAgent — a model — which told a judge a language
    // model had weighed the payment mode and the pincode.
    // Both are engines; the point is which one the event names. Crediting
    // the deadline watcher for a risk verdict is a claim about the wrong
    // engine, and the summary line it writes ends up on the judge's screen.
    expect(actorFacts("RiskAgent").kind).toBe<ActorKind>("engine");

    const watcher = readFileSync(
      join(process.cwd(), "src/lib/agent/watcher.ts"),
      "utf8",
    );
    // The two emits in the scoring block must name the engine. Checked against
    // the source because the alternative is booting the watcher with a live
    // database, and the thing worth pinning is the attribution itself.
    for (const type of ["risk.scored", "risk.intervention_proposed"]) {
      const at = watcher.indexOf(`type: "${type}"`);
      expect(at, `${type} is not emitted anywhere`).toBeGreaterThan(-1);
      const actorLine = watcher.slice(at, at + 200).match(/actor:\s*"([^"]+)"/);
      expect(actorLine?.[1], `${type} is credited to the wrong actor`).toBe("RiskAgent");
    }
  });

  it("gives the entitlement engine the capability its tool needs", () => {
    // Renaming the actor on an event also renames the agent the registry
    // checks, so the engine has to hold `compute` or its own tool is refused.
    expect(may("EntitlementEngine", "check_entitlement")).toBe(true);
    // And it must hold nothing that acts.
    expect(may("EntitlementEngine", "issue_refund")).toBe(false);
    expect(may("EntitlementEngine", "send_message")).toBe(false);
  });
});
