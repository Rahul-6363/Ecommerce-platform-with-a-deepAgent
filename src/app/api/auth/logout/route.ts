import { destroySession } from "@/lib/auth/session";
import { handler } from "@/lib/api";

export async function POST() {
  return handler(async () => {
    await destroySession();
    return { signedOut: true };
  });
}
