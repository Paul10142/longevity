import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { extractTextFromFile } from "@/lib/fileExtraction"
import { enqueueJob, pingWorker } from "@/lib/jobs"
import { normalizeYouTubeSegments, type TimedSegment } from "@/lib/transcriptSegments"

/**
 * Create a source and enqueue extraction.
 *
 * v2: this route does NOT process inline. It stores the source + transcript,
 * enqueues an `extract_source` job, and returns immediately. The background
 * worker (app/api/worker/tick) chunks, extracts, embeds, consolidates, tags,
 * and synthesizes — all resumable via the jobs table.
 */
export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured. Please set up environment variables." },
        { status: 500 }
      )
    }

    const contentType = request.headers.get("content-type") || ""
    let type: string
    let title: string
    let authors: string[]
    let date: string | null
    let url: string | null
    let transcript: string
    // Timed caption segments (YouTube JSON path only); persisted to
    // sources.timed_transcript so extraction can carry the clock through.
    let segments: TimedSegment[] = []

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData()
      type = formData.get("type") as string
      title = formData.get("title") as string
      authors = JSON.parse((formData.get("authors") as string) || "[]")
      date = (formData.get("date") as string) || null
      url = (formData.get("url") as string) || null
      const file = formData.get("file") as File | null
      const pastedTranscript = formData.get("transcript") as string | null

      if (!type || !title) {
        return NextResponse.json(
          { error: "Missing required fields: type and title are required" },
          { status: 400 }
        )
      }

      if (file && file.size > 0) {
        try {
          transcript = await extractTextFromFile(file)
        } catch (error) {
          return NextResponse.json(
            {
              error: "Failed to extract text from file",
              details: error instanceof Error ? error.message : "Unknown error",
            },
            { status: 400 }
          )
        }
      } else if (pastedTranscript) {
        transcript = pastedTranscript
      } else {
        return NextResponse.json(
          { error: "Either a file or transcript text is required" },
          { status: 400 }
        )
      }
    } else {
      const body = await request.json()
      type = body.type
      title = body.title
      authors = body.authors || []
      date = body.date || null
      url = body.url || null
      transcript = body.transcript
      // Accept already-normalised { text, start_ms, end_ms } segments, and also
      // tolerate raw { text, start, duration } if a caller sends those.
      segments = Array.isArray(body.segments)
        ? (body.segments as unknown[]).every(
            (s) => s && typeof s === "object" && "start_ms" in (s as object)
          )
          ? (body.segments as TimedSegment[])
          : normalizeYouTubeSegments(body.segments)
        : []

      if (!type || !title || !transcript) {
        return NextResponse.json(
          { error: "Missing required fields: type, title, and transcript are required" },
          { status: 400 }
        )
      }
    }

    // Default authority tier by source type (overridable later in the source
    // editor). Peer-reviewed for articles, expert for books/podcasts/videos.
    const authorityTier =
      type === "article" ? "peer_reviewed" : type === "book" ? "expert" : "expert"

    const baseRow = {
      type,
      title,
      authors: authors || [],
      date: date || null,
      url: url || null,
      transcript_quality: "high",
      transcript,
      authority_tier: authorityTier,
      processing_status: "pending",
      processing_error: null,
      last_processed_at: null,
    }
    const rowWithTiming =
      segments.length > 0 ? { ...baseRow, timed_transcript: segments } : baseRow

    let { data: source, error: insertError } = await supabaseAdmin
      .from("sources")
      .insert(rowWithTiming)
      .select("id")
      .single()

    // Degrade gracefully if migration 010 (sources.timed_transcript) is not yet
    // applied: retry without the column so source creation never breaks.
    if (insertError && segments.length > 0 && /timed_transcript/.test(insertError.message || "")) {
      console.warn("[sources] timed_transcript column absent; storing source without timing")
      ;({ data: source, error: insertError } = await supabaseAdmin
        .from("sources")
        .insert(baseRow)
        .select("id")
        .single())
    }

    if (insertError || !source) {
      console.error("Error inserting source:", insertError)
      return NextResponse.json(
        {
          error: `Failed to create source: ${insertError?.message}`,
          details: insertError?.details || null,
          code: insertError?.code || null,
        },
        { status: 500 }
      )
    }

    await enqueueJob("extract_source", { source_id: source.id })

    // Nudge the worker so processing starts within seconds, not at the next cron tick.
    pingWorker(request.nextUrl.origin)

    return NextResponse.json({
      success: true,
      sourceId: source.id,
      message: "Source created; extraction queued.",
    })
  } catch (error) {
    console.error("Error in POST /api/admin/sources:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
