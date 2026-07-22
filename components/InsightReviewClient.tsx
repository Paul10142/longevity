'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { InsightReviewFilters } from './InsightReviewFilters'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface Insight {
  id: string
  statement: string
  context_note?: string | null
  evidence_type: string
  confidence?: 'high' | 'medium' | 'low'
  actionability?: string
  primary_audience?: 'Patient' | 'Clinician' | 'Both'
  insight_type?: string
  qualifiers?: Record<string, any>
  locator: string
  sourceTitle?: string
  sourceType?: string
  topics?: Array<{ id: string; name: string; slug: string }>
}

interface InsightReviewClientProps {
  insightsBySource: Record<string, Insight[]>
  accurateInsightCounts?: Record<string, number>
  searchParams: Record<string, string | undefined>
  totalCount: number
  currentPage: number
  hasSearchOrFilters: boolean
  allSources: string[]
  allTopics?: Array<{ id: string; name: string; slug: string }>
}

export function InsightReviewClient({ 
  insightsBySource, 
  accurateInsightCounts,
  totalCount,
  currentPage,
  hasSearchOrFilters,
  allSources,
  allTopics = []
}: InsightReviewClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const limit = 100
  const totalPages = Math.ceil(totalCount / limit)

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('page', newPage.toString())
    router.push(`?${params.toString()}`)
  }

  return (
    <>
      <InsightReviewFilters allSources={allSources} allTopics={allTopics} />

      {hasSearchOrFilters && (
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing page {currentPage} of {totalPages} ({totalCount.toLocaleString()} total results)
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage <= 1}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage >= totalPages}
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-8">
        {Object.keys(insightsBySource).length > 0 ? (
          Object.entries(insightsBySource).map(([sourceId, insights]) => {
            const firstInsight = insights[0]
            // Use accurate count from server if available (matches Source/Manage Sources pages)
            // Otherwise fall back to counting distinct insights in results
            const count = accurateInsightCounts?.[sourceId] ?? (() => {
              const distinctInsightIds = new Set(insights.map(i => i.id))
              return distinctInsightIds.size
            })()
            return (
              <Card key={sourceId}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-xl mb-2">
                        {firstInsight.sourceTitle || 'Unknown Source'}
                      </CardTitle>
                      <div className="flex gap-2">
                        <Badge variant="outline">{firstInsight.sourceType}</Badge>
                        <Badge variant="secondary">{count} insights</Badge>
                        <Link href={`/sources/${sourceId}`}>
                          <Button variant="ghost" size="sm">View Source</Button>
                        </Link>
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {insights.map((insight: Insight) => (
                      <div
                        key={`${insight.id}-${insight.locator}`}
                        className="border-l-4 border-primary/30 pl-4 py-2"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <Badge variant="outline" className="text-xs">
                                {insight.locator}
                              </Badge>
                              <Badge variant="secondary" className="text-xs">
                                {insight.evidence_type}
                              </Badge>
                              <Badge
                                variant={
                                  insight.confidence === 'high'
                                    ? 'default'
                                    : insight.confidence === 'medium'
                                    ? 'secondary'
                                    : 'outline'
                                }
                                className="text-xs"
                              >
                                {insight.confidence} confidence
                              </Badge>
                              <Badge variant="outline" className="text-xs">
                                {insight.insight_type}
                              </Badge>
                              {insight.actionability && (
                                <Badge variant="outline" className="text-xs">
                                  {insight.actionability} Actionability
                                </Badge>
                              )}
                            </div>
                            <p className="font-medium mb-1">{insight.statement}</p>
                            {insight.context_note && (
                              <p className="text-sm text-muted-foreground mb-2">
                                {insight.context_note}
                              </p>
                            )}
                            {/* Primary audience - only show if not Both */}
                            {insight.primary_audience && insight.primary_audience !== 'Both' && (
                              <div className="mt-2">
                                <Badge variant="outline" className="text-xs">
                                  For {insight.primary_audience}s
                                </Badge>
                              </div>
                            )}
                            {insight.qualifiers &&
                              Object.keys(insight.qualifiers).length > 0 && (
                                <div className="mt-2 text-xs text-muted-foreground">
                                  {Object.entries(insight.qualifiers)
                                    .filter(([_, value]) => value)
                                    .map(([key, value]) => (
                                      <span key={key} className="mr-4">
                                        <strong>{key.replace(/_/g, ' ')}:</strong> {String(value)}
                                      </span>
                                    ))}
                                </div>
                              )}
                            {/* Topics/Concepts this insight is connected to */}
                            {insight.topics && insight.topics.length > 0 && (
                              <div className="mt-3 pt-3 border-t">
                                <div className="flex flex-wrap gap-1">
                                  <span className="text-xs text-muted-foreground mr-2">Topics:</span>
                                  {insight.topics.map((topic: any) => (
                                    <Link key={topic.id} href={`/topics/${topic.slug}`}>
                                      <Badge variant="secondary" className="text-xs hover:bg-primary/20">
                                        {topic.name}
                                      </Badge>
                                    </Link>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )
          })
        ) : null}
      </div>
    </>
  )
}
