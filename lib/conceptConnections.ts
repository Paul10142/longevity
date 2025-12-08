/**
 * Concept Connections System
 * 
 * Computes and manages relationships between concepts based on:
 * 1. Shared insights (concepts that share insights)
 * 2. Semantic similarity (using concept embeddings)
 * 3. Hierarchy (parent-child relationships)
 * 
 * Used for:
 * - Cross-concept navigation
 * - Related concept suggestions
 * - Enhanced narrative generation (context from related concepts)
 */

import { supabaseAdmin } from './supabaseServer'
import { generateConceptEmbedding } from './embeddings'

export type ConceptConnectionType = 'shared_insights' | 'semantic' | 'hierarchy'

export interface ConceptConnection {
  concept_id: string
  related_concept_id: string
  connection_strength: number
  connection_type: ConceptConnectionType
  shared_insight_count?: number
}

/**
 * Compute connections between concepts based on shared insights
 * Two concepts are connected if they share at least 2 insights
 */
export async function computeSharedInsightConnections(
  conceptId: string,
  minSharedInsights: number = 2
): Promise<ConceptConnection[]> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Get all insights for this concept
  const { data: insightsData, error: insightsError } = await supabaseAdmin
    .from('insight_concepts')
    .select('insight_id')
    .eq('concept_id', conceptId)

  if (insightsError || !insightsData) {
    throw new Error(`Error fetching insights: ${insightsError?.message}`)
  }

  const insightIds = insightsData.map((ic: any) => ic.insight_id)

  if (insightIds.length === 0) {
    return []
  }

  // Find other concepts that share these insights
  const { data: sharedConcepts, error: sharedError } = await supabaseAdmin
    .from('insight_concepts')
    .select('concept_id, insight_id')
    .in('insight_id', insightIds)
    .neq('concept_id', conceptId)

  if (sharedError) {
    throw new Error(`Error finding shared concepts: ${sharedError.message}`)
  }

  // Count shared insights per concept
  const conceptCounts = new Map<string, number>()
  sharedConcepts?.forEach((sc: any) => {
    const count = conceptCounts.get(sc.concept_id) || 0
    conceptCounts.set(sc.concept_id, count + 1)
  })

  // Build connections for concepts with enough shared insights
  const connections: ConceptConnection[] = []
  conceptCounts.forEach((count, relatedConceptId) => {
    if (count >= minSharedInsights) {
      // Connection strength = shared insights / total insights (normalized)
      const strength = Math.min(count / insightIds.length, 1.0)
      
      connections.push({
        concept_id: conceptId,
        related_concept_id: relatedConceptId,
        connection_strength: strength,
        connection_type: 'shared_insights',
        shared_insight_count: count,
      })
    }
  })

  return connections
}

/**
 * Compute semantic connections between concepts
 * Uses concept embeddings to find similar concepts
 */
export async function computeSemanticConnections(
  conceptId: string,
  threshold: number = 0.75,
  maxResults: number = 10
): Promise<ConceptConnection[]> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Get concept with embedding
  const { data: concept, error: conceptError } = await supabaseAdmin
    .from('concepts')
    .select('id, name, description, embedding')
    .eq('id', conceptId)
    .single()

  if (conceptError || !concept) {
    throw new Error(`Concept not found: ${conceptError?.message}`)
  }

  // If no embedding, generate one
  let embedding = concept.embedding as number[] | null
  if (!embedding) {
    embedding = await generateConceptEmbedding({
      name: concept.name,
      description: concept.description || null,
    })
    
    // Store embedding for future use
    await supabaseAdmin
      .from('concepts')
      .update({ embedding })
      .eq('id', conceptId)
  }

  // Find similar concepts using semantic search
  // Use pgvector cosine distance operator (<=>)
  const { data: similarConcepts, error: similarError } = await supabaseAdmin
    .from('concepts')
    .select('id, name, embedding')
    .not('embedding', 'is', null)
    .neq('id', conceptId)
    .limit(maxResults * 2) // Get more than needed to filter by threshold

  if (similarError) {
    throw new Error(`Error finding similar concepts: ${similarError.message}`)
  }

  // Calculate similarity for each concept
  const connections: ConceptConnection[] = []
  
  for (const similarConcept of similarConcepts || []) {
    if (!similarConcept.embedding) continue

    // Calculate cosine similarity: 1 - cosine_distance
    const similarity = cosineSimilarity(embedding, similarConcept.embedding as number[])

    if (similarity >= threshold) {
      connections.push({
        concept_id: conceptId,
        related_concept_id: similarConcept.id,
        connection_strength: similarity,
        connection_type: 'semantic',
      })
    }
  }

  // Sort by strength and limit
  connections.sort((a, b) => b.connection_strength - a.connection_strength)
  return connections.slice(0, maxResults)
}

/**
 * Compute hierarchy connections (parent-child relationships)
 */
export async function computeHierarchyConnections(conceptId: string): Promise<ConceptConnection[]> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  const connections: ConceptConnection[] = []

  // Get parent concepts
  const { data: parents, error: parentsError } = await supabaseAdmin
    .from('concept_parents')
    .select('parent_id')
    .eq('concept_id', conceptId)

  if (parentsError) {
    throw new Error(`Error fetching parents: ${parentsError.message}`)
  }

  parents?.forEach((p: any) => {
    connections.push({
      concept_id: conceptId,
      related_concept_id: p.parent_id,
      connection_strength: 1.0, // Hierarchy connections are always strong
      connection_type: 'hierarchy',
    })
  })

  // Get child concepts
  const { data: children, error: childrenError } = await supabaseAdmin
    .from('concept_parents')
    .select('concept_id')
    .eq('parent_id', conceptId)

  if (childrenError) {
    throw new Error(`Error fetching children: ${childrenError.message}`)
  }

  children?.forEach((c: any) => {
    connections.push({
      concept_id: conceptId,
      related_concept_id: c.concept_id,
      connection_strength: 1.0,
      connection_type: 'hierarchy',
    })
  })

  return connections
}

