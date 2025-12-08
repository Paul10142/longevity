/**
 * Insight Clustering System
 * 
 * Groups similar raw insights using semantic similarity (embeddings)
 * Creates merge clusters for manual review in the dashboard
 * Also checks against existing unique insights to suggest merging into them
 */

import { supabaseAdmin } from './supabaseServer'
import { generateInsightEmbedding } from './embeddings'

const SEMANTIC_THRESHOLD = 0.90 // Conservative threshold for similarity
const MAX_MATCHES = 20 // Maximum similar insights to consider per anchor
const BATCH_SIZE = 500 // Process this many insights at a time

/**
 * Ensure an insight has an embedding, generating it if missing
 * Note: For best performance, generate all embeddings before clustering
 * This function is a fallback for on-demand generation
 */
async function ensureEmbeddingForInsight(
  insightId: string,
  statement: string,
  contextNote?: string | null
): Promise<number[]> {
  // Check if embedding already exists
  const { data: existing } = await supabaseAdmin
    .from('insights')
    .select('embedding')
    .eq('id', insightId)
    .single()

  if (existing?.embedding) {
    return existing.embedding as number[]
  }

  // Generate new embedding (fallback - should be rare if embeddings generated first)
  console.warn(`[Clustering] Generating embedding on-demand for insight ${insightId.substring(0, 8)}... (should have been generated first)`)
  const embedding = await generateInsightEmbedding({
    statement,
    context_note: contextNote || null
  })

  // Store it
  await supabaseAdmin
    .from('insights')
    .update({ embedding })
    .eq('id', insightId)

  return embedding
}

/**
 * Find similar raw insights using pgvector semantic search
 */
async function findSimilarRawInsights(
  embedding: number[],
  excludeIds: string[] = []
): Promise<Array<{ id: string; statement: string; similarity: number }>> {
  // Use the existing semantic search RPC function
  const { data, error } = await supabaseAdmin.rpc('search_insights_semantic', {
    query_embedding: embedding,
    match_threshold: SEMANTIC_THRESHOLD,
    match_count: MAX_MATCHES
  })

  if (error) {
    console.error('Error in semantic search:', error)
    return []
  }

  // Filter out excluded IDs and return with similarity
  return (data || [])
    .filter((item: any) => !excludeIds.includes(item.id))
    .map((item: any) => ({
      id: item.id,
      statement: item.statement,
      similarity: item.similarity
    }))
}

/**
 * Find similar unique insights using semantic search
 * Returns unique insights that are similar to the given embedding
 */
async function findSimilarUniqueInsights(
  embedding: number[]
): Promise<Array<{ id: string; canonical_statement: string; similarity: number }>> {
  // Get all unique insights with their canonical raw insights
  const { data: uniqueInsights, error } = await supabaseAdmin
    .from('unique_insights')
    .select(`
      id,
      canonical_statement,
      canonical_raw_id,
      insights!canonical_raw_id(embedding)
    `)

  if (error || !uniqueInsights) {
    console.error('Error fetching unique insights:', error)
    return []
  }

  // Calculate similarity for each unique insight using its canonical raw's embedding
  const similar: Array<{ id: string; canonical_statement: string; similarity: number }> = []

  for (const unique of uniqueInsights) {
    const canonicalEmbedding = (unique.insights as any)?.embedding as number[] | null
    
    if (!canonicalEmbedding) {
      continue // Skip if canonical raw doesn't have embedding
    }

    // Calculate cosine similarity: 1 - cosine_distance
    // Using pgvector distance operator (<=>) which is cosine distance
    // We need to calculate this in JavaScript
    const similarity = calculateCosineSimilarity(embedding, canonicalEmbedding)

    if (similarity >= SEMANTIC_THRESHOLD) {
      similar.push({
        id: unique.id,
        canonical_statement: unique.canonical_statement,
        similarity
      })
    }
  }

  // Sort by similarity (descending)
  similar.sort((a, b) => b.similarity - a.similarity)

  return similar
}

/**
 * Calculate cosine similarity between two vectors
 */
function calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    return 0
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }

  if (normA === 0 || normB === 0) {
    return 0
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Check if a set of insight IDs are already in a pending/approved cluster
 */
async function clusterExistsForSet(insightIds: string[]): Promise<boolean> {
  if (insightIds.length === 0) return false

  const { data, error } = await supabaseAdmin
    .from('merge_cluster_members')
    .select('cluster_id, merge_clusters!inner(status)')
    .in('raw_insight_id', insightIds)
    .in('merge_clusters.status', ['pending', 'approved'])

  if (error) {
    console.error('Error checking for existing clusters:', error)
    return false
  }

  return (data?.length || 0) > 0
}

/**
 * Check if a raw insight is already linked to a unique insight
 */
async function isLinkedToUniqueInsight(rawInsightId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('insights')
    .select('unique_insight_id')
    .eq('id', rawInsightId)
    .single()

  if (error || !data) {
    return false
  }

  return data.unique_insight_id !== null
}

/**
 * Build merge clusters for a batch of raw insights
 * Also creates suggestions to merge into existing unique insights
 */
async function buildMergeClustersForBatch(insightIds: string[]): Promise<{
  clustersCreated: number
  membersAdded: number
  mergeIntoUniqueSuggestions: number
  errors: number
}> {
  let clustersCreated = 0
  let membersAdded = 0
  let mergeIntoUniqueSuggestions = 0
  let errors = 0

  // Fetch the insights we need to process
  const { data: rawInsights, error: fetchError } = await supabaseAdmin
    .from('insights')
    .select('id, statement, context_note, embedding')
    .in('id', insightIds)
    .is('unique_insight_id', null)

  if (fetchError || !rawInsights) {
    console.error('Error fetching insights for clustering:', fetchError)
    return { clustersCreated: 0, membersAdded: 0, mergeIntoUniqueSuggestions: 0, errors: insightIds.length }
  }

  for (const raw of rawInsights) {
    try {
      // Skip if already linked to a unique insight
      if (await isLinkedToUniqueInsight(raw.id)) {
        continue
      }

      // Ensure embedding exists
      const embedding = await ensureEmbeddingForInsight(
        raw.id,
        raw.statement,
        raw.context_note
      )

      // First, check if this raw insight is similar to any existing unique insights
      const similarUniqueInsights = await findSimilarUniqueInsights(embedding)
      
      if (similarUniqueInsights.length > 0) {
        // Create a special cluster suggesting to merge into existing unique insight
        const { data: clusterInsert, error: clusterError } = await supabaseAdmin
          .from('merge_clusters')
          .insert({
            created_by: 'system',
            status: 'pending',
            suggested_unique_insight_id: similarUniqueInsights[0].id
          })
          .select('id')
          .single()

        if (!clusterError && clusterInsert) {
          // Insert the raw insight as a member
          const { error: membersError } = await supabaseAdmin
            .from('merge_cluster_members')
            .insert({
              cluster_id: clusterInsert.id,
              raw_insight_id: raw.id,
              similarity: similarUniqueInsights[0].similarity,
              is_selected: true
            })

          if (!membersError) {
            mergeIntoUniqueSuggestions++
            console.log(`Created merge-into-unique suggestion: raw ${raw.id.substring(0, 8)}... → unique ${similarUniqueInsights[0].id.substring(0, 8)}...`)
            continue // Skip regular clustering for this one
          }
        }
      }

      // Find similar raw insights (regular clustering)
      const neighbors = await findSimilarRawInsights(embedding, [raw.id])

      if (neighbors.length === 0) {
        continue // No similar insights found
      }

      // Check if these insights are already in a cluster
      const allIds = [raw.id, ...neighbors.map(n => n.id)]
      const alreadyClustered = await clusterExistsForSet(allIds)

      if (alreadyClustered) {
        continue // Skip if already clustered
      }

      // Create a new cluster
      const { data: clusterInsert, error: clusterError } = await supabaseAdmin
        .from('merge_clusters')
        .insert({
          created_by: 'system',
          status: 'pending'
        })
        .select('id')
        .single()

      if (clusterError || !clusterInsert) {
        console.error('Error creating cluster:', clusterError)
        errors++
        continue
      }

      const clusterId = clusterInsert.id
      clustersCreated++

      // Insert cluster members (anchor + neighbors)
      const members = [
        {
          cluster_id: clusterId,
          raw_insight_id: raw.id,
          similarity: 1.0, // Anchor has perfect similarity to itself
          is_selected: true
        },
        ...neighbors.map(n => ({
          cluster_id: clusterId,
          raw_insight_id: n.id,
          similarity: n.similarity,
          is_selected: true
        }))
      ]

      const { error: membersError } = await supabaseAdmin
        .from('merge_cluster_members')
        .insert(members)

      if (membersError) {
        console.error('Error inserting cluster members:', membersError)
        errors++
        // Try to clean up the cluster
        await supabaseAdmin
          .from('merge_clusters')
          .delete()
          .eq('id', clusterId)
        continue
      }

      membersAdded += members.length
      console.log(`Created cluster ${clusterId.substring(0, 8)}... with ${members.length} members`)

    } catch (error) {
      console.error(`Error processing insight ${raw.id}:`, error)
      errors++
    }
  }

  return { clustersCreated, membersAdded, mergeIntoUniqueSuggestions, errors }
}

/**
 * Get candidate insights for clustering (not yet merged, not in existing clusters)
 */
async function getCandidateInsightsForClustering(
  sourceId?: string,
  runId?: string,
  limit: number = BATCH_SIZE
): Promise<string[]> {
  let query = supabaseAdmin
    .from('insights')
    .select('id')
    .is('unique_insight_id', null)
    .is('deleted_at', null)
    .limit(limit)

  // Filter by source if provided
  if (sourceId) {
    query = query.eq('source_id', sourceId)
  }

  // Filter by run if provided
  if (runId) {
    query = query.eq('run_id', runId)
  }

  const { data, error } = await query

  if (error) {
    console.error('Error fetching candidate insights:', error)
    return []
  }

  const candidateIds = (data || []).map((row: { id: string }) => row.id)

  // Filter out insights already in pending/approved clusters
  const { data: alreadyClustered, error: clusterError } = await supabaseAdmin
    .from('merge_cluster_members')
    .select('raw_insight_id, merge_clusters!inner(status)')
    .in('raw_insight_id', candidateIds)
    .in('merge_clusters.status', ['pending', 'approved'])

  if (clusterError) {
    console.error('Error checking existing clusters:', clusterError)
    return candidateIds // Return all if we can't check
  }

  const clusteredIds = new Set(
    (alreadyClustered || []).map((item: any) => item.raw_insight_id)
  )

  return candidateIds.filter((id: string) => !clusteredIds.has(id))
}

/**
 * Main clustering function - processes a batch of insights
 */
export async function buildMergeClustersForNewInsights(
  options: {
    sourceId?: string
    runId?: string
    limit?: number
  } = {}
): Promise<{
  processed: number
  clustersCreated: number
  membersAdded: number
  mergeIntoUniqueSuggestions: number
  errors: number
}> {
  const { sourceId, runId, limit = BATCH_SIZE } = options

  console.log(`[Clustering] Starting clustering job`, { sourceId, runId, limit })

  // Get candidate insights
  const candidateIds = await getCandidateInsightsForClustering(sourceId, runId, limit)

  if (candidateIds.length === 0) {
    console.log('[Clustering] No candidate insights found')
    return { processed: 0, clustersCreated: 0, membersAdded: 0, mergeIntoUniqueSuggestions: 0, errors: 0 }
  }

  console.log(`[Clustering] Found ${candidateIds.length} candidate insights`)

  // Process the batch
  const result = await buildMergeClustersForBatch(candidateIds)

  console.log(`[Clustering] Completed:`, {
    processed: candidateIds.length,
    ...result
  })

  return {
    processed: candidateIds.length,
    ...result
  }
}
