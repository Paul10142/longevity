import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { processSourceFromPlainText } from "@/lib/pipeline"
import { extractTextFromFile } from "@/lib/fileExtraction"

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

    const contentType = request.headers.get("content-type") || ""
    let type: string
    let title: string
    let authors: string[]
    let date: string | null
    let url: string | null
    let transcript: string

    // Handle file upload (multipart/form-data)
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData()
      
      type = formData.get("type") as string
      title = formData.get("title") as string
      authors = JSON.parse(formData.get("authors") as string || "[]")
      date = formData.get("date") as string || null
      url = formData.get("url") as string || null
      const file = formData.get("file") as File | null
      const pastedTranscript = formData.get("transcript") as string | null

      // Validate required fields
      if (!type || !title) {
        return NextResponse.json(
          { error: "Missing required fields: type and title are required" },
          { status: 400 }
        )
      }

      // Extract transcript from file or use pasted text
      if (file && file.size > 0) {
        try {
          transcript = await extractTextFromFile(file)
        } catch (error) {
          return NextResponse.json(
            { 
              error: "Failed to extract text from file",
              details: error instanceof Error ? error.message : "Unknown error"
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
      // Handle JSON (existing behavior)
      const body = await request.json()
      type = body.type
      title = body.title
      authors = body.authors || []
      date = body.date || null
      url = body.url || null
      transcript = body.transcript

      // Validate required fields
      if (!type || !title || !transcript) {
        return NextResponse.json(
          { error: "Missing required fields: type, title, and transcript are required" },
          { status: 400 }
        )
      }
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

    // Prevent concurrent processing: if already processing, reject new request
    if (source.processing_status === 'processing') {
      return NextResponse.json({
        error: "Source is already being processed. Please wait for the current processing to complete.",
        sourceId: source.id,
        status: 'processing'
      }, { status: 409 }) // 409 Conflict
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

            // Trigger auto-tagging batch job for newly created insights
            // This runs asynchronously and won't block the response
            // Fire and forget - don't await to avoid blocking the response
            ;(async () => {
              try {
                // Determine the base URL for the API call
                // In serverless environments, use the request URL or environment variable
                const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 
                  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
                  'http://localhost:3000'
                
                // Call autotag-batch endpoint (fire and forget - don't wait for response)
                const response = await fetch(`${baseUrl}/api/admin/insights/autotag-batch`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ limit: 100 }), // Process up to 100 insights
                })
                
                if (!response.ok) {
                  console.warn(`Auto-tagging batch job returned status ${response.status}`)
                } else {
                  const result = await response.json()
                  console.log(`[autotag] Batch job completed: ${result.processed || 0} processed, ${result.tagged || 0} tagged`)
                }
              } catch (error) {
                // Log but don't fail - auto-tagging is non-critical
                console.warn('[autotag] Failed to trigger batch job:', error)
              }
            })()

            // Trigger clustering job for newly processed insights
            // This runs asynchronously and won't block the response
            // Fire and forget - don't await to avoid blocking the response
            ;(async () => {
              try {
                const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 
                  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
                  'http://localhost:3000'
                
                // Call clustering endpoint for this source
                const clusterResponse = await fetch(`${baseUrl}/api/admin/insights/cluster`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sourceId: source.id, limit: 500 }),
                })
                
                if (!clusterResponse.ok) {
                  console.warn(`Clustering job returned status ${clusterResponse.status}`)
                } else {
                  const clusterResult = await clusterResponse.json()
                  console.log(`[clustering] Job completed: ${clusterResult.result?.clustersCreated || 0} clusters created`)
                }
              } catch (error) {
                // Log but don't fail - clustering is non-critical
                console.warn('[clustering] Failed to trigger clustering job:', error)
              }
            })()

            // Trigger concept discovery job for newly processed source
            // This runs asynchronously and won't block the response
            // Fire and forget - don't await to avoid blocking the response
            ;(async () => {
              try {
                const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 
                  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
                  'http://localhost:3000'
                
                // Call concept discovery endpoint (fire and forget - don't wait for response)
                const response = await fetch(`${baseUrl}/api/admin/concepts/discover`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sourceId: source.id }),
                })
                
                if (!response.ok) {
                  console.warn(`Concept discovery job returned status ${response.status}`)
                } else {
                  const result = await response.json()
                  console.log(`[concept-discovery] Job completed: ${result.result?.processed || 0} processed, ${result.result?.created || 0} created`)
                }
              } catch (error) {
                // Log but don't fail - concept discovery is non-critical
                console.warn('[concept-discovery] Failed to trigger discovery job:', error)
              }
            })()

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
            body: JSON.stringify({ sourceId: source.id, limit: 500 }),
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

