/**
 * The shopping agent.
 *
 * A buyer says, in their own language, what they need — "2000 ke andar ek
 * accha running shoe chahiye, size 9" — and this runs a real tool-calling loop
 * over the catalogue until it can put something defensible in the cart.
 *
 * Three design choices worth naming:
 *
 *  - **It searches before it recommends.** The system prompt forbids naming a
 *    product that did not come back from `search_catalogue`, and because the
 *    cart only accepts a real SKU, a hallucinated product cannot be ordered.
 *  - **It answers in the buyer's language** but reasons in English, which is
 *    where the catalogue tags and the policy text live.
 *  - **It cannot place the order.** It fills the cart; the buyer presses the
 *    button. The gate is in `callTool`, not in the prompt.
 */
import { chat, chatJson, type ChatMessage } from "@/lib/groq/client";
import { callTool, SHOPPING_TOOLS, type ToolContext, type ToolResult } from "@/lib/agent/tools";
import { BUDGETS } from "@/lib/agent/mandate";
import { emit } from "@/lib/events";
import { connectDb } from "@/lib/db/connect";
import { AgentSession, Product } from "@/models";
import { LANGUAGES, type LangCode } from "@/lib/types";
import { brokenTool } from "@/lib/clock";
import {
  checkGrounding, correctionFor, factsFromToolResults,
  type GroundingIssue,
} from "@/lib/agent/grounding";

const SYSTEM = `You are the Vaanijya shopping assistant for buyers in India.

LANGUAGE
- Buyers write in English, Hindi, Kannada, Tamil, Telugu, Marathi, Bengali or Gujarati, in native script or Latin transliteration. Always reply in the same language and script they used; match Hinglish with Hinglish.

GROUNDING — the rule that matters most, and it is checked
- Every reply is checked against the tool results. A product name, price or return window you did not read from a tool is rejected and you are asked to write it again. So call the tool first.
- Call search_catalogue (or get_product) before naming any product, price, rating or spec. If you did not read it from a tool result, you do not know it.
- When the buyer states conditions that must ALL hold — a budget AND a spec, or a date, or "in stock", or "from a reliable seller" — call solve_constraints instead of search_catalogue. It enforces every condition in code and tells you which offers failed which one. Then say how many satisfied everything and name the rejection tally ("3 were over budget, 1 has no induction base") — buyers trust a filter they can see the workings of.
- solve_constraints also returns a true cost (sticker + COD fee + delivery + the seller's priced-in failure rate) and a delivery interval with a confidence date. Quote those numbers exactly; never add up a cost or guess an arrival date yourself. If a cheaper sticker has a higher true cost, say so plainly — that is the useful thing you know.
- For specs, box contents or stock numbers, call get_product and quote its fields exactly. Do not answer "most pressure cookers..." from general knowledge — read this one.
- For a return window, refund timeline or COD eligibility, call get_policy or get_product. Never state a number of days from memory.
- For "where is my order", call get_order or get_tracking. For "what did I order", call list_my_orders.
- If a tool gives you nothing, say so plainly and ask one narrowing question.

WHAT YOU CANNOT DO
- You cannot place an order. Fill the cart, summarise it, and ask the buyer to press "Place order". Never claim an order was placed.
- You cannot change prices or offer discounts. Say so plainly if asked.
- You do not decide refunds or returns; for a delivered item that is faulty, point the buyer to "Report a problem" on that order.

STYLE
- Two to four sentences, then one question or a clear next step. This is a chat panel.
- At most ONE question per reply, and only when the answer changes what you would do.
- Offer two or three options with a price and one concrete reason each — never a catalogue dump.
- If the budget cannot be met, say so and show the nearest option above it.
- Never mention tools, SKUs, JSON or internals. If asked something unrelated to shopping, say that is outside what you can help with and offer what you can do.`;

