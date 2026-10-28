"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AgentRail from "@/components/AgentRail";
import Shell from "@/components/Shell";
import ProductImage from "@/components/ProductImage";
import { api, Empty, INR, Spinner, Toast } from "@/components/ui";
import DestinationBlock from "@/components/DestinationBlock";

type Product = {
  sku: string; title: string; brand: string; category: string; subcategory: string;
  description: string; priceInr: number; mrpInr: number; discountPct: number;
  ratingAvg: number; ratingCount: number; stock: number; inStock: boolean;
  imageUrl?: string; imageEmoji: string; accentHex: string; attributes: Record<string, unknown>;
  boxContents: string[]; codEligible: boolean;
};

type CartLine = {
  sku: string; title: string; qty: number; unit_price_inr: number;
  line_total_inr: number; in_stock: boolean; added_by_agent: boolean; rationale: string;
};

type Cart = { items: CartLine[]; count: number; total_inr: number };

const SORTS = [
  { value: "popular", label: "Most reviewed" },
  { value: "rating", label: "Best rated" },
  { value: "price_low", label: "Price: low to high" },
  { value: "price_high", label: "Price: high to low" },
  { value: "discount", label: "Biggest discount" },
];

/** Price bands, so the commonest filter is one click rather than two fields. */
const PRICE_BANDS = [
  { label: "Under ₹500", min: 0, max: 500 },
  { label: "₹500 – ₹2,000", min: 500, max: 2000 },
  { label: "₹2,000 – ₹10,000", min: 2000, max: 10000 },
  { label: "Over ₹10,000", min: 10000, max: 0 },
];

