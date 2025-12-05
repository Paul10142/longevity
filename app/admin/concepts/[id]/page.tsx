import { notFound } from "next/navigation"
import Link from "next/link"
import { ConceptInsightTagger } from "@/components/ConceptInsightTagger"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default async function AdminConceptPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  
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

  // Fetch concept
  const { data: concept, error: conceptError } = await supabaseAdmin
    .from("concepts")
    .select("*")
    .eq("id", id)
    .single()

  if (conceptError || !concept) {
    notFound()
  }

  // Fetch all insights (from recent sources, limit to 200 for performance)
  const { data: insightsData, error: insightsError } = await supabaseAdmin
    .from("insights")
    .select(
      `
      id,
      statement,
      context_note,
      evidence_type,
      confidence,
      importance,
      insight_type,
      insight_sources (
        source_id,
        sources (
          id,
          title
        )
      )
    `
    )
    .order("created_at", { ascending: false })
    .limit(200)

  if (insightsError) {
    console.error("Error fetching insights:", insightsError)
  }

  // Fetch currently linked insights for this concept
  const { data: linkedInsights, error: linkedError } = await supabaseAdmin
    .from("insight_concepts")
    .select("insight_id")
    .eq("concept_id", id)

  const linkedInsightIds = new Set(linkedInsights?.map((li: any) => li.insight_id) || [])

  const insights = insightsData?.map((insight: any) => ({
    ...insight,
    sourceTitle: insight.insight_sources?.[0]?.sources?.title || "Unknown Source",
    isLinked: linkedInsightIds.has(insight.id),
  })) || []

  return (
    <div className="min-h-screen bg-background">
      <main>
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-6xl mx-auto">
          <div className="mb-8">
            <Link href="/admin/concepts" className="text-sm text-muted-foreground hover:text-primary mb-4 inline-block">
              ← Back to Concepts
            </Link>
            <Card>
              <CardHeader>
                <CardTitle className="text-3xl">{concept.name}</CardTitle>
                <p className="text-muted-foreground mt-2">{concept.description}</p>
              </CardHeader>
            </Card>
          </div>

          <ConceptInsightTagger conceptId={id} insights={insights} />
        </div>
      </div>
      </main>
    </div>
  )
}
