import Link from "next/link";
import Shell from "@/components/Shell";
import ProductImage from "@/components/ProductImage";
import { capabilities } from "@/lib/env";

/**
 * The front door.
 *
 * It states what the system does and what it refuses to do, then offers three
 * ways in. The hero is the agent transcript itself — a complaint in Kannada
 * becoming a cited policy decision — because that exchange *is* the product,
 * and showing it beats describing it.
 */
export default async function Home() {
  const caps = capabilities();

  /* The catalogue, read on the server.
   *
   * The front door used to describe the product and never show it, so a
   * visitor had to take "there is a catalogue" on trust and click through to
   * find out. These are real rows: if the database is unseeded the sections
   * render empty rather than inventing placeholder products, because a
   * storefront showing fake stock is the one thing this project does not do.
   */
  const { categories, featured, deals, total } = await storefront();

  return (
    <Shell>
      <main>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section
        style={{
          borderBottom: "1px solid var(--rule)",
          background:
            "radial-gradient(1200px 400px at 15% -10%, var(--haldi-wash), transparent 60%)," +
            "radial-gradient(900px 350px at 85% 0%, var(--neel-wash), transparent 55%)",
        }}
      >
        <div style={{ maxWidth: "76rem", margin: "0 auto", padding: "clamp(2.5rem,6vw,4.5rem) 1.25rem clamp(2.5rem,5vw,3.5rem)" }}>

          <div style={{ display: "grid", gap: "clamp(2rem,4vw,3.5rem)", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,22rem),1fr))", alignItems: "center" }}>
            <div>
              <h1 style={{ maxWidth: "15ch", marginBottom: "1.1rem" }}>
                Say what you need. In whatever language you think in.
              </h1>
              <p style={{ fontSize: "1.03rem", color: "var(--ink-soft)", maxWidth: "46ch", marginBottom: "1rem", lineHeight: 1.65 }}>
                An agent that shops for you, keeps your parcel from failing, and
                handles the complaint when something arrives broken.
              </p>
              {/* The one claim worth making before someone clicks: it cannot
                  move money on its own. Everything behind that is on /system. */}
              <p style={{ fontSize: ".92rem", color: "var(--ink-faint)", maxWidth: "46ch", marginBottom: "1.8rem", lineHeight: 1.6 }}>
                It never decides your money on its own — a person approves before a
                rupee moves.
              </p>
              <div style={{ display: "flex", gap: ".6rem", flexWrap: "wrap" }}>
                <Link href="/find" className="btn btn-accent">State what you need</Link>
                <Link href="/shop" className="btn btn-ghost">Browse the catalogue</Link>
                <Link href="/system" className="btn btn-ghost">See how it works</Link>
              </div>
            </div>

            {/* The transcript is the hero: a complaint becoming a cited decision. */}
            <div className="card enter" style={{ padding: "1.1rem", overflow: "hidden" }}>
              <div style={{ fontSize: ".78rem", color: "var(--ink-soft)", marginBottom: ".9rem" }}>
                One complaint, from a buyer&rsquo;s sentence to an approved remedy.
              </div>

              <Turn who="Buyer" tone="neutral">
                <span lang="kn" style={{ fontSize: "1rem" }}>ಇಯರ್‌ಬಡ್ ಬಂದಿದೆ ಆದರೆ ಬಲ ಭಾಗ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ</span>
                <div style={{ fontSize: ".78rem", color: "var(--ink-faint)", marginTop: ".25rem" }}>
                  The earbuds came but the right side does not work
                </div>
              </Turn>

              <Turn who="Triage" tone="indigo">
                Classified <strong>DOA</strong> &middot; Kannada detected &middot; evidence flag
                <code className="mono"> stated_fault</code>
              </Turn>

              <Turn who="Orchestrator" tone="indigo">
                Planned 7 steps: read the order &rarr; courier record &rarr; policy
                &rarr; <strong>rule engine</strong> &rarr; draft &rarr; verify &rarr; gate
              </Turn>

              <Turn who="Policy engine" tone="gold">
                Clause <strong>VJ-ELEC-2.1</strong> &middot; inside the 7-day window &middot;
                replacement stock available
                <div style={{ marginTop: ".35rem", fontWeight: 600, color: "var(--ink)" }}>
                  Remedy: replacement &middot; ₹0 cash &middot; by 25 Oct
                </div>
              </Turn>

              <Turn who="Operator" tone="moss">
                Approved. The buyer is emailed the decision and the clause it rests on.
              </Turn>

              <div style={{ marginTop: ".9rem", paddingTop: ".7rem", borderTop: "1px solid var(--rule)", fontSize: ".76rem", color: "var(--ink-faint)" }}>
                The model read the sentence and wrote the letter. It did not pick the
                remedy, the amount or the date.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── The catalogue, which is what people came for ─────────────── */}
      {total > 0 && (
        <section className="home-shop">
          <div className="home-shop-in">
            <div className="home-shop-head">
              <div>
                <h2>Shop by category</h2>
                <p>
                  {total} products across {categories.length} categories. Every
                  price, seller and parcel here is fictional demonstration data.
                </p>
              </div>
              <Link href="/shop" className="btn btn-ghost btn-sm">
                Browse all {total}
              </Link>
            </div>

            <div className="cat-grid">
              {categories.map((c) => (
                <Link
                  key={c.name}
                  href={`/shop?category=${encodeURIComponent(c.name)}`}
                  className="cat-tile"
                >
                  <span className="cat-emoji" aria-hidden>{c.emoji}</span>
                  <span className="cat-name">{c.name}</span>
                  <span className="cat-count">{c.count} items</span>
                </Link>
              ))}
            </div>

            {/* Two strips rather than one long grid: "most reviewed" and
                "biggest discount" answer different questions, and a single
                undifferentiated row of twelve answers neither. */}
            <div className="strip-head">
              <h3>Most reviewed</h3>
              <Link href="/shop?sort=popular">See more</Link>
            </div>
            <div className="prod-strip">
              {featured.map((p) => <MiniCard key={p.sku} p={p} />)}
            </div>

            {deals.length > 0 && (
              <>
                <div className="strip-head">
                  <h3>Biggest discounts</h3>
                  <Link href="/shop?sort=discount">See more</Link>
                </div>
                <div className="prod-strip">
                  {deals.map((p) => <MiniCard key={p.sku} p={p} />)}
                </div>
              </>
            )}

            {/* The discovery path, offered where someone is already failing to
                find a product by browsing — which is when it is useful. */}
            <div className="home-find">
              <div>
                <strong>Cannot find the name of what you want?</strong>
                <p>
                  Describe the problem instead — &ldquo;a gift for my mother who
                  has back pain&rdquo; — and the constraint solver returns what
                  qualifies, and why everything else did not.
                </p>
              </div>
              <Link href="/find" className="btn btn-accent btn-sm">State a need</Link>
            </div>
          </div>
        </section>
      )}

      {/* ── What it actually does ────────────────────────────────────── */}
      <section style={{ maxWidth: "76rem", margin: "0 auto", padding: "clamp(2.5rem,5vw,4rem) 1.25rem" }}>
        <h2 style={{ marginBottom: ".6rem" }}>Three lanes, one agent</h2>
        <p style={{ color: "var(--ink-soft)", maxWidth: "54ch", marginBottom: "2rem" }}>
          Things go wrong while you are choosing, just before a parcel arrives, or
          just after. This works all three.
        </p>

        <div className="stagger" style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,19rem),1fr))" }}>
          <Lane
            title="Before you choose: say what you need"
            points={[
              "Describe it in your own words — type or speak, in any of eight languages.",
              "You get only what fits every condition, each one checked against the product.",
              "And why the rest were rejected. No other platform tells you that.",
              "Prices include delivery, COD fees and the seller's failure rate.",
              "Delivery is an interval, not a promise: likely, and 80% confident.",
            ]}
          />
          <Lane
            title="Before delivery: it stops the parcel failing"
            points={[
              "The agent fills your cart with a reason for each item. You press order.",
              "Every parcel is risk-scored before dispatch — COD, pincode, address, history.",
              "Cheap fixes it just does. Anything that costs you something, it asks.",
              "On a safe parcel it does nothing, and says so.",
            ]}
          />
          <Lane
            title="After delivery: it decides, and shows its working"
            points={[
              "Say or type what went wrong, in your language, with photos.",
              "A vision model reads the photo; the courier record and your history are weighed too.",
              "A rule engine with no model in it sets the remedy and amount, and cites the clause.",
              "Your refund says how much, where it is going and by when.",
              "Nothing automatic rejects you. A doubtful claim goes to a person.",
            ]}
          />
        </div>
      </section>

      {/* ── The line we hold ─────────────────────────────────────────── */}
      <section style={{ borderTop: "1px solid var(--rule)", background: "var(--paper-sunk)" }}>
        <div style={{ maxWidth: "76rem", margin: "0 auto", padding: "clamp(2.5rem,5vw,3.5rem) 1.25rem" }}>
          <div style={{ display: "grid", gap: "2rem", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,20rem),1fr))" }}>
            <div>
              <h2 style={{ marginBottom: ".8rem" }}>Where the model stops</h2>
              <p style={{ color: "var(--ink-soft)", maxWidth: "46ch", marginBottom: "1rem", lineHeight: 1.7 }}>
                The language model classifies a complaint and writes the letter.
                A pure function with unit tests computes the money. We do not let
                a model do arithmetic on someone&rsquo;s refund.
              </p>
              <p style={{ color: "var(--ink-soft)", maxWidth: "46ch", lineHeight: 1.7 }}>
                Four actions always stop for a human: messaging you, converting
                your payment, filing a claim, and moving money. That gate is
                enforced in the code that calls the tool, not requested in a prompt.
              </p>
            </div>

            <div className="card" style={{ padding: "1.1rem" }}>
              <div style={{ fontSize: ".74rem", color: "var(--ink-faint)", marginBottom: ".75rem" }}>
                Running right now
              </div>
              <CapRow name="Agent model" status={caps.model.status} detail={caps.model.detail} />
              <CapRow name="Photo analysis" status={caps.vision.status} detail={caps.vision.detail} />
              <CapRow name="Voice complaints" status={caps.voice.status} detail={caps.voice.detail} />
              <CapRow name="Database" status={caps.database.status} detail={caps.database.detail} />
              <CapRow name="Email" status={caps.mail.status} detail={caps.mail.detail} />
              <div style={{ marginTop: ".85rem", paddingTop: ".7rem", borderTop: "1px solid var(--rule)", fontSize: ".78rem", color: "var(--ink-faint)", lineHeight: 1.6 }}>
                Anything not live falls back to a deterministic path. The engines,
                the gate and the watcher never needed a model.{" "}
                <Link href="/system" style={{ color: "var(--neel-ink)", fontWeight: 550 }}>
                  See every engine, gate and threshold
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      </main>
    </Shell>
  );
}

