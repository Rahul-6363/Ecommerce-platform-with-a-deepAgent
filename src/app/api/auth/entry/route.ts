/**
 * What the sign-in and registration pages need to know before anyone is
 * authenticated.
 *
 * Unauthenticated by necessity — it is read by the page you use to sign in —
 * so it returns only facts that are safe to publish to anyone:
 *
 *  - whether the catalogue has been seeded, so the page can name the setup
 *    command instead of failing with an empty shop;
 *  - whether data will persist, so nobody registers an account that a restart
 *    will silently delete;
 *  - the demo accounts, **and only outside production**.
 *
 * That last one is the point of this route existing at all. The demo
 * credentials were hardcoded into the page bundle, which means they shipped to
 * every browser in every environment. Deciding visibility on the server is
 * what makes "hidden in production" true rather than a claim.
 */
import { connectDb } from "@/lib/db/connect";
import { Product, User } from "@/models";
import { USERS, DEMO_PASSWORD } from "@/lib/seed-data";
import { persistenceStatus } from "@/lib/seed-guard";
import { handler } from "@/lib/api";
import { env } from "@/lib/env";

/**
 * Demo accounts are shown when this is not a production build **and** the
 * seeded accounts are actually present. Listing credentials for accounts that
 * do not exist would just be a wrong hint.
 */
export async function GET() {
  return handler(async () => {
    await connectDb();

    const products = await Product.countDocuments();
    const persistence = persistenceStatus();

    const show = !env.app.isProd;
    const seededPresent = show
      ? await User.countDocuments({ email: { $in: USERS.map((u) => u.email) } })
      : 0;

    const demoAccountsVisible = show && seededPresent > 0;

    return {
      seeded: products > 0,
      products,
      persistent: persistence.persistent,
      persistenceNote: persistence.message,
      demoAccountsVisible,
      // Empty in production, so the password never reaches the browser there.
      demoPassword: demoAccountsVisible ? DEMO_PASSWORD : "",
      demoAccounts: demoAccountsVisible
        ? USERS.map((u) => ({
            email: u.email,
            name: u.name,
            note:
              u.role === "operator"
                ? "Operator — approves claims, runs the rescue sweep and the demo controls"
                : "Buyer — shop, order and file a complaint",
          }))
        : [],
    };
  });
}