export type AgentTurn = {
  reply: string;
  toolCalls: { name: string; args: Record<string, unknown>; ok: boolean; summary: string }[];
  cart: { count: number; total_inr: number } | null;
  degraded: boolean;
  requirements: Requirements;
};

export type Requirements = {
  /** A real catalogue category, safe to filter on. */
  category?: string;
  /** What the buyer actually called it, kept for display. */
  category_said?: string;
  budget_inr?: number;
  brand?: string;
  size?: string;
  use_case?: string;
  must_have?: string[];
  notes?: string;
};

/** Run one buyer turn through the agent. */
export async function runShoppingTurn(
  sessionId: string,
  userId: string,
  userMessage: string,
  lang: LangCode = "en",
): Promise<AgentTurn> {
  await connectDb();

  const session = await AgentSession.findOneAndUpdate(
    { sessionId },
    { $setOnInsert: { sessionId, userId, kind: "shopping", lang, messages: [], requirements: {} } },
    { upsert: true, returnDocument: "after" },
  );

  session.messages.push({ role: "user", content: userMessage, at: new Date() });

  await emit({
    type: "agent.turn",
    actor: "ShoppingAgent",
    summary: `Buyer (${LANGUAGES[lang] ?? lang}): "${truncate(userMessage, 120)}"`,
    payload: { message: userMessage, lang },
    userId,
    sessionId,
  });

  const ctx: ToolContext = {
    userId,
    agent: "ShoppingAgent",
    sessionId,
    brokenTool: await brokenTool(),
  };

  // History, trimmed: the last 16 turns is plenty and keeps the prompt small.
  // Filter BEFORE slicing. Slicing first counts tool rows against the window,
  // so a tool-heavy run silently pushes the real conversation out of context.
  // Six turns is enough to follow a thread and keeps the prompt affordable.
  const history: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    ...(session.messages as { role: string; content: string }[])
      .filter((m) => (m.role === "user" || m.role === "assistant") && (m.content ?? "").trim())
      .slice(-6)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  const profile = await callTool("get_buyer_profile", {}, ctx);
  if (profile.ok) {
    const pr = profile.data as {
      name?: string; lang?: string; priority?: string;
      default_address?: { city?: string; pincode?: string } | null;
      order_count?: number; store_credit_inr?: number;
    };
    // A sentence, not a JSON dump. This is sent on every step of the loop.
    history.splice(1, 0, {
      role: "system",
      content:
        `Buyer: ${pr.name ?? "unknown"}, prefers ${pr.priority ?? "money"} over ` +
        `${pr.priority === "speed" ? "refunds" : "replacements"}, ` +
        `${pr.order_count ?? 0} past orders` +
        (pr.default_address?.city ? `, delivers to ${pr.default_address.city} ${pr.default_address.pincode}` : "") +
        (pr.store_credit_inr ? `, has ₹${pr.store_credit_inr} store credit` : "") +
        ". Do not recite this back.",
    });
  }

  const toolCalls: AgentTurn["toolCalls"] = [];
  const rawResults: { name: string; ok: boolean; data?: unknown }[] = [];
  let degraded = false;
  let reply = "";

  const conversation: ChatMessage[] = [...history];
  let retriedForGrounding = false;
  let groundingIssues: GroundingIssue[] = [];

  for (let step = 0; step < BUDGETS.maxToolCallsPerTurn; step++) {
    // 500 rather than 900: a chat reply is two to four sentences, and the
    // free-tier token-per-minute budget is small enough that an inflated
    // ceiling costs real conversations.
    const res = await chat(conversation, { tools: SHOPPING_TOOLS, temperature: 0.3, maxTokens: 500 });

    if (!res.ok) {
      degraded = true;
      await emit({
        type: "system.degraded",
        actor: "ShoppingAgent",
        summary: `Model unavailable (${res.error}) — falling back to deterministic search`,
        payload: { error: res.error },
        userId,
        sessionId,
      });
      // The fallback gets the requirements the session has accumulated, not
      // just this message. "Need help with this order" carries no budget and
      // no category, but the session already knows both — dropping them
      // searches the whole catalogue and returns nonsense.
      const fb = await fallbackTurn(
        userMessage,
        (session.requirements ?? {}) as Requirements,
        (session.messages as { role: string; content: string }[])
          .filter((m) => m.role === "user")
          .map((m) => m.content),
        ctx,
      );
      reply = fb.reply;
      toolCalls.push(...fb.toolCalls);
      break;
    }

    if (res.toolCalls.length === 0) {
      const candidate = res.content.trim();
      const facts = factsFromToolResults(rawResults);
      const issues = checkGrounding(candidate, facts, lang, userMessage);

      // One corrective attempt. A prompt rule is a request; this is the check
      // that a reply about real products and real policy has to pass. If the
      // second attempt is no better we keep it and append a correction, so the
      // buyer is never silently handed an invented price.
      if (issues.length > 0 && !retriedForGrounding) {
        retriedForGrounding = true;
        groundingIssues = issues;

        await emit({
          type: "agent.grounding_rejected",
          actor: "GroundingGuard",
          summary: `Reply rejected: ${issues.map((i) => i.detail).join("; ")}`,
          payload: { issues, reply: candidate.slice(0, 900) },
          userId,
          sessionId,
        });

        conversation.push({ role: "assistant", content: candidate });
        conversation.push({
          role: "user",
          content:
            "That reply failed the grounding check:\n" +
            issues.map((i) => `- ${i.detail}`).join("\n") +
            "\n\nWrite it again. Call search_catalogue or get_product first and " +
            "use only the titles, prices and specs those return. Reply in the " +
            "same language the buyer used. Do not state a return window or a " +
            "policy number you have not read from get_policy.",
        });
        continue;
      }

      reply = candidate;
      groundingIssues = issues;
      break;
    }

    // Record the assistant's tool-call turn, then each result.
    conversation.push({
      role: "assistant",
      content: res.content ?? "",
      tool_calls: res.toolCalls.map((t) => ({
        id: t.id,
        type: "function" as const,
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      })),
    });

    for (const tc of res.toolCalls) {
      const out = await callTool(tc.name, tc.args, ctx);
      const summary = out.ok
        ? summarise(tc.name, out.data)
        : `${out.code}: ${out.error}`;

      toolCalls.push({ name: tc.name, args: tc.args, ok: out.ok, summary });
      // Kept separately from the display summary: the grounding guard needs the
      // real titles and prices, not a one-line description of them.
      rawResults.push({ name: tc.name, ok: out.ok, data: out.ok ? out.data : undefined });

      session.messages.push({
        role: "tool",
        content: summary,
        toolName: tc.name,
        toolArgs: tc.args,
        toolResult: out.ok ? out.data : { error: out.error, code: out.code },
        at: new Date(),
      });

      conversation.push({
        role: "tool",
        tool_call_id: tc.id,
        // Pruned, not truncated. A raw catalogue row is ~15 fields the model
        // does not need, and every tool result is re-sent on every later step
        // of the loop — so a fat result is paid for repeatedly. On a small
        // tokens-per-minute budget that is the difference between a working
        // conversation and a rate limit.
        content: compactForPrompt(tc.name, out),
      });
    }
  }

  if (!reply) {
    reply = degraded
      ? reply || "I could not reach the assistant just now. Tell me the product and your budget, and I will search directly."
      : "Tell me a little more about what you need — a budget or how you will use it — and I will find it.";
  }

  // If the reply still could not be substantiated, say so rather than letting
  // an invented price stand as fact. The buyer gets the answer plus an honest
  // note about the part we cannot vouch for.
  if (groundingIssues.length > 0) {
    const note = correctionFor(groundingIssues);
    if (note) reply = `${reply}\n\n_${note}_`;
    await emit({
      type: "agent.grounding_rejected",
      actor: "GroundingGuard",
      summary:
        `Reply sent with a correction appended: ` +
        groundingIssues.map((i) => i.kind).join(", "),
      payload: { issues: groundingIssues, corrected: true },
      userId,
      sessionId,
    });
  }

  session.messages.push({ role: "assistant", content: reply, at: new Date() });

  // Extract structured requirements so the UI can show what the agent believes.
  const requirements = await extractRequirements(
    (session.messages as { role: string; content: string }[])
      .filter((m) => m.role === "user")
      .slice(-6)
      .map((m) => m.content)
      .join("\n"),
    (session.requirements ?? {}) as Requirements,
  );
  session.requirements = requirements;
  session.lang = lang;
  await session.save();

  if (Object.keys(requirements).length) {
    await emit({
      type: "agent.requirements_updated",
      actor: "ShoppingAgent",
      summary: `Understood: ${describeRequirements(requirements)}`,
      payload: requirements,
      userId,
      sessionId,
    });
  }

  await emit({
    type: "agent.turn",
    actor: "ShoppingAgent",
    summary: `Replied in ${LANGUAGES[lang] ?? lang} after ${toolCalls.length} tool call(s)`,
    payload: { reply, toolCalls: toolCalls.map((t) => t.name), degraded },
    userId,
    sessionId,
  });

  const cartRes = await callTool("view_cart", {}, ctx);
  const cart = cartRes.ok
    ? {
        count: (cartRes.data as { count: number }).count,
        total_inr: (cartRes.data as { total_inr: number }).total_inr,
      }
    : null;

  return { reply, toolCalls, cart, degraded, requirements };
}


