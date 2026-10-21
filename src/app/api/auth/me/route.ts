import { currentUser } from "@/lib/auth/session";
import { handler } from "@/lib/api";
import { capabilities } from "@/lib/env";

export async function GET() {
  return handler(async () => {
    const u = await currentUser();
    return {
      user: u
        ? {
            email: u.email, name: u.name, role: u.role, lang: u.lang,
            priority: u.priority, storeCreditInr: u.storeCreditInr,
            addresses: u.addresses, totalClaims: u.totalClaims,
          }
        : null,
      capabilities: capabilities(),
    };
  });
}
