"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, setVoiceWanted, useGreeting, useSpeaker, voiceWanted } from "@/components/ui";
import { narrateGreeting, type GreetingStage } from "@/lib/speech/narrate";

/**
 * The application shell.
 *
 * Before this, every page drew its own header. That meant no way back from an
 * order, no constant place for the cart, and a different arrangement of the
 * same four links on each screen. One shell fixes all three: identity on the
 * left, places in the middle, and the things that belong to *you* — your cart
 * and your account — on the right.
 *
 * The cart count lives here rather than only above the catalogue, because the
 * agent can add to the cart from any page and that has to be visible the
 * moment it happens.
 */

export type ShellUser = { name: string; role: string } | null;

/** Pages a signed-in buyer can reach, in the order they are usually needed. */
const PLACES = [
  { href: "/shop", label: "Shop" },
  // Before the catalogue in intent, though after it in the list: this is the
  // "stop scrolling" entry point, and it needs to be findable without being
  // mistaken for the catalogue itself.
  { href: "/find", label: "Find by need" },
  { href: "/orders", label: "My orders" },
  { href: "/system", label: "How it works" },
  // Last, and deliberately named for what it does rather than what it is:
  // "Watch it work" is an invitation, "Walkthrough" is a document.
  { href: "/walkthrough", label: "Watch it work" },
];

