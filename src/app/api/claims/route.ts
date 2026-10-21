import { requireUser } from "@/lib/auth/session";
import { connectDb } from "@/lib/db/connect";
import { Claim, Order } from "@/models";
import type { LeanClaim, LeanOrder } from "@/models";
import { openClaim, type EvidenceUpload } from "@/lib/agent/claims";
import { handler, fail } from "@/lib/api";
import { createHash } from "node:crypto";

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 4;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

/** A buyer's own claims, newest first. */
export async function GET() {
  return handler(async () => {
    const user = await requireUser();
    await connectDb();

    const claims = await Claim.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean<LeanClaim[]>();

    const orders = await Order.find({ _id: { $in: claims.map((c) => c.orderId) } })
      .select("orderNo items")
      .lean<LeanOrder[]>();
    const byId = new Map(orders.map((o) => [String(o._id), o]));

    return {
      claims: claims.map((c) => {
        const o = byId.get(String(c.orderId));
        return {
          claimNo: c.claimNo,
          orderNo: o?.orderNo ?? "",
          productTitle: o?.items?.[0]?.title ?? "",
          state: c.state,
          issueType: c.issueType,
          rawComplaint: c.rawComplaint,
          translatedComplaint: c.translatedComplaint,
          lang: c.lang,
          inputMode: c.inputMode,
          verdict: c.verdict,
          authenticity: c.authenticity,
          draftMessage: c.draftMessage,
          approval: c.approval,
          evidenceCount: (c.evidence ?? []).length,
          evidence: (c.evidence ?? []).map((e) => ({
            kind: e.kind, filename: e.filename, bytes: e.bytes,
            dataUrl: e.dataUrl, visionFindings: e.visionFindings,
          })),
          createdAt: c.createdAt,
          resolvedAt: c.resolvedAt,
        };
      }),
    };
  });
}

/**
 * Raise a complaint.
 *
 * Multipart, because the proof is the point: the buyer attaches photographs of
 * the defect and optionally a voice note in their own language. Everything from
 * transcription to the approval request happens in `openClaim`.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();

    const ct = req.headers.get("content-type") ?? "";
    if (!ct.includes("multipart/form-data")) {
      return fail("Send this as multipart/form-data so photographs can be attached.", 415);
    }

    const form = await req.formData();
    const orderNo = String(form.get("orderNo") ?? "").trim();
    const complaint = String(form.get("complaint") ?? "").trim();
    const lang = String(form.get("lang") ?? "").trim() || undefined;

    if (!orderNo) return fail("Which order is this about?", 422);

    /* ── Photographs ─────────────────────────────────────────────── */

    const evidence: EvidenceUpload[] = [];
    const files = form.getAll("evidence").filter((f): f is File => f instanceof File);

    if (files.length > MAX_FILES) {
      return fail(`Attach at most ${MAX_FILES} files.`, 413);
    }

    for (const f of files) {
      if (f.size === 0) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        return fail(`${f.name} is ${(f.size / 1e6).toFixed(1)}MB; the limit is 6MB per photo.`, 413);
      }
      if (!IMAGE_TYPES.includes(f.type)) {
        return fail(`${f.name} is ${f.type || "an unknown type"}. Attach a JPEG, PNG or WebP photo.`, 415);
      }
      const buf = Buffer.from(await f.arrayBuffer());
      evidence.push({
        kind: "image",
        filename: f.name || `photo-${evidence.length + 1}.jpg`,
        mimeType: f.type,
        bytes: buf.length,
        // Stored inline as a data URL so the platform needs no object store.
        // The one field to change if you move to S3 or GridFS.
        dataUrl: `data:${f.type};base64,${buf.toString("base64")}`,
        caption: "",
      });
      // A hash of the bytes, so the same photograph submitted on two claims is
      // detectable later without keeping the image around to compare.
      const sha = createHash("sha256").update(buf).digest("hex");
      evidence[evidence.length - 1].caption = `sha256:${sha.slice(0, 16)}`;
    }

    /* ── Voice note ──────────────────────────────────────────────── */

    const audioFile = form.get("audio");
    let audio: { buffer: Buffer; filename: string } | null = null;
    if (audioFile instanceof File && audioFile.size > 0) {
      if (audioFile.size > MAX_AUDIO_BYTES) {
        return fail(`That recording is ${(audioFile.size / 1e6).toFixed(1)}MB; the limit is 10MB.`, 413);
      }
      audio = {
        buffer: Buffer.from(await audioFile.arrayBuffer()),
        filename: audioFile.name || "complaint.webm",
      };
    }

    if (!complaint && !audio) {
      return fail("Tell us what went wrong — type it, or record a voice note.", 422);
    }

    const outcome = await openClaim({
      userId: String(user._id),
      orderNo,
      complaint,
      lang,
      inputMode: audio && !complaint ? "voice" : "text",
      audio,
      evidence,
    });

    return outcome;
  });
}
