import { requireOperator } from "@/lib/auth/session";
import { connectDb } from "@/lib/db/connect";
import { MailLog } from "@/models";
import { handler } from "@/lib/api";

/** Every letter the system sent or would have sent. */
export async function GET(req: Request) {
  return handler(async () => {
    await requireOperator();
    await connectDb();
    const limit = Math.min(
      Number.parseInt(new URL(req.url).searchParams.get("limit") ?? "60", 10) || 60,
      200,
    );
    const rows = await MailLog.find().sort({ sentAt: -1 }).limit(limit).lean();
    return {
      mail: rows.map((m) => ({
        id: String(m._id), to: m.to, from: m.from, subject: m.subject,
        status: m.status, template: m.template, error: m.error,
        html: m.html, text: m.text, sentAt: m.sentAt,
      })),
    };
  });
}