/**
 * A tool result, reduced to what the model needs to answer.
 *
 * `search_catalogue` returns every field of every match; the model needs the
 * sku, title, price, rating and stock to talk about it. The rest is weight
 * that gets re-sent on each subsequent step of the loop.
 */
function compactForPrompt(tool: string, out: ToolResult): string {
  if (!out.ok) return JSON.stringify({ error: out.error, code: out.code });
  const d = out.data as Record<string, unknown>;

  if (tool === "search_catalogue") {
    const rows = (d.results ?? []) as Record<string, unknown>[];
    return JSON.stringify({
      count: rows.length,
      results: rows.slice(0, 6).map((r) => ({
        sku: r.sku, title: r.title, brand: r.brand,
        price_inr: r.price_inr, rating: r.rating,
        in_stock: r.in_stock, cod: r.cod_eligible,
        // One short line of detail, so the model can say *why* it fits.
        about: String(r.description ?? "").slice(0, 120),
      })),
    });
  }

  if (tool === "get_product") {
    return JSON.stringify({
      sku: d.sku, title: d.title, brand: d.brand, price_inr: d.price_inr,
      rating: d.rating, in_stock: d.in_stock, stock: d.stock,
      attributes: d.attributes, box_contents: d.box_contents,
      cod_eligible: d.cod_eligible,
      about: String(d.description ?? "").slice(0, 260),
    });
  }

  if (tool === "solve_constraints") {
    // Already shaped for the model by the handler. Passed through whole: the
    // rejection tally is the part the buyer most needs quoted back, so
    // trimming it here would defeat the tool.
    return JSON.stringify(d);
  }

  if (tool === "get_tracking") {
    const scans = (d.scans ?? []) as Record<string, unknown>[];
    return JSON.stringify({
      status: d.status, courier: d.courier, attempts: d.attempts,
      promised_by: d.promised_by,
      // Only the last three scans matter for answering "where is my parcel".
      recent_scans: scans.slice(-3),
    });
  }

  const json = JSON.stringify(d);
  return json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
}

