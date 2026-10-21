/**
 * The buyer's delivery addresses.
 *
 * GET lists them with the facts each one implies — the tier, and the advice
 * worth acting on — because an address list that shows only the text hides the
 * reason one of them keeps failing.
 *
 * POST adds, PUT replaces one, PATCH promotes one to default, DELETE removes.
 * The default is simply index 0: `placeOrder` already reads
 * `addresses[addressIndex ?? 0]`, so promoting is a reorder rather than a flag
 * nothing else reads.
 *
 * Every write goes through `newAddress`, which derives the city, state and
 * tier from the pincode rather than trusting the client. A browser that could
 * post `pinTier: 1` could buy itself a three-day delivery promise to a village.
 */
import { z } from "zod";
import { connectDb } from "@/lib/db/connect";
import { User } from "@/models";
import { requireUser } from "@/lib/auth/session";
import { handler, fail } from "@/lib/api";
import { newAddress, addressAdvice, formatAddress, AddressError } from "@/lib/addresses";
import { pinFacts } from "@/lib/engines/pincode";
import { emit } from "@/lib/events";

const AddressBody = z.object({
  label: z.string().max(20).default("Home"),
  line: z.string().min(1, "Give a street address."),
  landmark: z.string().max(80).default(""),
  city: z.string().max(60).default(""),
  state: z.string().max(60).default(""),
  pincode: z.string().min(1, "Give a pincode."),
  phone: z.string().max(20).default(""),
});

/** How many a buyer may keep. Enough for home, work and a parent's house. */
const MAX_ADDRESSES = 6;

export async function GET() {
  return handler(async () => {
    const user = await requireUser();
    await connectDb();
    const doc = await User.findById(user._id).select("addresses").lean<{
      addresses?: Parameters<typeof formatAddress>[0][];
    }>();

    const addresses = (doc?.addresses ?? []).map((a, index) => ({
      index,
      ...a,
      isDefault: index === 0,
      oneLine: formatAddress(a),
      facts: pinFacts(a.pincode ?? ""),
      // Recomputed on read rather than stored: the advice depends on the risk
      // rules, and those change more often than the address does.
      advice: addressAdvice(a),
    }));

    return { addresses, max: MAX_ADDRESSES };
  });
}

export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = AddressBody.parse(await req.json().catch(() => ({})));

    let address;
    try {
      address = newAddress(body);
    } catch (e) {
      // The two blocking cases carry per-field advice, so the form can point
      // at what to fix instead of saying "invalid".
      if (e instanceof AddressError) return fail(e.message, 422, { advice: e.advice });
      throw e;
    }

    await connectDb();
    const doc = await User.findById(user._id).select("addresses");
    if (!doc) return fail("Sign in to continue.", 401);

    if ((doc.addresses?.length ?? 0) >= MAX_ADDRESSES) {
      return fail(`You can keep ${MAX_ADDRESSES} addresses. Remove one first.`, 409);
    }

    doc.addresses.push(address);
    await doc.save();

    await emit({
      type: "address.added",
      actor: "Buyer",
      userId: String(user._id),
      summary: `Added a ${address.label.toLowerCase()} address in ${address.city || address.pincode}`,
      payload: { pincode: address.pincode, pinTier: address.pinTier, label: address.label },
    });

    return {
      index: doc.addresses.length - 1,
      address,
      oneLine: formatAddress(address),
      advice: addressAdvice(address),
    };
  });
}

const EditBody = AddressBody.extend({ index: z.number().int().min(0) });

export async function PUT(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = EditBody.parse(await req.json().catch(() => ({})));

    let address;
    try {
      address = newAddress(body);
    } catch (e) {
      if (e instanceof AddressError) return fail(e.message, 422, { advice: e.advice });
      throw e;
    }

    await connectDb();
    const doc = await User.findById(user._id).select("addresses");
    if (!doc) return fail("Sign in to continue.", 401);
    if (!doc.addresses?.[body.index]) return fail("No such address.", 404);

    doc.addresses[body.index] = address;
    await doc.save();

    return { index: body.index, address, oneLine: formatAddress(address), advice: addressAdvice(address) };
  });
}

const PickBody = z.object({ index: z.number().int().min(0) });

/** Promote an address to the default by moving it to the front. */
export async function PATCH(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { index } = PickBody.parse(await req.json().catch(() => ({})));

    await connectDb();
    const doc = await User.findById(user._id).select("addresses");
    if (!doc) return fail("Sign in to continue.", 401);
    if (!doc.addresses?.[index]) return fail("No such address.", 404);

    const [picked] = doc.addresses.splice(index, 1);
    doc.addresses.unshift(picked);
    await doc.save();

    return { addresses: doc.addresses.length, defaultIs: formatAddress(picked) };
  });
}

export async function DELETE(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { index } = PickBody.parse(await req.json().catch(() => ({})));

    await connectDb();
    const doc = await User.findById(user._id).select("addresses");
    if (!doc) return fail("Sign in to continue.", 401);
    if (!doc.addresses?.[index]) return fail("No such address.", 404);

    // Never the last one. An account with no address cannot order, and
    // discovering that at checkout is worse than being told now.
    if (doc.addresses.length === 1) {
      return fail("That is your only address. Add another before removing this one.", 409);
    }

    doc.addresses.splice(index, 1);
    await doc.save();

    return { addresses: doc.addresses.length };
  });
}
