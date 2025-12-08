import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseServer'
import { getRelatedConcepts } from '@/lib/conceptConnections'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params

    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: 'Supabase not configured' },
        { status: 500 }
      )
    }

    // Get concept by slug
    const { data: concept, error: conceptError } = await supabaseAdmin
      .from('concepts')
      .select('id')
      .eq('slug', slug)
      .single()

    if (conceptError || !concept) {
      return NextResponse.json(
        { error: 'Concept not found' },
        { status: 404 }
      )
    }

    // Get related concepts
    const related = await getRelatedConcepts(concept.id, 10, 0.3)

    return NextResponse.json({
      concept_id: concept.id,
      related_concepts: related,
    })
  } catch (error) {
    console.error('Error fetching related concepts:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
