import { TopicsView } from "@/components/TopicsView"
import { supabaseAdmin } from "@/lib/supabaseServer"
import type { Concept } from "@/lib/types"

// Cache topics list for 5 minutes
export const revalidate = 300

interface Relationship {
  source: string
  target: string
  type: 'parent' | 'shared'
}

export default async function TopicsPage() {
  if (!supabaseAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <main>
        <div className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
          <div className="text-center">
            <h1 className="text-2xl font-bold mb-4">Configuration Required</h1>
            <p className="text-muted-foreground">
              Please set up your Supabase environment variables in .env.local
            </p>
          </div>
        </div>
        </main>
      </div>
    )
  }

  // Fetch concepts
  const { data: concepts, error: conceptsError } = await supabaseAdmin
    .from("concepts")
    .select("*")
    .order("name", { ascending: true })

  if (conceptsError) {
    console.error("Error fetching concepts:", conceptsError)
  }

  // Fetch parent-child relationships
  const { data: parentRelations } = await supabaseAdmin
    .from("concept_parents")
    .select("concept_id, parent_id")

  // Fetch insight-concept links to infer relationships
  const { data: insightConcepts } = await supabaseAdmin
    .from("insight_concepts")
    .select("insight_id, concept_id")

  // Build relationship map from shared insights
  const conceptInsightMap = new Map<string, Set<string>>()
  
  if (insightConcepts) {
    insightConcepts.forEach((ic: any) => {
      if (!conceptInsightMap.has(ic.concept_id)) {
        conceptInsightMap.set(ic.concept_id, new Set())
      }
      conceptInsightMap.get(ic.concept_id)!.add(ic.insight_id)
    })
  }

  // Calculate relationships
  const relationships: Relationship[] = []
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

  return (
    <div className="min-h-screen bg-background">
      <main>
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-7xl mx-auto">
          <div className="mb-8">
            <h1 className="text-4xl font-bold mb-4">Topics</h1>
            <p className="text-lg text-muted-foreground">
              Explore topics and their relationships. Click on a topic to see related topics, then click again to navigate to the topic page.
            </p>
          </div>

          <TopicsView 
            initialConcepts={concepts as Concept[] || []}
            initialRelationships={relationships}
          />
        </div>
      </div>
      </main>
    </div>
  )
}
