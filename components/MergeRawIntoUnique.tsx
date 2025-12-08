'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Search, Plus } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface MergeRawIntoUniqueProps {
  uniqueInsightId: string
}

export function MergeRawIntoUnique({ uniqueInsightId }: MergeRawIntoUniqueProps) {
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{
    id: string
    statement: string
    sourceTitle: string
    confidence: string
    similarity?: number
  }>>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isMerging, setIsMerging] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults([])
      return
    }

    setIsSearching(true)
    setError(null)

    try {
      const response = await fetch(`/api/admin/insights/search-raw?q=${encodeURIComponent(searchQuery)}&excludeUniqueId=${uniqueInsightId}`)
      
      if (!response.ok) {
        throw new Error('Search failed')
      }

      const data = await response.json()
      setSearchResults(data.results || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setIsSearching(false)
    }
  }

  const handleMerge = async (rawInsightId: string) => {
    setIsMerging(rawInsightId)
    setError(null)

    try {
      const response = await fetch('/api/admin/insights/merge-into-unique', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawInsightId,
          uniqueInsightId
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to merge')
      }

      // Remove from search results
      setSearchResults(prev => prev.filter(r => r.id !== rawInsightId))
      setIsMerging(null)
      
      // Refresh the page to show updated raw insights
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setIsMerging(null)
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <h3 className="font-semibold mb-4">Add Raw Insight to This Unique Insight</h3>
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Search for raw insights by statement..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            <Button onClick={handleSearch} disabled={isSearching}>
              {isSearching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
            </Button>
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          {searchResults.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Found {searchResults.length} raw insight{searchResults.length !== 1 ? 's' : ''}
              </p>
              {searchResults.map((result) => (
                <Card key={result.id} className="border">
                  <CardContent className="pt-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <p className="text-sm">{result.statement}</p>
                        <div className="flex flex-wrap gap-2 mt-2">
                          <Badge variant="outline" className="text-xs">
                            {result.sourceTitle}
                          </Badge>
                          <Badge variant="outline" className="text-xs">
                            {result.confidence}
                          </Badge>
                          {result.similarity && (
                            <Badge variant="outline" className="text-xs">
                              {(result.similarity * 100).toFixed(1)}% similar
                            </Badge>
                          )}
                        </div>
                      </div>
                      <Button
                        onClick={() => handleMerge(result.id)}
                        disabled={isMerging === result.id}
                        size="sm"
                        variant="outline"
                      >
                        {isMerging === result.id ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Merging...
                          </>
                        ) : (
                          <>
                            <Plus className="mr-2 h-4 w-4" />
                            Add
                          </>
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
