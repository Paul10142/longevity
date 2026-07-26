import { cookies } from "next/headers"
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/adminAuth"

/**
 * Read the admin session cookie in a Server Component / Route Handler and report
 * whether the current viewer is an authenticated admin. Used to gate admin-only
 * UI (Evidence tab, claim counts) on otherwise-public pages.
 *
 * NOTE: this is a UI convenience, not the security boundary — `middleware.ts` is
 * what actually protects /admin and /api/admin routes.
 */
export async function isAdmin(): Promise<boolean> {
  const store = await cookies()
  return verifySessionToken(store.get(ADMIN_COOKIE)?.value)
}