/**
 * Compute all connections for a concept
 * Combines shared insights, semantic, and hierarchy connections
 */
export async function computeAllConnections(conceptId: string): Promise<ConceptConnection[]> {
  const [shared, semantic, hierarchy] = await Promise.all([
    computeSharedInsightConnections(conceptId),
    computeSemanticConnections(conceptId).catch(() => []), // Don't fail if semantic fails
    computeHierarchyConnections(conceptId),
  ])

  // Combine and deduplicate (prefer hierarchy > shared > semantic)
  const connectionMap = new Map<string, ConceptConnection>()

  // Add in priority order: hierarchy, shared, semantic
  hierarchy.forEach(conn => {
    connectionMap.set(conn.related_concept_id, conn)
  })

  shared.forEach(conn => {
    if (!connectionMap.has(conn.related_concept_id)) {
      connectionMap.set(conn.related_concept_id, conn)
    }
  })

  semantic.forEach(conn => {
    if (!connectionMap.has(conn.related_concept_id)) {
      connectionMap.set(conn.related_concept_id, conn)
    }
  })

  return Array.from(connectionMap.values())
}

/**
 * Store connections in database
 * Upserts to handle updates
 */
export async function storeConnections(connections: ConceptConnection[]): Promise<void> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  if (connections.length === 0) {
    return
  }

  const { error } = await supabaseAdmin
    .from('concept_connections')
    .upsert(connections, {
      onConflict: 'concept_id,related_concept_id',
    })

  if (error) {
    throw new Error(`Failed to store connections: ${error.message}`)
  }
}

/**
 * Get related concepts for a concept
 * Fetches from database (computes if not exists)
 */
export async function getRelatedConcepts(
  conceptId: string,
  limit: number = 5,
  minStrength: number = 0.5
): Promise<Array<{ id: string; name: string; slug: string; description: string | null; connection_strength: number; connection_type: string }>> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  // Fetch connections from database
  const { data: connections, error: connectionsError } = await supabaseAdmin
    .from('concept_connections')
    .select(
      `
      related_concept_id,
      connection_strength,
      connection_type,
      concepts!concept_connections_related_concept_id_fkey (
        id,
        name,
        slug,
        description
      )
    `
    )
    .eq('concept_id', conceptId)
    .gte('connection_strength', minStrength)
    .order('connection_strength', { ascending: false })
    .limit(limit)

  if (connectionsError) {
    // If no connections exist, try computing them
    console.log(`[Concept Connections] No connections found for ${conceptId}, computing...`)
    try {
      const computed = await computeAllConnections(conceptId)
      await storeConnections(computed)
      
      // Retry fetch
      const { data: retryConnections, error: retryError } = await supabaseAdmin
        .from('concept_connections')
        .select(
          `
          related_concept_id,
          connection_strength,
          connection_type,
          concepts!concept_connections_related_concept_id_fkey (
            id,
            name,
            slug,
            description
          )
        `
        )
        .eq('concept_id', conceptId)
        .gte('connection_strength', minStrength)
        .order('connection_strength', { ascending: false })
        .limit(limit)

      if (retryError || !retryConnections) {
        return []
      }

      return retryConnections
        .map((c: any) => ({
          id: c.concepts.id,
          name: c.concepts.name,
          slug: c.concepts.slug,
          description: c.concepts.description,
          connection_strength: c.connection_strength,
          connection_type: c.connection_type,
        }))
        .filter((c: any) => c.id) // Filter out nulls
    } catch (computeError) {
      console.error(`[Concept Connections] Error computing connections:`, computeError)
      return []
    }
  }

  if (!connections) {
    return []
  }

  return connections
    .map((c: any) => ({
      id: c.concepts?.id,
      name: c.concepts?.name,
      slug: c.concepts?.slug,
      description: c.concepts?.description,
      connection_strength: c.connection_strength,
      connection_type: c.connection_type,
    }))
    .filter((c: any) => c.id) // Filter out nulls
}

/**
 * Get sample insights from related concepts
 * Used for narrative generation context
 */
export async function getRelatedConceptInsights(
  relatedConcepts: Array<{ id: string }>,
  limitPerConcept: number = 3
): Promise<Array<{ id: string; statement: string; context_note: string | null; concept_id: string; concept_name: string }>> {
  if (!supabaseAdmin || relatedConcepts.length === 0) {
    return []
  }

  const conceptIds = relatedConcepts.map(c => c.id)
  const allInsights: Array<{ id: string; statement: string; context_note: string | null; concept_id: string; concept_name: string }> = []

  // Fetch top insights from each related concept (only importance 3)
  for (const concept of relatedConcepts) {
    const { data: insights, error } = await supabaseAdmin
      .from('insight_concepts')
      .select(
        `
        insights (
          id,
          statement,
          context_note,
          importance,
          actionability
        ),
        concepts!insight_concepts_concept_id_fkey (
          name
        )
      `
      )
      .eq('concept_id', concept.id)
      .eq('insights.importance', 3)
      .is('insights.deleted_at', null)
      .order('insights.created_at', { ascending: false })
      .limit(limitPerConcept)

    if (error || !insights) continue

    insights.forEach((item: any) => {
      if (item.insights && item.concepts && item.insights.importance === 3) {
        allInsights.push({
          id: item.insights.id,
          statement: item.insights.statement,
          context_note: item.insights.context_note,
          concept_id: concept.id,
          concept_name: item.concepts.name,
        })
      }
    })
  }

  return allInsights
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error('Vectors must have the same length')
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}
