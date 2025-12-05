import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { processSourceFromPlainText } from "@/lib/pipeline"

// Helper to send SSE data
function sendSSE(controller: ReadableStreamDefaultController, data: any) {
  const message = `data: ${JSON.stringify(data)}\n\n`
  controller.enqueue(new TextEncoder().encode(message))
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

    // Insert source (including transcript)
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
      })
      .select("id")
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

    // Check if client wants streaming progress updates
    const acceptHeader = request.headers.get("accept") || ""
    const wantsStreaming = acceptHeader.includes("text/event-stream")
    
    if (wantsStreaming) {
      // Return streaming response with Server-Sent Events
      const stream = new ReadableStream({
        async start(controller) {
          try {
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
            
            sendSSE(controller, {
              status: { type: 'success', message: 'Processing complete!' },
              done: true,
              sourceId: source.id
            })
            
            controller.close()
          } catch (processingError) {
            console.error("Error processing transcript:", processingError)
            sendSSE(controller, {
              status: {
                type: 'error',
                message: 'Processing failed',
                details: processingError instanceof Error ? processingError.message : "Unknown error"
              },
              done: true
            })
            controller.close()
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
      console.log(`Starting processing for source ${source.id}`)
      await processSourceFromPlainText(source.id, transcript)
      console.log(`Finished processing for source ${source.id}`)
    } catch (processingError) {
      console.error("Error processing transcript:", processingError)
      // Note: Source is already created, but processing failed
      // In production, you might want to mark it as "processing_failed"
      return NextResponse.json(
        {
          error: "Source created but processing failed",
          sourceId: source.id,
          details: processingError instanceof Error ? processingError.message : "Unknown error",
        },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      sourceId: source.id,
      message: "Source created and processed successfully",
    })
  } catch (error) {
    console.error("Error in POST /api/admin/sources:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

