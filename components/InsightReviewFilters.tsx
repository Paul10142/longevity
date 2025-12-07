'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

interface InsightReviewFiltersProps {
  allSources?: string[]
  allTopics?: Array<{ id: string; name: string; slug: string }>
}

export function InsightReviewFilters({ allSources = [], allTopics = [] }: InsightReviewFiltersProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isExpanded, setIsExpanded] = useState<boolean>(false)
  const [searchQuery, setSearchQuery] = useState<string>(searchParams.get('search') || '')

  // Get current filter values from URL
  const selectedSource = searchParams.get('source') || 'all'
  const selectedTopic = searchParams.get('topic') || 'all'
  const selectedActionability = searchParams.get('actionability') || 'all'
  const selectedType = searchParams.get('type') || 'all'
  const selectedEvidenceType = searchParams.get('evidenceType') || 'all'
  const selectedConfidence = searchParams.get('confidence') || 'all'

  // Sync search input with URL params when they change externally
  useEffect(() => {
    const urlSearch = searchParams.get('search') || ''
    if (urlSearch !== searchQuery) {
      setSearchQuery(urlSearch)
    }
  }, [searchParams])



  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      applyFilters()
    }
  }

  const [localFilters, setLocalFilters] = useState({
    source: selectedSource,
    topic: selectedTopic,
    actionability: selectedActionability,
    type: selectedType,
    evidenceType: selectedEvidenceType,
    confidence: selectedConfidence
  })

  // Sync local filters with URL params when they change externally
  useEffect(() => {
    setLocalFilters({
      source: selectedSource,
      topic: selectedTopic,
      actionability: selectedActionability,
      type: selectedType,
      evidenceType: selectedEvidenceType,
      confidence: selectedConfidence
    })
  }, [selectedSource, selectedTopic, selectedActionability, selectedType, selectedEvidenceType, selectedConfidence])

  const updateLocalFilter = (key: string, value: string) => {
    setLocalFilters(prev => ({ ...prev, [key]: value }))
  }

  const applyFilters = () => {
    const params = new URLSearchParams()
    
    if (searchQuery.trim()) {
      params.set('search', searchQuery.trim())
    }
    if (localFilters.source !== 'all') {
      params.set('source', localFilters.source)
    }
    if (localFilters.topic !== 'all') {
      params.set('topic', localFilters.topic)
    }
    if (localFilters.actionability !== 'all') {
      params.set('actionability', localFilters.actionability)
    }
    if (localFilters.type !== 'all') {
      params.set('type', localFilters.type)
    }
    if (localFilters.evidenceType !== 'all') {
      params.set('evidenceType', localFilters.evidenceType)
    }
    if (localFilters.confidence !== 'all') {
      params.set('confidence', localFilters.confidence)
    }

    params.set('page', '1')
    const newUrl = params.toString() ? `/admin/insights/review?${params.toString()}` : '/admin/insights/review'
    router.push(newUrl)
  }

  const hasActiveFilters = 
    searchQuery.trim() !== '' ||
    localFilters.source !== 'all' ||
    localFilters.topic !== 'all' ||
    localFilters.actionability !== 'all' ||
    localFilters.type !== 'all' ||
    localFilters.evidenceType !== 'all' ||
    localFilters.confidence !== 'all'

  const clearFilters = () => {
    setSearchQuery('')
    router.push('/admin/insights/review')
  }

  // Count active filters
  const activeFilterCount = [
    searchQuery.trim() !== '',
    localFilters.source !== 'all',
    localFilters.topic !== 'all',
    localFilters.actionability !== 'all',
    localFilters.type !== 'all',
    localFilters.evidenceType !== 'all',
    localFilters.confidence !== 'all'
  ].filter(Boolean).length

  return (
    <Card className="mb-6">
      <CardContent className="p-0">
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Search Insights</h3>
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
                className="h-8 text-xs"
              >
                <X className="h-3 w-3 mr-1" />
                Clear all
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
              className="h-8 text-xs"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="h-4 w-4 mr-1" />
                  Collapse
                </>
              ) : (
                <>
                  <ChevronDown className="h-4 w-4 mr-1" />
                  Filter
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Search input - always visible */}
        <div className="p-4 border-b">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search insights by statement, context, or quote..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyPress={handleKeyPress}
                className="pl-9"
              />
            </div>
            <Button onClick={applyFilters} size="default">
              Search
            </Button>
          </div>
          {!hasActiveFilters && (
            <p className="text-xs text-muted-foreground mt-2">
              Enter a search query or apply filters, then click Search to view insights
            </p>
          )}
        </div>
        
        {isExpanded && (
          <div className="p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {/* Source Filter */}
              <div className="space-y-2">
                <Label htmlFor="source-filter" className="text-xs font-medium">Source</Label>
                <select
                  id="source-filter"
                  value={localFilters.source}
                  onChange={(e) => updateLocalFilter('source', e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="all">All Sources</option>
                  {allSources.map(source => (
                    <option key={source} value={source}>{source}</option>
                  ))}
                </select>
              </div>

              {/* Topic Filter */}
              <div className="space-y-2">
                <Label htmlFor="topic-filter" className="text-xs font-medium">Topic</Label>
                <select
                  id="topic-filter"
                  value={localFilters.topic}
                  onChange={(e) => updateLocalFilter('topic', e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="all">All Topics</option>
                  {allTopics.map(topic => (
                    <option key={topic.id} value={topic.slug}>{topic.name}</option>
                  ))}
                </select>
              </div>

              {/* Actionability Filter */}
              <div className="space-y-2">
                <Label htmlFor="actionability-filter" className="text-xs font-medium">Actionability</Label>
                <select
                  id="actionability-filter"
                  value={localFilters.actionability}
                  onChange={(e) => updateLocalFilter('actionability', e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="all">All Levels</option>
                  <option value="High">High</option>
                  <option value="Medium">Medium</option>
                  <option value="Low">Low</option>
                  <option value="Background">Background</option>
                </select>
              </div>

              {/* Insight Type Filter */}
              <div className="space-y-2">
                <Label htmlFor="type-filter" className="text-xs font-medium">Insight Type</Label>
                <select
                  id="type-filter"
                  value={localFilters.type}
                  onChange={(e) => updateLocalFilter('type', e.target.value)}
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

              {/* Evidence Type Filter */}
              <div className="space-y-2">
                <Label htmlFor="evidence-filter" className="text-xs font-medium">Evidence Type</Label>
                <select
                  id="evidence-filter"
                  value={localFilters.evidenceType}
                  onChange={(e) => updateLocalFilter('evidenceType', e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="all">All Types</option>
                  <option value="RCT">RCT</option>
                  <option value="Cohort">Cohort</option>
                  <option value="MetaAnalysis">Meta-Analysis</option>
                  <option value="CaseSeries">Case Series</option>
                  <option value="Mechanistic">Mechanistic</option>
                  <option value="Animal">Animal</option>
                  <option value="ExpertOpinion">Expert Opinion</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              {/* Confidence Filter */}
              <div className="space-y-2">
                <Label htmlFor="confidence-filter" className="text-xs font-medium">Confidence</Label>
                <select
                  id="confidence-filter"
                  value={localFilters.confidence}
                  onChange={(e) => updateLocalFilter('confidence', e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="all">All Levels</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>

            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
