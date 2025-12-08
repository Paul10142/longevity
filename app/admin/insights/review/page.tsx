import { supabaseAdmin } from '@/lib/supabaseServer'
import { Card, CardContent } from '@/components/ui/card'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Download } from 'lucide-react'
import { InsightReviewClient } from '@/components/InsightReviewClient'

interface SearchParams {
  search?: string
  source?: string
  topic?: string
  actionability?: string
  type?: string
  evidenceType?: string
  confidence?: string
  page?: string
}

export default async function InsightsReviewPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  // Await searchParams in Next.js 15+
  const params = await searchParams
  if (!supabaseAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <main className="container mx-auto py-8">
          <div className="text-center">
            <h1 className="text-2xl font-bold mb-4">Configuration Required</h1>
            <p className="text-muted-foreground">
              Please set up your Supabase environment variables
            </p>
          </div>
        </main>
      </div>
    )
  }

  // Get raw insights count (all insight records - this is the raw layer)
  const { count: rawInsightsCount } = await supabaseAdmin
    .from('insights')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null)

  // Get unique insights count (from unique_insights table)
  const { count: uniqueInsightsCount } = await supabaseAdmin
    .from('unique_insights')
    .select('*', { count: 'exact', head: true })

  // Get total source links count (all insight-source links for non-deleted insights)
  // This counts all source links, so if an insight appears in 3 sources, it counts as 3
  const { count: totalSourceLinksCount } = await supabaseAdmin
    .from('insight_sources')
    .select('insight_id, insights!inner(deleted_at)', { count: 'exact', head: true })
    .is('insights.deleted_at', null)
  
  const rawInsights = rawInsightsCount || 0
  const uniqueInsights = uniqueInsightsCount || 0
  const totalSourceLinks = totalSourceLinksCount || 0


  // Get high actionability count (raw insights)
  const { count: highActionabilityCount } = await supabaseAdmin
    .from('insights')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null)
    .eq('actionability', 'High')

  // Extract search and filter params
  const searchQuery = params.search || ''
  const selectedSource = params.source
  const selectedTopic = params.topic
  const selectedActionability = params.actionability
  const selectedType = params.type
  const selectedEvidenceType = params.evidenceType
  const selectedConfidence = params.confidence
  const page = parseInt(params.page || '1', 10)
  const limit = 100 // Limit results per page
  const offset = (page - 1) * limit

  // Debug logging
  if (process.env.NODE_ENV === 'development') {
    console.log('Search params received:', {
      searchQuery,
      selectedSource,
      selectedTopic,
      selectedActionability,
      selectedType,
      selectedEvidenceType,
      selectedConfidence,
      page
    })
  }

  // Only fetch insights if there's a search query or active filters
  const hasSearchOrFilters = !!(
    searchQuery ||
    (selectedSource && selectedSource !== 'all') ||
    (selectedTopic && selectedTopic !== 'all') ||
    (selectedActionability && selectedActionability !== 'all') ||
    (selectedType && selectedType !== 'all') ||
    (selectedEvidenceType && selectedEvidenceType !== 'all') ||
    (selectedConfidence && selectedConfidence !== 'all')
  )

  let insightsQuery = supabaseAdmin
    .from('insights')
    .select(`
      id,
      statement,
      context_note,
      evidence_type,
      confidence,
      actionability,
      primary_audience,
      insight_type,
      qualifiers,
      created_at,
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
        concept_id,
        concepts (
          id,
          name,
          slug
        )
      )
    `, { count: 'exact' })
    .is('deleted_at', null)

  // Apply text search if provided
  // Search across statement and context_note fields
  if (searchQuery && searchQuery.trim()) {
    const trimmedQuery = searchQuery.trim()
    const searchPattern = `%${trimmedQuery}%`
    
    // Use or() to search across multiple columns
    // Supabase PostgREST syntax: column.operator.value,column2.operator.value2
    // The % signs should be included in the pattern string
    try {
      insightsQuery = insightsQuery.or(
        `statement.ilike.${searchPattern},context_note.ilike.${searchPattern}`
      )
    } catch (searchError) {
      // Fallback: if or() fails, just search statement field
      console.error('Error with or() search, falling back to statement search:', searchError)
      insightsQuery = insightsQuery.ilike('statement', searchPattern)
    }
    
    if (process.env.NODE_ENV === 'development') {
      console.log('Applying search with pattern:', searchPattern)
      console.log('Search query:', trimmedQuery)
    }
  }

  // Apply source filter - use a different query structure to avoid headers overflow
  // When source filter is active, query from insight_sources instead of insights
  let sourceFilteredQuery: any = null
  let useSourceQuery = false
  
  if (selectedSource && selectedSource !== 'all') {
    // First, get the source ID(s) that match the selected source title
    const { data: matchingSources, error: sourcesError } = await supabaseAdmin
      .from('sources')
      .select('id')
      .eq('title', selectedSource)
    
    if (sourcesError) {
      console.error('Error fetching sources for filter:', sourcesError)
    }
    
    const sourceIds = matchingSources?.map((s: { id: string }) => s.id) || []
    
    if (sourceIds.length > 0) {
      // Query from insight_sources to avoid headers overflow
      // This is the same pattern used in the export route
      useSourceQuery = true
      sourceFilteredQuery = supabaseAdmin
        .from('insight_sources')
        .select(`
          source_id,
          locator,
          insights!inner (
            id,
            statement,
            context_note,
            evidence_type,
            confidence,
            actionability,
            primary_audience,
            insight_type,
            qualifiers,
            created_at,
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
              concept_id,
              concepts (
                id,
                name,
                slug
              )
            )
          )
        `, { count: 'exact' })
        .in('source_id', sourceIds)
        .is('insights.deleted_at', null)
    } else {
      // Source title not found - return empty by using impossible filter
      insightsQuery = insightsQuery.eq('id', '00000000-0000-0000-0000-000000000000')
    }
  }

  // Apply topic filter if specified
  let selectedConceptId: string | null = null
  if (selectedTopic && selectedTopic !== 'all') {
    // Get concept ID from slug
    const { data: conceptData } = await supabaseAdmin
      .from('concepts')
      .select('id')
      .eq('slug', selectedTopic)
      .single()
    
    if (conceptData) {
      selectedConceptId = conceptData.id
      // Filter insights by concept through insight_concepts
      // Get insight IDs linked to this concept
      const { data: insightConceptLinks } = await supabaseAdmin
        .from('insight_concepts')
        .select('insight_id')
        .eq('concept_id', selectedConceptId)
      
      const topicInsightIds = insightConceptLinks?.map((link: { insight_id: string }) => link.insight_id) || []
      
      if (topicInsightIds.length > 0) {
        // Apply topic filter to the query
        if (topicInsightIds.length > 1000) {
          // Limit to avoid headers overflow
          insightsQuery = insightsQuery.in('id', topicInsightIds.slice(0, 1000))
        } else {
          insightsQuery = insightsQuery.in('id', topicInsightIds)
        }
      } else {
        // No insights match the topic - return empty
        insightsQuery = insightsQuery.eq('id', '00000000-0000-0000-0000-000000000000')
      }
    }
  }

  // Apply other filters
  if (selectedActionability && selectedActionability !== 'all') {
    insightsQuery = insightsQuery.eq('actionability', selectedActionability)
  }
  if (selectedType && selectedType !== 'all') {
    insightsQuery = insightsQuery.eq('insight_type', selectedType)
  }
  if (selectedEvidenceType && selectedEvidenceType !== 'all') {
    insightsQuery = insightsQuery.eq('evidence_type', selectedEvidenceType)
  }
  if (selectedConfidence && selectedConfidence !== 'all') {
    insightsQuery = insightsQuery.eq('confidence', selectedConfidence)
  }

  // Only fetch if there's a search or filters, otherwise return empty
  let insightsData = null
  let error = null
  let insightsCount = 0

  if (hasSearchOrFilters) {
    try {
      let result
      
      if (useSourceQuery && sourceFilteredQuery) {
        // Apply other filters to the source-based query
        let query = sourceFilteredQuery
        
        // Apply text search if provided
        if (searchQuery && searchQuery.trim()) {
          const trimmedQuery = searchQuery.trim()
          const searchPattern = `%${trimmedQuery}%`
          query = query.or(`insights.statement.ilike.${searchPattern},insights.context_note.ilike.${searchPattern}`)
        }
        
        // Apply topic filter if specified (use already-fetched conceptId)
        if (selectedTopic && selectedTopic !== 'all' && selectedConceptId) {
          // Get insight IDs linked to this concept (reuse the query from above if available)
          // Since we already have selectedConceptId, we can filter directly
          // But we need to get the insight IDs first
          const { data: insightConceptLinks } = await supabaseAdmin
            .from('insight_concepts')
            .select('insight_id')
            .eq('concept_id', selectedConceptId)
          
          const topicInsightIds = insightConceptLinks?.map((link: { insight_id: string }) => link.insight_id) || []
          
          if (topicInsightIds.length > 0) {
            if (topicInsightIds.length > 1000) {
              query = query.in('insights.id', topicInsightIds.slice(0, 1000))
            } else {
              query = query.in('insights.id', topicInsightIds)
            }
          } else {
            // No insights match - return empty
            query = query.eq('insights.id', '00000000-0000-0000-0000-000000000000')
          }
        }
        
        // Apply other filters
        if (selectedActionability && selectedActionability !== 'all') {
          query = query.eq('insights.actionability', selectedActionability)
        }
        if (selectedType && selectedType !== 'all') {
          query = query.eq('insights.insight_type', selectedType)
        }
        if (selectedEvidenceType && selectedEvidenceType !== 'all') {
          query = query.eq('insights.evidence_type', selectedEvidenceType)
        }
        if (selectedConfidence && selectedConfidence !== 'all') {
          query = query.eq('insights.confidence', selectedConfidence)
        }
        
        result = await query
          .order('insights.created_at', { ascending: false })
          .range(offset, offset + limit - 1)
        
        // Transform the data structure to match the expected format
        // When querying from insight_sources, we need to extract the insights and preserve the structure
        const transformedData: any[] = []
        const seenInsightIds = new Set<string>()
        
        result.data?.forEach((item: any) => {
          const insight = item.insights
          if (insight && !seenInsightIds.has(insight.id)) {
            seenInsightIds.add(insight.id)
            // Preserve the insight_sources structure from the nested data
            transformedData.push(insight)
          }
        })
        
        insightsData = transformedData
        error = result.error
        insightsCount = result.count || 0
      } else {
        // Use regular insights query
        result = await insightsQuery
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1)
        
        insightsData = result.data
        error = result.error
        insightsCount = result.count || 0
      }
    } catch (queryError) {
      console.error('Exception during query execution:', queryError)
      error = queryError instanceof Error ? { message: queryError.message, stack: queryError.stack } : queryError
    }

    if (error) {
      console.error('Error fetching insights:', error)
      console.error('Error details:', JSON.stringify(error, null, 2))
      // Log more details for debugging
      console.error('Search query:', searchQuery)
      console.error('Filters:', {
        selectedSource,
        selectedTopic,
        selectedActionability,
        selectedType,
        selectedEvidenceType,
        selectedConfidence
      })
      console.error('Has search or filters:', hasSearchOrFilters)
      console.error('Using source query:', useSourceQuery)
    }
  }

  // Get accurate insight counts per source from insight_sources table
  // This matches how the Source page and Manage Sources page count insights
  // This ensures we count all insights, even if some are soft-deleted
  const { data: allInsightSources } = await supabaseAdmin
    .from('insight_sources')
    .select('source_id, insight_id, insights!inner(deleted_at)')
    .is('insights.deleted_at', null)
  
  // Count distinct insights per source (matching Manage Sources page logic)
  const accurateInsightCounts: Record<string, number> = {}
  // Count distinct sources that have insights
  const distinctSourcesWithInsights = new Set<string>()
  if (allInsightSources) {
    const insightsCountMap = new Map<string, Set<string>>()
    allInsightSources.forEach((item: any) => {
      // Track distinct sources
      distinctSourcesWithInsights.add(item.source_id)
      // Count insights per source
      if (!insightsCountMap.has(item.source_id)) {
        insightsCountMap.set(item.source_id, new Set())
      }
      insightsCountMap.get(item.source_id)!.add(item.insight_id)
    })
    insightsCountMap.forEach((insightSet, sourceId) => {
      accurateInsightCounts[sourceId] = insightSet.size
    })
  }
  
  const totalSourcesWithInsights = distinctSourcesWithInsights.size

  // Fetch all source titles for the filter dropdown
  const { data: sourcesData } = await supabaseAdmin
    .from('sources')
    .select('id, title')
    .order('title', { ascending: true })
  
  const allSources = sourcesData?.map((s: { title: string }) => s.title).filter(Boolean) || []

  // Fetch all topics/concepts for the filter dropdown
  const { data: topicsData } = await supabaseAdmin
    .from('concepts')
    .select('id, name, slug')
    .order('name', { ascending: true })
  
  const allTopics = topicsData || []

  const uniqueInsightsShown = insightsData?.length || 0

  // Group insights by source for easier review
  const insightsBySource: Record<string, any[]> = {}
  if (insightsData) {
    insightsData.forEach((item: any) => {
      const sourceLinks = item.insight_sources || []
      // Get all topics/concepts this insight is connected to
      const conceptLinks = item.insight_concepts || []
      const topics = conceptLinks
        .map((ic: any) => ic.concepts)
        .filter(Boolean)
      
      // Apply topic filter if specified
      if (selectedTopic && selectedTopic !== 'all') {
        const hasTopic = topics.some((t: any) => t?.slug === selectedTopic)
        if (!hasTopic) {
          return // Skip this insight if it doesn't have the selected topic
        }
      }

      sourceLinks.forEach((link: any) => {
        // Apply source filter if specified (filter by source title)
        if (selectedSource && selectedSource !== 'all') {
          if (link.sources?.title !== selectedSource) {
            return // Skip this source link if it doesn't match
          }
        }
        const sourceId = link.source_id
        if (!insightsBySource[sourceId]) {
          insightsBySource[sourceId] = []
        }
        insightsBySource[sourceId].push({
          ...item,
          locator: link.locator,
          sourceTitle: link.sources?.title,
          sourceType: link.sources?.type,
          topics: topics
        })
      })
    })
  }
  
  // Calculate total source links from grouped data (for display in filtered results)
  const totalSourceLinksFromGrouped = Object.values(insightsBySource).reduce((sum, insights) => sum + insights.length, 0)

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold mb-2">Insight Review</h1>
              <p className="text-muted-foreground">
                Review and critique extracted insights to improve extraction accuracy
              </p>
              <div className="flex gap-2 mt-2">
                <Link href="/admin/sources">
                  <Button variant="ghost" size="sm">← Sources</Button>
                </Link>
                <Link href="/admin/concepts">
                  <Button variant="ghost" size="sm">Concepts</Button>
                </Link>
                <Link href="/admin/insights/clusters">
                  <Button variant="ghost" size="sm">Merge Clusters</Button>
                </Link>
                <Link href="/admin/insights/unique">
                  <Button variant="ghost" size="sm">Unique Insights</Button>
                </Link>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {rawInsights.toLocaleString()} raw insights • {uniqueInsights.toLocaleString()} unique insights • {totalSourceLinks.toLocaleString()} source links
                {hasSearchOrFilters && (
                  <span> • Showing {uniqueInsightsShown.toLocaleString()} of {insightsCount || 0} matching insights ({totalSourceLinksFromGrouped.toLocaleString()} source links)</span>
                )}
                {!hasSearchOrFilters && (
                  <span> • Use search or filters to view insights</span>
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <Button asChild variant="outline">
                <a href={`/api/admin/insights/export?format=json&limit=${uniqueInsights || 10000}`} download>
                  <Download className="mr-2 h-4 w-4" />
                  Export JSON
                </a>
              </Button>
              <Button asChild variant="outline">
                <a href={`/api/admin/insights/export?format=csv&limit=${rawInsights || 10000}`} download>
                  <Download className="mr-2 h-4 w-4" />
                  Export CSV
                </a>
              </Button>
            </div>
          </div>

          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-5 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold">{rawInsights.toLocaleString()}</div>
                  <div className="text-sm text-muted-foreground">Raw Insights</div>
                  <div className="text-xs text-muted-foreground/70 mt-1">(All extracted)</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{uniqueInsights.toLocaleString()}</div>
                  <div className="text-sm text-muted-foreground">Unique Insights</div>
                  <div className="text-xs text-muted-foreground/70 mt-1">(Merged)</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{totalSourceLinks.toLocaleString()}</div>
                  <div className="text-sm text-muted-foreground">Source Links</div>
                  <div className="text-xs text-muted-foreground/70 mt-1">(All connections)</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">
                    {(highActionabilityCount || 0).toLocaleString()}
                  </div>
                  <div className="text-sm text-muted-foreground">High Actionability</div>
                  <div className="text-xs text-muted-foreground/70 mt-1">(Unique)</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{totalSourcesWithInsights.toLocaleString()}</div>
                  <div className="text-sm text-muted-foreground">Sources</div>
                  <div className="text-xs text-muted-foreground/70 mt-1">(With insights)</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <InsightReviewClient 
          insightsBySource={insightsBySource} 
          accurateInsightCounts={accurateInsightCounts}
          searchParams={params as Record<string, string | undefined>}
          totalCount={insightsCount || 0}
          currentPage={page}
          hasSearchOrFilters={hasSearchOrFilters}
          allSources={allSources}
        />

        {!hasSearchOrFilters && (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground mb-2">Enter a search query or apply filters to view insights</p>
              <p className="text-sm text-muted-foreground/70">There are {rawInsights.toLocaleString()} raw insights available to search</p>
            </CardContent>
          </Card>
        )}

        {hasSearchOrFilters && uniqueInsightsShown === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">No insights found matching your search criteria</p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  )
}