/**
 * No model available: do the obvious deterministic thing rather than failing.
 * Pull numbers out of the message as a budget, pull known category words out
 * as a category, search, and present the top three.
 */
async function fallbackTurn(
  message: string,
  known: Requirements,
  priorUserMessages: string[],
  ctx: ToolContext,
): Promise<{ reply: string; toolCalls: AgentTurn["toolCalls"] }> {
  // Build the search from everything the session knows, newest first. A turn
  // like "show me something cheaper" or "need help with this order" carries no
  // constraint of its own, so without this the filters vanish and the search
  // returns the whole catalogue — a saree and a pressure cooker for someone who
  // asked for shoes.
  const budget = extractBudget(message) ?? known.budget_inr ?? null;
  // Resolve against the real catalogue. The model stores the buyer's own
  // phrasing ("running shoes"), which is not a category value, and passing it
  // through filters out every product.
  const category =
    (await guessCategory(message)) ?? (await resolveCategory(known.category)) ?? null;
  const brand = known.brand ?? null;

  // The query text: this message plus whatever the buyer said earlier, so the
  // product words survive a follow-up that does not repeat them. Stopwords are
  // dropped — "need help with this order" contributes nothing but noise, and
  // every extra term widens the regex OR in the catalogue search.
  const queryParts = [message, ...priorUserMessages.slice(-4).reverse()];
  const seen = new Set<string>();
  const terms = queryParts
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (w) =>
        w.length >= 3 &&
        !STOPWORDS.has(w) &&
        !/^\d+$/.test(w) && // the budget is a filter, not a search term
        !seen.has(w) &&
        seen.add(w),
    )
    .slice(0, 8);

  // If stripping noise left nothing, fall back to the known category so the
  // search is still anchored to something real.
  const query = terms.length ? terms.join(" ") : (category ?? "");

  const args: Record<string, unknown> = { query: query.slice(0, 200), limit: 3 };
  if (budget) args.max_price_inr = budget;
  if (category) args.category = category;
  if (brand) args.brand = brand;

  const out = await callTool("search_catalogue", args, ctx);
  const calls: AgentTurn["toolCalls"] = [
    {
      name: "search_catalogue", args, ok: out.ok,
      summary: out.ok ? summarise("search_catalogue", out.data) : String(out.error),
    },
  ];

  if (!out.ok) {
    return {
      reply: "The catalogue search failed just now. Please try again in a moment.",
      toolCalls: calls,
    };
  }

  const results = (out.data as {
    results: { title: string; price_inr: number; rating: number; sku: string }[];
  }).results;

  // Say what was actually searched for, so a wrong answer is debuggable by the
  // person reading it rather than mysterious.
  const criteria = [
    category ? category : null,
    brand ? `brand ${brand}` : null,
    budget ? `under ₹${budget.toLocaleString("en-IN")}` : null,
  ].filter(Boolean).join(", ");

  if (!results.length) {
    return {
      reply:
        `I could not find anything${criteria ? ` matching ${criteria}` : " matching that"}. ` +
        (budget
          ? "Try raising the budget, or name the product differently."
          : "Try naming the product differently."),
      toolCalls: calls,
    };
  }

  const lines = results
    .map((r, i) => `${i + 1}. ${r.title} — ₹${r.price_inr.toLocaleString("en-IN")}${r.rating ? ` (${r.rating}★)` : ""}`)
    .join("\n");

  return {
    reply:
      `I am running without the language model, so this is a direct catalogue search` +
      `${criteria ? ` for ${criteria}` : ""}:\n\n${lines}\n\n` +
      `Tap one to add it to your cart. For a proper conversation, add a GROQ_API_KEY.`,
    toolCalls: calls,
  };
}

