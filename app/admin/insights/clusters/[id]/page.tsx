import { supabaseAdmin } from '@/lib/supabaseServer'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ClusterDetailClient } from '@/components/ClusterDetailClient'
import { notFound } from 'next/navigation'

export default async function ClusterDetailPage({
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

  // Fetch cluster details
  const { data: cluster, error: clusterError } = await supabaseAdmin
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
    `)
    .eq('id', id)
    .single()

  if (clusterError || !cluster) {
    notFound()
  }

  // Fetch cluster members with full insight details
  const { data: members, error: membersError } = await supabaseAdmin
    .from('merge_cluster_members')
    .select(`
      id,
      raw_insight_id,
      similarity,
      is_selected,
      insights!inner(
        id,
        statement,
        context_note,
        confidence,
        evidence_type,
        qualifiers,
        source_id,
        locator,
        sources!inner(
          id,
          title
        )
      )
    `)
    .eq('cluster_id', id)
    .order('similarity', { ascending: false })

  if (membersError) {
    console.error('Error fetching cluster members:', membersError)
  }

  const membersWithDetails = (members || []).map((member: any) => ({
    memberId: member.id,
    rawInsightId: member.raw_insight_id,
    similarity: member.similarity,
    isSelected: member.is_selected,
    statement: member.insights?.statement,
    contextNote: member.insights?.context_note,
    confidence: member.insights?.confidence,
    evidenceType: member.insights?.evidence_type,
    qualifiers: member.insights?.qualifiers,
    sourceId: member.insights?.source_id,
    sourceTitle: member.insights?.sources?.title || 'Unknown Source',
    locator: member.insights?.locator
  }))

  // Auto-suggest canonical: longest statement among selected members
  const selectedMembers = membersWithDetails.filter((m: typeof membersWithDetails[0]) => m.isSelected)
  const canonicalSuggestion = selectedMembers.length > 0
    ? selectedMembers.reduce((longest: typeof membersWithDetails[0], current: typeof membersWithDetails[0]) => 
        current.statement.length > longest.statement.length ? current : longest
      )
    : membersWithDetails[0]

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Link href="/admin/insights/clusters">
                  <Button variant="ghost" size="sm">← Back to Clusters</Button>
                </Link>
              </div>
              <h1 className="text-3xl font-bold mb-2">Cluster Review</h1>
              <p className="text-muted-foreground">
                Review and merge similar insights into a unique idea
              </p>
              <div className="flex items-center gap-2 mt-2">
                <Badge variant={
                  cluster.status === 'approved' ? 'default' :
                  cluster.status === 'rejected' ? 'destructive' :
                  'secondary'
                }>
                  {cluster.status}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  Created {new Date(cluster.created_at).toLocaleDateString()} by {cluster.created_by}
                </span>
              </div>
            </div>
          </div>
        </div>

        <ClusterDetailClient
          clusterId={id}
          clusterStatus={cluster.status}
          members={membersWithDetails}
          canonicalSuggestion={canonicalSuggestion}
          suggestedUniqueInsight={cluster.suggested_unique_insight_id ? {
            id: cluster.unique_insights?.id,
            canonical_statement: cluster.unique_insights?.canonical_statement
          } : undefined}
        />
      </main>
    </div>
  )
}
