"use client"

import { useState, useMemo } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import Link from "next/link"
import { Sparkles } from "lucide-react"
import { formatEvidenceType, capitalizeWords } from "@/lib/utils"
import type { InsightSortOption, InsightGroupOption, InsightWithMetadata } from "@/lib/types"

interface EvidenceViewProps {
  insights: any[]
}

export function EvidenceView({ insights }: EvidenceViewProps) {
  const [sortBy, setSortBy] = useState<InsightSortOption>('importance')
  const [groupBy, setGroupBy] = useState<InsightGroupOption>('source')
  const [showOnlyNew, setShowOnlyNew] = useState(false)

  // Filter insights if "show only new" is enabled
  const filteredInsights = useMemo(() => {
    if (showOnlyNew) {
      return insights.filter((insight: any) => insight.isNew)
    }
    return insights
  }, [insights, showOnlyNew])

  // Sort insights based on selected option
  const sortedInsights = useMemo(() => {
    const sorted = [...filteredInsights]
    
    switch (sortBy) {
      case 'importance':
        sorted.sort((a: any, b: any) => {
          const importanceA = a.importance ?? 2
          const importanceB = b.importance ?? 2
          return importanceB - importanceA
        })
        break
      case 'recency':
        sorted.sort((a: any, b: any) => {
          const dateA = a.created_at ? new Date(a.created_at).getTime() : 0
          const dateB = b.created_at ? new Date(b.created_at).getTime() : 0
          return dateB - dateA
        })
        break
      case 'evidence_strength':
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
        sorted.sort((a: any, b: any) => {
          const strengthA = evidenceStrength[a.evidence_type] ?? 0
          const strengthB = evidenceStrength[b.evidence_type] ?? 0
          return strengthB - strengthA
        })
        break
      case 'actionability':
        const actionabilityStrength: Record<string, number> = {
          'High': 3,
          'Medium': 2,
          'Low': 1,
          'Background': 0,
        }
        sorted.sort((a: any, b: any) => {
          const strengthA = actionabilityStrength[a.actionability] ?? 0
          const strengthB = actionabilityStrength[b.actionability] ?? 0
          return strengthB - strengthA
        })
        break
    }
    
    return sorted
  }, [filteredInsights, sortBy])

  // Group insights based on selected option
  const groupedInsights = useMemo(() => {
    if (groupBy === 'none') {
      return { 'All Insights': sortedInsights }
    }

    const groups: Record<string, any[]> = {}

    sortedInsights.forEach((insight: any) => {
      let groupKey: string

      switch (groupBy) {
        case 'source':
          groupKey = insight.source?.title || 'Unknown Source'
          break
        case 'evidence_type':
          groupKey = formatEvidenceType(insight.evidence_type)
          break
        case 'date':
          if (insight.created_at) {
            const date = new Date(insight.created_at)
            const month = date.toLocaleString('default', { month: 'long', year: 'numeric' })
            groupKey = month
          } else {
            groupKey = 'Unknown Date'
          }
          break
        default:
          groupKey = 'All Insights'
      }

      if (!groups[groupKey]) {
        groups[groupKey] = []
      }
      groups[groupKey].push(insight)
    })

    return groups
  }, [sortedInsights, groupBy, formatEvidenceType])

  const newInsightsCount = insights.filter((i: any) => i.isNew).length

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4 p-4 bg-muted/30 rounded-lg border">
        <div className="flex items-center gap-2">
          <Label htmlFor="sort-by" className="text-sm font-medium">Sort by:</Label>
          <Select value={sortBy} onValueChange={(value) => setSortBy(value as InsightSortOption)}>
            <SelectTrigger id="sort-by" className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="importance">Importance</SelectItem>
              <SelectItem value="recency">Recency</SelectItem>
              <SelectItem value="evidence_strength">Evidence Strength</SelectItem>
              <SelectItem value="actionability">Actionability</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Label htmlFor="group-by" className="text-sm font-medium">Group by:</Label>
          <Select value={groupBy} onValueChange={(value) => setGroupBy(value as InsightGroupOption)}>
            <SelectTrigger id="group-by" className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="source">Source</SelectItem>
              <SelectItem value="evidence_type">Evidence Type</SelectItem>
              <SelectItem value="date">Date</SelectItem>
              <SelectItem value="none">None</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {newInsightsCount > 0 && (
          <Button
            variant={showOnlyNew ? "default" : "outline"}
            size="sm"
            onClick={() => setShowOnlyNew(!showOnlyNew)}
            className="gap-2"
          >
            <Sparkles className="h-4 w-4" />
            New ({newInsightsCount})
          </Button>
        )}

        <div className="ml-auto text-sm text-muted-foreground">
          Showing {filteredInsights.length} of {insights.length} insights
        </div>
      </div>

      {/* Grouped Insights */}
      <div className="space-y-8">
        {Object.entries(groupedInsights).map(([groupKey, groupInsights]) => (
          <div key={groupKey}>
            {groupBy !== 'none' && (
              <div className="mb-4 flex items-center gap-2">
                <h2 className="text-2xl font-semibold">{groupKey}</h2>
                {groupBy === 'source' && groupInsights[0]?.source && (
                  <>
                    <Badge variant="secondary" className="capitalize">
                      {groupInsights[0].source.type}
                    </Badge>
                    <Link 
                      href={`/sources/${groupInsights[0].source.id}`}
                      className="text-sm text-muted-foreground hover:text-primary"
                    >
                      View source →
                    </Link>
                  </>
                )}
                <Badge variant="outline" className="ml-auto">
                  {groupInsights.length} insight{groupInsights.length !== 1 ? 's' : ''}
                </Badge>
              </div>
            )}

            <div className="space-y-4">
              {groupInsights.map((insight: any) => (
                <Card key={insight.id} className={insight.importance === 3 ? 'border-2 border-primary/30' : ''}>
                  <CardContent className="pt-6">
                    {/* Header with importance indicator and metadata */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
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
                          {/* New badge */}
                          {insight.isNew && (
                            <Badge variant="default" className="text-xs gap-1">
                              <Sparkles className="h-3 w-3" />
                              New
                            </Badge>
                          )}
                          {/* Evidence Type */}
                          <Badge variant="secondary" className="text-xs">
                            {formatEvidenceType(insight.evidence_type)}
                          </Badge>
                          {/* Confidence */}
                          <Badge
                            variant={
                              insight.confidence === "high"
                                ? "default"
                                : insight.confidence === "medium"
                                ? "secondary"
                                : "outline"
                            }
                            className="text-xs"
                          >
                            {capitalizeWords(insight.confidence)} Confidence
                          </Badge>
                          {/* Insight type badge */}
                          <Badge variant="outline" className="text-xs">
                            {insight.insight_type || 'Explanation'}
                          </Badge>
                          {/* Actionability */}
                          {insight.actionability && (
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
                        
                        
                        {insight.context_note && (
                          <p className="text-sm text-muted-foreground mb-3">
                            {insight.context_note}
                          </p>
                        )}
                      </div>
                      <div className="ml-4 shrink-0">
                        <Badge variant="outline">
                          {insight.locator}
                        </Badge>
                      </div>
                    </div>

                    {/* Primary audience - only show if not Both */}
                    {insight.primary_audience && insight.primary_audience !== 'Both' && (
                      <div className="mt-3">
                        <Badge variant="outline" className="text-xs">
                          For {insight.primary_audience}s
                        </Badge>
                      </div>
                    )}

                    {insight.qualifiers &&
                      Object.keys(insight.qualifiers).length > 0 && (
                        <div className="mt-4 pt-4 border-t">
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
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

