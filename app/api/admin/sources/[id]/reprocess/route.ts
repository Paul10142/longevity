import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { processSourceFromPlainText } from "@/lib/pipeline"

// Helper to send SSE data (silently fails if client disconnected)
function sendSSE(controller: ReadableStreamDefaultController, data: any) {
  try {
    const message = `data: ${JSON.stringify(data)}\n\n`
    controller.enqueue(new TextEncoder().encode(message))
  } catch (error) {
    // Client disconnected - processing continues but we can't send updates
    // This is fine, the actual work will complete server-side
    console.log('Client disconnected, continuing processing in background')
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured. Please set up environment variables." },
        { status: 500 }
      )
    }

    const { id } = await params

    // Fetch the source and its transcript
    const { data: source, error: sourceError } = await supabaseAdmin
      .from("sources")
      .select("id, transcript")
      .eq("id", id)
      .single()

    if (sourceError || !source) {
      return NextResponse.json(
        { error: `Source not found: ${sourceError?.message}` },
        { status: 404 }
      )
    }

    if (!source.transcript) {
      return NextResponse.json(
        { error: "Source has no transcript to process" },
        { status: 400 }
      )
    }

    // Check if source is currently being processed
    // Check both the source status AND if there are any active processing runs
    const { data: currentSource } = await supabaseAdmin
      .from("sources")
      .select("processing_status, last_processed_at")
      .eq("id", id)
      .single()

    // Also check if there are any runs with status 'processing' for this source
    const { data: activeRuns } = await supabaseAdmin
      .from("source_processing_runs")
      .select("id, processed_at")
      .eq("source_id", id)
      .eq("status", "processing")

    // Check for stuck processing (processing for more than 30 minutes)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    
    if (currentSource?.processing_status === 'processing') {
      // Check if it's been stuck for more than 30 minutes
      if (currentSource.last_processed_at && currentSource.last_processed_at < thirtyMinutesAgo) {
        console.log(`[Reprocess] Detected stuck processing status (last_processed_at: ${currentSource.last_processed_at}), clearing it`)
        await supabaseAdmin
          .from("sources")
          .update({
            processing_status: 'failed',
            processing_error: 'Processing was stuck and has been cleared. You can retry now.'
          })
          .eq("id", id)
      } else {
        return NextResponse.json(
          { error: "Source is already being processed. Please wait for the current processing to complete." },
          { status: 409 } // 409 Conflict
        )
      }
    }

    // Check for stuck processing runs
    if (activeRuns && activeRuns.length > 0) {
      const stuckRuns = activeRuns.filter((run: any) => 
        run.processed_at && run.processed_at < thirtyMinutesAgo
      )
      
      if (stuckRuns.length > 0) {
        console.log(`[Reprocess] Detected ${stuckRuns.length} stuck processing run(s), clearing them`)
        for (const run of stuckRuns) {
          await supabaseAdmin
            .from("source_processing_runs")
            .update({
              status: 'failed',
              error_message: 'Processing was stuck and has been cleared.'
            })
            .eq("id", run.id)
        }
      } else {
        return NextResponse.json(
          { error: "Source is already being processed. Please wait for the current processing to complete." },
          { status: 409 } // 409 Conflict
        )
      }
    }

    // Check if client wants streaming progress updates
    const acceptHeader = request.headers.get("accept") || ""
    const wantsStreaming = acceptHeader.includes("text/event-stream")

    if (wantsStreaming) {
      // Return streaming response with Server-Sent Events
      const stream = new ReadableStream({
        async start(controller) {
          try {
            // Update status to 'processing' before starting
            await supabaseAdmin
              .from("sources")
              .update({
                processing_status: 'processing',
                processing_error: null,
              })
              .eq("id", id)

            sendSSE(controller, {
              status: { type: 'creating', message: 'Starting new processing run (preserving previous runs)...' }
            })

            // Note: We do NOT delete existing data from previous runs.
            // The system is designed to support multiple runs per source.
            // Each new run creates its own chunks and insight_sources linked via run_id.
            // Old runs' data is preserved and can be viewed in the UI via run tabs.

            // Reprocess the transcript
            await processSourceFromPlainText(id, source.transcript, (progress) => {
              sendSSE(controller, {
                status: {
                  type: progress.stage === 'chunking' ? 'chunking' :
                        progress.stage === 'extracting' ? 'extracting' :
                        'success',
                  message: progress.message,
                  progress: progress.chunksProcessed,
                  total: progress.totalChunks,
                  insightsCreated: progress.insightsCreated
                }
              })
            })

            // Update status to 'succeeded' on success
            await supabaseAdmin
              .from("sources")
              .update({
                processing_status: 'succeeded',
                last_processed_at: new Date().toISOString(),
                processing_error: null,
              })
              .eq("id", id)

            // Trigger clustering job for newly processed insights
            // This runs asynchronously and won't block the response
            ;(async () => {
              try {
                const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 
                  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
                  'http://localhost:3000'
                
                const clusterResponse = await fetch(`${baseUrl}/api/admin/insights/cluster`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sourceId: id, limit: 500 }),
                })
                
                if (!clusterResponse.ok) {
                  console.warn(`Clustering job returned status ${clusterResponse.status}`)
                } else {
                  const clusterResult = await clusterResponse.json()
                  console.log(`[clustering] Job completed: ${clusterResult.result?.clustersCreated || 0} clusters created`)
                }
              } catch (error) {
                console.warn('[clustering] Failed to trigger clustering job:', error)
              }
            })()

            // TODO: After automating ingestion, call revalidatePath('/topics/[slug]')
            // so topic pages pick up new narratives/evidence without manual deploys.

            sendSSE(controller, {
              status: { type: 'success', message: 'New processing run complete! Previous runs preserved.' },
              done: true,
              sourceId: id
            })

            try {
              controller.close()
            } catch (error) {
              // Client already disconnected, that's fine
            }
          } catch (processingError) {
            console.error("Error reprocessing transcript:", processingError)
            const errorMessage = processingError instanceof Error ? processingError.message : "Unknown error"
            const errorStack = processingError instanceof Error ? processingError.stack : undefined
            const errorDetails = errorStack ? `${errorMessage}\n\nStack trace:\n${errorStack}` : errorMessage
            
            // Update status to 'failed' on error
            await supabaseAdmin
              .from("sources")
              .update({
                processing_status: 'failed',
                last_processed_at: new Date().toISOString(),
                processing_error: errorMessage.substring(0, 1000), // Truncate if needed
              })
              .eq("id", id)
            
            sendSSE(controller, {
              status: {
                type: 'error',
                message: `Reprocessing failed: ${errorMessage}`,
                details: errorDetails
              },
              done: true
            })
            // Give time for the error message to be sent before closing
            await new Promise(resolve => setTimeout(resolve, 100))
            try {
              controller.close()
            } catch (error) {
              // Client already disconnected, that's fine
            }
          }
        }
      })

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      })
    }

    // Non-streaming fallback
    try {
      // Update status to 'processing' before starting
      await supabaseAdmin
        .from("sources")
        .update({
          processing_status: 'processing',
          processing_error: null,
        })
        .eq("id", id)

      // Note: We do NOT delete existing data from previous runs.
      // The system is designed to support multiple runs per source.
      // Each new run creates its own chunks and insight_sources linked via run_id.
      // Old runs' data is preserved and can be viewed in the UI via run tabs.

      // Reprocess
      await processSourceFromPlainText(id, source.transcript)

      // Update status to 'succeeded' on success
      await supabaseAdmin
        .from("sources")
        .update({
          processing_status: 'succeeded',
          last_processed_at: new Date().toISOString(),
          processing_error: null,
        })
        .eq("id", id)

      // TODO: After automating ingestion, call revalidatePath('/topics/[slug]')
      // so topic pages pick up new narratives/evidence without manual deploys.

      return NextResponse.json({
        success: true,
        sourceId: id,
        message: "New processing run created successfully. Previous runs preserved.",
      })
    } catch (processingError) {
      console.error("Error reprocessing transcript:", processingError)
      const errorMessage = processingError instanceof Error ? processingError.message : "Unknown error"
      
      // Update status to 'failed' on error
      await supabaseAdmin
        .from("sources")
        .update({
          processing_status: 'failed',
          last_processed_at: new Date().toISOString(),
          processing_error: errorMessage.substring(0, 1000), // Truncate if needed
        })
        .eq("id", id)

      return NextResponse.json(
        { error: errorMessage },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error("Error in POST /api/admin/sources/[id]/reprocess:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
