import { supabaseAdmin } from '@/lib/supabaseServer'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ClusterAllButton } from '@/components/ClusterAllButton'

interface SearchParams {
  status?: string
  page?: string
}

export default async function ClustersPage({
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

  const statusFilter = params.status || 'pending'
  const page = parseInt(params.page || '1', 10)
  const limit = 50
  const offset = (page - 1) * limit

  // Fetch clusters
  let query = supabaseAdmin
    .from('merge_clusters')
    .select(`
      id,
      created_at,
      created_by,
      status,
      suggested_unique_insight_id,
      unique_insights!suggested_unique_insight_id(
        id,
        canonical_statement
      )
    `, { count: 'exact' })
    .order('created_at', { ascending: false })

  if (statusFilter !== 'all') {
    query = query.eq('status', statusFilter)
  }

  const { data: clusters, error: clustersError, count } = await query.range(offset, offset + limit - 1)

  if (clustersError) {
    console.error('Error fetching clusters:', clustersError)
  }

  // Get preview statement and member count for each cluster
  const clustersWithPreview = await Promise.all(
    (clusters || []).map(async (cluster: any) => {
      // Get member count
      const { count: memberCount } = await supabaseAdmin
        .from('merge_cluster_members')
        .select('*', { count: 'exact', head: true })
        .eq('cluster_id', cluster.id)

      // Get first member's statement for preview
      const { data: firstMember } = await supabaseAdmin
        .from('merge_cluster_members')
        .select(`
          raw_insight_id,
          insights!inner(statement)
        `)
        .eq('cluster_id', cluster.id)
        .order('similarity', { ascending: false })
        .limit(1)
        .single()

      // Extract suggested unique insight info from the joined data
      const suggestedUniqueInsight = cluster.suggested_unique_insight_id && cluster.unique_insights
        ? {
            id: (cluster.unique_insights as any).id,
            canonical_statement: (cluster.unique_insights as any).canonical_statement
          }
        : undefined

      return {
        ...cluster,
        memberCount: memberCount || 0,
        preview: firstMember?.insights?.statement?.substring(0, 150) || 'No preview available',
        suggestedUniqueInsight
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
              <h1 className="text-3xl font-bold mb-2">Merge Clusters</h1>
              <p className="text-muted-foreground">
                Review and merge similar raw insights into unique ideas
              </p>
              <div className="flex gap-2 mt-2">
                <Link href="/admin/insights/review">
                  <Button variant="ghost" size="sm">← Review Insights</Button>
                </Link>
                <Link href="/admin/sources">
                  <Button variant="ghost" size="sm">Sources</Button>
                </Link>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <ClusterAllButton />
              <p className="text-xs text-muted-foreground text-right max-w-xs">
                First generates missing embeddings, then clusters all unclustered insights in batches.
              </p>
            </div>
          </div>

          {/* Status filter tabs */}
          <div className="flex gap-2 mb-4">
            <Link href="/admin/insights/clusters?status=pending">
              <Button variant={statusFilter === 'pending' ? 'default' : 'outline'} size="sm">
                Pending ({count || 0})
              </Button>
            </Link>
            <Link href="/admin/insights/clusters?status=approved">
              <Button variant={statusFilter === 'approved' ? 'default' : 'outline'} size="sm">
                Approved
              </Button>
            </Link>
            <Link href="/admin/insights/clusters?status=rejected">
              <Button variant={statusFilter === 'rejected' ? 'default' : 'outline'} size="sm">
                Rejected
              </Button>
            </Link>
            <Link href="/admin/insights/clusters?status=all">
              <Button variant={statusFilter === 'all' ? 'default' : 'outline'} size="sm">
                All
              </Button>
            </Link>
          </div>
        </div>

        {/* Clusters list */}
        <div className="space-y-4">
          {clustersWithPreview.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No clusters found. Clusters are created automatically when similar insights are detected.
              </CardContent>
            </Card>
          ) : (
            clustersWithPreview.map((cluster: any) => (
              <Card key={cluster.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <CardTitle className="text-lg">
                          {cluster.suggestedUniqueInsight ? 'Merge Into Existing' : 'Cluster'} {cluster.id.substring(0, 8)}...
                        </CardTitle>
                        <Badge variant={
                          cluster.status === 'approved' ? 'default' :
                          cluster.status === 'rejected' ? 'destructive' :
                          'secondary'
                        }>
                          {cluster.status}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          {cluster.memberCount} member{cluster.memberCount !== 1 ? 's' : ''}
                        </span>
                        {cluster.suggestedUniqueInsight && (
                          <Badge variant="outline" className="text-xs">
                            Existing Unique
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mb-2">
                        Created {new Date(cluster.created_at).toLocaleDateString()} by {cluster.created_by}
                      </p>
                      {cluster.suggestedUniqueInsight ? (
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Raw Insight:</p>
                          <p className="text-sm line-clamp-2">{cluster.preview}...</p>
                          <p className="text-sm font-medium mt-2">Existing Unique Insight:</p>
                          <p className="text-sm line-clamp-2 text-muted-foreground">
                            {cluster.suggestedUniqueInsight.canonical_statement?.substring(0, 150)}...
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm line-clamp-2">
                          {cluster.preview}...
                        </p>
                      )}
                    </div>
                    <Link href={`/admin/insights/clusters/${cluster.id}`}>
                      <Button size="sm">Review</Button>
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
              <Link href={`/admin/insights/clusters?status=${statusFilter}&page=${page - 1}`}>
                <Button variant="outline" size="sm">Previous</Button>
              </Link>
            )}
            <span className="text-sm text-muted-foreground self-center">
              Page {page} of {totalPages}
            </span>
            {page < totalPages && (
              <Link href={`/admin/insights/clusters?status=${statusFilter}&page=${page + 1}`}>
                <Button variant="outline" size="sm">Next</Button>
              </Link>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
