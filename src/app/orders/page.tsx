"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  api, Chip, Disclosure, Empty, INR, Ladder, RiskDial, Spinner,
  StateChip, SuspicionBar, Toast, humanise,
} from "@/components/ui";
import ComplaintForm from "@/components/ComplaintForm";
import Shell from "@/components/Shell";
import AddressBook from "@/components/AddressBook";

type Scan = { at: string; location: string; note: string; code: string };

type Order = {
  orderNo: string; status: string; amountInr: number;
  paymentMode: string; paymentStatus: string;
  placedAt: string; promisedBy: string; deliveredAt: string | null;
  placedByAgent: boolean;
  address: { line: string; landmark: string; city: string; pincode: string };
  deliveryInstructions?: string;
  items: { sku: string; title: string; qty: number; unitPriceInr: number; boxContents: string[] }[];
  shipment: {
    shipmentId: string; courier: string; awb: string; status: string;
    attempts: number; riskScore: number | null; riskBand: string | null; scans: Scan[];
  } | null;
  claims: {
    claimNo: string; state: string; issueType: string;
    remedy: string; amountInr: number; authenticity: string;
  }[];
  refunds: Refund[];
};

type Refund = {
  refundNo: string;
  amountInr: number;
  remedy: string;
  method: "ORIGINAL_PAYMENT" | "BANK_TRANSFER" | "STORE_CREDIT";
  destination: string;
  status: "INITIATED" | "PROCESSING" | "SETTLED" | "FAILED";
  initiatedAt: string;
  expectedBy: string;
  settledAt: string | null;
  clauseIds: string[];
};

type Claim = {
  claimNo: string; orderNo: string; productTitle: string; state: string;
  issueType: string; rawComplaint: string; translatedComplaint: string;
  lang: string; inputMode: string;
  verdict: {
    eligible: boolean; remedy: string; amountInr: number;
    deadlineAt: string | null; clauseIds: string[]; reasons: string[]; confidence: number;
  };
  authenticity: { verdict: string; score: number; narrative: string; signals: { factor: string; points: number; detail: string }[] };
  draftMessage: string;
  approval: { decision: string | null; note: string; requestedAction: string };
  evidence: { kind: string; filename: string; dataUrl: string; visionFindings: Record<string, unknown> | null }[];
  createdAt: string;
};