export default function Shell({
  user,
  cartCount,
  /** Re-read the cart. Passed in when the page owns the cart state. */
  onCartChange,
  children,
}: {
  user?: ShellUser;
  cartCount?: number;
  onCartChange?: () => void;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<ShellUser>(user ?? null);
  const [count, setCount] = useState(cartCount ?? 0);

  // When the page does not pass a user, the shell finds out for itself, so a
  // page can be dropped in without wiring identity through it.
  useEffect(() => {
    if (user !== undefined) {
      setMe(user);
      return;
    }
    api<{ user: ShellUser }>("/api/auth/me")
      .then((r) => setMe(r.user))
      .catch(() => setMe(null));
  }, [user]);

  useEffect(() => {
    if (cartCount !== undefined) {
      setCount(cartCount);
      return;
    }
    // Only when there is somebody to have a cart. The shell renders on public
    // pages now, so firing this unconditionally meant every signed-out visit
    // asked "what is in my cart" and logged a 401 for the answer "nothing".
    if (!me) {
      setCount(0);
      return;
    }
    api<{ count: number }>("/api/cart")
      .then((r) => setCount(r.count ?? 0))
      .catch(() => undefined);
  }, [cartCount, me]);

  const signOut = useCallback(async () => {
    await api("/api/auth/logout", { json: {} }).catch(() => undefined);
    router.push("/signin");
  }, [router]);

  const places = me?.role === "operator" ? [...PLACES, { href: "/desk", label: "Desk" }] : PLACES;

  /**
   * Whether the agent is allowed to speak.
   *
   * Read after mount rather than during render: the value lives in
   * `localStorage`, which does not exist on the server, and reading it in the
   * initial render would make the server and client markup disagree.
   *
   * It is in the shell because the agent now speaks first, unprompted, on
   * three different screens. Anything that starts talking to you on its own
   * owes you an obvious way to stop it, in the same place every time.
   */
  const [voice, setVoice] = useState(true);
  useEffect(() => setVoice(voiceWanted()), []);

  /**
   * The agent greets you on arrival, from the shell rather than per page.
   *
   * Putting it here is what makes "it talks when I open the site" true: the
   * front door is a server component with no hooks, and three of the four
   * screens that deserve a greeting are wrapped by this shell anyway. One
   * place also means one greeting — a page that greeted on its own as well
   * would talk over this one.
   *
   * The complaint form is the exception and greets itself, because it opens as
   * a dialogue over a page that has already said hello.
   */
  const speaker = useSpeaker();
  const stage: GreetingStage | "" =
    pathname === "/" || pathname === "/shop"
      ? "shop"
      : pathname === "/find"
        ? "find"
        : pathname === "/orders"
          ? "orders"
          : "";

  // Waits for identity, so the greeting can use a first name rather than
  // greeting a signed-in buyer anonymously. On the front door there may be no
  // user at all, and it greets without a name instead of staying silent.
  const ready = pathname === "/" ? true : me !== null;
  useGreeting(speaker, stage ? narrateGreeting(stage as GreetingStage, me?.name) : "", {
    stage,
    enabled: !!stage && ready,
  });

  /* The account menu.
   *
   * Closes on an outside click and on Escape, because a menu that only closes
   * by clicking its own trigger is a menu people leave open by accident and
   * then click through. */
  const [acctOpen, setAcctOpen] = useState(false);
  const acctRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!acctOpen) return;
    const onDown = (e: MouseEvent) => {
      if (acctRef.current && !acctRef.current.contains(e.target as Node)) setAcctOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAcctOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [acctOpen]);

  // Close it on navigation, or it survives the route change and hangs over
  // the new page.
  useEffect(() => { setAcctOpen(false); }, [pathname]);

  const toggleVoice = useCallback(() => {
    setVoice((on) => {
      const next = !on;
      setVoiceWanted(next);
      // Cut off anything mid-sentence. Turning a voice off has to be
      // immediate, or the switch reads as broken.
      if (!next && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("vaanijya:hush"));
      }
      return next;
    });
  }, []);

  return (
    <>
      <header className="shell">
        <div className="shell-in">
          <Link href="/" className="wordmark">
            Vaanijya
          </Link>

          <nav className="shell-nav" aria-label="Main">
            {places.map((p) => (
              <Link
                key={p.href}
                href={p.href}
                className="navlink"
                aria-current={pathname === p.href ? "page" : undefined}
              >
                {p.label}
              </Link>
            ))}

            {me ? (
              <>
                {/* The cart count is the one piece of state worth a colour in
                    the shell: it changes without the buyer touching it. */}
                <Link
                  href="/shop"
                  className="navlink"
                  style={{ display: "inline-flex", alignItems: "center", gap: ".4rem" }}
                >
                  Cart
                  {count > 0 && (
                    <span key={count} className="count pop" aria-label={`${count} in your cart`}>
                      {count}
                    </span>
                  )}
                </Link>

                <button
                  className="navlink"
                  onClick={toggleVoice}
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                  aria-pressed={voice}
                  title={voice ? "The agent speaks. Click to silence it." : "The agent is silent. Click to let it speak."}
                >
                  <span aria-hidden>{voice ? "🔊" : "🔇"}</span>
                  <span className="sr-only">
                    {voice ? "Silence the agent" : "Let the agent speak"}
                  </span>
                </button>

                {/* The account menu.
                  *
                  * Replaces a bare first name beside a Sign out button, which
                  * gave a buyer nowhere to go for their own things. Operator
                  * links appear here only for an operator, and the desk still
                  * enforces that on the server — this hides a link, it does
                  * not grant anything. */}
                <div className="acct" ref={acctRef}>
                  <button
                    className="acct-trigger"
                    onClick={() => setAcctOpen((v) => !v)}
                    aria-expanded={acctOpen}
                    aria-haspopup="menu"
                  >
                    <span className="acct-avatar" aria-hidden>
                      {me.name.trim().charAt(0).toUpperCase() || "?"}
                    </span>
                    <span className="acct-name">{me.name.split(" ")[0]}</span>
                    <span className="acct-caret" aria-hidden>▾</span>
                  </button>

                  {acctOpen && (
                    <div className="acct-menu" role="menu">
                      <div className="acct-head">
                        <strong>{me.name}</strong>
                        <span>{me.role === "operator" ? "Operator" : "Buyer"}</span>
                      </div>
                      <Link href="/orders" role="menuitem" onClick={() => setAcctOpen(false)}>
                        My orders
                      </Link>
                      <Link href="/orders#addresses" role="menuitem" onClick={() => setAcctOpen(false)}>
                        Delivery addresses
                      </Link>
                      {me.role === "operator" && (
                        <Link href="/desk" role="menuitem" onClick={() => setAcctOpen(false)}>
                          Resolution desk
                        </Link>
                      )}
                      <button role="menuitem" onClick={signOut}>Sign out</button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <Link href="/signin" className="navlink">Sign in</Link>
                <Link href="/register" className="btn btn-primary btn-sm" style={{ marginLeft: ".2rem" }}>
                  Create account
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      {children}

      <footer
        style={{
          borderTop: "1px solid var(--rule)",
          padding: "1.4rem 1.25rem",
          textAlign: "center",
          fontSize: ".8rem",
          color: "var(--ink-faint)",
        }}
      >
        A demonstration platform. Every price, seller and parcel here is fictional.
      </footer>
    </>
  );
}
