"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, Banner, Spinner, Toast } from "@/components/ui";

/**
 * Sign in.
 *
 * Two things changed here from the version that only knew demo accounts:
 *
 *  1. **Registration is the primary path.** The demo accounts are a
 *     convenience for a reviewer, not the way in, so they sit below the form
 *     and behind a disclosure — and the server hides them entirely in
 *     production, where a published credential is a vulnerability rather than
 *     a shortcut.
 *  2. **There is no "build the database" button.** It used to be open to
 *     anyone while the user table was empty. Seeding deletes every
 *     collection, so it now belongs to `npm run setup -- --seed`, run by
 *     whoever owns the database. If the catalogue is empty this page says so
 *     and names the command instead of offering to run it.
 */

type Health = {
  seeded: boolean;
  demoAccountsVisible: boolean;
  demoAccounts: { email: string; name: string; note: string }[];
  demoPassword: string;
  persistent: boolean;
  persistenceNote: string;
};

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [showDemo, setShowDemo] = useState(false);
  const [toast, setToast] = useState<{ m: string; t: "ok" | "err" } | null>(null);

  const load = useCallback(async () => {
    try {
      setHealth(await api<Health>("/api/auth/entry"));
    } catch {
      /* The form still works without this; it only drives the hints. */
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const u = await api<{ role: string }>("/api/auth/login", { json: { email, password } });
      // An operator lands on the desk; everyone else on the storefront.
      router.push(u.role === "operator" ? "/desk" : "/shop");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    }
    setBusy(false);
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Link href="/" className="auth-brand">Vaanijya</Link>
        <h1 className="auth-title">Sign in</h1>
        <p className="auth-lede">
          New here? <Link href="/register">Create an account</Link> — it takes a
          name, an email and a password.
        </p>

        {health && !health.seeded && (
          <div style={{ marginBottom: "1rem" }}>
            <Banner tone="gold">
              The catalogue is empty. Run{" "}
              <code className="mono">npm run setup -- --seed</code> in the project
              directory to build it, then reload. Seeding deletes every
              collection, so it is a command rather than a button.
            </Banner>
          </div>
        )}

        {health && !health.persistent && (
          <div style={{ marginBottom: "1rem" }}>
            <Banner tone="indigo">{health.persistenceNote}</Banner>
          </div>
        )}

        <form onSubmit={submit} noValidate>
          <label className="field-label" htmlFor="email">Email</label>
          <input
            id="email"
            className="field"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            autoFocus
            aria-describedby={error ? "signin-error" : undefined}
          />

          <label className="field-label" htmlFor="password" style={{ marginTop: ".9rem" }}>
            Password
          </label>
          <input
            id="password"
            className="field"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            aria-describedby={error ? "signin-error" : undefined}
          />

          {error && (
            <p id="signin-error" role="alert" className="field-error">{error}</p>
          )}

          <button
            className="btn btn-primary"
            disabled={busy}
            style={{ width: "100%", marginTop: "1.1rem" }}
          >
            {busy ? <Spinner label="Signing in" /> : "Sign in"}
          </button>
        </form>

        {/* Demo accounts, only where the server says it is safe to show them. */}
        {health?.demoAccountsVisible && health.demoAccounts.length > 0 && (
          <div className="auth-demo">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setShowDemo((v) => !v)}
              aria-expanded={showDemo}
            >
              {showDemo ? "Hide demo accounts" : "Use a demo account instead"}
            </button>

            {showDemo && (
              <>
                <p className="auth-demo-note">
                  Seeded accounts for a local demonstration. Every password is{" "}
                  <code className="mono">{health.demoPassword}</code>. These are
                  hidden automatically in a production build.
                </p>
                <ul className="auth-demo-list">
                  {health.demoAccounts.map((a) => (
                    <li key={a.email}>
                      <button
                        type="button"
                        onClick={() => {
                          setEmail(a.email);
                          setPassword(health.demoPassword);
                          setToast({ m: `Filled in ${a.name}. Press Sign in.`, t: "ok" });
                        }}
                      >
                        <strong>{a.name}</strong>
                        <span className="mono">{a.email}</span>
                        <em>{a.note}</em>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {toast && <Toast message={toast.m} tone={toast.t} onDone={() => setToast(null)} />}
    </main>
  );
}
