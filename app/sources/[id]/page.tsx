import { notFound } from "next/navigation"
import Link from "next/link"
import { SourceEditorClient } from "@/components/SourceEditorClient"
import { TranscriptEditorClient } from "@/components/TranscriptEditorClient"
import { SourceInsightsClient } from "@/components/SourceInsightsClient"
import { ProcessingRunsCard } from "@/components/ProcessingRunsCard"
import { supabaseAdmin } from "@/lib/supabaseServer"

export default async function SourcePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // Await params in Next.js 15+
  const { id } = await params
  
  // Check if Supabase is configured
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
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

  // Fetch source (including transcript)
  const { data: source, error: sourceError } = await supabaseAdmin
    .from("sources")
    .select("*, transcript")
    .eq("id", id)
    .single()

  if (sourceError || !source) {
    notFound()
  }

  // Fetch chunks to calculate timestamps
  const { data: chunks, error: chunksError } = await supabaseAdmin
    .from("chunks")
    .select("id, locator, content")
    .eq("source_id", id)
    .order("locator", { ascending: true })

  // Fetch processing runs for this source
  const { data: processingRuns, error: processingRunsError } = await supabaseAdmin
    .from("source_processing_runs")
    .select("*")
    .eq("source_id", id)
    .order("processed_at", { ascending: false })

  if (processingRunsError) {
    console.error("Error fetching processing runs:", processingRunsError)
  }

  // Fetch insights linked to this source, including which other sources they're linked to
  // Also fetch topics/concepts each insight is connected to
  const { data: insights, error: insightsError } = await supabaseAdmin
    .from("insight_sources")
    .select(
      `
      locator,
      insights (
        id,
        statement,
        context_note,
        evidence_type,
        qualifiers,
        confidence,
        importance,
        actionability,
        primary_audience,
        insight_type,
        has_direct_quote,
        direct_quote,
        tone,
        insight_sources (
          source_id,
          sources (
            id,
            title
          )
        ),
        insight_concepts (
          concept_id,
          concepts (
            id,
            name,
            slug
          )
        )
      )
    `
    )
    .eq("source_id", id)

  if (insightsError) {
    console.error("Error fetching insights:", insightsError)
  }

  // Calculate estimated timestamps based on chunk positions
  // Assuming average speaking rate of ~150 words per minute
  const calculateTimestamp = (locator: string, chunks: any[]): string => {
    const segmentNum = parseInt(locator.replace('seg-', ''))
    if (!chunks || chunks.length === 0) return ''
    
    // Find position of this segment
    const segmentIndex = chunks.findIndex((c: any) => c.locator === locator)
    if (segmentIndex === -1) return ''
    
    // Calculate cumulative character count up to this segment
    let cumulativeChars = 0
    for (let i = 0; i <= segmentIndex; i++) {
      cumulativeChars += chunks[i]?.content?.length || 0
    }
    
    // Estimate: ~5 characters per word, ~150 words per minute = ~750 chars per minute
    // Use average of all chunks to get total estimated duration
    const totalChars = chunks.reduce((sum, c) => sum + (c.content?.length || 0), 0)
    const estimatedTotalMinutes = totalChars / 750 // ~750 chars per minute
    const segmentPosition = cumulativeChars / totalChars
    const estimatedMinutes = estimatedTotalMinutes * segmentPosition
    
    const minutes = Math.floor(estimatedMinutes)
    const seconds = Math.floor((estimatedMinutes - minutes) * 60)
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }

  const insightsList =
    insights
      ?.map((item: any) => {
        const insight = item.insights
        if (!insight?.id) return null
        
        // Get all sources this insight is linked to
        const linkedSources = insight.insight_sources || []
        const otherSources = linkedSources
          .filter((ls: any) => ls.source_id !== id)
          .map((ls: any) => ls.sources?.title)
          .filter(Boolean)
        
        // Get all topics/concepts this insight is connected to
        const conceptLinks = insight.insight_concepts || []
        const topics = conceptLinks
          .map((ic: any) => ic.concepts)
          .filter(Boolean)
        
        return {
          ...insight,
          locator: item.locator,
          timestamp: calculateTimestamp(item.locator, chunks || []),
          sharedWithSources: otherSources,
          isShared: otherSources.length > 0,
          topics: topics,
          importance: insight.importance ?? 2,
          actionability: insight.actionability ?? 'Medium',
          primary_audience: insight.primary_audience ?? 'Both',
          insight_type: insight.insight_type ?? 'Explanation',
          has_direct_quote: insight.has_direct_quote ?? false,
          direct_quote: insight.direct_quote ?? null,
          tone: insight.tone ?? 'Neutral',
        }
      })
      .filter((i: any) => i !== null)
      // Sort by locator to show insights in the order they appear in the source
      // This makes it easier to see how insights build up and relate to the conversation flow
      .sort((a: any, b: any) => {
        // Extract numeric segment number from "seg-001" format for proper sorting
        const aNum = parseInt(a.locator.replace('seg-', '')) || 0
        const bNum = parseInt(b.locator.replace('seg-', '')) || 0
        return aNum - bNum
      })
      // Assign sequential reference numbers (#1, #2, #3...) based on source order
      .map((insight: any, index: number) => ({
        ...insight,
        referenceNumber: index + 1
      })) || []

  // Organize insights by locator for ProcessingRunsCard
  const insightsByLocator: Record<string, Array<{ id: string; statement: string; importance?: number; insight_type?: string }>> = {}
  insightsList.forEach((insight: any) => {
    if (!insightsByLocator[insight.locator]) {
      insightsByLocator[insight.locator] = []
    }
    insightsByLocator[insight.locator].push({
      id: insight.id,
      statement: insight.statement,
      importance: insight.importance,
      insight_type: insight.insight_type
    })
  })

  return (
    <div className="min-h-screen bg-background">
      <main>
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-4xl mx-auto">
          {/* Back Button */}
          <div className="mb-6">
            <Link 
              href="/admin/sources" 
              className="text-sm text-muted-foreground hover:text-primary inline-flex items-center gap-1"
            >
              ← Back to Manage Sources
            </Link>
          </div>
          
          <SourceEditorClient source={source} />
          
          {/* Transcript Section - Now with editing and collapsible */}
          <TranscriptEditorClient sourceId={source.id} transcript={source.transcript} />
          
          {/* Processing Runs - Show if we have runs or transcript exists */}
          {((processingRuns && processingRuns.length > 0 && chunks) || source.transcript) && (
            <ProcessingRunsCard
              sourceId={source.id}
              processingRuns={processingRuns || []}
              chunks={chunks || []}
              insightsByLocator={insightsByLocator}
              hasTranscript={!!source.transcript}
            />
          )}
          
          <div className="mb-6 text-sm mt-6">
            <Link href="/admin/concepts" className="text-primary hover:underline">
              Tag insights to topics →
            </Link>
          </div>

          <SourceInsightsClient 
            insights={insightsList}
          />
        </div>
      </div>
      </main>
    </div>
  )
}
