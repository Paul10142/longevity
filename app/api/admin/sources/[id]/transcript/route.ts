import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { isAdmin } from "@/lib/isAdmin"
import {
  buildTranscriptPayload,
  TRANSCRIPT_SOURCE_COLUMNS,
  type TranscriptSourceRow,
} from "@/lib/transcriptPayload"

export const dynamic = "force-dynamic"

/**
 * The readable transcript for one source, parsed into speaker turns (or
 * minute-long caption paragraphs) on the server. Feeds the "Transcript"
 * pop-up; the full page at /admin/sources/[id]/transcript does the same work
 * without the round trip.
 *
 * Returns the public episode links and video URL — never `sources.url`, which
 * for feed rows is the private, members-only Supercast link.
 *
 * middleware.ts already requires an admin session for /api/admin/*; the
 * isAdmin() check is belt and braces, as on /api/claims/[id]/members.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 })

  const { id } = await params
  const { data, error } = await supabaseAdmin
    .from("sources")
    .select(TRANSCRIPT_SOURCE_COLUMNS)
    .eq("id", id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: "Source not found" }, { status: 404 })

  return NextResponse.json(buildTranscriptPayload(data as unknown as TranscriptSourceRow))
}
