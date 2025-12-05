import { notFound } from "next/navigation"
import Link from "next/link"
import { TopicViewTabs } from "@/components/TopicViewTabs"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { retrySupabaseQuery } from "@/lib/retry"

// Helper to capitalize first letter of each word
function capitalizeWords(str: string): string {
  return str.split(' ').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ')
}

// Helper to format evidence type (handles camelCase like "ExpertOpinion" → "Expert Opinion")
function formatEvidenceType(type: string): string {
  if (type === 'RCT') return 'RCT'
  if (type === 'MetaAnalysis') return 'Meta-Analysis'
  
  // Handle camelCase: insert space before capital letters, then capitalize
  const spaced = type.replace(/([a-z])([A-Z])/g, '$1 $2')
  return capitalizeWords(spaced)
}

// Cache this page for 60 seconds, revalidate on demand
export const revalidate = 60

export default async function TopicPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  
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

  // Fetch concept by slug (with retry logic for transient errors)
  const { data: concept, error: conceptError } = await retrySupabaseQuery(
    () => supabaseAdmin
      .from("concepts")
      .select("*")
      .eq("slug", slug)
      .single(),
    { maxRetries: 3 }
  )

  if (conceptError || !concept) {
    // If it's a network error after retries, throw to show error boundary
    if (conceptError?.message?.toLowerCase().includes('network') || 
        conceptError?.message?.toLowerCase().includes('timeout') ||
        conceptError?.message?.toLowerCase().includes('fetch')) {
      throw new Error(`Failed to load topic: ${conceptError.message}`)
    }
    // Otherwise, it's likely a 404 (concept doesn't exist)
    notFound()
  }

  // Fetch topic articles (clinician and patient) - graceful degradation if this fails
  const { data: articles, error: articlesError } = await retrySupabaseQuery(
    () => supabaseAdmin
      .from("topic_articles")
      .select("*")
      .eq("concept_id", concept.id)
      .order("version", { ascending: false }),
    { maxRetries: 2 } // Fewer retries since articles are optional
  )

  if (articlesError) {
    console.warn("Error fetching topic articles (non-fatal):", articlesError)
    // Continue without articles - they're optional
  }

  const clinicianArticle = articles?.find((a: any) => a.audience === 'clinician') || null
  const patientArticle = articles?.find((a: any) => a.audience === 'patient') || null

  // Fetch protocol (latest version) - graceful degradation if this fails
  const { data: protocols, error: protocolsError } = await retrySupabaseQuery(
    () => supabaseAdmin
      .from("topic_protocols")
      .select("*")
      .eq("concept_id", concept.id)
      .order("version", { ascending: false })
      .limit(1),
    { maxRetries: 2 } // Fewer retries since protocols are optional
  )

  if (protocolsError) {
    console.warn("Error fetching topic protocol (non-fatal):", protocolsError)
    // Continue without protocol - it's optional
  }

  let protocol = protocols && protocols.length > 0 ? protocols[0] : null

  // Protocol generation is now handled via admin API route only
  // No LLM helpers should be called from page renders

  // Check if admin tools should be shown
  const showAdminTools = process.env.NODE_ENV === 'development' || process.env.SHOW_ADMIN_TOOLS === 'true'

  // Fetch insights linked to this concept (excluding soft-deleted for public views)
  let insightsData
  let insightsError
  
  try {
    const result = await supabaseAdmin
      .from("insight_concepts")
      .select(
        `
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
          deleted_at,
          insight_sources (
            source_id,
            locator,
            sources (
              id,
              title,
              type
            )
          )
        )
      `
      )
      .eq("concept_id", concept.id)
      .is("insights.deleted_at", null) // Only non-deleted insights for public views
    
    insightsData = result.data
    insightsError = result.error
  } catch (error) {
    // Network or connection errors - throw to trigger error boundary
    console.error("Network error fetching insights:", error)
    throw new Error(`Failed to load insights: ${error instanceof Error ? error.message : 'Network error'}`)
  }

  // For admin view, fetch ALL insights (including deleted) for this concept
  // Optimized: fetch all insights with their concepts in a single query to avoid N+1
  let allInsightsForAdmin: any[] = []
  if (showAdminTools) {
    // Fetch all insights (including deleted) with their sources AND concepts in one query
    // Use retry logic for transient network errors
    const { data: adminInsights, error: adminInsightsError } = await retrySupabaseQuery(
      () => supabaseAdmin
        .from("insight_concepts")
        .select(
          `
          insight_id,
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
            deleted_at,
            insight_sources (
              source_id,
              locator,
              sources (
                id,
                title,
                type
              )
            ),
            insight_concepts (
              concepts (
                id,
                name,
                slug
              )
            )
          )
        `
        )
        .eq("concept_id", concept.id),
      { maxRetries: 3 }
    )

    if (adminInsightsError) {
      console.warn("Error fetching admin insights (non-fatal):", adminInsightsError)
      // Continue with empty admin insights - admin view will just be empty
    }

    if (adminInsights) {
      // Group by insight_id to avoid duplicates
      // Note: When querying from insight_concepts, Supabase returns one row per insight-concept pair,
      // but each row contains the full insight with ALL its concepts via the nested query
      const insightsMap = new Map<string, any>()
      
      adminInsights.forEach((item: any) => {
        const insight = item.insights
        if (!insight?.id) return

        // Only add if we haven't seen this insight yet (deduplicate)
        if (!insightsMap.has(insight.id)) {
          // Collect all concepts for this insight from the nested query
          const concepts = (insight.insight_concepts || [])
            .map((ic: any) => ic.concepts)
            .filter(Boolean)
          
          insightsMap.set(insight.id, {
            insights: {
              ...insight,
              concepts
            }
          })
        }
      })

      allInsightsForAdmin = Array.from(insightsMap.values())
    }
  }

  if (insightsError) {
    console.error("Error fetching insights:", insightsError)
    // Don't throw here - we'll show what we can with partial data
    // The error boundary will catch if this is a fatal error
  }

  // Group insights by source
  const insightsBySource: Record<string, any[]> = {}
  
  insightsData?.forEach((item: any) => {
    const insight = item.insights
    if (!insight?.id) return

    const sourceLinks = insight.insight_sources || []
    sourceLinks.forEach((link: any) => {
      const source = link.sources
      if (!source) return

      const sourceId = source.id
      if (!insightsBySource[sourceId]) {
        insightsBySource[sourceId] = {
          source: source,
          insights: []
        }
      }

      insightsBySource[sourceId].insights.push({
        ...insight,
        locator: link.locator,
      })
    })
  })

  // Sort insights within each source by importance
  Object.keys(insightsBySource).forEach(sourceId => {
    insightsBySource[sourceId].insights.sort((a: any, b: any) => {
      const importanceA = a.importance ?? 2
      const importanceB = b.importance ?? 2
      return importanceB - importanceA
    })
  })

  const sourcesList = Object.values(insightsBySource)

  return (
    <div className="min-h-screen bg-background">
      <main>
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-6xl mx-auto">
          {/* Concept Header */}
          <div className="mb-8">
            <Link href="/topics" className="text-sm text-muted-foreground hover:text-primary mb-4 inline-block">
              ← Back to Topics
            </Link>
            <h1 className="text-4xl font-bold mb-2">{concept.name}</h1>
            <p className="text-lg text-muted-foreground">{concept.description}</p>
            <p className="text-sm text-muted-foreground mt-2">
              {insightsData?.length || 0} insight{insightsData?.length !== 1 ? 's' : ''} across {sourcesList.length} source{sourcesList.length !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Topic View Tabs */}
          {(() => {
            const evidenceViewContent = sourcesList.length > 0 ? (
              <div className="space-y-8">
                {sourcesList.map(({ source, insights }: any) => (
                  <div key={source.id}>
                    <div className="mb-4 flex items-center gap-2">
                      <h2 className="text-2xl font-semibold">{source.title}</h2>
                      <Badge variant="secondary" className="capitalize">{source.type}</Badge>
                      <Link 
                        href={`/sources/${source.id}`}
                        className="text-sm text-muted-foreground hover:text-primary"
                      >
                        View source →
                      </Link>
                    </div>

                    <div className="space-y-4">
                      {insights.map((insight: any) => (
                        <Card key={insight.id} className={insight.importance === 3 ? 'border-2 border-primary/30' : ''}>
                          <CardContent className="pt-6">
                            {/* Header with importance indicator */}
                            <div className="flex items-start justify-between mb-3">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  {/* Importance indicator (1-3 stars) */}
                                  <div className="flex gap-0.5">
                                    {[1, 2, 3].map((level) => (
                                      <span
                                        key={level}
                                        className={`text-sm ${
                                          level <= (insight.importance ?? 2)
                                            ? 'text-primary'
                                            : 'text-muted-foreground/30'
                                        }`}
                                      >
                                        ★
                                      </span>
                                    ))}
                                  </div>
                                  {/* Insight type badge */}
                                  <Badge variant="outline" className="text-xs">
                                    {insight.insight_type || 'Explanation'}
                                  </Badge>
                                  {/* Actionability */}
                                  {insight.actionability && insight.actionability !== 'Background' && (
                                    <Badge 
                                      variant={insight.actionability === 'High' ? 'default' : 'secondary'}
                                      className="text-xs"
                                    >
                                      {insight.actionability} Actionability
                                    </Badge>
                                  )}
                                </div>
                                
                                <p className="text-lg font-medium mb-2">
                                  {insight.statement}
                                </p>
                                
                                {/* Direct quote if present */}
                                {insight.has_direct_quote && insight.direct_quote && (
                                  <blockquote className="border-l-4 border-primary/30 pl-4 my-3 italic text-muted-foreground">
                                    "{insight.direct_quote}"
                                  </blockquote>
                                )}
                                
                                {insight.context_note && (
                                  <p className="text-sm text-muted-foreground mb-3">
                                    {insight.context_note}
                                  </p>
                                )}
                              </div>
                              <div className="ml-4 shrink-0">
                                <Badge variant="outline">
                                  {insight.locator}
                                </Badge>
                              </div>
                            </div>

                            <div className="flex flex-wrap gap-2 items-center">
                              <Badge variant="secondary">
                                {formatEvidenceType(insight.evidence_type)}
                              </Badge>
                              <Badge
                                variant={
                                  insight.confidence === "high"
                                    ? "default"
                                    : insight.confidence === "medium"
                                    ? "secondary"
                                    : "outline"
                                }
                              >
                                {capitalizeWords(insight.confidence)} Confidence
                              </Badge>
                              {/* Primary audience */}
                              {insight.primary_audience && insight.primary_audience !== 'Both' && (
                                <Badge variant="outline" className="text-xs">
                                  For {insight.primary_audience}s
                                </Badge>
                              )}
                              {/* Tone */}
                              {insight.tone && insight.tone !== 'Neutral' && (
                                <span className="text-xs text-muted-foreground">
                                  Tone: {insight.tone}
                                </span>
                              )}
                            </div>

                            {insight.qualifiers &&
                              Object.keys(insight.qualifiers).length > 0 && (
                                <div className="mt-4 pt-4 border-t">
                                  <div className="grid grid-cols-2 gap-2 text-sm">
                                    {Object.entries(insight.qualifiers).map(
                                      ([key, value]: [string, any]) =>
                                        value && (
                                          <div key={key}>
                                            <strong className="capitalize">
                                              {key.replace(/_/g, " ")}:
                                            </strong>{" "}
                                            {String(value)}
                                          </div>
                                        )
                                    )}
                                  </div>
                                </div>
                              )}
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-muted-foreground mb-4">
                    No insights tagged to this topic yet.
                  </p>
                  <Link href={`/admin/concepts`}>
                    <span className="text-primary hover:underline">
                      Tag insights to this topic →
                    </span>
                  </Link>
                </CardContent>
              </Card>
            )

            return (
              <TopicViewTabs
                patientArticle={patientArticle}
                clinicianArticle={clinicianArticle}
                protocol={protocol}
                evidenceView={evidenceViewContent}
                conceptSlug={slug}
                showAdminTools={showAdminTools}
                conceptId={concept.id}
                allInsightsForAdmin={showAdminTools ? insightsData : []}
              />
            )
          })()}
        </div>
      </div>
      </main>
    </div>
  )
}
