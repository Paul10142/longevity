import { NextRequest, NextResponse } from "next/server"
import { extractYouTubeVideoId } from "@/lib/youtubeUtils"

/**
 * Fetch YouTube transcript and metadata from YouTube Transcript API
 * 
 * POST /api/admin/sources/fetch-youtube-transcript
 * Body: { url: string }
 * 
 * Returns: { transcript: string, title?: string, date?: string, url: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { url } = body

    if (!url || typeof url !== 'string') {
      return NextResponse.json(
        { error: "YouTube URL is required" },
        { status: 400 }
      )
    }

    // Extract video ID from URL
    const videoId = extractYouTubeVideoId(url)
    if (!videoId) {
      return NextResponse.json(
        { error: "Invalid YouTube URL. Please provide a valid YouTube video link." },
        { status: 400 }
      )
    }

    // Get API token from environment
    const apiToken = process.env.YOUTUBE_TRANSCRIPT_API_TOKEN
    if (!apiToken) {
      return NextResponse.json(
        { error: "YouTube Transcript API token not configured. Please set YOUTUBE_TRANSCRIPT_API_TOKEN environment variable." },
        { status: 500 }
      )
    }

    // Call YouTube Transcript API
    const apiUrl = "https://www.youtube-transcript.io/api/transcripts"
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ids: [videoId]
      }),
    })

    // Handle rate limiting
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After")
      const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : 10
      return NextResponse.json(
        { 
          error: `Rate limit exceeded. Please wait ${retrySeconds} seconds before trying again.`,
          retryAfter: retrySeconds
        },
        { status: 429 }
      )
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`YouTube Transcript API error (${response.status}):`, errorText)
      
      if (response.status === 404) {
        return NextResponse.json(
          { error: "Transcript not available for this video. The video may not have captions enabled." },
          { status: 404 }
        )
      }

      return NextResponse.json(
        { 
          error: `Failed to fetch transcript: ${response.statusText}`,
          details: errorText.substring(0, 200)
        },
        { status: response.status }
      )
    }

    const data = await response.json()

    // Parse the API response
    // The API returns an array of transcript objects
    // Each object has: id, transcript (array of { text, start, duration })
    if (!data || !Array.isArray(data) || data.length === 0) {
      return NextResponse.json(
        { error: "No transcript data returned from API" },
        { status: 500 }
      )
    }

    const videoData = data[0]
    if (!videoData || !videoData.transcript || !Array.isArray(videoData.transcript)) {
      return NextResponse.json(
        { error: "Invalid transcript data format" },
        { status: 500 }
      )
    }

    // Combine transcript segments into full text
    const transcriptText = videoData.transcript
      .map((segment: { text: string }) => segment.text)
      .join(" ")
      .trim()

    if (!transcriptText) {
      return NextResponse.json(
        { error: "Transcript is empty" },
        { status: 500 }
      )
    }

    // Extract metadata if available
    // The API may return additional fields like title, date, etc.
    const result: {
      transcript: string
      title?: string
      date?: string
      url: string
      videoId: string
    } = {
      transcript: transcriptText,
      url: url,
      videoId: videoId,
    }

    // If the API returns title, use it
    if (videoData.title) {
      result.title = videoData.title
    }

    // If the API returns date/publishedAt, use it
    if (videoData.publishedAt || videoData.date) {
      const dateStr = videoData.publishedAt || videoData.date
      // Try to parse and format as YYYY-MM-DD
      try {
        const date = new Date(dateStr)
        if (!isNaN(date.getTime())) {
          result.date = date.toISOString().split('T')[0] // Format as YYYY-MM-DD
        }
      } catch (e) {
        // If date parsing fails, try to use as-is if it's already in YYYY-MM-DD format
        if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          result.date = dateStr
        }
      }
    }

    // If the API returns channel/author info, we could extract it here
    // For now, we'll let the user fill in authors manually

    return NextResponse.json({
      success: true,
      ...result,
    })
  } catch (error) {
    console.error("Error in POST /api/admin/sources/fetch-youtube-transcript:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Unknown error occurred",
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
