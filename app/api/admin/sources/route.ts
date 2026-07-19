import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { extractTextFromFile } from "@/lib/fileExtraction"
import { enqueueJob, pingWorker } from "@/lib/jobs"

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

      if (!type || !title || !transcript) {
        return NextResponse.json(
          { error: "Missing required fields: type, title, and transcript are required" },
          { status: 400 }
        )
      }
    }

    const { data: source, error: insertError } = await supabaseAdmin
      .from("sources")
      .insert({
        type,
        title,
        authors: authors || [],
        date: date || null,
        url: url || null,
        transcript_quality: "high",
        transcript,
        processing_status: "pending",
        processing_error: null,
        last_processed_at: null,
      })
      .select("id")
      .single()

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
