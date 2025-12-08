/**
 * Training Data Export for Fine-Tuning
 * 
 * Exports manual merge decisions as labeled training data
 * Supports OpenAI fine-tuning format (JSONL) and custom JSON format
 */

import { supabaseAdmin } from './supabaseServer'

export interface TrainingExample {
  insight1: {
    id: string
    statement: string
    context_note?: string | null
    confidence: string
    evidence_type: string
    similarity?: number
  }
  insight2: {
    id: string
    statement: string
    context_note?: string | null
    confidence: string
    evidence_type: string
    similarity?: number
  }
  should_merge: boolean
  label_source: 'approved_merge' | 'rejected_cluster' | 'partial_merge' | 'manual_reject'
  cluster_id?: string
  metadata?: {
    similarity_score?: number
    canonical_selected?: string
    merge_date?: string
  }
}

/**
 * Export all approved merges as positive training examples
 */
async function exportApprovedMerges(): Promise<TrainingExample[]> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Get all approved clusters
  const { data: approvedClusters, error: clusterError } = await supabaseAdmin
    .from('merge_clusters')
    .select('id, created_at')
    .eq('status', 'approved')

  if (clusterError || !approvedClusters) {
    throw new Error(`Failed to fetch approved clusters: ${clusterError?.message}`)
  }

  const examples: TrainingExample[] = []

  for (const cluster of approvedClusters) {
    // Get all members of this cluster
    const { data: members, error: membersError } = await supabaseAdmin
      .from('merge_cluster_members')
      .select(`
        raw_insight_id,
        similarity,
        is_selected,
        insights!inner(
          id,
          statement,
          context_note,
          confidence,
          evidence_type
        )
      `)
      .eq('cluster_id', cluster.id)

    if (membersError || !members) {
      console.error(`Error fetching members for cluster ${cluster.id}:`, membersError)
      continue
    }

    // Get the unique insight this cluster was merged into
    const { data: uniqueInsight } = await supabaseAdmin
      .from('insights')
      .select('unique_insight_id')
      .in('id', members.map((m: { raw_insight_id: string }) => m.raw_insight_id))
      .not('unique_insight_id', 'is', null)
      .limit(1)
      .single()

    if (!uniqueInsight) {
      continue // Skip if not actually merged
    }

    // Get canonical insight
    const { data: canonical } = await supabaseAdmin
      .from('unique_insights')
      .select('canonical_raw_id')
      .eq('id', uniqueInsight.unique_insight_id)
      .single()

    const canonicalId = canonical?.canonical_raw_id

    // Create pairs: canonical with each selected member
    const selectedMembers = members.filter((m: { is_selected: boolean }) => m.is_selected)
    const canonicalMember = selectedMembers.find((m: { raw_insight_id: string }) => m.raw_insight_id === canonicalId) || selectedMembers[0]

    for (const member of selectedMembers) {
      if (member.raw_insight_id === canonicalMember.raw_insight_id) {
        continue // Skip self-pairs
      }

      const insight1 = canonicalMember.insights as any
      const insight2 = member.insights as any

      examples.push({
        insight1: {
          id: insight1.id,
          statement: insight1.statement,
          context_note: insight1.context_note,
          confidence: insight1.confidence,
          evidence_type: insight1.evidence_type,
          similarity: canonicalMember.similarity || undefined
        },
        insight2: {
          id: insight2.id,
          statement: insight2.statement,
          context_note: insight2.context_note,
          confidence: insight2.confidence,
          evidence_type: insight2.evidence_type,
          similarity: member.similarity || undefined
        },
        should_merge: true,
        label_source: 'approved_merge',
        cluster_id: cluster.id,
        metadata: {
          similarity_score: member.similarity || undefined,
          canonical_selected: canonicalMember.raw_insight_id,
          merge_date: cluster.created_at
        }
      })
    }

    // Create negative examples: selected vs unselected
    const unselectedMembers = members.filter((m: { is_selected: boolean }) => !m.is_selected)
    for (const selected of selectedMembers) {
      for (const unselected of unselectedMembers) {
        const insight1 = selected.insights as any
        const insight2 = unselected.insights as any

        examples.push({
          insight1: {
            id: insight1.id,
            statement: insight1.statement,
            context_note: insight1.context_note,
            confidence: insight1.confidence,
            evidence_type: insight1.evidence_type,
            similarity: selected.similarity || undefined
          },
          insight2: {
            id: insight2.id,
            statement: insight2.statement,
            context_note: insight2.context_note,
            confidence: insight2.confidence,
            evidence_type: insight2.evidence_type,
            similarity: unselected.similarity || undefined
          },
          should_merge: false,
          label_source: 'partial_merge',
          cluster_id: cluster.id,
          metadata: {
            similarity_score: unselected.similarity || undefined,
            canonical_selected: canonicalMember.raw_insight_id
          }
        })
      }
    }
  }

  return examples
}