function extractBudget(s: string): number | null {
  // "under 2000", "2000 ke andar", "₹2,000", "2k"
  const k = s.match(/(\d+(?:\.\d+)?)\s*k\b/i);
  if (k) return Math.round(Number.parseFloat(k[1]) * 1000);
  const nums = [...s.matchAll(/(?:₹|rs\.?|inr)?\s*(\d[\d,]{2,})/gi)]
    .map((m) => Number.parseInt(m[1].replace(/,/g, ""), 10))
    .filter((n) => n >= 100 && n <= 500_000);
  return nums.length ? Math.max(...nums) : null;
}

/** Category words across the languages we accept, mapped to catalogue values. */
const CATEGORY_WORDS: Record<string, string[]> = {
  footwear: ["shoe", "shoes", "sneaker", "sandal", "chappal", "joota", "jute", "boot", "slipper", "செருப்பு", "ಚಪ್ಪಲಿ", "जूता", "जूते"],
  electronics: ["phone", "mobile", "earbud", "earphone", "headphone", "laptop", "charger", "watch", "speaker", "tv", "फोन", "मोबाइल", "ಮೊಬೈಲ್", "மொபைல்"],
  apparel: ["shirt", "tshirt", "t-shirt", "kurta", "saree", "jeans", "dress", "kapda", "कपड़ा", "शर्ट", "ಅಂಗಿ", "சட்டை"],
  home: ["bedsheet", "pillow", "curtain", "mattress", "lamp", "chair", "table"],
  kitchen: ["cooker", "kadai", "pan", "bottle", "mixer", "grinder", "tiffin", "कुकर", "ಕುಕ್ಕರ್"],
  beauty: ["cream", "shampoo", "soap", "serum", "oil", "lipstick"],
  grocery: ["rice", "dal", "atta", "oil", "masala", "tea", "coffee", "चावल", "ಅಕ್ಕಿ", "அரிசி"],
  books: ["book", "novel", "guide", "textbook", "किताब", "ಪುಸ್ತಕ", "புத்தகம்"],
};

