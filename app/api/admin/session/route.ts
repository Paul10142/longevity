import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { ADMIN_COOKIE, adminGateConfigured, verifySessionToken } from "@/lib/adminAuth"

export const dynamic = "force-dynamic"

// Lightweight probe the header uses to decide whether to show the Admin menu.
export async function GET() {
  const store = await cookies()
  const authed = await verifySessionToken(store.get(ADMIN_COOKIE)?.value)
  return NextResponse.json({ authed, configured: adminGateConfigured() })
}