/**
 * Export rejected clusters as negative training examples
 */
async function exportRejectedClusters(): Promise<TrainingExample[]> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Get all rejected clusters
  const { data: rejectedClusters, error: clusterError } = await supabaseAdmin
    .from('merge_clusters')
    .select('id')
    .eq('status', 'rejected')

  if (clusterError || !rejectedClusters) {
    throw new Error(`Failed to fetch rejected clusters: ${clusterError?.message}`)
  }

  const examples: TrainingExample[] = []

  for (const cluster of rejectedClusters) {
    // Get all members
    const { data: members, error: membersError } = await supabaseAdmin
      .from('merge_cluster_members')
      .select(`
        raw_insight_id,
        similarity,
        insights!inner(
          id,
          statement,
          context_note,
          confidence,
          evidence_type
        )
      `)
      .eq('cluster_id', cluster.id)
      .order('similarity', { ascending: false })

    if (membersError || !members || members.length < 2) {
      continue
    }

    // Create pairs: all combinations within the cluster (all should NOT merge)
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const member1 = members[i]
        const member2 = members[j]

        const insight1 = member1.insights as any
        const insight2 = member2.insights as any

        examples.push({
          insight1: {
            id: insight1.id,
            statement: insight1.statement,
            context_note: insight1.context_note,
            confidence: insight1.confidence,
            evidence_type: insight1.evidence_type,
            similarity: member1.similarity || undefined
          },
          insight2: {
            id: insight2.id,
            statement: insight2.statement,
            context_note: insight2.context_note,
            confidence: insight2.confidence,
            evidence_type: insight2.evidence_type,
            similarity: member2.similarity || undefined
          },
          should_merge: false,
          label_source: 'rejected_cluster',
          cluster_id: cluster.id,
          metadata: {
            similarity_score: member2.similarity || undefined
          }
        })
      }
    }
  }

  return examples
}

/**
 * Export all training data (positive + negative examples)
 */
export async function exportTrainingData(): Promise<{
  positive: TrainingExample[]
  negative: TrainingExample[]
  total: number
  stats: {
    approved_merges: number
    rejected_clusters: number
    partial_merges: number
  }
}> {
  console.log('[Training Data Export] Starting export...')

  const positive = await exportApprovedMerges()
  console.log(`[Training Data Export] Found ${positive.length} positive examples`)

  const negative = await exportRejectedClusters()
  console.log(`[Training Data Export] Found ${negative.length} negative examples`)

  // Count by source
  const stats = {
    approved_merges: positive.filter(e => e.label_source === 'approved_merge').length,
    rejected_clusters: negative.filter(e => e.label_source === 'rejected_cluster').length,
    partial_merges: positive.filter(e => e.label_source === 'partial_merge').length + 
                    negative.filter(e => e.label_source === 'partial_merge').length
  }

  return {
    positive,
    negative,
    total: positive.length + negative.length,
    stats
  }
}

/**
 * Convert training examples to OpenAI fine-tuning format (JSONL)
 */
export function convertToOpenAIFormat(examples: TrainingExample[]): string {
  const lines: string[] = []

  for (const example of examples) {
    const systemPrompt = "You are an expert at determining if two medical insights express the same idea, even if worded differently. Consider the core meaning, not just the exact words."
    
    const userPrompt = `Insight 1: ${example.insight1.statement}${example.insight1.context_note ? `\nContext: ${example.insight1.context_note}` : ''}\nConfidence: ${example.insight1.confidence}\nEvidence: ${example.insight1.evidence_type}\n\nInsight 2: ${example.insight2.statement}${example.insight2.context_note ? `\nContext: ${example.insight2.context_note}` : ''}\nConfidence: ${example.insight2.confidence}\nEvidence: ${example.insight2.evidence_type}${example.metadata?.similarity_score ? `\nSimilarity Score: ${example.metadata.similarity_score.toFixed(3)}` : ''}\n\nShould these insights be merged into one?`

    const assistantResponse = example.should_merge 
      ? "MERGE - These insights express the same idea and should be combined."
      : "DON'T MERGE - These insights are different and should remain separate."

    const message = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
        { role: "assistant", content: assistantResponse }
      ]
    }

    lines.push(JSON.stringify(message))
  }

  return lines.join('\n')
}

/**
 * Convert training examples to custom JSON format
 */
export function convertToCustomJSONFormat(examples: TrainingExample[]): string {
  return JSON.stringify(examples, null, 2)
}
