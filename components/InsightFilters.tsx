'use client'

import { useState, useMemo, useEffect } from 'react'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface Insight {
  id: string
  topics?: Array<{ id: string; name: string; slug: string }>
  confidence?: 'high' | 'medium' | 'low'
  insight_type?: 'Protocol' | 'Explanation' | 'Mechanism' | 'Anecdote' | 'Warning' | 'Controversy' | 'Other'
  primary_audience?: 'Patient' | 'Clinician' | 'Both'
  [key: string]: any
}

interface InsightFiltersProps {
  insights: Insight[]
  onFilteredInsightsChange: (filtered: Insight[]) => void
}

export function InsightFilters({ insights, onFilteredInsightsChange }: InsightFiltersProps) {
  const [isExpanded, setIsExpanded] = useState<boolean>(false)
  const [selectedTopic, setSelectedTopic] = useState<string>('all')
  const [selectedConfidence, setSelectedConfidence] = useState<string>('all')
  const [selectedType, setSelectedType] = useState<string>('all')
  const [selectedAudience, setSelectedAudience] = useState<string>('all')

  // Extract unique values for filter options
  const allTopics = useMemo(() => {
    const topicSet = new Set<string>()
    insights.forEach(insight => {
      insight.topics?.forEach(topic => {
        if (topic?.name) {
          topicSet.add(topic.name)
        }
      })
    })
    return Array.from(topicSet).sort()
  }, [insights])

  const filteredInsights = useMemo(() => {
    return insights.filter(insight => {
      // Filter by topic
      if (selectedTopic !== 'all') {
        const hasTopic = insight.topics?.some(topic => topic.name === selectedTopic)
        if (!hasTopic) return false
      }

      // Filter by confidence
      if (selectedConfidence !== 'all') {
        if (insight.confidence !== selectedConfidence) return false
      }

      // Filter by insight type
      if (selectedType !== 'all') {
        if (insight.insight_type !== selectedType) return false
      }

      // Filter by primary audience
      if (selectedAudience !== 'all') {
        if (insight.primary_audience !== selectedAudience) return false
      }

      return true
    })
  }, [insights, selectedTopic, selectedConfidence, selectedType, selectedAudience])

  // Notify parent of filtered insights
  useEffect(() => {
    onFilteredInsightsChange(filteredInsights)
  }, [filteredInsights, onFilteredInsightsChange])

  const hasActiveFilters = 
    selectedTopic !== 'all' ||
    selectedConfidence !== 'all' ||
    selectedType !== 'all' ||
    selectedAudience !== 'all'

  const clearFilters = () => {
    setSelectedTopic('all')
    setSelectedConfidence('all')
    setSelectedType('all')
    setSelectedAudience('all')
  }

  // Count active filters
  const activeFilterCount = [
    selectedTopic !== 'all',
    selectedConfidence !== 'all',
    selectedType !== 'all',
    selectedAudience !== 'all'
  ].filter(Boolean).length

  return (
    <div className="space-y-4 mb-6 border rounded-lg bg-white">
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold leading-none">Filter Insights</h3>
          {activeFilterCount > 0 && (
            <Badge variant="secondary" className="text-xs">
              {activeFilterCount} active
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-7 text-xs"
            >
              Clear filters
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsExpanded(!isExpanded)}
            className="h-7 text-xs"
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-4 w-4 mr-1" />
                Collapse
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4 mr-1" />
                Expand
              </>
            )}
          </Button>
        </div>
      </div>
      
      {isExpanded && (
        <div className="px-4 pb-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Topic Filter */}
        <div className="space-y-2">
          <Label htmlFor="topic-filter" className="text-xs">Topic</Label>
          <select
            id="topic-filter"
            value={selectedTopic}
            onChange={(e) => setSelectedTopic(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="all">All Topics</option>
            {allTopics.map(topic => (
              <option key={topic} value={topic}>{topic}</option>
            ))}
          </select>
        </div>

        {/* Confidence Filter */}
        <div className="space-y-2">
          <Label htmlFor="confidence-filter" className="text-xs">Confidence</Label>
          <select
            id="confidence-filter"
            value={selectedConfidence}
            onChange={(e) => setSelectedConfidence(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="all">All Confidence Levels</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        {/* Type of Opinion Filter */}
        <div className="space-y-2">
          <Label htmlFor="type-filter" className="text-xs">Type of Opinion</Label>
          <select
            id="type-filter"
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="all">All Types</option>
            <option value="Protocol">Protocol</option>
            <option value="Explanation">Explanation</option>
            <option value="Mechanism">Mechanism</option>
            <option value="Anecdote">Anecdote</option>
            <option value="Warning">Warning</option>
            <option value="Controversy">Controversy</option>
            <option value="Other">Other</option>
          </select>
        </div>

        {/* Who's It For Filter */}
        <div className="space-y-2">
          <Label htmlFor="audience-filter" className="text-xs">Who's It For</Label>
          <select
            id="audience-filter"
            value={selectedAudience}
            onChange={(e) => setSelectedAudience(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <option value="all">All Audiences</option>
            <option value="Patient">Patient</option>
            <option value="Clinician">Clinician</option>
            <option value="Both">Both</option>
          </select>
        </div>
      </div>

        {hasActiveFilters && (
          <div className="pt-4 border-t mt-4">
            <p className="text-xs text-muted-foreground">
              Showing {filteredInsights.length} of {insights.length} insights
            </p>
          </div>
        )}
        </div>
      )}
    </div>
  )
}
