/**
 * Insight Prioritization System
 * 
 * Implements tiered prioritization for protocol/article generation that:
 * - Ensures new insights (last 30 days) are always included
 * - Limits insights sent to OpenAI to ~350 (stays within token limits)
 * - Uses composite scoring (importance + actionability + evidence strength + recency)
 */

import type { Insight } from './pipeline'

// Extended Insight type with database fields
export interface InsightForPrioritization extends Insight {
  id: string
  created_at?: string
}

export type PrioritizedInsights = {
  tier1: InsightForPrioritization[] // Core insights (~150): Top 100 by score + all recent insights
  tier2: InsightForPrioritization[] // Supporting insights (~200): Next 200 by score
  tier3: InsightForPrioritization[] // Reference insights (remaining): Not sent to OpenAI
  totalCount: number
  tier1Count: number
  tier2Count: number
  tier3Count: number
}

interface InsightWithScore extends InsightForPrioritization {
  score: number
  isRecent: boolean
}

/**
 * Calculate composite score for an insight
 * Higher score = higher priority for generation
 */
function calculateInsightScore(insight: InsightForPrioritization, isRecent: boolean): number {
  // Importance: 1, 2, or 3 (default 2)
  const importance = insight.importance ?? 2
  const importanceScore = importance * 10

  // Actionability: Background=0, Low=1, Medium=2, High=3
  const actionabilityScores: Record<string, number> = {
    'Background': 0,
    'Low': 1,
    'Medium': 2,
    'High': 3,
  }
  const actionability = insight.actionability || 'Medium'
  const actionabilityScore = (actionabilityScores[actionability] ?? 2) * 5

  // Evidence strength: Higher quality evidence = higher score
  const evidenceStrength: Record<string, number> = {
    'MetaAnalysis': 5,
    'RCT': 4,
    'Cohort': 3,
    'CaseSeries': 2,
    'Other': 1,
    'Mechanistic': 1,
    'Animal': 1,
    'ExpertOpinion': 0,
  }
  const evidenceType = insight.evidence_type || 'Other'
  const evidenceScore = (evidenceStrength[evidenceType] ?? 1) * 3

  // Recency bonus: Recent insights get +5 points
  const recencyScore = isRecent ? 5 : 0

  return importanceScore + actionabilityScore + evidenceScore + recencyScore
}

/**
 * Prioritize insights for protocol/article generation
 * 
 * @param insights - All insights for a concept
 * @param maxCount - Maximum insights to include in Tier 1 + Tier 2 (default 350)
 * @param audience - Optional audience filter ('patient' or 'clinician')
 * @returns Prioritized insights split into tiers
 */
export function prioritizeInsightsForGeneration(
  insights: InsightForPrioritization[],
  maxCount: number = 350,
  audience?: 'patient' | 'clinician'
): PrioritizedInsights {
  if (insights.length === 0) {
    return {
      tier1: [],
      tier2: [],
      tier3: [],
      totalCount: 0,
      tier1Count: 0,
      tier2Count: 0,
      tier3Count: 0,
    }
  }

  // Calculate 30 days ago for "recent" detection
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  // Filter by audience if specified
  let filteredInsights = insights
  if (audience) {
    // Convert lowercase audience to capitalized format used in primary_audience
    const audienceCapitalized = audience === 'patient' ? 'Patient' : 'Clinician'
    filteredInsights = insights.filter(insight => {
      const primaryAudience = insight.primary_audience || 'Both'
      return primaryAudience === audienceCapitalized || primaryAudience === 'Both'
    })
  }

  // Calculate scores and mark recent insights
  const insightsWithScores: InsightWithScore[] = filteredInsights.map(insight => {
    const insightCreatedAt = insight.created_at ? new Date(insight.created_at) : null
    const isRecent = insightCreatedAt ? insightCreatedAt >= thirtyDaysAgo : false
    const score = calculateInsightScore(insight, isRecent)
    
    return {
      ...insight,
      score,
      isRecent,
    }
  })

  // Sort by score (descending)
  insightsWithScores.sort((a, b) => b.score - a.score)

  // Tier 1: Top 100 by score + all recent insights (up to 50 additional)
  const top100ByScore = insightsWithScores.slice(0, 100)
  const recentInsights = insightsWithScores.filter(i => i.isRecent && !top100ByScore.includes(i))
  const additionalRecent = recentInsights.slice(0, 50) // Max 50 additional recent insights
  const tier1 = [...top100ByScore, ...additionalRecent]
  // Deduplicate (in case a recent insight was already in top 100)
  const tier1Ids = new Set(tier1.map(i => i.id))
  const tier1Deduplicated = tier1.filter((insight, index, self) => 
    index === self.findIndex(i => i.id === insight.id)
  )

  // Tier 2: Next insights by score (up to maxCount - tier1Count)
  const tier1IdsSet = new Set(tier1Deduplicated.map(i => i.id))
  const remainingForTier2 = insightsWithScores.filter(i => !tier1IdsSet.has(i.id))
  const tier2Max = Math.max(0, maxCount - tier1Deduplicated.length)
  const tier2 = remainingForTier2.slice(0, tier2Max)

  // Tier 3: All remaining insights
  const tier1And2Ids = new Set([...tier1Deduplicated, ...tier2].map(i => i.id))
  const tier3 = insightsWithScores.filter(i => !tier1And2Ids.has(i.id))

  return {
    tier1: tier1Deduplicated.map(({ score, isRecent, ...insight }) => insight),
    tier2: tier2.map(({ score, isRecent, ...insight }) => insight),
    tier3: tier3.map(({ score, isRecent, ...insight }) => insight),
    totalCount: filteredInsights.length,
    tier1Count: tier1Deduplicated.length,
    tier2Count: tier2.length,
    tier3Count: tier3.length,
  }
}

/**
 * Get insights to send to OpenAI for generation
 * Combines Tier 1 and Tier 2 insights
 */
export function getInsightsForGeneration(prioritized: PrioritizedInsights): InsightForPrioritization[] {
  return [...prioritized.tier1, ...prioritized.tier2]
}

