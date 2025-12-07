'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import type { Concept } from '@/lib/types'

interface Relationship {
  source: string
  target: string
  type: 'parent' | 'shared'
}

interface TopicMapViewProps {
  concepts: Concept[]
  relationships: Relationship[]
}

export function TopicMapView({ concepts, relationships }: TopicMapViewProps) {
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null)
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set())

  // Build parent-child hierarchy
  const parentMap = new Map<string, string[]>() // parent -> children
  const childMap = new Map<string, string>() // child -> parent
  
  relationships
    .filter(rel => rel.type === 'parent')
    .forEach(rel => {
      if (!parentMap.has(rel.source)) {
        parentMap.set(rel.source, [])
      }
      parentMap.get(rel.source)!.push(rel.target)
      childMap.set(rel.target, rel.source)
    })

  // Build shared relationships map
  const sharedMap = new Map<string, string[]>() // topic -> related topics
  
  relationships
    .filter(rel => rel.type === 'shared')
    .forEach(rel => {
      if (!sharedMap.has(rel.source)) {
        sharedMap.set(rel.source, [])
      }
      if (!sharedMap.has(rel.target)) {
        sharedMap.set(rel.target, [])
      }
      sharedMap.get(rel.source)!.push(rel.target)
      sharedMap.get(rel.target)!.push(rel.source)
    })

  // Get root topics (topics without parents)
  const rootTopics = useMemo(() => 
    concepts.filter(c => !childMap.has(c.id)),
    [concepts, childMap]
  )

  // Get children of a topic
  const getChildren = (topicId: string): Concept[] => {
    const childIds = parentMap.get(topicId) || []
    return childIds
      .map(id => concepts.find(c => c.id === id))
      .filter(Boolean) as Concept[]
  }

  // Get related topics (shared insights)
  const getRelated = (topicId: string): Concept[] => {
    const relatedIds = sharedMap.get(topicId) || []
    return relatedIds
      .map(id => concepts.find(c => c.id === id))
      .filter(Boolean) as Concept[]
  }

  const handleTopicClick = (topicId: string) => {
    if (selectedTopic === topicId) {
      setSelectedTopic(null)
      const newExpanded = new Set(expandedTopics)
      newExpanded.delete(topicId)
      setExpandedTopics(newExpanded)
    } else {
      setSelectedTopic(topicId)
      const newExpanded = new Set(expandedTopics)
      newExpanded.add(topicId)
      setExpandedTopics(newExpanded)
    }
  }

  const TopicBox = ({ topic, level = 0, isChild = false }: { 
    topic: Concept
    level?: number
    isChild?: boolean
  }) => {
    const children = getChildren(topic.id)
    const related = getRelated(topic.id)
    const isSelected = selectedTopic === topic.id
    const isExpanded = expandedTopics.has(topic.id)
    const hasChildren = children.length > 0
    const hasRelated = related.length > 0

    return (
      <div className="relative">
        <div
          onClick={() => handleTopicClick(topic.id)}
          className={`
            rounded-lg border-2 p-4 cursor-pointer transition-all
            ${isSelected 
              ? 'border-primary bg-primary/5 shadow-md' 
              : 'border-border bg-card hover:border-primary/50 hover:shadow-sm'
            }
            ${isChild ? 'ml-8 mt-3' : ''}
          `}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-base mb-1">{topic.name}</h3>
              {topic.description && (
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {topic.description}
                </p>
              )}
              {(hasChildren || hasRelated) && (
                <div className="mt-2 flex flex-wrap gap-1 text-xs text-muted-foreground">
                  {hasChildren && (
                    <span className="px-2 py-0.5 bg-muted rounded">
                      {children.length} subtopic{children.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {hasRelated && (
                    <span className="px-2 py-0.5 bg-muted rounded">
                      {related.length} related
                    </span>
                  )}
                </div>
              )}
            </div>
            <Link
              href={`/topics/${topic.slug}`}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 text-sm text-primary hover:underline whitespace-nowrap"
            >
              View →
            </Link>
          </div>
        </div>

        {/* Show children and related when expanded */}
        {isExpanded && (
          <div className="mt-4 space-y-3">
            {hasChildren && (
              <div>
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 px-2">
                  Subtopics
                </div>
                <div className="space-y-3">
                  {children.map(child => (
                    <TopicBox key={child.id} topic={child} level={level + 1} isChild />
                  ))}
                </div>
              </div>
            )}
            {hasRelated && (
              <div>
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 px-2">
                  Related Topics
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {related.map(rel => (
                    <TopicBox key={rel.id} topic={rel} level={level + 1} isChild />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (concepts.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No topics available
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {rootTopics.map(topic => (
        <TopicBox key={topic.id} topic={topic} />
      ))}
      {/* Show orphan topics (no parent, not in root) */}
      {concepts
        .filter(c => !rootTopics.find(r => r.id === c.id) && !childMap.has(c.id))
        .map(topic => (
          <TopicBox key={topic.id} topic={topic} />
        ))}
    </div>
  )
}

