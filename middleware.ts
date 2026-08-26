import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/adminAuth"

/**
 * Two gates, with deliberately different behaviour.
 *
 * 1. THE ADMIN WORKBENCH (/admin, /api/admin). Requires a valid admin session;
 *    unauthenticated page requests go to the login screen, API requests get 401.
 *    The login/logout/session endpoints are exempt so the gate is reachable.
 *
 * 2. THE UNRELEASED PRODUCT (the Medical Library, search, and everything that
 *    reads from them). The site is public and patients may land on it, but this
 *    half is not ready to be seen. Hiding it from the navigation is not enough —
 *    the URLs stay reachable, and search engines find them — so it is gated
 *    here too.
 *
 *    These redirect to the HOME PAGE, not to the login screen. A patient who
 *    lands on /topics should quietly get the landing page; showing them a
 *    password prompt is exactly the confusion this is meant to prevent. An admin
 *    who is not signed in also lands home and can sign in from the header.
 *
 * Removing a path from UNRELEASED is how a section is released.
 */

// Paths under the protected prefixes that must stay open (else login can't work).
const OPEN_PATHS = new Set([
  "/admin/login",
  "/api/admin/login",
  "/api/admin/logout",
  "/api/admin/session",
])

/** Route prefixes that are admin-only until the product is ready to show. */
const UNRELEASED = [
  "/topics",
  "/search",
  "/medical-library",
  "/sources",
  "/transcript",
  "/start",
]

function isUnreleased(pathname: string): boolean {
  return UNRELEASED.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (OPEN_PATHS.has(pathname)) return NextResponse.next()

  const authed = await verifySessionToken(req.cookies.get(ADMIN_COOKIE)?.value)
  if (authed) return NextResponse.next()

  // Unreleased product pages: send visitors home, silently. No login prompt —
  // see the header comment.
  if (isUnreleased(pathname)) {
    const home = req.nextUrl.clone()
    home.pathname = "/"
    home.search = ""
    return NextResponse.redirect(home)
  }

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
  matcher: [
    "/admin/:path*",
    "/api/admin/:path*",
    // Unreleased product surfaces. Listed explicitly rather than matched by a
    // catch-all so adding a new public page never accidentally gates it.
    "/topics/:path*",
    "/search/:path*",
    "/medical-library/:path*",
    "/sources/:path*",
    "/transcript/:path*",
    "/start/:path*",
    "/topics",
    "/search",
    "/medical-library",
    "/sources",
    "/transcript",
    "/start",
  ],
}