const TRACK_STEPS = ["PLACED", "CONFIRMED", "PACKED", "DISPATCHED", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"];

export default function Orders() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [user, setUser] = useState<{ name: string; role: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [complaintFor, setComplaintFor] = useState<Order | null>(null);
  const [tab, setTab] = useState<"orders" | "claims" | "addresses">("orders");
  const [toast, setToast] = useState<{ m: string; t: "ok" | "err" } | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, c] = await Promise.all([
        api<{ orders: Order[] }>("/api/orders"),
        api<{ claims: Claim[] }>("/api/claims"),
      ]);
      setOrders(o.orders);
      setClaims(c.claims);
    } catch {
      /* handled by the auth redirect */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    api<{ user: { name: string; role: string } | null }>("/api/auth/me")
      .then((r) => (r.user ? setUser(r.user) : router.push("/signin")))
      .catch(() => router.push("/signin"));
  }, [router]);

  useEffect(() => { load(); }, [load]);

  // The buyer's screen updates while the operator works the other side.
  useEffect(() => {
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  if (!user || loading) {
    return <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}><Spinner label="Loading your orders" /></main>;
  }

  return (
    <Shell user={user}>
      <main className="page page-narrow">
        <h1 style={{ fontSize: "clamp(1.5rem,3.4vw,2.1rem)", marginBottom: ".4rem" }}>
          Your orders
        </h1>
        <p style={{ color: "var(--ink-soft)", marginTop: 0, marginBottom: "1.4rem" }}>
          Track a parcel, or report something that arrived wrong.
        </p>

        <div
          role="tablist"
          aria-label="Orders and complaints"
          style={{ display: "flex", gap: ".4rem", marginBottom: "1.25rem" }}
        >
          {(["orders", "claims", "addresses"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              onClick={() => setTab(t)}
              className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-ghost"}`}
              aria-selected={tab === t}
            >
              {t === "orders"
                ? `Orders (${orders.length})`
                : t === "claims"
                  ? `Complaints (${claims.length})`
                  : "Addresses"}
            </button>
          ))}
        </div>

      {tab === "orders" && (
        orders.length === 0 ? (
          <Empty title="No orders yet">
            <Link href="/shop" style={{ color: "var(--neel-ink)", fontWeight: 550 }}>
              Go to the shop
            </Link>{" "}
            and tell the agent what you need.
          </Empty>
        ) : (
          <div className="stagger" style={{ display: "grid", gap: "1rem" }}>
            {orders.map((o) => (
              <OrderCard key={o.orderNo} order={o} onComplain={() => setComplaintFor(o)} />
            ))}
          </div>
        )
      )}

      {/* The addresses live here because this is where a buyer comes after a
          parcel went wrong, and a wrong address is one of the reasons it did. */}
      {tab === "addresses" && (
        <div>
          <p style={{ color: "var(--ink-soft)", fontSize: ".88rem", marginTop: 0, marginBottom: "1rem", maxWidth: "58ch" }}>
            The pincode on an address decides how long delivery takes and how
            likely it is to fail — so these are not just a label. You can say a
            whole address out loud instead of typing it.
          </p>
          <AddressBook />
        </div>
      )}

      {tab === "claims" && (
        claims.length === 0 ? (
          <Empty title="No complaints filed">
            If something arrives broken, open the order and report it — type it or
            record a voice note, in whatever language you prefer.
          </Empty>
        ) : (
          <div className="stagger" style={{ display: "grid", gap: "1rem" }}>
            {claims.map((c) => <ClaimCard key={c.claimNo} claim={c} />)}
          </div>
        )
      )}

      {complaintFor && (
        <ComplaintForm
          order={complaintFor}
          onClose={() => setComplaintFor(null)}
          onFiled={(msg) => {
            setComplaintFor(null);
            setToast({ m: msg, t: "ok" });
            setTab("claims");
            load();
          }}
        />
      )}

        {toast && <Toast message={toast.m} tone={toast.t} onDone={() => setToast(null)} />}
      </main>
    </Shell>
  );
}

/**
 * A refund, stated the way a buyer asks about it.
 *
 * "paymentStatus: REFUNDED" answers none of the three questions anyone
 * actually has — how much, to where, and by when. So all three are on one
 * line, with the policy clause that set the amount, and the promised date is
 * shown until the money has genuinely landed.
 */
function RefundRow({ refund: r }: { refund: Refund }) {
  const settled = r.status === "SETTLED";
  const late =
    !settled && new Date(r.expectedBy).getTime() < Date.now();

  const day = (iso: string) =>
    new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  return (
    <div style={{ fontSize: ".82rem", paddingTop: ".2rem" }}>
      <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap" }}>
        <span className="mono" style={{ color: "var(--ink-faint)" }}>{r.refundNo}</span>
        <Chip tone={settled ? "moss" : late ? "brick" : "gold"}>
          {settled ? "money received" : late ? "overdue" : "on its way"}
        </Chip>
        <strong style={{ fontWeight: 650 }}>{INR(r.amountInr)}</strong>
        <span style={{ color: "var(--ink-soft)" }}>
          {r.method === "STORE_CREDIT"
            ? "as store credit"
            : r.method === "BANK_TRANSFER"
              ? "by bank transfer"
              : "to your original payment method"}
        </span>
      </div>

      <div style={{ color: "var(--ink-faint)", marginTop: ".15rem", lineHeight: 1.55 }}>
        {settled ? (
          <>Settled {day(r.settledAt ?? r.expectedBy)} — {r.destination}.</>
        ) : (
          <>
            Expected by {day(r.expectedBy)} — {r.destination}.
            {late && " This is past the date we promised you; it has been flagged."}
          </>
        )}
        {r.clauseIds.length > 0 && (
          <> Amount set by clause {r.clauseIds.join(", ")}.</>
        )}
      </div>
    </div>
  );
}