/**
 * Resolve a category name to one the catalogue actually uses, or null.
 *
 * The model writes whatever phrase the buyer used into `requirements.category`
 * — "running shoes", "sports footwear" — but `search_catalogue` matches the
 * category field exactly, so an unrecognised value silently excludes every
 * product. Trusting that string is how a search for shoes returns nothing when
 * the shoes are right there.
 */
async function resolveCategory(value: string | undefined | null): Promise<string | null> {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;

  await connectDb();
  const real = (await Product.distinct("category", { active: true })) as string[];
  const lower = new Map(real.map((c) => [c.toLowerCase(), c]));

  // Exact match on a real category.
  const exact = lower.get(v);
  if (exact) return exact;

  // The phrase contains a real category ("sports footwear" -> footwear).
  for (const [k, original] of lower) {
    if (v.includes(k)) return original;
  }

  // Fall back to the keyword map, which knows "shoes" means footwear.
  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    if (words.some((w) => v.includes(w.toLowerCase()))) {
      return lower.get(cat.toLowerCase()) ?? null;
    }
  }

  // Unrecognised: drop it rather than filtering everything out.
  return null;
}

/** Words that carry no product meaning, so they only dilute the query. */
const STOPWORDS = new Set([
  "need", "want", "looking", "look", "help", "please", "this", "that", "with",
  "the", "and", "for", "any", "some", "something", "anything", "else", "more",
  "show", "give", "find", "get", "buy", "order", "orders", "cart", "good",
  "best", "nice", "under", "below", "around", "about", "than", "less", "cheap",
  "cheaper", "rupees", "rupee", "price", "budget", "have", "chahiye", "mujhe",
  "kya", "hai", "karo", "dikhao", "andar",
]);

async function guessCategory(message: string): Promise<string | null> {
  const lower = message.toLowerCase();
  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    if (words.some((w) => lower.includes(w.toLowerCase()))) return cat;
  }
  // Last resort: does any product tag appear in the message?
  await connectDb();
  const hit = await Product.findOne({
    tags: { $in: lower.split(/[\s,]+/).filter((t) => t.length >= 3) },
  })
    .select("category")
    .lean();
  return hit?.category ?? null;
}