export default function Shop() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  // Categories now arrive with a count, so the navigation can say how many
  // are in each rather than offering one that turns out to be empty.
  const [categories, setCategories] = useState<{ name: string; count: number }[]>([]);
  const [total, setTotal] = useState(0);
  const [band, setBand] = useState(-1);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [cart, setCart] = useState<Cart>({ items: [], count: 0, total_inr: 0 });
  const [user, setUser] = useState<{ name: string; role: string } | null>(null);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("popular");
  const [loading, setLoading] = useState(true);
  const [placing, setPlacing] = useState(false);
  const [payment, setPayment] = useState<"PREPAID" | "COD">("PREPAID");
  /**
   * Where it goes, and what the courier should know.
   *
   * This page used to send neither: the order silently went to `addresses[0]`
   * and there was no way to say anything about the delivery at all.
   */
  const [addressIndex, setAddressIndex] = useState(0);
  const [instructions, setInstructions] = useState("");
  const [showCart, setShowCart] = useState(true);
  const [toast, setToast] = useState<{ m: string; t: "ok" | "err" } | null>(null);
  /** Set once /api/auth/me has answered, either way. */
  const [identityKnown, setIdentityKnown] = useState(false);

  const loadCart = useCallback(async () => {
    try {
      setCart(await api<Cart>("/api/cart"));
    } catch {
      /* not signed in yet — the shell prompts */
    }
  }, []);

  /* Browsing needs no account.
   *
   * This used to redirect a signed-out visitor straight to /signin, so the
   * catalogue was invisible until you had registered — which is backwards:
   * nobody creates an account to find out whether a shop stocks anything.
   * The cart and checkout still require a session, and say so at the point
   * they need one. */
  useEffect(() => {
    api<{ user: { name: string; role: string } | null }>("/api/auth/me")
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setIdentityKnown(true));
  }, []);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ q, category, sort, limit: "72" });
    if (band >= 0) {
      const b = PRICE_BANDS[band];
      if (b.min) params.set("minPrice", String(b.min));
      if (b.max) params.set("maxPrice", String(b.max));
    }
    if (inStockOnly) params.set("inStock", "1");

    api<{
      products: Product[];
      categories: { name: string; count: number }[];
      total: number;
    }>(`/api/catalogue?${params}`)
      .then((r) => {
        setProducts(r.products);
        setCategories(r.categories);
        setTotal(r.total);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [q, category, sort, band, inStockOnly]);

  /* Wait until identity is known, then only ask if there is someone to ask
   * about. Firing this on mount meant a signed-out visitor's first page load
   * always emitted a 401 for a question with a fine answer: an empty cart. */
  useEffect(() => {
    if (!identityKnown || !user) return;
    loadCart();
  }, [identityKnown, user, loadCart]);

  async function addToCart(sku: string) {
    // Browsing is public, so this is a reachable state rather than an edge
    // case. Naming the next step beats a bare "Unauthorized".
    if (!user) {
      setToast({ m: "Sign in or create an account to start a cart.", t: "err" });
      return;
    }
    try {
      await api("/api/cart", { json: { action: "add", sku, qty: 1 } });
      await loadCart();
      setShowCart(true);
    } catch (e) {
      setToast({ m: e instanceof Error ? e.message : "That item could not be added.", t: "err" });
    }
  }

  async function removeFromCart(sku: string) {
    try {
      await api("/api/cart", { json: { action: "remove", sku } });
      await loadCart();
    } catch (e) {
      setToast({ m: e instanceof Error ? e.message : "That item could not be removed.", t: "err" });
    }
  }

  async function placeOrder() {
    setPlacing(true);
    try {
      const r = await api<{
        orderNo: string; amountInr: number;
        risk: { band: string; intervention: string | null };
      }>("/api/orders", {
        json: {
          paymentMode: payment,
          addressIndex,
          deliveryInstructions: instructions.trim() || undefined,
          agentSessionId: localStorage.getItem("vaanijya.session") ?? undefined,
        },
      });
      await loadCart();
      setInstructions("");
      setToast({
        m:
          `${r.orderNo} placed for ${INR(r.amountInr)}. Delivery risk: ` +
          `${r.risk.band.toLowerCase()}` +
          (r.risk.intervention
            ? ` — the agent suggested ${r.risk.intervention.replace(/_/g, " ")}.`
            : "."),
        t: "ok",
      });
    } catch (e) {
      setToast({ m: e instanceof Error ? e.message : "The order could not be placed.", t: "err" });
    }
    setPlacing(false);
  }

  const outOfStockInCart = useMemo(() => cart.items.some((l) => !l.in_stock), [cart.items]);

  /* Spin only while we genuinely do not know who this is.
   *
   * This used to be `if (!user)`, which was correct while the page redirected
   * a signed-out visitor to /signin: `user` was null only for the instant
   * before the redirect. Once browsing was made public, null became a
   * permanent and perfectly valid state — a guest — so the page spun forever
   * on "Loading your catalogue" and never rendered. The question is whether
   * identity has been RESOLVED, not whether somebody is signed in. */
  if (!identityKnown) {
    return (
      <main style={{ display: "grid", placeItems: "center", minHeight: "100dvh" }}>
        <Spinner label="Loading your catalogue" />
      </main>
    );
  }

  return (
    <Shell user={user} cartCount={cart.count} onCartChange={loadCart}>
      <main className="page">
        <div className="workspace">
          {/* ── Catalogue ──────────────────────────────────────────── */}
          <section style={{ minWidth: 0 }}>
            <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
              <input
                className="field"
                style={{ flex: "1 1 14rem" }}
                placeholder="Search by name, brand or what it is for"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search products"
              />
              <select
                className="field"
                style={{ width: "auto" }}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                aria-label="Filter by category"
              >
                <option value="all">All categories ({total})</option>
                {categories.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} ({c.count})
                  </option>
                ))}
              </select>
              <select
                className="field"
                style={{ width: "auto" }}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                aria-label="Sort results"
              >
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>

            {/* Price bands and availability as chips.
              *
              * Two fields for a price range is two decisions a buyer has to
              * make before seeing anything; a band is one click. Availability
              * is a real filter rather than a badge, because an out-of-stock
              * product that looks purchasable is the commonest way a
              * storefront wastes somebody's time. */}
            <div className="filter-row">
              {PRICE_BANDS.map((b, i) => (
                <button
                  key={b.label}
                  type="button"
                  className={`filter-chip ${band === i ? "on" : ""}`}
                  aria-pressed={band === i}
                  onClick={() => setBand(band === i ? -1 : i)}
                >
                  {b.label}
                </button>
              ))}
              <button
                type="button"
                className={`filter-chip ${inStockOnly ? "on" : ""}`}
                aria-pressed={inStockOnly}
                onClick={() => setInStockOnly((v) => !v)}
              >
                In stock only
              </button>
              {(band >= 0 || inStockOnly || category !== "all" || q) && (
                <button
                  type="button"
                  className="filter-chip clear"
                  onClick={() => { setBand(-1); setInStockOnly(false); setCategory("all"); setQ(""); }}
                >
                  Clear all
                </button>
              )}
              <span className="filter-count">
                {loading ? "searching…" : `${products.length} of ${total} shown`}
              </span>
            </div>

            {/* The cart sits above the grid so an item the agent adds is seen
                the moment it lands, rather than hidden behind an icon. It
                collapses instead of disappearing, so the page does not jump
                as items come and go. */}
            {cart.count > 0 && (
              <div className="card enter" style={{ padding: "1rem", marginBottom: "1rem" }}>
                <div
                  style={{
                    display: "flex", justifyContent: "space-between",
                    alignItems: "baseline", gap: ".75rem",
                  }}
                >
                  <h3>Your cart</h3>
                  <button
                    onClick={() => setShowCart((s) => !s)}
                    aria-expanded={showCart}
                    style={{
                      background: "none", border: "none", padding: 0, cursor: "pointer",
                      fontSize: ".8rem", color: "var(--neel)", fontWeight: 550,
                    }}
                  >
                    {showCart ? "Hide" : `Show ${cart.count} item${cart.count === 1 ? "" : "s"}`}
                  </button>
                </div>

                {showCart && (
                  <div className="enter">
                    {cart.items.map((l) => (
                      <div
                        key={l.sku}
                        style={{
                          display: "flex", gap: ".75rem", padding: ".55rem 0",
                          borderTop: "1px solid var(--rule)", alignItems: "flex-start",
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: ".88rem", fontWeight: 550 }}>
                            {l.title}{" "}
                            <span style={{ color: "var(--ink-faint)", fontWeight: 400 }}>× {l.qty}</span>
                          </div>
                          {l.added_by_agent && l.rationale && (
                            <div style={{ fontSize: ".76rem", color: "var(--neel-ink)", marginTop: ".15rem" }}>
                              The agent added this: {l.rationale}
                            </div>
                          )}
                          {!l.in_stock && (
                            <div style={{ fontSize: ".76rem", color: "var(--brick)", marginTop: ".15rem" }}>
                              Only part of this quantity is in stock. Lower the quantity to order.
                            </div>
                          )}
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div style={{ fontSize: ".88rem", fontWeight: 600 }}>{INR(l.line_total_inr)}</div>
                          <button
                            onClick={() => removeFromCart(l.sku)}
                            style={{
                              background: "none", border: "none", padding: 0, cursor: "pointer",
                              fontSize: ".75rem", color: "var(--ink-faint)", textDecoration: "underline",
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* The destination, before the button that commits to
                        it. Previously absent entirely on this page. */}
                    <div
                      style={{
                        paddingTop: ".8rem", marginTop: ".4rem",
                        borderTop: "1px solid var(--rule)",
                      }}
                    >
                      <DestinationBlock
                        addressIndex={addressIndex}
                        onAddressChange={setAddressIndex}
                        instructions={instructions}
                        onInstructionsChange={setInstructions}
                      />
                    </div>

                    <div
                      style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        gap: ".75rem", flexWrap: "wrap", paddingTop: ".75rem",
                        marginTop: ".25rem", borderTop: "1px solid var(--rule-strong)",
                      }}
                    >
                      <div>
                        <div key={cart.total_inr} className="pop" style={{ fontSize: "1.1rem", fontWeight: 650 }}>
                          {INR(cart.total_inr)}
                        </div>
                        <div style={{ display: "flex", gap: ".3rem", marginTop: ".4rem" }}>
                          {(["PREPAID", "COD"] as const).map((p) => (
                            <button
                              key={p}
                              onClick={() => setPayment(p)}
                              className={`chip ${payment === p ? "chip-indigo" : "chip-neutral"}`}
                              style={{ cursor: "pointer" }}
                              aria-pressed={payment === p}
                            >
                              {p === "COD" ? "Cash on delivery" : "Pay online"}
                            </button>
                          ))}
                        </div>
                      </div>
                      <button
                        className="btn btn-accent"
                        onClick={placeOrder}
                        disabled={placing || outOfStockInCart}
                      >
                        {placing ? <Spinner label="Placing your order" /> : "Place order"}
                      </button>
                    </div>

                    <p style={{ fontSize: ".75rem", color: "var(--ink-faint)", margin: ".6rem 0 0" }}>
                      The agent fills your cart. You press this button — it cannot
                      spend your money for you.
                    </p>
                  </div>
                )}
              </div>
            )}

            {loading ? (
              <div className="grid-products">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="tile">
                    <div className="skeleton" style={{ height: "5.5rem", marginBottom: ".75rem" }} />
                    <div className="skeleton" style={{ height: ".7rem", width: "40%", marginBottom: ".4rem" }} />
                    <div className="skeleton" style={{ height: ".9rem", width: "85%", marginBottom: ".5rem" }} />
                    <div className="skeleton" style={{ height: "1rem", width: "50%" }} />
                  </div>
                ))}
              </div>
            ) : products.length === 0 ? (
              <Empty title="Nothing matched that search">
                Try fewer words, or tell the agent what you need in your own
                language — it searches the same catalogue and can work from a
                description rather than a product name.
              </Empty>
            ) : (
              <>
                <div style={{ fontSize: ".8rem", color: "var(--ink-faint)", marginBottom: ".6rem" }}>
                  {products.length} product{products.length === 1 ? "" : "s"}
                  {category !== "all" && ` in ${category}`}
                </div>
                <div className="grid-products stagger">
                  {products.map((p) => (
                    <article key={p.sku} className="tile">
                      <ProductImage
                        src={p.imageUrl}
                        emoji={p.imageEmoji}
                        alt={p.title}
                        accent={p.accentHex}
                        size="card"
                      />

                      <div className="tile-brand">{p.brand}</div>
                      <h3 className="tile-title">{p.title}</h3>

                      <div
                        style={{
                          display: "flex", alignItems: "baseline", gap: ".4rem",
                          marginBottom: ".45rem", flexWrap: "wrap",
                        }}
                      >
                        <span className="tile-price">{INR(p.priceInr)}</span>
                        {p.discountPct > 0 && (
                          <>
                            <span className="tile-mrp">{INR(p.mrpInr)}</span>
                            <span className="tile-off">{p.discountPct}% off</span>
                          </>
                        )}
                      </div>

                      <div
                        style={{
                          display: "flex", alignItems: "center", gap: ".45rem",
                          flexWrap: "wrap", marginBottom: ".65rem",
                          fontSize: ".76rem", color: "var(--ink-faint)",
                        }}
                      >
                        <span style={{ color: "var(--haldi-deep)" }} aria-hidden>★</span>
                        <span>
                          {p.ratingAvg}{" "}
                          <span aria-hidden>({p.ratingCount.toLocaleString("en-IN")})</span>
                          <span className="sr-only">
                            out of 5, from {p.ratingCount.toLocaleString("en-IN")} ratings
                          </span>
                        </span>
                        {!p.codEligible && <span>· online payment only</span>}
                      </div>

                      <div style={{ marginTop: "auto" }}>
                        {p.inStock ? (
                          <button
                            className="btn btn-ghost btn-sm liftable"
                            onClick={() => addToCart(p.sku)}
                            style={{ width: "100%" }}
                          >
                            Add to cart
                          </button>
                        ) : (
                          <button className="btn btn-ghost btn-sm" disabled style={{ width: "100%" }}>
                            Out of stock
                          </button>
                        )}
                        {p.stock > 0 && p.stock <= 20 && (
                          <div
                            style={{
                              fontSize: ".72rem", color: "var(--haldi-deep)",
                              marginTop: ".35rem", textAlign: "center",
                            }}
                          >
                            Only {p.stock} left
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </>
            )}
          </section>

          <AgentRail onCartChange={loadCart} />
        </div>
      </main>

      {toast && <Toast message={toast.m} tone={toast.t} onDone={() => setToast(null)} />}
    </Shell>
  );
}
