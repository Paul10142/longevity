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

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured. Please set up environment variables." },
        { status: 500 }
      )
    }

    const body = await request.json()
    const { type, title, authors, date, url, transcript } = body

    // Validate required fields
    if (!type || !title || !transcript) {
      return NextResponse.json(
        { error: "Missing required fields: type, title, and transcript are required" },
        { status: 400 }
      )
    }

    // Insert source (including transcript) with processing_status = 'pending'
    const { data: source, error: insertError } = await supabaseAdmin
      .from("sources")
      .insert({
        type,
        title,
        authors: authors || [],
        date: date || null,
        url: url || null,
        transcript_quality: "high",
        transcript: transcript, // Save the raw transcript
        processing_status: 'pending', // Explicit initial state
        processing_error: null,
        last_processed_at: null,
      })
      .select("id, processing_status")
      .single()

    if (insertError || !source) {
      console.error("Error inserting source:", insertError)
      console.error("Full error details:", JSON.stringify(insertError, null, 2))
      console.error("Supabase URL:", process.env.NEXT_PUBLIC_SUPABASE_URL)
      return NextResponse.json(
        { 
          error: `Failed to create source: ${insertError?.message}`,
          details: insertError?.details || null,
          hint: insertError?.hint || null,
          code: insertError?.code || null
        },
        { status: 500 }
      )
    }

    // Idempotency check: if source already succeeded, short-circuit
    if (source.processing_status === 'succeeded') {
      return NextResponse.json({
        success: true,
        sourceId: source.id,
        message: "Source already processed successfully",
        alreadyProcessed: true,
      })
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
              .eq("id", source.id)

            sendSSE(controller, {
              status: { type: 'creating', message: 'Source created, starting processing...' }
            })
            
            await processSourceFromPlainText(source.id, transcript, (progress) => {
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
              .eq("id", source.id)

            // TODO: After automating ingestion, call revalidatePath('/topics/[slug]')
            // so topic pages pick up new narratives/evidence without manual deploys.
            
            sendSSE(controller, {
              status: { type: 'success', message: 'Processing complete!' },
              done: true,
              sourceId: source.id
            })
            
            try {
              controller.close()
            } catch (error) {
              // Client already disconnected, that's fine
            }
          } catch (processingError) {
            console.error("Error processing transcript:", processingError)
            const errorMessage = processingError instanceof Error ? processingError.message : "Unknown error"
            
            // Update status to 'failed' on error
            await supabaseAdmin
              .from("sources")
              .update({
                processing_status: 'failed',
                last_processed_at: new Date().toISOString(),
                processing_error: errorMessage.substring(0, 1000), // Truncate if needed
              })
              .eq("id", source.id)
            
            sendSSE(controller, {
              status: {
                type: 'error',
                message: 'Processing failed',
                details: errorMessage
              },
              done: true
            })
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
    
    // Process the transcript (non-streaming, for backwards compatibility)
    try {
      // Update status to 'processing' before starting
      await supabaseAdmin
        .from("sources")
        .update({
          processing_status: 'processing',
          processing_error: null,
        })
        .eq("id", source.id)

      console.log(`Starting processing for source ${source.id}`)
      await processSourceFromPlainText(source.id, transcript)
      console.log(`Finished processing for source ${source.id}`)

      // Update status to 'succeeded' on success
      await supabaseAdmin
        .from("sources")
        .update({
          processing_status: 'succeeded',
          last_processed_at: new Date().toISOString(),
          processing_error: null,
        })
        .eq("id", source.id)

      // TODO: After automating ingestion, call revalidatePath('/topics/[slug]')
      // so topic pages pick up new narratives/evidence without manual deploys.

      return NextResponse.json({
        success: true,
        sourceId: source.id,
        message: "Source created and processed successfully",
      })
    } catch (processingError) {
      console.error("Error processing transcript:", processingError)
      const errorMessage = processingError instanceof Error ? processingError.message : "Unknown error"
      
      // Update status to 'failed' on error
      await supabaseAdmin
        .from("sources")
        .update({
          processing_status: 'failed',
          last_processed_at: new Date().toISOString(),
          processing_error: errorMessage.substring(0, 1000), // Truncate if needed
        })
        .eq("id", source.id)

      return NextResponse.json(
        {
          error: "Source created but processing failed",
          sourceId: source.id,
          details: errorMessage,
        },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error("Error in POST /api/admin/sources:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

