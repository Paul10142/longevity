import { NextRequest, NextResponse } from "next/server"

/**
 * API route to fetch YouTube video transcript and metadata
 * POST /api/admin/youtube-transcript
 * Body: { videoId: string }
 */
export async function POST(request: NextRequest) {
  try {
    const apiToken = process.env.YOUTUBE_TRANSCRIPT_API_TOKEN

    if (!apiToken) {
      return NextResponse.json(
        { error: "YouTube Transcript API token not configured" },
        { status: 500 }
      )
    }

    const body = await request.json()
    const { videoId } = body

    if (!videoId || typeof videoId !== 'string') {
      return NextResponse.json(
        { error: "Video ID is required" },
        { status: 400 }
      )
    }

    // Call YouTube Transcript API
    const response = await fetch('https://www.youtube-transcript.io/api/transcripts', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ids: [videoId]
      })
    })

    if (!response.ok) {
      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After')
        return NextResponse.json(
          { 
            error: "Rate limit exceeded. Please try again later.",
            retryAfter: retryAfter ? parseInt(retryAfter) : null
          },
          { status: 429 }
        )
      }

      // Handle other errors
      const errorText = await response.text()
      let errorMessage = `Failed to fetch transcript: ${response.status} ${response.statusText}`
      
      try {
        const errorJson = JSON.parse(errorText)
        errorMessage = errorJson.error || errorJson.message || errorMessage
      } catch {
        // If not JSON, use the text as-is
        if (errorText) {
          errorMessage = errorText
        }
      }

      return NextResponse.json(
        { error: errorMessage },
        { status: response.status }
      )
    }

    const data = await response.json()

    // Parse the API response
    // The YouTube Transcript API returns an array of video transcript objects
    // Each video object contains an array of segments with time-segmented data
    // Format: [{ videoId: "...", transcript: [{ text: "...", start: 5, duration: 5, timestamp: "00:05" }, ...] }]
    
    if (!data || !Array.isArray(data) || data.length === 0) {
      return NextResponse.json(
        { error: "No transcript found for this video" },
        { status: 404 }
      )
    }

    const videoData = data[0]

    // Extract transcript segments - the API returns time-segmented data
    // Each segment has: text, start (seconds), duration (seconds), timestamp (MM:SS)
    let transcriptText = ''
    let segments: any[] = []
    
    // Handle different possible response formats
    if (typeof videoData === 'string') {
      // If the entire response is a string (unlikely but handle it)
      transcriptText = videoData
    } else if (Array.isArray(videoData.transcript)) {
      // Most common format: array of segment objects
      segments = videoData.transcript
      transcriptText = segments
        .map((segment: any) => {
          // Extract text from segment object
          if (typeof segment === 'string') {
            return segment
          }
          // Handle segment with 'text' property
          if (segment.text && typeof segment.text === 'string') {
            return segment.text.trim()
          }
          return ''
        })
        .filter((text: string) => text.length > 0)
        .join(' ') // Join segments with spaces for natural flow
    } else if (Array.isArray(videoData.text)) {
      // Alternative format: segments in 'text' array
      segments = videoData.text
      transcriptText = segments
        .map((segment: any) => {
          if (typeof segment === 'string') {
            return segment.trim()
          }
          if (segment.text && typeof segment.text === 'string') {
            return segment.text.trim()
          }
          return ''
        })
        .filter((text: string) => text.length > 0)
        .join(' ')
    } else if (videoData.transcript && typeof videoData.transcript === 'string') {
      // If transcript is already a plain string
      transcriptText = videoData.transcript
    } else if (videoData.text && typeof videoData.text === 'string') {
      // If text is already a plain string
      transcriptText = videoData.text
    } else if (videoData.transcript || videoData.text) {
      // Fallback: try to stringify if it's an object
      console.warn('Unexpected transcript format, attempting to stringify:', typeof videoData.transcript || typeof videoData.text)
      transcriptText = JSON.stringify(videoData.transcript || videoData.text)
    }

    // Validate we have transcript text
    if (!transcriptText || transcriptText.trim().length === 0) {
      return NextResponse.json(
        { error: "Transcript is empty or in an unexpected format" },
        { status: 404 }
      )
    }

    // Log segment information for debugging
    if (segments.length > 0) {
      console.log(`Parsed ${segments.length} time-segmented transcript segments`)
      console.log(`Total transcript length: ${transcriptText.length} characters`)
      if (segments.length > 0 && segments[0].start !== undefined) {
        const firstSegment = segments[0]
        const lastSegment = segments[segments.length - 1]
        console.log(`Time range: ${firstSegment.timestamp || firstSegment.start}s - ${lastSegment.timestamp || (lastSegment.start + lastSegment.duration)}s`)
      }
    }

    // Extract metadata if available
    // The API may include video metadata in the response
    const metadata = {
      title: videoData.title || videoData.videoTitle || null,
      date: videoData.date || videoData.uploadDate || videoData.publishedAt || null,
      channel: videoData.channel || videoData.channelName || videoData.uploader || null,
      // Additional metadata that might be useful
      videoId: videoData.videoId || videoId,
      duration: videoData.duration || null,
    }

    return NextResponse.json({
      success: true,
      transcript: transcriptText,
      metadata,
    })
  } catch (error) {
    console.error("Error fetching YouTube transcript:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Unknown error occurred",
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
