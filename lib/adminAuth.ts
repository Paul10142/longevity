/**
 * Admin session gate — shared, runtime-agnostic helpers.
 *
 * Deliberately dependency-free and free of `next/headers` so this module is safe
 * to import from BOTH edge middleware and Node server components / route handlers.
 * Uses the Web Crypto API (`crypto.subtle`), available in every runtime we target.
 *
 * The gate is a single shared password (`ADMIN_PASSWORD`). On success we mint an
 * HMAC-signed cookie carrying only an expiry timestamp — no secret rides in the
 * cookie, and it can't be forged without `ADMIN_SESSION_SECRET`.
 */

export const ADMIN_COOKIE = "la_admin"
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function sessionSecret(): string | null {
  const s = process.env.ADMIN_SESSION_SECRET
  return s && s.length > 0 ? s : null
}

/** The configured admin password, or null if the gate hasn't been set up yet. */
export function adminPassword(): string | null {
  const p = process.env.ADMIN_PASSWORD
  return p && p.length > 0 ? p : null
}

/** True only when both the password and signing secret are configured. */
export function adminGateConfigured(): boolean {
  return adminPassword() !== null && sessionSecret() !== null
}

/** Length-independent, constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  // Compare a fixed-length digest of each so length itself doesn't leak or short-circuit.
  let diff = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length)
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

function base64url(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function hmac(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data))
  return base64url(new Uint8Array(sig))
}

/**
 * Mint a signed session token valid for SESSION_TTL_MS.
 * Returns null when the signing secret isn't configured (fail closed).
 */
export async function createSessionToken(now: number = Date.now()): Promise<string | null> {
  const secret = sessionSecret()
  if (!secret) return null
  const exp = String(now + SESSION_TTL_MS)
  const sig = await hmac(secret, exp)
  return `${exp}.${sig}`
}

/** Verify a session cookie value: valid signature AND not expired. */
export async function verifySessionToken(
  token: string | undefined | null,
  now: number = Date.now()
): Promise<boolean> {
  const secret = sessionSecret()
  if (!secret || !token) return false
  const dot = token.indexOf(".")
  if (dot < 1) return false
  const exp = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expNum = Number(exp)
  if (!Number.isFinite(expNum) || expNum < now) return false
  const expected = await hmac(secret, exp)
  return safeEqual(sig, expected)
}
