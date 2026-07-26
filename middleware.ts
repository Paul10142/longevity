import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/adminAuth"

/**
 * Gate the admin workbench. Every /admin page and /api/admin route requires a
 * valid admin session cookie; unauthenticated page requests are bounced to the
 * login screen, API requests get a 401. The login/logout/session endpoints are
 * exempt so the gate itself is reachable.
 */

// Paths under the protected prefixes that must stay open (else login can't work).
const OPEN_PATHS = new Set([
  "/admin/login",
  "/api/admin/login",
  "/api/admin/logout",
  "/api/admin/session",
])

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (OPEN_PATHS.has(pathname)) return NextResponse.next()

  const authed = await verifySessionToken(req.cookies.get(ADMIN_COOKIE)?.value)
  if (authed) return NextResponse.next()

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const url = req.nextUrl.clone()
  url.pathname = "/admin/login"
  url.search = ""
  // Preserve where they were headed so login can send them back.
  url.searchParams.set("next", pathname + req.nextUrl.search)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
}
