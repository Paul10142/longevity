/**
 * Semantic Search System
 * 
 * Provides semantic search functionality using pgvector embeddings
 * Supports both global search and topic-specific search
 */

import { supabaseAdmin } from './supabaseServer'
import { generateEmbedding } from './embeddings'

export interface SearchResult {
  id: string
  statement: string
  context_note: string | null
  evidence_type: string
  qualifiers: any
  confidence: string
  importance: number | null
  actionability: string | null
  primary_audience: string | null
  insight_type: string | null
  tone: string | null
  created_at: string
  similarity: number
  source?: {
    id: string
    title: string
    type: string
  }
}

/**
 * Semantic search for insights
 * 
 * @param query - Search query text
 * @param conceptId - Optional concept ID to limit search to a specific topic
 * @param limit - Maximum number of results (default 50)
 * @param matchThreshold - Minimum similarity score (0-1, default 0.7)
 * @returns Array of insights sorted by similarity
 */
export async function semanticSearchInsights(
  query: string,
  conceptId?: string,
  limit: number = 50,
  matchThreshold: number = 0.7
): Promise<SearchResult[]> {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin not configured')
  }

  if (!query || query.trim().length === 0) {
    return []
  }

  // Generate embedding for search query
  const queryEmbedding = await generateEmbedding(query.trim())

  // Call RPC function for semantic search
  const { data, error } = await supabaseAdmin.rpc('search_insights_semantic', {
    query_embedding: queryEmbedding,
    concept_id: conceptId || null,
    match_threshold: matchThreshold,
    match_count: limit,
  })

  if (error) {
    console.error('Error in semantic search:', error)
    throw new Error(`Semantic search failed: ${error.message}`)
  }

  if (!data || data.length === 0) {
    return []
  }

  // Fetch source information for each insight
  const insightIds = data.map((r: any) => r.id)
  const { data: sourceLinks } = await supabaseAdmin
    .from('insight_sources')
    .select('insight_id, source_id, sources(id, title, type)')
    .in('insight_id', insightIds)

  // Map sources to insights
  const sourcesByInsightId = new Map<string, any>()
  sourceLinks?.forEach((link: any) => {
    if (!sourcesByInsightId.has(link.insight_id)) {
      sourcesByInsightId.set(link.insight_id, link.sources)
    }
  })

  // Combine search results with source information
  return data.map((result: any) => ({
    ...result,
    source: sourcesByInsightId.get(result.id) || undefined,
  }))
}

/**
 * Hybrid search: combines semantic search with keyword search
 * 
 * @param query - Search query text
 * @param conceptId - Optional concept ID to limit search to a specific topic
 * @param limit - Maximum number of results (default 50)
 * @returns Array of insights sorted by relevance
 */
export async function hybridSearch(
  query: string,
  conceptId?: string,
  limit: number = 50
): Promise<SearchResult[]> {
  if (!query || query.trim().length === 0) {
    return []
  }

  // Semantic search (may return empty if embeddings not available)
  let semanticResults: SearchResult[] = []
  try {
    semanticResults = await semanticSearchInsights(query, conceptId, limit, 0.6) // Lower threshold for hybrid
  } catch (error) {
    // If semantic search fails (e.g., no embeddings yet), continue with keyword search only
    console.warn('Semantic search failed, using keyword search only:', error)
  }

  // Keyword search (PostgreSQL full-text search)
  if (!supabaseAdmin) {
    return semanticResults // Return semantic results only if Supabase not configured
  }

  let keywordQuery = supabaseAdmin
    .from('insights')
    .select(`
      id,
      statement,
      context_note,
      evidence_type,
      qualifiers,
      confidence,
      importance,
      actionability,
      primary_audience,
      insight_type,
      tone,
      created_at
    `)
    .is('deleted_at', null)
    .or(`statement.ilike.%${query}%,context_note.ilike.%${query}%`)
    .limit(limit)

  // Filter by concept if provided
  if (conceptId) {
    const { data: conceptInsights } = await supabaseAdmin
      .from('insight_concepts')
      .select('insight_id')
      .eq('concept_id', conceptId)

    const insightIds = conceptInsights?.map((ic: { insight_id: string }) => ic.insight_id) || []
    if (insightIds.length > 0) {
      keywordQuery = keywordQuery.in('id', insightIds)
    } else {
      // No insights for this concept, return empty
      return semanticResults
    }
  }

  const { data: keywordResults } = await keywordQuery

  // Combine and deduplicate results
  const semanticIds = new Set(semanticResults.map(r => r.id))
  const keywordResultsWithSimilarity = (keywordResults || [])
    .filter((r: any) => !semanticIds.has(r.id))
    .map((r: any) => ({
      ...r,
      similarity: 0.5, // Default similarity for keyword matches
    }))

  // Combine results: semantic first (higher similarity), then keyword
  const combined = [...semanticResults, ...keywordResultsWithSimilarity]
  
  // Sort by similarity (descending)
  combined.sort((a, b) => b.similarity - a.similarity)

  // Limit results
  return combined.slice(0, limit)
}

