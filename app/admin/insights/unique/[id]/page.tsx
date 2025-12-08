import { supabaseAdmin } from '@/lib/supabaseServer'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { notFound } from 'next/navigation'
import { UniqueInsightEditor } from '@/components/UniqueInsightEditor'
import { MergeRawIntoUnique } from '@/components/MergeRawIntoUnique'

export default async function UniqueInsightDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
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

  // Fetch unique insight
  const { data: uniqueInsight, error: uniqueError } = await supabaseAdmin
    .from('unique_insights')
    .select(`
      id,
      canonical_statement,
      canonical_raw_id,
      canonical_source_id,
      created_at,
      sources!canonical_source_id(id, title)
    `)
    .eq('id', id)
    .single()

  if (uniqueError || !uniqueInsight) {
    notFound()
  }

  // Fetch all supporting raw insights
  const { data: rawInsights, error: rawError } = await supabaseAdmin
    .from('insights')
    .select(`
      id,
      statement,
      context_note,
      confidence,
      evidence_type,
      qualifiers,
      source_id,
      locator,
      sources!source_id(id, title)
    `)
    .eq('unique_insight_id', id)
    .order('source_id')
    .order('locator')

  if (rawError) {
    console.error('Error fetching raw insights:', rawError)
  }

  // Calculate statistics
  const rawCount = rawInsights?.length || 0
  const sourceIds = new Set(rawInsights?.map((r: any) => r.source_id).filter(Boolean) || [])
  const sourceCount = sourceIds.size

  const confidenceValues = rawInsights?.map((r: any) => {
    if (r.confidence === 'high') return 3
    if (r.confidence === 'medium') return 2
    if (r.confidence === 'low') return 1
    return 2
  }) || []

  const avgConf = confidenceValues.length > 0
    ? confidenceValues.reduce((a: number, b: number) => a + b, 0) / confidenceValues.length
    : 2

  let avgConfidenceLabel = 'medium'
  if (avgConf >= 2.5) avgConfidenceLabel = 'high'
  else if (avgConf < 1.5) avgConfidenceLabel = 'low'

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Link href="/admin/insights/unique">
                  <Button variant="ghost" size="sm">← Back to Unique Insights</Button>
                </Link>
              </div>
              <h1 className="text-3xl font-bold mb-2">Unique Insight Details</h1>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {/* Canonical statement */}
          <Card>
            <CardHeader>
              <CardTitle>Canonical Statement</CardTitle>
            </CardHeader>
            <CardContent>
              <UniqueInsightEditor
                uniqueInsightId={id}
                currentStatement={uniqueInsight.canonical_statement}
              />
              <div className="flex flex-wrap gap-2 mt-4 text-sm">
                <Badge variant="outline">
                  From: {uniqueInsight.sources?.title || 'Unknown Source'}
                </Badge>
                <Badge variant="outline">
                  Created {new Date(uniqueInsight.created_at).toLocaleDateString()}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Evidence summary */}
          <Card>
            <CardHeader>
              <CardTitle>Evidence Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-2xl font-bold">{rawCount}</div>
                  <div className="text-sm text-muted-foreground">Raw Insights</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{sourceCount}</div>
                  <div className="text-sm text-muted-foreground">Sources</div>
                </div>
                <div>
                  <div className="text-2xl font-bold capitalize">{avgConfidenceLabel}</div>
                  <div className="text-sm text-muted-foreground">Avg Confidence</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Add raw insight */}
          <MergeRawIntoUnique uniqueInsightId={id} />

          {/* Supporting raw insights */}
          <Card>
            <CardHeader>
              <CardTitle>Supporting Raw Insights ({rawCount})</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {rawInsights && rawInsights.length > 0 ? (
                  rawInsights.map((raw: any) => (
                    <Card key={raw.id} className={raw.id === uniqueInsight.canonical_raw_id ? 'border-primary' : ''}>
                      <CardContent className="pt-6">
                        <div className="space-y-2">
                          <div className="flex items-start justify-between">
                            <p className="flex-1">{raw.statement}</p>
                            {raw.id === uniqueInsight.canonical_raw_id && (
                              <Badge variant="default" className="ml-2">Canonical</Badge>
                            )}
                          </div>
                          {raw.context_note && (
                            <p className="text-sm text-muted-foreground italic">
                              {raw.context_note}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-2 text-xs">
                            <Badge variant="outline">{raw.evidence_type}</Badge>
                            <Badge variant="outline">Confidence: {raw.confidence}</Badge>
                            <Badge variant="outline">{raw.sources?.title || 'Unknown Source'}</Badge>
                            {raw.locator && (
                              <Badge variant="outline">{raw.locator}</Badge>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                ) : (
                  <p className="text-muted-foreground text-center py-4">
                    No supporting raw insights found
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
