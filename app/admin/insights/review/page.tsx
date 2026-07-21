import { supabaseAdmin } from '@/lib/supabaseServer'
import { Card, CardContent } from '@/components/ui/card'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Download } from 'lucide-react'
import { InsightReviewClient } from '@/components/InsightReviewClient'

/**
 * Raw-insight review (v2).
 *
 * The layered model makes this query flat: `raw_insights` carries `source_id`,
 * so filtering by source is a column predicate rather than the join gymnastics
 * the v1 version needed. Topic filtering still goes through the claim layer,
 * since topics are attached to canonical claims, not to raw extractions.
 */

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

const PAGE_SIZE = 100

export default async function InsightsReviewPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
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

  const db = supabaseAdmin

  // ── Corpus-wide stats ────────────────────────────────────────
  const [
    { count: rawInsightsCount },
    { count: claimsCount },
    { count: memberCount },
    { count: highActionabilityCount },
  ] = await Promise.all([
    db.from('raw_insights').select('*', { count: 'exact', head: true }),
    db.from('claims').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    db.from('claim_members').select('*', { count: 'exact', head: true }),
    db.from('raw_insights').select('*', { count: 'exact', head: true }).eq('actionability', 'High'),
  ])

  const rawInsights = rawInsightsCount || 0
  const claims = claimsCount || 0
  const consolidated = memberCount || 0

  // ── Filter inputs ────────────────────────────────────────────
  const searchQuery = (params.search || '').trim()
  const selectedSource = params.source
  const selectedTopic = params.topic
  const selectedActionability = params.actionability
  const selectedType = params.type
  const selectedEvidenceType = params.evidenceType
  const selectedConfidence = params.confidence
  const page = Math.max(parseInt(params.page || '1', 10) || 1, 1)
  const offset = (page - 1) * PAGE_SIZE

  const isSet = (v: string | undefined) => !!v && v !== 'all'
  const hasSearchOrFilters = !!(
    searchQuery ||
    isSet(selectedSource) ||
    isSet(selectedTopic) ||
    isSet(selectedActionability) ||
    isSet(selectedType) ||
    isSet(selectedEvidenceType) ||
    isSet(selectedConfidence)
  )

  // Dropdown options.
  const [{ data: sourcesData }, { data: topicsData }] = await Promise.all([
    db.from('sources').select('id, title, type').order('title', { ascending: true }),
    db
      .from('topics')
      .select('id, name, slug')
      .eq('status', 'active')
      .order('name', { ascending: true }),
  ])
  const allSourceRows = (sourcesData || []) as { id: string; title: string; type: string }[]
  const allSources = allSourceRows.map((s) => s.title).filter(Boolean)
  const allTopics = (topicsData || []) as { id: string; name: string; slug: string }[]

  // Per-source totals for the card headers.
  const { data: allInsightSourceIds } = await db
    .from('raw_insights')
    .select('source_id')
    .range(0, 49999)
  const accurateInsightCounts: Record<string, number> = {}
  ;(allInsightSourceIds || []).forEach((r: any) => {
    accurateInsightCounts[r.source_id] = (accurateInsightCounts[r.source_id] || 0) + 1
  })
  const totalSourcesWithInsights = Object.keys(accurateInsightCounts).length

  // ── Filtered page of raw insights ────────────────────────────
  let insightRows: any[] = []
  let matchingCount = 0
  let queryError: { message: string } | null = null

  if (hasSearchOrFilters) {
    // Topic filter resolves through claims → the raw insights that back them.
    let topicRawIds: string[] | null = null
    if (isSet(selectedTopic)) {
      const { data: topic } = await db
        .from('topics')
        .select('id')
        .eq('slug', selectedTopic)
        .maybeSingle()

      if (!topic) {
        topicRawIds = []
      } else {
        const { data: claimLinks } = await db
          .from('claim_topics')
          .select('claim_id')
          .eq('topic_id', topic.id)
        const claimIds = (claimLinks || []).map((l: any) => l.claim_id)

        if (claimIds.length === 0) {
          topicRawIds = []
        } else {
          const { data: members } = await db
            .from('claim_members')
            .select('raw_insight_id')
            .in('claim_id', claimIds)
            .range(0, 49999)
          topicRawIds = (members || []).map((m: any) => m.raw_insight_id)
        }
      }
    }

    let q = db
      .from('raw_insights')
      .select(
        `
        id, source_id, locator, start_ms, statement, context_note, direct_quote,
        evidence_type, confidence, importance, actionability,
        primary_audience, insight_type, qualifiers, created_at,
        sources ( id, title, type )
      `,
        { count: 'exact' }
      )

    if (searchQuery) {
      const pattern = `%${searchQuery.replace(/[%,()]/g, ' ')}%`
      q = q.or(
        `statement.ilike.${pattern},context_note.ilike.${pattern},direct_quote.ilike.${pattern}`
      )
    }
    if (isSet(selectedSource)) {
      const ids = allSourceRows.filter((s) => s.title === selectedSource).map((s) => s.id)
      // No source matched the title → force an empty result rather than ignoring the filter.
      q = ids.length > 0 ? q.in('source_id', ids) : q.eq('source_id', '00000000-0000-0000-0000-000000000000')
    }
    if (topicRawIds !== null) {
      q = topicRawIds.length > 0
        ? q.in('id', topicRawIds.slice(0, 1000))
        : q.eq('id', '00000000-0000-0000-0000-000000000000')
    }
    if (isSet(selectedActionability)) q = q.eq('actionability', selectedActionability)
    if (isSet(selectedType)) q = q.eq('insight_type', selectedType)
    if (isSet(selectedEvidenceType)) q = q.eq('evidence_type', selectedEvidenceType)
    if (isSet(selectedConfidence)) q = q.eq('confidence', selectedConfidence)

    const result = await q
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)

    if (result.error) {
      console.error('Error fetching raw insights:', result.error)
      queryError = result.error
    }
    insightRows = result.data || []
    matchingCount = result.count || 0
  }

  // Topics for the insights on this page, via their claims.
  const topicsByInsightId = new Map<string, Array<{ id: string; name: string; slug: string }>>()
  if (insightRows.length > 0) {
    const { data: members } = await db
      .from('claim_members')
      .select('raw_insight_id, claim_id')
      .in('raw_insight_id', insightRows.map((i) => i.id))

    const claimIds = Array.from(new Set((members || []).map((m: any) => m.claim_id)))
    if (claimIds.length > 0) {
      const { data: links } = await db
        .from('claim_topics')
        .select('claim_id, topics ( id, name, slug )')
        .in('claim_id', claimIds)

      const topicsByClaim = new Map<string, Array<{ id: string; name: string; slug: string }>>()
      ;(links || []).forEach((l: any) => {
        if (!l.topics?.id) return
        const list = topicsByClaim.get(l.claim_id) || []
        list.push({ id: l.topics.id, name: l.topics.name, slug: l.topics.slug })
        topicsByClaim.set(l.claim_id, list)
      })
      ;(members || []).forEach((m: any) => {
        const t = topicsByClaim.get(m.claim_id)
        if (t?.length) topicsByInsightId.set(m.raw_insight_id, t)
      })
    }
  }

  // Group for display.
  const insightsBySource: Record<string, any[]> = {}
  insightRows.forEach((i: any) => {
    const list = insightsBySource[i.source_id] || []
    list.push({
      ...i,
      sourceTitle: i.sources?.title,
      sourceType: i.sources?.type,
      topics: topicsByInsightId.get(i.id) || [],
    })
    insightsBySource[i.source_id] = list
  })

  const shown = insightRows.length

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
                <Link href="/admin/topics">
                  <Button variant="ghost" size="sm">Topics</Button>
                </Link>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {rawInsights.toLocaleString()} raw insights • {claims.toLocaleString()} claims
                {hasSearchOrFilters
                  ? ` • Showing ${shown.toLocaleString()} of ${matchingCount.toLocaleString()} matching`
                  : ' • Use search or filters to view insights'}
              </p>
            </div>
            <div className="flex gap-2">
              <Button asChild variant="outline">
                <a href={`/api/admin/insights/export?format=json&limit=${rawInsights || 10000}`} download>
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
                  <div className="text-2xl font-bold">{claims.toLocaleString()}</div>
                  <div className="text-sm text-muted-foreground">Claims</div>
                  <div className="text-xs text-muted-foreground/70 mt-1">(Deduplicated)</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{consolidated.toLocaleString()}</div>
                  <div className="text-sm text-muted-foreground">Consolidated</div>
                  <div className="text-xs text-muted-foreground/70 mt-1">(Insights in a claim)</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{(highActionabilityCount || 0).toLocaleString()}</div>
                  <div className="text-sm text-muted-foreground">High Actionability</div>
                  <div className="text-xs text-muted-foreground/70 mt-1">(Raw)</div>
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

        {queryError && (
          <Card className="mb-6">
            <CardContent className="py-6 text-center">
              <p className="text-destructive font-medium">Error loading insights</p>
              <p className="text-sm text-muted-foreground mt-1">{queryError.message}</p>
            </CardContent>
          </Card>
        )}

        <InsightReviewClient
          insightsBySource={insightsBySource}
          accurateInsightCounts={accurateInsightCounts}
          searchParams={params as Record<string, string | undefined>}
          totalCount={matchingCount}
          currentPage={page}
          hasSearchOrFilters={hasSearchOrFilters}
          allSources={allSources}
          allTopics={allTopics}
        />

        {!hasSearchOrFilters && (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground mb-2">
                Enter a search query or apply filters to view insights
              </p>
              <p className="text-sm text-muted-foreground/70">
                There are {rawInsights.toLocaleString()} raw insights available to search
              </p>
            </CardContent>
          </Card>
        )}

        {hasSearchOrFilters && shown === 0 && !queryError && (
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
