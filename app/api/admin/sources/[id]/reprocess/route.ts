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
              status: { type: 'creating', message: 'Starting reprocessing...' }
            })

            // Delete existing data for this source
            // Order matters: delete insight_sources first (foreign key constraint)
            const { error: deleteInsightSourcesError } = await supabaseAdmin
              .from("insight_sources")
              .delete()
              .eq("source_id", id)

            if (deleteInsightSourcesError) {
              console.warn("Warning: Failed to delete some insight_sources:", deleteInsightSourcesError)
            }

            // Delete chunks (this will cascade delete any remaining links)
            const { error: deleteChunksError } = await supabaseAdmin
              .from("chunks")
              .delete()
              .eq("source_id", id)

            if (deleteChunksError) {
              throw new Error(`Failed to delete existing chunks: ${deleteChunksError.message}`)
            }

            sendSSE(controller, {
              status: { type: 'chunking', message: 'Cleared existing data, reprocessing transcript...' }
            })

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

            // TODO: After automating ingestion, call revalidatePath('/topics/[slug]')
            // so topic pages pick up new narratives/evidence without manual deploys.

            sendSSE(controller, {
              status: { type: 'success', message: 'Reprocessing complete!' },
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

      // Delete existing data for this source (order matters for foreign keys)
      const { error: deleteInsightSourcesError } = await supabaseAdmin
        .from("insight_sources")
        .delete()
        .eq("source_id", id)

      if (deleteInsightSourcesError) {
        console.warn("Warning: Failed to delete some insight_sources:", deleteInsightSourcesError)
      }

      const { error: deleteChunksError } = await supabaseAdmin
        .from("chunks")
        .delete()
        .eq("source_id", id)

      if (deleteChunksError) {
        throw new Error(`Failed to delete existing chunks: ${deleteChunksError.message}`)
      }

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
        message: "Source reprocessed successfully",
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
