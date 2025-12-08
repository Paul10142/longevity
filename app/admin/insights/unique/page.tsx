import { supabaseAdmin } from '@/lib/supabaseServer'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface SearchParams {
  page?: string
}

export default async function UniqueInsightsPage({
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

  const page = parseInt(params.page || '1', 10)
  const limit = 50
  const offset = (page - 1) * limit

  // Fetch unique insights with aggregated data
  const { data: uniqueInsights, error: uniqueError, count } = await supabaseAdmin
    .from('unique_insights')
    .select(`
      id,
      canonical_statement,
      canonical_raw_id,
      canonical_source_id,
      created_at,
      insights!inner(id)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (uniqueError) {
    console.error('Error fetching unique insights:', uniqueError)
  }

  // Get counts and confidence for each unique insight
  const uniqueInsightsWithStats = await Promise.all(
    (uniqueInsights || []).map(async (unique: any) => {
      const { data: rawInsights } = await supabaseAdmin
        .from('insights')
        .select('id, confidence, source_id')
        .eq('unique_insight_id', unique.id)

      const rawCount = rawInsights?.length || 0
      const sourceIds = new Set(rawInsights?.map((r: any) => r.source_id).filter(Boolean) || [])
      const sourceCount = sourceIds.size

      // Calculate average confidence
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

      return {
        ...unique,
        rawCount,
        sourceCount,
        avgConfidence: avgConfidenceLabel
      }
    })
  )

  const totalPages = count ? Math.ceil(count / limit) : 1

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl font-bold mb-2">Unique Insights</h1>
              <p className="text-muted-foreground">
                Deduplicated idea-level insights aggregated from raw statements
              </p>
              <div className="flex gap-2 mt-2">
                <Link href="/admin/insights/clusters">
                  <Button variant="ghost" size="sm">← Merge Clusters</Button>
                </Link>
                <Link href="/admin/insights/review">
                  <Button variant="ghost" size="sm">Review Insights</Button>
                </Link>
                <Link href="/admin/sources">
                  <Button variant="ghost" size="sm">Sources</Button>
                </Link>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {count || 0} unique insights
              </p>
            </div>
          </div>
        </div>

        {/* Unique insights list */}
        <div className="space-y-4">
          {uniqueInsightsWithStats.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No unique insights yet. Create them by merging clusters in the Merge Clusters page.
              </CardContent>
            </Card>
          ) : (
            uniqueInsightsWithStats.map((unique: any) => (
              <Card key={unique.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-lg mb-2">
                        {unique.canonical_statement}
                      </CardTitle>
                      <div className="flex flex-wrap gap-2 text-sm">
                        <Badge variant="outline">
                          {unique.rawCount} raw insight{unique.rawCount !== 1 ? 's' : ''}
                        </Badge>
                        <Badge variant="outline">
                          {unique.sourceCount} source{unique.sourceCount !== 1 ? 's' : ''}
                        </Badge>
                        <Badge variant={
                          unique.avgConfidence === 'high' ? 'default' :
                          unique.avgConfidence === 'low' ? 'secondary' :
                          'outline'
                        }>
                          Avg: {unique.avgConfidence}
                        </Badge>
                        <span className="text-muted-foreground">
                          Created {new Date(unique.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                    <Link href={`/admin/insights/unique/${unique.id}`}>
                      <Button size="sm">View Details</Button>
                    </Link>
                  </div>
                </CardHeader>
              </Card>
            ))
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex justify-center gap-2 mt-8">
            {page > 1 && (
              <Link href={`/admin/insights/unique?page=${page - 1}`}>
                <Button variant="outline" size="sm">Previous</Button>
              </Link>
            )}
            <span className="text-sm text-muted-foreground self-center">
              Page {page} of {totalPages}
            </span>
            {page < totalPages && (
              <Link href={`/admin/insights/unique?page=${page + 1}`}>
                <Button variant="outline" size="sm">Next</Button>
              </Link>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
