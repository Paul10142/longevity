'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { InsightFilters } from './InsightFilters'

interface Insight {
  id: string
  statement: string
  context_note?: string | null
  evidence_type: string
  qualifiers?: Record<string, any>
  confidence?: 'high' | 'medium' | 'low'
  importance?: number
  actionability?: string
  primary_audience?: 'Patient' | 'Clinician' | 'Both'
  insight_type?: 'Protocol' | 'Explanation' | 'Mechanism' | 'Anecdote' | 'Warning' | 'Controversy' | 'Other'
  has_direct_quote?: boolean
  direct_quote?: string | null
  tone?: string
  locator: string
  timestamp?: string
  sharedWithSources?: string[]
  isShared?: boolean
  topics?: Array<{ id: string; name: string; slug: string }>
  referenceNumber?: number
  [key: string]: any
}

interface SourceInsightsClientProps {
  insights: Insight[]
}

// Helper to capitalize first letter of each word
const capitalizeWords = (str: string): string => {
  if (!str) return ''
  return str.split(' ').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ')
}

// Helper to format evidence type (handles camelCase like "ExpertOpinion" → "Expert Opinion")
const formatEvidenceType = (type: string): string => {
  if (!type) return ''
  // Special cases that should stay as-is or have specific formatting
  if (type === 'RCT') return 'RCT'
  if (type === 'MetaAnalysis') return 'Meta-Analysis'
  
  // Handle camelCase: insert space before capital letters, then capitalize
  const spaced = type.replace(/([a-z])([A-Z])/g, '$1 $2')
  return capitalizeWords(spaced)
}

export function SourceInsightsClient({ 
  insights
}: SourceInsightsClientProps) {
  const [filteredInsights, setFilteredInsights] = useState<Insight[]>(insights)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">
          Insights ({filteredInsights.length})
        </h2>
      </div>

      <InsightFilters 
        insights={insights} 
        onFilteredInsightsChange={setFilteredInsights}
      />

      {filteredInsights.length > 0 ? (
        filteredInsights.map((insight: Insight) => (
          <Card key={insight.id} className={insight.importance === 3 ? 'border-2 border-primary/30' : ''}>
            <CardContent className="pt-6">
              {/* Header with importance indicator */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    {/* Reference Number - Prominently displayed */}
                    {insight.referenceNumber && (
                      <Badge variant="default" className="text-xs font-mono font-bold bg-primary">
                        #{insight.referenceNumber}
                      </Badge>
                    )}
                    {/* Importance indicator (1-3 stars) */}
                    <div className="flex gap-0.5">
                      {[1, 2, 3].map((level) => (
                        <span
                          key={level}
                          className={`text-sm ${
                            level <= (insight.importance ?? 2)
                              ? 'text-primary'
                              : 'text-muted-foreground/30'
                          }`}
                        >
                          ★
                        </span>
                      ))}
                    </div>
                    {/* Insight type badge */}
                    <Badge variant="outline" className="text-xs">
                      {insight.insight_type}
                    </Badge>
                    {/* Actionability */}
                    {insight.actionability && insight.actionability !== 'Background' && (
                      <Badge 
                        variant={insight.actionability === 'High' ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {insight.actionability} Actionability
                      </Badge>
                    )}
                  </div>
                  
                  <p className="text-lg font-medium mb-2">
                    {insight.statement}
                  </p>
                  
                  {/* Direct quote if present */}
                  {insight.has_direct_quote && insight.direct_quote && (
                    <blockquote className="border-l-4 border-primary/30 pl-4 my-3 italic text-muted-foreground">
                      "{insight.direct_quote}"
                    </blockquote>
                  )}
                  
                  {insight.context_note && (
                    <p className="text-sm text-muted-foreground mb-3">
                      {insight.context_note}
                    </p>
                  )}
                  {insight.isShared && insight.sharedWithSources && insight.sharedWithSources.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-2 italic">
                      Also found in: {insight.sharedWithSources.join(', ')}
                    </p>
                  )}
                  
                  {/* Topics/Concepts this insight is connected to */}
                  {insight.topics && insight.topics.length > 0 && (
                    <div className="mt-4 pt-4 border-t">
                      <div className="flex flex-wrap gap-1">
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
                <div className="ml-4 shrink-0 flex flex-col items-end gap-1">
                  <Badge variant="outline">
                    {insight.locator}
                  </Badge>
                  {insight.timestamp && (
                    <span className="text-xs text-muted-foreground">
                      ~{insight.timestamp}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 items-center mt-4 pt-4 border-t">
                <Badge variant="secondary">
                  {formatEvidenceType(insight.evidence_type)}
                </Badge>
                <Badge
                  variant={
                    insight.confidence === "high"
                      ? "default"
                      : insight.confidence === "medium"
                      ? "secondary"
                      : "outline"
                  }
                >
                  {capitalizeWords(insight.confidence || '')} Confidence
                </Badge>
                {/* Primary audience */}
                {insight.primary_audience && insight.primary_audience !== 'Both' && (
                  <Badge variant="outline" className="text-xs">
                    For {insight.primary_audience}s
                  </Badge>
                )}
                {/* Tone */}
                {insight.tone && insight.tone !== 'Neutral' && (
                  <span className="text-xs text-muted-foreground">
                    Tone: {insight.tone}
                  </span>
                )}
              </div>

              {insight.qualifiers &&
                Object.keys(insight.qualifiers).length > 0 && (
                  <div className="mt-4 pt-4 pb-4 border-t border-b">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      {Object.entries(insight.qualifiers).map(
                        ([key, value]: [string, any]) =>
                          value && (
                            <div key={key}>
                              <strong className="capitalize">
                                {key.replace(/_/g, " ")}:
                              </strong>{" "}
                              {String(value)}
                            </div>
                          )
                      )}
                    </div>
                  </div>
                )}
            </CardContent>
          </Card>
        ))
      ) : (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              No insights match the selected filters.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
