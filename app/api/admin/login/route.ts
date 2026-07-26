import { NextResponse } from "next/server"
import {
  ADMIN_COOKIE,
  SESSION_TTL_MS,
  adminGateConfigured,
  adminPassword,
  createSessionToken,
  safeEqual,
} from "@/lib/adminAuth"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  if (!adminGateConfigured()) {
    return NextResponse.json(
      { error: "Admin access is not configured on the server." },
      { status: 503 }
    )
  }

  let password = ""
  try {
    const body = await req.json()
    password = typeof body?.password === "string" ? body.password : ""
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }

  if (!safeEqual(password, adminPassword()!)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 })
  }

  const token = await createSessionToken()
  if (!token) {
    return NextResponse.json(
      { error: "Admin access is not configured on the server." },
      { status: 503 }
    )
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
  return res
}
