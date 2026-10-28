"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, Banner, Spinner } from "@/components/ui";
import { LANGUAGES } from "@/lib/types";

/**
 * Create an account.
 *
 * Deliberately four fields. The address is optional and collapsed, because
 * requiring one here was a real obstacle: a buyer who only wants to look has
 * to invent a pincode before they can see a price, and an address typed under
 * that pressure is exactly the one that later produces a confidently wrong
 * delivery date. Checkout asks for it, where the destination is shown before
 * the button that commits.
 *
 * Validation is mirrored, not delegated. The messages here are for the person
 * typing; the server validates the same rules again because a client-side
 * check is a convenience and never a guarantee. Where the two could drift —
 * the password floor, the pincode shape — the server's answer is the one
 * displayed.
 */

type Entry = { persistent: boolean; persistenceNote: string };

const MIN_PASSWORD = 8;

export default function RegisterPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirm] = useState("");
  const [phone, setPhone] = useState("");
  const [lang, setLang] = useState("en");
  const [priority, setPriority] = useState<"speed" | "money">("money");

  const [wantAddress, setWantAddress] = useState(false);
  const [line, setLine] = useState("");
  const [landmark, setLandmark] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [pincode, setPincode] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [entry, setEntry] = useState<Entry | null>(null);

  const load = useCallback(async () => {
    try {
      setEntry(await api<Entry>("/api/auth/entry"));
    } catch {
      /* hints only */
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  /** The checks worth giving instant feedback on. */
  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (name.trim().length < 2) e.name = "Give your name, at least 2 characters.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) e.email = "That is not an email address.";
    if (password.length < MIN_PASSWORD) e.password = `Use at least ${MIN_PASSWORD} characters.`;
    if (confirmPassword !== password) e.confirmPassword = "The two passwords do not match.";
    if (wantAddress) {
      if (line.trim().length < 5) e.line = "Give a full street address.";
      if (!/^\d{6}$/.test(pincode.trim())) e.pincode = "An Indian pincode is 6 digits.";
    }
    return e;
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    const e = validate();
    setFieldErrors(e);
    if (Object.keys(e).length > 0) return;

    setBusy(true);
    setError("");
    try {
      await api("/api/auth/register", {
        json: {
          name: name.trim(),
          email: email.trim(),
          password,
          confirmPassword,
          phone: phone.trim(),
          lang,
          priority,
          ...(wantAddress
            ? { address: { line: line.trim(), landmark: landmark.trim(), city: city.trim(), state: state.trim(), pincode: pincode.trim() } }
            : {}),
        },
      });
      // Registered and signed in: straight to the shop, which is what they came for.
      router.push("/shop");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work.");
    }
    setBusy(false);
  }

  const err = (k: string) =>
    fieldErrors[k] ? <p className="field-error" role="alert">{fieldErrors[k]}</p> : null;

  return (
    <main className="auth-page">
      <div className="auth-card auth-card-wide">
        <Link href="/" className="auth-brand">Vaanijya</Link>
        <h1 className="auth-title">Create an account</h1>
        <p className="auth-lede">
          Already have one? <Link href="/signin">Sign in</Link>.
        </p>

        {entry && !entry.persistent && (
          <div style={{ marginBottom: "1rem" }}>
            <Banner tone="gold">{entry.persistenceNote}</Banner>
          </div>
        )}

        <form onSubmit={submit} noValidate>
          <div className="auth-grid">
            <div>
              <label className="field-label" htmlFor="r-name">Name</label>
              <input
                id="r-name" className="field" value={name} autoFocus
                onChange={(e) => setName(e.target.value)}
                autoComplete="name" required
                aria-invalid={Boolean(fieldErrors.name)}
              />
              {err("name")}
            </div>

            <div>
              <label className="field-label" htmlFor="r-email">Email</label>
              <input
                id="r-email" className="field" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email" required
                aria-invalid={Boolean(fieldErrors.email)}
              />
              {err("email")}
            </div>

            <div>
              <label className="field-label" htmlFor="r-password">Password</label>
              <input
                id="r-password" className="field" type="password" value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password" required minLength={MIN_PASSWORD}
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby="r-password-hint"
              />
              <p id="r-password-hint" className="field-hint">
                At least {MIN_PASSWORD} characters.
              </p>
              {err("password")}
            </div>

            <div>
              <label className="field-label" htmlFor="r-confirm">Confirm password</label>
              <input
                id="r-confirm" className="field" type="password" value={confirmPassword}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password" required
                aria-invalid={Boolean(fieldErrors.confirmPassword)}
              />
              {err("confirmPassword")}
            </div>

            <div>
              <label className="field-label" htmlFor="r-phone">
                Phone <span className="field-optional">optional</span>
              </label>
              <input
                id="r-phone" className="field" value={phone} inputMode="tel"
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
              />
              <p className="field-hint">
                A courier who can call is the commonest reason a first delivery
                attempt succeeds.
              </p>
            </div>

            <div>
              <label className="field-label" htmlFor="r-lang">Preferred language</label>
              <select
                id="r-lang" className="field" value={lang}
                onChange={(e) => setLang(e.target.value)}
              >
                {Object.entries(LANGUAGES).map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
              <p className="field-hint">
                You can shop and complain in any of these, whatever you pick.
              </p>
            </div>
          </div>

          {/* What matters more when something goes wrong. This drives a real
              decision in the entitlement engine, so it is asked plainly. */}
          <fieldset className="auth-fieldset">
            <legend className="field-label">If an order goes wrong, you would rather have</legend>
            <div className="auth-radio-row">
              <label>
                <input
                  type="radio" name="priority" value="money"
                  checked={priority === "money"}
                  onChange={() => setPriority("money")}
                />
                <span>The money back</span>
              </label>
              <label>
                <input
                  type="radio" name="priority" value="speed"
                  checked={priority === "speed"}
                  onChange={() => setPriority("speed")}
                />
                <span>A working replacement, fast</span>
              </label>
            </div>
            <p className="field-hint">
              This decides which remedy you are offered when both are allowed.
              You can change it later.
            </p>
          </fieldset>

          {/* Optional address, collapsed. */}
          <div className="auth-fieldset">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setWantAddress((v) => !v)}
              aria-expanded={wantAddress}
            >
              {wantAddress ? "Skip the address for now" : "Add a delivery address now (optional)"}
            </button>

            {wantAddress && (
              <div className="auth-grid" style={{ marginTop: ".8rem" }}>
                <div style={{ gridColumn: "1 / -1" }}>
                  <label className="field-label" htmlFor="r-line">Street address</label>
                  <input
                    id="r-line" className="field" value={line}
                    onChange={(e) => setLine(e.target.value)}
                    autoComplete="address-line1"
                    aria-invalid={Boolean(fieldErrors.line)}
                  />
                  {err("line")}
                </div>
                <div>
                  <label className="field-label" htmlFor="r-landmark">
                    Landmark <span className="field-optional">optional</span>
                  </label>
                  <input
                    id="r-landmark" className="field" value={landmark}
                    onChange={(e) => setLandmark(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="r-pincode">Pincode</label>
                  <input
                    id="r-pincode" className="field" value={pincode} inputMode="numeric"
                    onChange={(e) => setPincode(e.target.value)}
                    autoComplete="postal-code" maxLength={6}
                    aria-invalid={Boolean(fieldErrors.pincode)}
                  />
                  {err("pincode")}
                  <p className="field-hint">
                    The city, state and delivery tier are worked out from this.
                  </p>
                </div>
                <div>
                  <label className="field-label" htmlFor="r-city">
                    City <span className="field-optional">optional</span>
                  </label>
                  <input
                    id="r-city" className="field" value={city}
                    onChange={(e) => setCity(e.target.value)}
                    autoComplete="address-level2"
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="r-state">
                    State <span className="field-optional">optional</span>
                  </label>
                  <input
                    id="r-state" className="field" value={state}
                    onChange={(e) => setState(e.target.value)}
                    autoComplete="address-level1"
                  />
                </div>
              </div>
            )}
          </div>

          {error && <p className="field-error" role="alert" style={{ marginTop: ".8rem" }}>{error}</p>}

          <button
            className="btn btn-primary"
            disabled={busy}
            style={{ width: "100%", marginTop: "1.1rem" }}
          >
            {busy ? <Spinner label="Creating your account" /> : "Create account"}
          </button>

          <p className="auth-fineprint">
            Every account created here is a buyer account. Operator access to
            the resolution desk is provisioned separately, from the machine that
            owns the database — it is not something this form can grant.
          </p>
        </form>
      </div>
    </main>
  );
}
