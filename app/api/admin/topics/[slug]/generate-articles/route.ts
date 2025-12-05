import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { generateTopicArticlesForConcept } from "@/lib/topicNarrative"

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

    // Find concept by slug
    const { data: concept, error: conceptError } = await supabaseAdmin
      .from("concepts")
      .select("id, name")
      .eq("slug", slug)
      .single()

    if (conceptError || !concept) {
      return NextResponse.json(
        { error: `Concept not found: ${conceptError?.message || 'Unknown error'}` },
        { status: 404 }
      )
    }

    // Generate articles
    await generateTopicArticlesForConcept(concept.id)

    // Revalidate the topic page so it updates quickly
    revalidatePath(`/topics/${slug}`)
    
    // TODO: After automating ingestion, call revalidatePath('/topics/[slug]')
    // so topic pages pick up new narratives/evidence without manual deploys.

    return NextResponse.json({
      success: true,
      message: `Generated clinician and patient articles for "${concept.name}"`,
      conceptId: concept.id,
    })
  } catch (error) {
    console.error("Error in POST /api/admin/topics/[slug]/generate-articles:", error)
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Unknown error",
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
