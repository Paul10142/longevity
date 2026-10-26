import { NextRequest, NextResponse } from "next/server"
import { isAdmin } from "@/lib/isAdmin"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { loadAnswer, saveFeedback } from "@/lib/ask/store"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_NOTE = 1000

/** Thumbs and an optional note: POST { rating: 1 | -1, note? }. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 })

  let body: { rating?: unknown; note?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Send JSON: { rating, note? }" }, { status: 400 })
  }
  if (body.rating !== 1 && body.rating !== -1) {
    return NextResponse.json({ error: "rating must be 1 or -1" }, { status: 400 })
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, MAX_NOTE) : null

  try {
    if (!(await loadAnswer(id))) return NextResponse.json({ error: "Not found" }, { status: 404 })
    await saveFeedback(id, body.rating, note)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 })
  }
}
