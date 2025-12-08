'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { LayoutGrid, List } from 'lucide-react'
import { TopicMap } from './TopicMap'
import { TopicListView } from './TopicListView'
import type { Concept } from '@/lib/types'

interface Relationship {
  source: string
  target: string
  type: 'parent' | 'shared'
}

interface TopicsViewProps {
  initialConcepts?: Concept[]
  initialRelationships?: Relationship[]
}

type ViewMode = 'map' | 'list'

export function TopicsView({ initialConcepts, initialRelationships }: TopicsViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('map')
  const [concepts, setConcepts] = useState<Concept[]>(initialConcepts || [])
  const [relationships, setRelationships] = useState<Relationship[]>(initialRelationships || [])
  const [loading, setLoading] = useState(!initialConcepts)
  const resetMapFnRef = useRef<(() => void) | null>(null)
  const [resetMapFn, setResetMapFn] = useState<(() => void) | null>(null)
  
  // Use a stable callback to set the reset function
  const handleResetRef = useCallback((resetFn: () => void) => {
    resetMapFnRef.current = resetFn
    // Update state in a way that doesn't cause render issues
    setResetMapFn(() => resetFn)
  }, [])

  // Fetch data if not provided
  useEffect(() => {
    if (!initialConcepts) {
      fetch('/api/topics/relationships')
        .then(res => res.json())
        .then(data => {
          setConcepts(data.concepts || [])
          setRelationships(data.relationships || [])
          setLoading(false)
        })
        .catch(err => {
          console.error('Error fetching topic relationships:', err)
          setLoading(false)
        })
    }
  }, [initialConcepts])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[400px]">
        <div className="text-muted-foreground">Loading topics...</div>
      </div>
    )
  }

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-end gap-4">
        <div className="flex items-center gap-4">
          {viewMode === 'map' && resetMapFn && (
            <button
              onClick={resetMapFn}
              className="px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 rounded-md transition-colors"
            >
              Reset View
            </button>
          )}
          <div className="flex items-center gap-2 border rounded-lg p-1 bg-muted/50">
          <button
            onClick={() => setViewMode('map')}
            className={`
              px-4 py-2 rounded-md text-sm font-medium transition-colors
              flex items-center gap-2
              ${viewMode === 'map'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
              }
            `}
            aria-label="Map view"
          >
            <LayoutGrid className="w-4 h-4" />
            <span className="hidden sm:inline">Map</span>
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`
              px-4 py-2 rounded-md text-sm font-medium transition-colors
              flex items-center gap-2
              ${viewMode === 'list'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
              }
            `}
            aria-label="List view"
          >
            <List className="w-4 h-4" />
            <span className="hidden sm:inline">List</span>
          </button>
          </div>
        </div>
      </div>

      {viewMode === 'map' ? (
        <TopicMap 
          initialConcepts={concepts} 
          initialRelationships={relationships}
          onResetRef={handleResetRef}
        />
      ) : (
        <TopicListView concepts={concepts} relationships={relationships} />
      )}
    </div>
  )
}

