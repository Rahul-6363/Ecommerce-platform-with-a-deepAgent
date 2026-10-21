/**
 * List the models this GROQ_API_KEY can actually reach, and probe each one for
 * the three capabilities the platform depends on.
 *
 * This exists because Groq retires model names, and a retired name returns a
 * 404 that is indistinguishable from a broken key: the agent drops to its
 * deterministic fallback and the UI says "running without a model". Run this
 * when that happens.
 *
 *   npx tsx scripts/models.ts
 */
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

function loadKey(): string {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY.trim();
  for (const f of [".env.local", ".env"]) {
    try {
      const m = readFileSync(f, "utf8").match(/^\s*GROQ_API_KEY\s*=\s*(.*)$/m);
      const v = m?.[1]?.trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    } catch {
      /* try the next file */
    }
  }
  return "";
}

const KEY = loadKey();
const BASE = "https://api.groq.com/openai/v1";

/** A real PNG: Groq rejects images under 32px, so a 1x1 test is useless. */
function testPng(w = 64, h = 64): string {
  const crc32 = (b: Buffer) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      const p = o + 1 + x * 3;
      raw[p] = x < w / 2 ? 230 : 30;
      raw[p + 1] = 60;
      raw[p + 2] = 60;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function post(body: unknown) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    choices?: { message?: { content?: string; tool_calls?: unknown[] } }[];
    error?: { message?: string };
  };
  return { status: res.status, ok: res.ok, json };
}

const TOOL = [{
  type: "function",
  function: {
    name: "search_catalogue",
    description: "Search products",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, max_price_inr: { type: "number" } },
      required: ["query"],
    },
  },
}];

async function probe(model: string) {
  const out = { chat: "–", tools: "–", json: "–", vision: "–" };

  const c = await post({ model, messages: [{ role: "user", content: "Reply with one word: ready" }], max_tokens: 16 });
  out.chat = c.ok ? (c.json.choices?.[0]?.message?.content?.trim() ? "yes" : "empty") : `${c.status}`;

  if (c.ok) {
    const t = await post({
      model, max_tokens: 200, tools: TOOL, tool_choice: "auto",
      messages: [{ role: "user", content: "Find running shoes under 2000 rupees" }],
    });
    out.tools = t.ok && t.json.choices?.[0]?.message?.tool_calls?.length ? "yes" : t.ok ? "no" : `${t.status}`;

    const j = await post({
      model, max_tokens: 60, response_format: { type: "json_object" },
      messages: [{ role: "user", content: 'Return JSON {"ok":true}' }],
    });
    out.json = j.ok ? "yes" : `${j.status}`;

    const v = await post({
      model, max_tokens: 60,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe the colours in one sentence." },
          { type: "image_url", image_url: { url: testPng() } },
        ],
      }],
    });
    out.vision = v.ok ? "yes" : "no";
  }

  return out;
}

async function main() {
  if (!KEY) {
    console.error("\nNo GROQ_API_KEY found in the environment, .env.local or .env.");
    console.error("Get a free key at https://console.groq.com/keys\n");
    process.exit(1);
  }
  if (!KEY.startsWith("gsk_")) {
    console.error(`\nGROQ_API_KEY does not look like a Groq key (expected gsk_…, got ${KEY.slice(0, 6)}…)\n`);
    process.exit(1);
  }

  const res = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${KEY}` } });
  if (!res.ok) {
    console.error(`\nGroq rejected the key (HTTP ${res.status}). Check it at https://console.groq.com/keys\n`);
    process.exit(1);
  }

  const { data } = (await res.json()) as { data: { id: string }[] };
  const ids = data.map((m) => m.id).sort();

  // Audio and guard models are not chat models; probing them is just noise.
  const chatish = ids.filter((id) => !/whisper|orpheus|prompt-guard|tts/i.test(id));
  const audio = ids.filter((id) => /whisper/i.test(id));

  console.log(`\n${ids.length} model(s) reachable with this key.\n`);
  console.log("Probing the capabilities this platform needs:\n");
  console.log("  model                            chat   tools  json   vision");
  console.log("  " + "-".repeat(62));

  const rows: { model: string; chat: string; tools: string; json: string; vision: string }[] = [];
  for (const m of chatish) {
    const r = await probe(m);
    rows.push({ model: m, ...r });
    console.log(
      `  ${m.padEnd(32)} ${r.chat.padEnd(6)} ${r.tools.padEnd(6)} ${r.json.padEnd(6)} ${r.vision}`,
    );
  }

  // The agent needs three things, and all three are load-bearing:
  //   chat="yes"  — it must return prose. A reasoning model that puts its
  //                 output somewhere other than message.content reports
  //                 "empty" here, and is useless for replying to a buyer
  //                 however well it calls tools.
  //   tools="yes" — the shopping agent is a tool-calling loop.
  //   json="yes"  — triage, planning and requirement extraction use JSON mode.
  const usable = rows.filter((r) => r.chat === "yes" && r.tools === "yes" && r.json === "yes");
  // Prefer one that also sees images, so a single model covers the whole app.
  const best = usable.find((r) => r.vision === "yes") ?? usable[0];
  const bestVision = rows.find((r) => r.vision === "yes");

  console.log();
  if (best) {
    console.log("Recommended for .env:\n");
    console.log(`  GROQ_TEXT_MODEL=${best.model}`);
    if (bestVision) console.log(`  GROQ_VISION_MODEL=${bestVision.model}`);
    if (audio.length) console.log(`  GROQ_AUDIO_MODEL=${audio.includes("whisper-large-v3-turbo") ? "whisper-large-v3-turbo" : audio[0]}`);
    console.log();
  } else {
    console.log(
      "No reachable model does all three of chat, tool-calling and JSON mode,\n" +
      "which the agent needs. The platform still runs end to end on its\n" +
      "deterministic path, and the UI says it is degraded.\n",
    );
    const mute = rows.filter((r) => r.chat === "empty" && r.tools === "yes");
    if (mute.length) {
      console.log(
        `Note: ${mute.map((r) => r.model).join(", ")} call tools but return no\n` +
        "message content, so they cannot write a reply to a buyer.\n",
      );
    }
  }
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)) + "\n");
  process.exit(1);
});