function Turn({ who, tone, children }: { who: string; tone: "neutral" | "indigo" | "gold" | "moss"; children: React.ReactNode }) {
  const accent = {
    neutral: "var(--rule-strong)", indigo: "var(--neel)",
    gold: "var(--haldi)", moss: "var(--moss)",
  }[tone];
  return (
    <div style={{ borderLeft: `2px solid ${accent}`, paddingLeft: ".75rem", marginBottom: ".8rem" }}>
      <div style={{ fontSize: ".7rem", color: "var(--ink-faint)", marginBottom: ".2rem" }}>{who}</div>
      <div style={{ fontSize: ".875rem", color: "var(--ink-soft)", lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}

function Lane({ title, points }: { title: string; points: string[] }) {
  return (
    <div className="card" style={{ padding: "1.4rem" }}>
      <h3 style={{ marginBottom: ".9rem" }}>{title}</h3>
      <ul className="ladder">
        {points.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

function CapRow({ name, status, detail }: { name: string; status: string; detail: string }) {
  const live = status === "live";
  const colour = live ? "var(--moss)" : status === "ephemeral" ? "var(--neel)" : "var(--haldi-deep)";
  return (
    <div style={{ display: "flex", gap: ".6rem", alignItems: "flex-start", padding: ".4rem 0", borderBottom: "1px solid var(--rule)" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: colour, marginTop: ".42rem", flexShrink: 0 }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: ".84rem", fontWeight: 550 }}>{name}</div>
        <div style={{ fontSize: ".76rem", color: "var(--ink-faint)" }}>{detail}</div>
      </div>
    </div>
  );
}


/* ─────────────────────── Storefront data ─────────────────────────────── */

type Mini = {
  sku: string; title: string; brand: string; priceInr: number; mrpInr: number;
  discountPct: number; ratingAvg: number; ratingCount: number;
  imageUrl: string; imageEmoji: string; accentHex: string; inStock: boolean;
};

/** One emoji per category, for the tiles. Keyed by the canonical name. */
const CATEGORY_EMOJI: Record<string, string> = {
  electronics: "\u{1F50C}",
  computers: "\u{1F5A5}\u{FE0F}",
  kitchen: "\u{1F373}",
  home: "\u{1F6CB}\u{FE0F}",
  apparel: "\u{1F455}",
  footwear: "\u{1F45E}",
  beauty: "\u{1F9F4}",
  sports: "\u{1F3CB}\u{FE0F}",
  books: "\u{1F4DA}",
  hardware: "\u{1F9F0}",
};

/**
 * Read the storefront straight from the database.
 *
 * Not through `/api/catalogue`: this is a server component, so a fetch to our
 * own route would be a needless round trip through the HTTP layer. The
 * projection is the same one the API returns, so the cards look identical
 * either way.
 */
async function storefront(): Promise<{
  total: number;
  categories: { name: string; count: number; emoji: string }[];
  featured: Mini[];
  deals: Mini[];
}> {
  try {
    const { connectDb } = await import("@/lib/db/connect");
    const { Product } = await import("@/models");
    await connectDb();

    const total = await Product.countDocuments({ active: true });
    if (total === 0) return { total: 0, categories: [], featured: [], deals: [] };

    const mini = (p: Record<string, unknown>): Mini => {
      const price = Number(p.priceInr ?? 0);
      const mrp = Number(p.mrpInr ?? 0);
      return {
        sku: String(p.sku), title: String(p.title), brand: String(p.brand),
        priceInr: price, mrpInr: mrp,
        discountPct: mrp > 0 ? Math.round((1 - price / mrp) * 100) : 0,
        ratingAvg: Number(p.ratingAvg ?? 0), ratingCount: Number(p.ratingCount ?? 0),
        imageUrl: String(p.imageUrl ?? ""),
        imageEmoji: String(p.imageEmoji ?? "\u{1F4E6}"),
        accentHex: String(p.accentHex ?? "#3d4a9e"),
        inStock: Number(p.stock ?? 0) > 0,
      };
    };

    const [catRows, featuredRows, dealRows] = await Promise.all([
      Product.aggregate<{ _id: string; n: number }>([
        { $match: { active: true } },
        { $group: { _id: "$category", n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      // In stock only: a featured product nobody can buy is a dead tile.
      Product.find({ active: true, stock: { $gt: 0 } })
        .sort({ ratingCount: -1 })
        .limit(6)
        .lean(),
      Product.find({ active: true, stock: { $gt: 0 }, mrpInr: { $gt: 0 } })
        .sort({ mrpInr: -1 })
        .limit(6)
        .lean(),
    ]);

    const deals = (dealRows as Record<string, unknown>[])
      .map(mini)
      .filter((p) => p.discountPct >= 25)
      .sort((a, b) => b.discountPct - a.discountPct)
      .slice(0, 6);

    return {
      total,
      categories: catRows.map((c) => ({
        name: c._id,
        count: c.n,
        emoji: CATEGORY_EMOJI[c._id] ?? "\u{1F4E6}",
      })),
      featured: (featuredRows as Record<string, unknown>[]).map(mini),
      deals,
    };
  } catch {
    // An unreachable database must not take the front door down with it.
    return { total: 0, categories: [], featured: [], deals: [] };
  }
}

const INR = (n: number) => `\u20B9${Math.trunc(n || 0).toLocaleString("en-IN")}`;

function MiniCard({ p }: { p: Mini }) {
  return (
    <Link href={`/shop?q=${encodeURIComponent(p.title)}`} className="mini-card">
      <ProductImage
        src={p.imageUrl}
        emoji={p.imageEmoji}
        alt={p.title}
        accent={p.accentHex}
        size="card"
        className="mini-art"
      />
      <span className="mini-brand">{p.brand}</span>
      <span className="mini-title">{p.title}</span>
      <span className="mini-price">
        <strong>{INR(p.priceInr)}</strong>
        {p.discountPct > 0 && (
          <>
            <s>{INR(p.mrpInr)}</s>
            <em>{p.discountPct}% off</em>
          </>
        )}
      </span>
      <span className="mini-meta">
        {p.ratingAvg.toFixed(1)} &#9733; ({p.ratingCount.toLocaleString("en-IN")})
      </span>
    </Link>
  );
}
