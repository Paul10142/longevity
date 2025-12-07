import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabaseServer"

// Cache for 5 minutes
export const revalidate = 300

export async function GET() {
  try {
    if (!supabaseAdmin) {
      return NextResponse.json(
        { error: "Supabase not configured" },
        { status: 500 }
      )
    }

    // Fetch all concepts
    const { data: concepts, error: conceptsError } = await supabaseAdmin
      .from("concepts")
      .select("*")
      .order("name", { ascending: true })

    if (conceptsError) {
      console.error("Error fetching concepts:", conceptsError)
      return NextResponse.json(
        { error: conceptsError.message },
        { status: 500 }
      )
    }

    // Fetch parent-child relationships
    const { data: parentRelations, error: parentError } = await supabaseAdmin
      .from("concept_parents")
      .select("concept_id, parent_id")

    if (parentError) {
      console.warn("Error fetching concept_parents (may be empty):", parentError)
    }

    // Fetch insight-concept links to infer relationships from shared insights
    const { data: insightConcepts, error: insightError } = await supabaseAdmin
      .from("insight_concepts")
      .select("insight_id, concept_id")

    if (insightError) {
      console.warn("Error fetching insight_concepts:", insightError)
    }

    // Build relationship map from shared insights
    // Two concepts are related if they share insights
    const conceptInsightMap = new Map<string, Set<string>>()
    
    if (insightConcepts) {
      insightConcepts.forEach((ic: any) => {
        if (!conceptInsightMap.has(ic.concept_id)) {
          conceptInsightMap.set(ic.concept_id, new Set())
        }
        conceptInsightMap.get(ic.concept_id)!.add(ic.insight_id)
      })
    }

    // Calculate relationships: concepts that share at least 2 insights are related
    const relationships: Array<{ source: string; target: string; type: 'parent' | 'shared' }> = []
    const conceptIds = concepts?.map((c: { id: string }) => c.id) || []

    // Add parent-child relationships
    if (parentRelations) {
      parentRelations.forEach((rel: any) => {
        relationships.push({
          source: rel.parent_id,
          target: rel.concept_id,
          type: 'parent'
        })
      })
    }

    // Add relationships from shared insights
    for (let i = 0; i < conceptIds.length; i++) {
      for (let j = i + 1; j < conceptIds.length; j++) {
        const concept1 = conceptIds[i]
        const concept2 = conceptIds[j]
        const insights1 = conceptInsightMap.get(concept1) || new Set()
        const insights2 = conceptInsightMap.get(concept2) || new Set()
        
        // Count shared insights
        let sharedCount = 0
        insights1.forEach(insightId => {
          if (insights2.has(insightId)) {
            sharedCount++
          }
        })

        // If they share at least 2 insights, they're related
        if (sharedCount >= 2) {
          relationships.push({
            source: concept1,
            target: concept2,
            type: 'shared'
          })
        }
      }
    }

    return NextResponse.json({
      concepts: concepts || [],
      relationships
    })
  } catch (error) {
    console.error("Error in GET /api/topics/relationships:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

