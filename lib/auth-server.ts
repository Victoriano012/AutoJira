import { auth } from "@/auth";
import { getOrCreateUser } from "./users";

/** DB user id of the signed-in user, or null. AUTH_DEV_USER bypasses Google
 * locally (same convention as the sibling apps). */
export async function requireUserId(): Promise<number | null> {
  if (process.env.AUTH_DEV_USER) {
    return getOrCreateUser(process.env.AUTH_DEV_USER, "Dev user");
  }
  const session = await auth();
  return session?.uid ?? null;
}