/** Keep a structured belief about what the buyer wants, refined each turn. */
async function extractRequirements(
  userText: string,
  previous: Requirements,
): Promise<Requirements> {
  const parsed = await chatJson<Requirements>(
    [
      {
        role: "system",
        content:
          "Extract shopping requirements from the buyer's messages into JSON. " +
          "Keys: category, budget_inr (number), brand, size, use_case, must_have " +
          "(array of short strings), notes. Omit a key entirely if the buyer has " +
          "not indicated it. Do not invent values. Messages may be in any Indian " +
          "language or transliteration.",
      },
      { role: "user", content: userText.slice(0, 2000) },
    ],
    { temperature: 0, maxTokens: 300 },
  );

  if (!parsed) {
    // Deterministic floor: a budget is the one thing worth getting right
    // without a model, because it changes which results are even shown.
    const budget = extractBudget(userText);
    const category = await guessCategory(userText);
    return {
      ...previous,
      ...(budget ? { budget_inr: budget } : {}),
      ...(category ? { category } : {}),
    };
  }

  const merged: Requirements = { ...previous };
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || v === undefined || v === "" ) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    (merged as Record<string, unknown>)[k] = v;
  }

  // Normalise the category to a value the catalogue actually has. The model
  // records the buyer's phrasing, which is right for the chips on screen but
  // wrong as a filter; keeping the raw phrase separately means neither use is
  // compromised.
  if (merged.category) {
    const resolved = await resolveCategory(merged.category);
    if (resolved && resolved !== merged.category) {
      merged.category_said = merged.category;
      merged.category = resolved;
    } else if (!resolved) {
      // Unrecognised: keep it for display, but never filter on it.
      merged.category_said = merged.category;
      delete merged.category;
    }
  }

  return merged;
}

function describeRequirements(r: Requirements): string {
  const bits: string[] = [];
  if (r.category_said ?? r.category) bits.push(String(r.category_said ?? r.category));
  if (r.brand) bits.push(`brand ${r.brand}`);
  if (r.size) bits.push(`size ${r.size}`);
  if (r.budget_inr) bits.push(`under ₹${r.budget_inr}`);
  if (r.use_case) bits.push(`for ${r.use_case}`);
  if (r.must_have?.length) bits.push(r.must_have.join(", "));
  return bits.join(" · ") || "nothing specific yet";
}

/** A one-line, human-readable version of a tool result for the trace panel. */
function summarise(tool: string, data: unknown): string {
  const d = data as Record<string, unknown>;
  switch (tool) {
    case "search_catalogue": {
      const r = (d.results ?? []) as { title: string; price_inr: number }[];
      return r.length
        ? `${r.length} match(es): ${r.slice(0, 3).map((x) => `${x.title} ₹${x.price_inr}`).join("; ")}`
        : "no matches";
    }
    case "add_to_cart": {
      const a = d.added as { title: string; qty: number } | undefined;
      return a ? `added ${a.title} × ${a.qty}, cart now ₹${d.cart_total_inr}` : "added";
    }
    case "view_cart":
      return `${d.count ?? 0} item(s), ₹${d.total_inr ?? 0}`;
    case "get_product":
      return `${d.title} — ₹${d.price_inr}, ${d.in_stock ? "in stock" : "out of stock"}`;
    case "solve_constraints": {
      const sat = (d.satisfied ?? []) as { title: string; true_cost_inr: number }[];
      const tally = (d.rejection_summary ?? []) as string[];
      return (
        `${sat.length} satisfied all constraints` +
        (sat.length
          ? `: ${sat.slice(0, 2).map((x) => `${x.title} ₹${x.true_cost_inr} all-in`).join("; ")}`
          : "") +
        (tally.length ? ` · rejected: ${tally.join(", ")}` : "")
      );
    }
    case "get_buyer_profile":
      return `${d.name}, ${d.order_count} past order(s)`;
    case "list_my_orders":
      return `${Array.isArray(data) ? data.length : 0} order(s)`;
    case "get_tracking":
      return `${d.status} via ${d.courier}, ${(d.scans as unknown[])?.length ?? 0} scan(s)`;
    default:
      return JSON.stringify(data).slice(0, 180);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