function OrderCard({ order, onComplain }: { order: Order; onComplain: () => void }) {
  const stepIndex = TRACK_STEPS.indexOf(order.status);
  const delivered = order.status === "DELIVERED";
  const late = !delivered && new Date(order.promisedBy) < new Date();

  return (
    <article className="card actionable" style={{ padding: "1.1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", marginBottom: ".8rem" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap", marginBottom: ".25rem" }}>
            <span className="mono" style={{ color: "var(--ink-faint)" }}>{order.orderNo}</span>
            <StateChip state={order.status} />
            {order.placedByAgent && <Chip tone="indigo">agent assembled</Chip>}
            {late && <Chip tone="brick">past the promised date</Chip>}
          </div>
          {order.items.map((i) => (
            <div key={i.sku} style={{ fontSize: ".92rem", fontWeight: 550 }}>
              {i.title} <span style={{ color: "var(--ink-faint)", fontWeight: 400 }}>× {i.qty}</span>
            </div>
          ))}
          <div style={{ fontSize: ".8rem", color: "var(--ink-faint)", marginTop: ".2rem" }}>
            {order.address.line}, {order.address.city} {order.address.pincode}
          </div>
          {/* What the buyer told the courier, shown back to them: an
              instruction you cannot see afterwards is one you cannot tell
              went ignored. */}
          {order.deliveryInstructions && (
            <div
              style={{
                fontSize: ".78rem", color: "var(--ink-soft)", marginTop: ".3rem",
                paddingLeft: ".55rem", borderLeft: "2px solid var(--haldi)",
                lineHeight: 1.5, maxWidth: "48ch",
              }}
            >
              &ldquo;{order.deliveryInstructions}&rdquo;
            </div>
          )}
        </div>

        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: "1.05rem", fontWeight: 650 }}>{INR(order.amountInr)}</div>
          <div style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>
            {order.paymentMode === "COD" ? "Cash on delivery" : humanise(order.paymentStatus)}
          </div>
        </div>
      </div>

      {/* Progress rail. Steps are states the parcel is actually in, not decoration. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: ".2rem", margin: ".9rem 0 1.5rem" }}>
        {TRACK_STEPS.map((s, i) => (
          <div key={s} style={{ flex: 1, minWidth: 0, position: "relative" }}>
            <div
              style={{
                height: 3, borderRadius: 2,
                background: i <= stepIndex ? "var(--moss)" : "var(--paper-sunk)",
                transition: "background-color .4s var(--ease-out)",
                transitionDelay: `${i * 60}ms`,
              }}
            />
            {/* The label hangs below its own segment. The last step is pinned
                to the right so it does not overflow the card. */}
            {i === stepIndex && (
              <div
                style={{
                  position: "absolute", top: ".3rem",
                  left: i === TRACK_STEPS.length - 1 ? "auto" : 0,
                  right: i === TRACK_STEPS.length - 1 ? 0 : "auto",
                  fontSize: ".7rem", color: "var(--moss)", fontWeight: 600, whiteSpace: "nowrap",
                }}
              >
                {humanise(s)}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>
          {delivered
            ? `Delivered ${new Date(order.deliveredAt!).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
            : `Expected by ${new Date(order.promisedBy).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
          {order.shipment && ` · ${order.shipment.courier}`}
        </div>

        <div style={{ display: "flex", gap: ".4rem", alignItems: "center" }}>
          {order.shipment?.riskScore !== null && order.shipment?.riskBand && !delivered && (
            <span className="dial"><RiskDial score={order.shipment.riskScore!} band={order.shipment.riskBand} /></span>
          )}
          {delivered && order.claims.length === 0 && (
            <button className="btn btn-ghost btn-sm" onClick={onComplain}>Report a problem</button>
          )}
        </div>
      </div>

      {order.claims.length > 0 && (
        <div style={{ marginTop: ".8rem", paddingTop: ".7rem", borderTop: "1px solid var(--rule)" }}>
          {order.claims.map((c) => (
            <div key={c.claimNo} style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap", fontSize: ".82rem" }}>
              <span className="mono" style={{ color: "var(--ink-faint)" }}>{c.claimNo}</span>
              <StateChip state={c.state} />
              <span style={{ color: "var(--ink-soft)" }}>
                {humanise(c.issueType)} → {humanise(c.remedy)}
                {c.amountInr > 0 && ` ${INR(c.amountInr)}`}
              </span>
            </div>
          ))}
        </div>
      )}

      {order.refunds.length > 0 && (
        <div style={{ marginTop: ".8rem", paddingTop: ".7rem", borderTop: "1px solid var(--rule)" }}>
          {order.refunds.map((r) => (
            <RefundRow key={r.refundNo} refund={r} />
          ))}
        </div>
      )}

      {order.shipment && order.shipment.scans.length > 0 && (
        <div style={{ marginTop: ".7rem" }}>
          <Disclosure summary={`Courier record (${order.shipment.scans.length} scans)`}>
            <Ladder
              reasons={order.shipment.scans.map(
                (s) =>
                  `${new Date(s.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} — ${s.location}: ${s.note}`,
              )}
            />
          </Disclosure>
        </div>
      )}
    </article>
  );
}

function ClaimCard({ claim }: { claim: Claim }) {
  const v = claim.verdict;
  const decided = claim.approval?.decision;

  return (
    <article className="card" style={{ padding: "1.1rem" }}>
      <div style={{ display: "flex", gap: ".4rem", alignItems: "center", flexWrap: "wrap", marginBottom: ".6rem" }}>
        <span className="mono" style={{ color: "var(--ink-faint)" }}>{claim.claimNo}</span>
        <StateChip state={claim.state} />
        <Chip tone="neutral">{humanise(claim.issueType)}</Chip>
        {claim.inputMode === "voice" && <Chip tone="indigo">voice</Chip>}
        <span style={{ fontSize: ".8rem", color: "var(--ink-faint)", marginLeft: "auto" }}>
          {claim.orderNo} · {claim.productTitle}
        </span>
      </div>

      {/* What the buyer said, in their own script — kept verbatim beside the
          translation, because the operator must be able to read the original. */}
      <blockquote
        style={{
          margin: "0 0 .8rem", padding: ".6rem .8rem", background: "var(--paper-sunk)",
          borderRadius: 8, fontSize: ".9rem", color: "var(--ink)", fontStyle: "italic",
        }}
      >
        <span lang={claim.lang}>&ldquo;{claim.rawComplaint}&rdquo;</span>
        {claim.lang !== "en" && claim.translatedComplaint && (
          <div style={{ fontSize: ".8rem", color: "var(--ink-faint)", fontStyle: "normal", marginTop: ".3rem" }}>
            {claim.translatedComplaint}
          </div>
        )}
      </blockquote>

      {claim.evidence.length > 0 && (
        <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", marginBottom: ".8rem" }}>
          {claim.evidence.filter((e) => e.kind === "image").map((e, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={e.dataUrl}
              alt={`Evidence photograph ${i + 1}: ${e.filename}`}
              style={{ width: 76, height: 76, objectFit: "cover", borderRadius: 7, border: "1px solid var(--rule)" }}
            />
          ))}
        </div>
      )}

      <div
        style={{
          padding: ".75rem .85rem", borderRadius: 8, marginBottom: ".7rem",
          background: v.eligible ? "var(--moss-wash)" : "var(--paper-sunk)",
          borderLeft: `3px solid ${v.eligible ? "var(--moss)" : "var(--rule-strong)"}`,
        }}
      >
        <div style={{ fontSize: ".95rem", fontWeight: 600, marginBottom: ".2rem" }}>
          {v.eligible
            ? `${humanise(v.remedy)}${v.amountInr > 0 ? ` of ${INR(v.amountInr)}` : ""}`
            : "No remedy under the policy"}
        </div>
        <div style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>
          {v.clauseIds.length > 0 && <>Clause {v.clauseIds.join(", ")} · </>}
          engine confidence {Math.round(v.confidence * 100)}%
          {v.deadlineAt && <> · by {new Date(v.deadlineAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</>}
        </div>
        {!decided && (
          <div style={{ fontSize: ".8rem", color: "var(--ink-faint)", marginTop: ".35rem" }}>
            A platform operator is reviewing this. Nothing has been paid yet.
          </div>
        )}
      </div>

      <Disclosure summary="How this was decided">
        <Ladder reasons={v.reasons} />
      </Disclosure>

      {claim.draftMessage && (
        <div style={{ marginTop: ".5rem" }}>
          <Disclosure summary="The letter we wrote you">
            <div style={{ whiteSpace: "pre-wrap", fontSize: ".85rem", color: "var(--ink-soft)", lineHeight: 1.65 }}>
              {claim.draftMessage}
            </div>
          </Disclosure>
        </div>
      )}
    </article>
  );
}
