import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { loadSpeakerContext } from "@/lib/speakerReviewData"
import { buildAssignments } from "@/lib/speakerReview"

export const dynamic = "force-dynamic"

/**
 * Save Paul's answers for one episode: `{ assignments: { "Speaker 2": "Rhonda Patrick", "Speaker 3": null } }`
 * (a name from the episode's own authors, or null for "not a guest").
 *
 * THE ONLY THING THIS WRITES is `sources.speaker_names` (migration 039). The transcript is never edited
 * here: the runner's re-attach (scripts/attachTranscripts.ts) reads the saved answers and rebuilds the
 * labels from the Deepgram file. Everything is checked on the server against the stored transcript: the
 * labels must be unnamed voices that exist, the names must be on the episode's own list, and each
 * answer's fingerprint is computed here, never taken from the browser.
 *
 * `{ assignments: {} }` clears the review.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })
  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "the request body must be JSON" }, { status: 400 })
  }
  const input = (body as { assignments?: unknown } | null)?.assignments
  if (input === undefined) return NextResponse.json({ error: "assignments is required" }, { status: 400 })

  const ctx = await loadSpeakerContext(id)
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.error === "no such source" ? 404 : 500 })
  if (ctx.columnMissing) {
    return NextResponse.json({ error: "Migration 039 (sources.speaker_names) is not applied yet, so nothing can be saved." }, { status: 409 })
  }

  const built = buildAssignments({ input, speakers: ctx.speakers, allowed: ctx.allowed, existing: ctx.saved })
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 })

  const value = Object.keys(built.names).length > 0 ? built.names : null
  const { error } = await supabaseAdmin.from("sources").update({ speaker_names: value }).eq("id", id)
  if (error) return NextResponse.json({ error: `could not save: ${error.message}` }, { status: 500 })
  return NextResponse.json({ saved: value ?? {} })
}
