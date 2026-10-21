"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, Toast, Spinner } from "@/components/ui";

type Health = { seeded: boolean; database: { ok: boolean; detail: string } };

const DEMO_ACCOUNTS = [
  { email: "arjun@example.in", name: "Arjun Menon", note: "Bengaluru · English · prefers a fast replacement" },
  { email: "lakshmi@example.in", name: "Lakshmi Prasad", note: "Tumakuru · ಕನ್ನಡ · tier-3 pincode, COD" },
  { email: "priya@example.in", name: "Priya Sharma", note: "Delhi · हिन्दी · prefers money back" },
  { email: "murugan@example.in", name: "Murugan Subramaniam", note: "Karur · தமிழ் · two rejected claims on record" },
  { email: "ops@vaanijya.in", name: "Resolution Desk", note: "Operator — approves claims and runs the demo controls" },
];

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState("arjun@example.in");
  const [password, setPassword] = useState("demo123");
  const [busy, setBusy] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [toast, setToast] = useState<{ m: string; t: "ok" | "err" } | null>(null);

  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
  }, []);

  async function signIn(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    try {
      const u = await api<{ role: string }>("/api/auth/login", { json: { email, password } });
      router.push(u.role === "operator" ? "/desk" : "/shop");
      router.refresh();
    } catch (err) {
      setToast({ m: err instanceof Error ? err.message : "Sign in failed.", t: "err" });
      setBusy(false);
    }
  }

  async function runSeed() {
    setSeeding(true);
    try {
      const r = await api<{ products: number; orders: number }>("/api/desk/seed", { json: {} });
      setToast({ m: `Database built: ${r.products} products, ${r.orders} demo orders.`, t: "ok" });
      setHealth(await api<Health>("/api/health"));
    } catch (err) {
      setToast({ m: err instanceof Error ? err.message : "Seed failed.", t: "err" });
    }
    setSeeding(false);
  }

  const needsSeed = health !== null && !health.seeded;

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "1.5rem 1.25rem" }}>
      <div style={{ width: "100%", maxWidth: "26rem" }}>
        <Link href="/" style={{ textDecoration: "none" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: "1.5rem", fontWeight: 650, textAlign: "center", marginBottom: ".3rem" }}>
            Vaanijya
          </div>
        </Link>
        <p style={{ textAlign: "center", color: "var(--ink-faint)", fontSize: ".85rem", marginBottom: "1.5rem" }}>
          Sign in to shop, or to work the resolution desk
        </p>

        {needsSeed && (
          <div className="card" style={{ padding: "1rem", marginBottom: "1rem", borderColor: "var(--haldi)" }}>
            <div style={{ fontWeight: 600, fontSize: ".9rem", marginBottom: ".3rem" }}>
              The database is empty
            </div>
            <p style={{ fontSize: ".84rem", color: "var(--ink-soft)", marginBottom: ".8rem" }}>
              Build the catalogue, the policies and six demo orders. Takes a second.
            </p>
            <button className="btn btn-accent" onClick={runSeed} disabled={seeding} style={{ width: "100%" }}>
              {seeding ? <Spinner label="Building" /> : "Build the demo database"}
            </button>
          </div>
        )}

        <form className="card" style={{ padding: "1.25rem" }} onSubmit={signIn}>
          <label style={{ display: "block", marginBottom: ".9rem" }}>
            <span style={{ fontSize: ".82rem", fontWeight: 550, display: "block", marginBottom: ".3rem" }}>Email</span>
            <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          <label style={{ display: "block", marginBottom: "1.1rem" }}>
            <span style={{ fontSize: ".82rem", fontWeight: 550, display: "block", marginBottom: ".3rem" }}>Password</span>
            <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? <Spinner label="Signing in" /> : "Sign in"}
          </button>
        </form>

        <div className="card" style={{ padding: "1rem", marginTop: "1rem" }}>
          <div style={{ fontSize: ".8rem", color: "var(--ink-faint)", marginBottom: ".6rem" }}>
            Demo accounts — every password is <code className="mono">demo123</code>
          </div>
          {DEMO_ACCOUNTS.map((a) => (
            <button
              key={a.email}
              onClick={() => { setEmail(a.email); setPassword("demo123"); }}
              style={{
                display: "block", width: "100%", textAlign: "left", background: "none",
                border: "none", borderTop: "1px solid var(--rule)", padding: ".55rem 0",
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: ".85rem", fontWeight: 550 }}>{a.name}</div>
              <div style={{ fontSize: ".76rem", color: "var(--ink-faint)" }}>{a.note}</div>
            </button>
          ))}
        </div>
      </div>

      {toast && <Toast message={toast.m} tone={toast.t} onDone={() => setToast(null)} />}
    </main>
  );
}
