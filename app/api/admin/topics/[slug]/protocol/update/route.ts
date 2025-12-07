import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { supabaseAdmin } from "@/lib/supabaseServer"

// TODO: Protect this route with authentication in production
// For now, it's open in dev and non-production environments

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured. Please set up environment variables." },
        { status: 500 }
      )
    }

    const { slug } = await params
    const body = await request.json()
    const { body_markdown } = body

    if (!body_markdown || typeof body_markdown !== 'string') {
      return NextResponse.json(
        { error: "body_markdown is required and must be a string" },
        { status: 400 }
      )
    }

    // Find concept by slug
    const { data: concept, error: conceptError } = await supabaseAdmin
      .from("concepts")
      .select("id")
      .eq("slug", slug)
      .single()

    if (conceptError || !concept) {
      return NextResponse.json(
        { error: `Concept not found: ${conceptError?.message || 'Unknown error'}` },
        { status: 404 }
      )
    }

    // Find the latest protocol for this concept
    const { data: latestProtocol, error: protocolError } = await supabaseAdmin
      .from("topic_protocols")
      .select("id")
      .eq("concept_id", concept.id)
      .order("version", { ascending: false })
      .limit(1)
      .single()

    if (protocolError || !latestProtocol) {
      return NextResponse.json(
        { error: `Protocol not found: ${protocolError?.message || 'Unknown error'}` },
        { status: 404 }
      )
    }

    // Update the protocol's body_markdown (leave outline unchanged)
    const { error: updateError } = await supabaseAdmin
      .from("topic_protocols")
      .update({
        body_markdown,
        updated_at: new Date().toISOString()
      })
      .eq("id", latestProtocol.id)

    if (updateError) {
      return NextResponse.json(
        { error: `Failed to update protocol: ${updateError.message}` },
        { status: 500 }
      )
    }

    // Revalidate the topic page so it updates quickly
    revalidatePath(`/topics/${slug}`)

    return NextResponse.json({
      success: true,
      message: "Protocol updated successfully",
    })
  } catch (error) {
    console.error("Error in POST /api/admin/topics/[slug]/protocol/update:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Unknown error",
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}

