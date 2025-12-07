'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronRight, ChevronDown } from 'lucide-react'
import type { Concept } from '@/lib/types'

interface Relationship {
  source: string
  target: string
  type: 'parent' | 'shared'
}

interface TopicListViewProps {
  concepts: Concept[]
  relationships: Relationship[]
}

export function TopicListView({ concepts, relationships }: TopicListViewProps) {
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

  // Get root topics (topics without parents)
  const rootTopics = concepts.filter(c => !childMap.has(c.id))

  // Get children of a topic
  const getChildren = (topicId: string): Concept[] => {
    const childIds = parentMap.get(topicId) || []
    return childIds
      .map(id => concepts.find(c => c.id === id))
      .filter(Boolean) as Concept[]
  }

  // Get related topics (shared insights, not parent-child)
  const getRelated = (topicId: string): Concept[] => {
    return relationships
      .filter(rel => 
        rel.type === 'shared' && 
        (rel.source === topicId || rel.target === topicId)
      )
      .map(rel => rel.source === topicId ? rel.target : rel.source)
      .map(id => concepts.find(c => c.id === id))
      .filter(Boolean) as Concept[]
  }

  const toggleTopic = (topicId: string) => {
    const newExpanded = new Set(expandedTopics)
    if (newExpanded.has(topicId)) {
      newExpanded.delete(topicId)
    } else {
      newExpanded.add(topicId)
    }
    setExpandedTopics(newExpanded)
  }

  const TopicItem = ({ topic, level = 0 }: { topic: Concept; level?: number }) => {
    const children = getChildren(topic.id)
    const related = getRelated(topic.id)
    const hasChildren = children.length > 0
    const hasRelated = related.length > 0
    const isExpanded = expandedTopics.has(topic.id)
    const indent = level * 24

    return (
      <div className={`border-b last:border-b-0 ${isExpanded ? 'bg-muted/40' : ''}`}>
        <div 
          className={`flex items-center gap-2 py-3 transition-colors ${
            isExpanded 
              ? 'bg-muted/30 hover:bg-muted/40' 
              : 'hover:bg-muted/50'
          }`}
          style={{ paddingLeft: `${indent + 16}px` }}
        >
          {(hasChildren || hasRelated) && (
            <button
              onClick={() => toggleTopic(topic.id)}
              className="p-1 hover:bg-muted rounded transition-colors"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
          )}
          {!(hasChildren || hasRelated) && <div className="w-6" />}
          
          <Link
            href={`/topics/${topic.slug}`}
            className="flex-1 group"
          >
            <div className="flex-1">
              <h3 className="font-semibold group-hover:text-primary transition-colors">
                {topic.name}
              </h3>
              {topic.description && (
                <p className="text-sm text-muted-foreground mt-1">
                  {topic.description}
                </p>
              )}
            </div>
          </Link>
        </div>

        {isExpanded && (
          <div className="bg-muted/20">
            {children.length > 0 && (
              <div>
                {children.map(child => (
                  <TopicItem key={child.id} topic={child} level={level + 1} />
                ))}
              </div>
            )}
            {related.length > 0 && (
              <div>
                <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Related Topics
                </div>
                {related.map(rel => (
                  <TopicItem key={rel.id} topic={rel} level={level + 1} />
                ))}
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
    <div className="border rounded-lg bg-card overflow-hidden">
      <div className="divide-y">
        {rootTopics.map(topic => (
          <TopicItem key={topic.id} topic={topic} />
        ))}
        {/* Show topics without parents that aren't in rootTopics (orphans) */}
        {concepts
          .filter(c => !rootTopics.find(r => r.id === c.id) && !childMap.has(c.id))
          .map(topic => (
            <TopicItem key={topic.id} topic={topic} />
          ))}
      </div>
    </div>
  )
}

