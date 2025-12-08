'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import type { Concept } from '@/lib/types'

// Dynamically import to avoid SSR issues
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false
})

interface TopicNode extends Concept {
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}

interface Relationship {
  source: string
  target: string
  type: 'parent' | 'shared'
}

interface TopicMapProps {
  initialConcepts?: Concept[]
  initialRelationships?: Relationship[]
  onResetRef?: (resetFn: () => void) => void
}

export function TopicMap({ initialConcepts, initialRelationships, onResetRef }: TopicMapProps) {
  const [concepts, setConcepts] = useState<Concept[]>(initialConcepts || [])
  const [relationships, setRelationships] = useState<Relationship[]>(initialRelationships || [])
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(!initialConcepts)
  const graphRef = useRef<any>()

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

  // Initialize view to show all nodes on first load
  useEffect(() => {
    if (graphRef.current && concepts.length > 0 && !selectedNode) {
      // Wait for graph to render, then zoom to fit all nodes
      setTimeout(() => {
        if (graphRef.current) {
          graphRef.current.zoomToFit(400, 20)
        }
      }, 500)
    }
  }, [concepts, selectedNode])


  // Build graph data with initial circular layout
  const graphData = useMemo(() => {
    const nodes = concepts.map((concept, index) => {
      // Always arrange nodes in a circle initially with more spacing
      const angle = (index / concepts.length) * 2 * Math.PI - Math.PI / 2
      const radius = 400 // Larger radius for more spacing between nodes
      const node: TopicNode = {
        ...concept,
        id: concept.id,
        name: concept.name,
        slug: concept.slug,
        description: concept.description,
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle)
      }
      // Always fix nodes in their circular positions - they never move
      node.fx = node.x
      node.fy = node.y
      return node
    })

    return {
      nodes,
      links: relationships.map(rel => ({
        source: rel.source,
        target: rel.target,
        type: rel.type
      }))
    }
  }, [concepts, relationships, selectedNode, expandedNodes])

  // Handle node click - zoom into node and show related topics
  const handleNodeClick = useCallback((node: TopicNode) => {
    const wasSelected = selectedNode === node.id
    
    if (wasSelected) {
      // If clicking the same node, deselect and reset to circle
      setSelectedNode(null)
      setExpandedNodes(new Set())
      // Reset all nodes to circular positions
      graphData.nodes.forEach((n: TopicNode, index: number) => {
        const angle = (index / graphData.nodes.length) * 2 * Math.PI - Math.PI / 2
        const radius = 400
        n.fx = radius * Math.cos(angle)
        n.fy = radius * Math.sin(angle)
      })
      if (graphRef.current) {
        graphRef.current.zoomToFit(400, 20)
      }
      return
    }

    setSelectedNode(node.id)
    
    // Find related nodes (connected via links)
    const relatedNodeIds = new Set<string>()
    relationships.forEach(rel => {
      if (rel.source === node.id) {
        relatedNodeIds.add(rel.target)
      }
      if (rel.target === node.id) {
        relatedNodeIds.add(rel.source)
      }
    })

    // Expand to show related nodes
    const newExpanded = new Set(expandedNodes)
    newExpanded.add(node.id)
    setExpandedNodes(newExpanded)
    
    // Position related nodes in a circle around the selected node
    if (graphRef.current && node.x !== undefined && node.y !== undefined) {
      const relatedNodes = graphData.nodes.filter((n: TopicNode) => 
        relatedNodeIds.has(n.id)
      )
      
      // Keep selected node in its original position (don't move it)
      // The selected node stays where it is in the circle
      
      // Keep non-related nodes in their original circular positions
      graphData.nodes.forEach((n: TopicNode) => {
        if (n.id !== node.id && !relatedNodeIds.has(n.id)) {
          // Keep them in their original circle positions
          const originalIndex = concepts.findIndex(c => c.id === n.id)
          if (originalIndex >= 0) {
            const angle = (originalIndex / concepts.length) * 2 * Math.PI - Math.PI / 2
            const radius = 400
            n.fx = radius * Math.cos(angle)
            n.fy = radius * Math.sin(angle)
          }
        }
      })
      
      // Position related nodes in a circle around the selected node
      const radius = 200 // Larger radius for better spacing
      relatedNodes.forEach((relatedNode: TopicNode, index: number) => {
        const angle = (index / relatedNodes.length) * 2 * Math.PI
        const x = node.x! + radius * Math.cos(angle)
        const y = node.y! + radius * Math.sin(angle)
        
        // Fix the position of related nodes around the selected node
        relatedNode.fx = x
        relatedNode.fy = y
      })

      // Fix the selected node in its original position (don't let it move)
      const originalIndex = concepts.findIndex(c => c.id === node.id)
      if (originalIndex >= 0) {
        const angle = (originalIndex / concepts.length) * 2 * Math.PI - Math.PI / 2
        const radius = 400
        node.fx = radius * Math.cos(angle)
        node.fy = radius * Math.sin(angle)
      }

      // Center and zoom in on the selected node - keep it in original position
      setTimeout(() => {
        if (graphRef.current && node.fx !== undefined && node.fy !== undefined) {
          // Center first, then zoom - ensures proper centering
          graphRef.current.centerAt(node.fx, node.fy, 1000)
          // Wait for centering to complete, then zoom
          setTimeout(() => {
            if (graphRef.current) {
              // Zoom to a more zoomed out level to see more context
              const zoomLevel = 1.2 // More zoomed out
              graphRef.current.zoom(zoomLevel, 1000)
            }
          }, 300)
        }
      }, 200)
    }
  }, [selectedNode, expandedNodes, relationships, graphData, concepts])

  // Handle double click - navigate to topic page
  const handleNodeDoubleClick = useCallback((node: TopicNode) => {
    window.location.href = `/topics/${node.slug}`
  }, [])

  // Node color - gray out non-selected nodes
  const getNodeColor = useCallback((node: TopicNode) => {
    if (selectedNode && node.id !== selectedNode) {
      return '#d1d5db' // light gray for non-selected
    }
    return '#6b7280' // gray-500 for selected or when nothing selected
  }, [selectedNode])

  // Reset view - clear selection and return to full view
  const resetView = useCallback(() => {
    setSelectedNode(null)
    setExpandedNodes(new Set())
    // Reset all nodes to circular positions
    if (graphRef.current) {
      const nodes = graphData.nodes
      nodes.forEach((node: TopicNode, index: number) => {
        const angle = (index / nodes.length) * 2 * Math.PI - Math.PI / 2
        const radius = 400
        node.fx = radius * Math.cos(angle)
        node.fy = radius * Math.sin(angle)
      })
      // Reset zoom to show all nodes - zoom out to default view
      setTimeout(() => {
        if (graphRef.current) {
          graphRef.current.zoomToFit(400, 20)
          // Ensure we're zoomed out enough to see the full circle
          setTimeout(() => {
            if (graphRef.current) {
              const currentZoom = graphRef.current.zoom()
              if (currentZoom > 0.8) {
                // If still too zoomed in, zoom out more to show full circle
                graphRef.current.zoom(0.8, 500)
              }
            }
          }, 200)
        }
      }, 100)
    }
  }, [graphData])

  // Expose reset function to parent using ref to avoid infinite loops
  const resetViewRef = useRef<(() => void) | null>(null)
  
  // Update ref when resetView changes
  useEffect(() => {
    resetViewRef.current = resetView
  }, [resetView])
  
  // Expose reset function to parent - use a ref callback to avoid render issues
  const onResetRefRef = useRef(onResetRef)
  useEffect(() => {
    onResetRefRef.current = onResetRef
  }, [onResetRef])
  
  // Expose reset function to parent - defer to next tick to avoid render issues
  useEffect(() => {
    if (onResetRefRef.current) {
      // Use setTimeout to defer the state update until after render completes
      const timeoutId = setTimeout(() => {
        if (onResetRefRef.current) {
          onResetRefRef.current(() => {
            if (resetViewRef.current) {
              resetViewRef.current()
            }
          })
        }
      }, 0)
      
      return () => clearTimeout(timeoutId)
    }
  }, [onResetRef])

  // All nodes same standardized size
  const getNodeSize = useCallback(() => {
    return 80 // Fixed size for all nodes - increased to 80px
  }, [])

  // Link color - gray out all links when a node is selected
  const getLinkColor = useCallback((link: any) => {
    if (selectedNode) {
      // When a node is selected, gray out all links (including those connected to it)
      return '#e5e7eb' // Very light gray for all links when something is selected
    }
    return '#94a3b8' // gray for all links when nothing selected
  }, [selectedNode])

  // Custom node renderer to show text labels
  const paintNode = useCallback((node: TopicNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const label = node.name
    const size = getNodeSize()
    const isSelected = selectedNode === node.id
    const isGrayedOut = selectedNode && node.id !== selectedNode
    
    // Draw circle with appropriate color
    ctx.fillStyle = getNodeColor(node)
    ctx.beginPath()
    ctx.arc(node.x!, node.y!, size, 0, 2 * Math.PI, false)
    ctx.fill()
    
    // Draw white border
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 3 / globalScale
    ctx.stroke()
    
    // Draw text - much larger font size
    const fontSize = 18 // Large, readable font size
    ctx.font = `bold ${fontSize}px Sans-Serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = isGrayedOut ? '#9ca3af' : '#ffffff' // Gray text for grayed out nodes
    
    // Wrap text if needed (simple word wrap)
    const words = label.split(' ')
    const maxWidth = size * 1.8
    let lines: string[] = []
    let line = ''
    
    for (let i = 0; i < words.length; i++) {
      const testLine = line + words[i] + ' '
      const metrics = ctx.measureText(testLine)
      if (metrics.width > maxWidth && i > 0) {
        lines.push(line.trim())
        line = words[i] + ' '
      } else {
        line = testLine
      }
    }
    if (line.trim()) {
      lines.push(line.trim())
    }
    
    // Center text vertically - calculate proper centering
    const lineHeight = fontSize * 1.3
    const totalHeight = (lines.length - 1) * lineHeight
    const startY = node.y! - (totalHeight / 2)
    
    lines.forEach((text, index) => {
      ctx.fillText(text, node.x!, startY + (index * lineHeight))
    })
  }, [getNodeColor, getNodeSize, selectedNode])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[900px]">
        <div className="text-muted-foreground">Loading topic map...</div>
      </div>
    )
  }

  if (!concepts || concepts.length === 0) {
    return (
      <div className="flex items-center justify-center h-[900px]">
        <div className="text-muted-foreground">No topics available</div>
      </div>
    )
  }

  return (
    <div className="w-full">
      <div 
        className="border rounded-lg overflow-hidden bg-background" 
        style={{ height: '900px' }}
        onClick={(e) => {
          // If clicking on the container (not on a node), reset everything
          if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'CANVAS') {
            resetView()
          }
        }}
      >
        <ForceGraph2D
          {...({
            ref: graphRef,
            graphData: graphData as any,
            nodeCanvasObject: paintNode as any,
            nodeVal: getNodeSize,
            linkColor: getLinkColor,
            linkWidth: 2,
            linkDirectionalArrowLength: 4,
            linkDirectionalArrowRelPos: 1,
            linkCurvature: 0.1,
            minZoom: 0.5,
            maxZoom: 4,
            onNodeClick: handleNodeClick as any,
            onNodeDoubleClick: handleNodeDoubleClick as any,
            onBackgroundClick: resetView as any,
            cooldownTicks: 100,
            onEngineStop: () => {
              // Animation stopped
            },
            d3Force: {
              charge: {
                strength: (node: TopicNode) => {
                  // No charge for fixed nodes (they stay in circle)
                  if (node.fx !== null && node.fx !== undefined) {
                    return 0
                  }
                  // Strong repulsion for free nodes (related topics when expanded)
                  return -300
                },
                distanceMax: 600
              },
              link: {
                distance: 250, // Distance between connected nodes
                strength: 0.1 // Weak link strength
              },
              center: {
                strength: 0 // No center force - nodes stay in circle
              }
            }
          } as any)}
        />
      </div>

      {/* Selected node info */}
      {selectedNode && (
        <div className="mt-4 p-4 border rounded-lg bg-card">
          {(() => {
            const node = concepts.find(c => c.id === selectedNode)
            if (!node) return null
            
            const related = relationships
              .filter(rel => rel.source === node.id || rel.target === node.id)
              .map(rel => rel.source === node.id ? rel.target : rel.source)
              .map(id => concepts.find(c => c.id === id))
              .filter(Boolean) as Concept[]

            return (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-lg font-semibold">{node.name}</h3>
                  <Link
                    href={`/topics/${node.slug}`}
                    className="text-sm text-primary hover:underline"
                  >
                    View Topic →
                  </Link>
                </div>
                {node.description && (
                  <p className="text-sm text-muted-foreground mb-3">{node.description}</p>
                )}
                {related.length > 0 && (
                  <div>
                    <p className="text-sm font-medium mb-2">Related Topics:</p>
                    <div className="flex flex-wrap gap-2">
                      {related.map(rel => (
                        <Link
                          key={rel.id}
                          href={`/topics/${rel.slug}`}
                          className="text-sm px-2 py-1 bg-secondary rounded hover:bg-secondary/80 transition-colors"
                        >
                          {rel.name}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}

