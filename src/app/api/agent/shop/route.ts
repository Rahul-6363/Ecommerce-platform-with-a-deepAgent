import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { runShoppingTurn } from "@/lib/agent/shopping";
import { connectDb } from "@/lib/db/connect";
import { AgentSession } from "@/models";
import type { LeanAgentSession } from "@/models";
import { handler } from "@/lib/api";
import { LANGUAGES, type LangCode } from "@/lib/types";
import { nanoid } from "nanoid";

const Body = z.object({
  message: z.string().min(1, "Say what you are looking for.").max(2000),
  sessionId: z.string().optional(),
  lang: z.enum(Object.keys(LANGUAGES) as [string, ...string[]]).optional(),
});

export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const b = Body.parse(await req.json());

    const sessionId = b.sessionId || `sess-${nanoid(10)}`;
    const lang = (b.lang ?? user.lang ?? "en") as LangCode;

    const turn = await runShoppingTurn(sessionId, String(user._id), b.message, lang);

    return { sessionId, ...turn };
  });
}

/** Replay a session so a refresh does not lose the conversation. */
export async function GET(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
    if (!sessionId) return { sessionId: "", messages: [], requirements: {} };

    await connectDb();
    const s = await AgentSession.findOne({
      sessionId,
      userId: user._id,
    }).lean<LeanAgentSession>();

    if (!s) return { sessionId, messages: [], requirements: {} };

    return {
      sessionId,
      lang: s.lang,
      requirements: s.requirements ?? {},
      messages: (s.messages ?? [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content, at: m.at })),
      trace: (s.messages ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => ({ tool: m.toolName, args: m.toolArgs, summary: m.content, at: m.at })),
    };
  });
}
