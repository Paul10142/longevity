'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { CheckCircle2, XCircle, Loader2, Trash2, Edit2, Check, X } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { ReprocessButton } from '@/components/ReprocessButton'
import { Tag } from 'lucide-react'

interface ProcessingRun {
  id: string
  source_id: string
  processed_at: string
  chunks_created: number
  chunks_processed: number
  chunks_with_insights: number
  chunks_without_insights: number
  total_insights_created: number
  processing_duration_seconds: number
  status: 'processing' | 'success' | 'failed'
  error_message: string | null
}

interface ChunkWithInsights {
  id: string
  locator: string
  content: string
  run_id?: string | null
  insights: Array<{
    id: string
    statement: string
    importance?: number
    insight_type?: string
  }>
}

interface ProcessingRunsCardProps {
  sourceId: string
  processingRuns: ProcessingRun[]
  chunks: Array<{ id: string; locator: string; content: string; run_id?: string | null }>
  insightsByLocator: Record<string, Array<{ id: string; statement: string; importance?: number; insight_type?: string }>>
  hasTranscript?: boolean
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`)
  
  return parts.join(' ')
}

function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function ProcessingRunsCard({ 
  sourceId, 
  processingRuns,
  chunks,
  insightsByLocator,
  hasTranscript = false
}: ProcessingRunsCardProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    processingRuns.length > 0 ? processingRuns[0].id : null
  )
  const [expandedChunks, setExpandedChunks] = useState<Set<string>>(new Set())
  const [editingInsightId, setEditingInsightId] = useState<string | null>(null)
  const [editingStatement, setEditingStatement] = useState<string>('')
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null)
  const [deletingInsightId, setDeletingInsightId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [isAutoTagging, setIsAutoTagging] = useState(false)

  // Show card if we have runs or if transcript exists (to show reprocess button)
  if (processingRuns.length === 0 && !hasTranscript) {
    return null
  }

  const selectedRun = processingRuns.find(r => r.id === selectedRunId) || processingRuns[0]

  // Get chunks for this specific run only (filter by run_id to avoid duplicates from other runs)
  const runChunks = chunks
    .filter(chunk => {
      // If chunk has run_id, match it to selected run
      // If chunk has no run_id (old data), only include if this is the first/only run
      if (chunk.run_id) {
        return chunk.run_id === selectedRun.id
      }
      // For backward compatibility: if no run_id, only show in first run
      return processingRuns.length === 1 && processingRuns[0].id === selectedRun.id
    })
    .map(chunk => ({
      ...chunk,
      insights: insightsByLocator[chunk.locator] || []
    }))
    .sort((a, b) => {
      const aNum = parseInt(a.locator.replace('seg-', ''))
      const bNum = parseInt(b.locator.replace('seg-', ''))
      return aNum - bNum
    })

  const handleDeleteRun = async (runId: string) => {
    if (!confirm('Are you sure you want to delete this processing run? This will remove the run record, but chunks and insights will remain.')) {
      return
    }

    setDeletingRunId(runId)
    setMessage(null)

    try {
      const response = await fetch(`/api/admin/runs/${runId}/delete`, {
        method: 'POST',
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to delete run')
      }

      setMessage({ type: 'success', text: 'Run deleted successfully' })
      setTimeout(() => {
        window.location.reload()
      }, 1000)
    } catch (error) {
      console.error('Error deleting run:', error)
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to delete run'
      })
      setDeletingRunId(null)
    }
  }

  const handleEditInsight = (insight: { id: string; statement: string }) => {
    setEditingInsightId(insight.id)
    setEditingStatement(insight.statement)
  }

  const handleCancelEdit = () => {
    setEditingInsightId(null)
    setEditingStatement('')
  }

  const handleSaveEdit = async (insightId: string) => {
    if (!editingStatement.trim()) {
      setMessage({ type: 'error', text: 'Statement cannot be empty' })
      return
    }

    try {
      const response = await fetch(`/api/admin/insights/${insightId}/update`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ statement: editingStatement.trim() }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to update insight')
      }

      setMessage({ type: 'success', text: 'Insight updated successfully' })
      setEditingInsightId(null)
      setEditingStatement('')
      setTimeout(() => {
        window.location.reload()
      }, 1000)
    } catch (error) {
      console.error('Error updating insight:', error)
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to update insight'
      })
    }
  }

  const handleAutoTag = async () => {
    setIsAutoTagging(true)
    setMessage(null)

    try {
      const response = await fetch(`/api/admin/sources/${sourceId}/autotag`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to trigger auto-tagging')
      }

      const result = await response.json()
      
      setMessage({
        type: 'success',
        text: `Auto-tagging complete! Processed ${result.processed || 0} insights, tagged ${result.tagged || 0} insights.`
      })
      
      // Refresh page after a short delay to show updated tags
      setTimeout(() => {
        window.location.reload()
      }, 2000)
    } catch (error) {
      console.error('Error triggering auto-tagging:', error)
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to trigger auto-tagging. Please try again.'
      })
    } finally {
      setIsAutoTagging(false)
    }
  }

  const handleDeleteInsight = async (insightId: string) => {
    if (!confirm('Are you sure you want to delete this insight? This will hide it from all views.')) {
      return
    }

    setDeletingInsightId(insightId)
    setMessage(null)

    try {
      const response = await fetch(`/api/admin/insights/${insightId}/delete`, {
        method: 'POST',
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to delete insight')
      }

      setMessage({ type: 'success', text: 'Insight deleted successfully' })
      setTimeout(() => {
        window.location.reload()
      }, 1000)
    } catch (error) {
      console.error('Error deleting insight:', error)
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to delete insight'
      })
      setDeletingInsightId(null)
    }
  }

  return (
    <Card className="mt-3">
      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value="processing-history" className="border-none">
          <AccordionTrigger className="hover:no-underline">
            <CardHeader className="p-0">
              <CardTitle>Processing History</CardTitle>
            </CardHeader>
          </AccordionTrigger>
          <AccordionContent>
            <CardContent className="pt-6">
              {/* Reprocess Button - At the top */}
              {hasTranscript && (
                <div className={processingRuns.length > 0 ? "mb-6 pb-6 border-b" : "mb-0"}>
                  <ReprocessButton sourceId={sourceId} />
                </div>
              )}
              {processingRuns.length > 0 && (
                <>
                  {message && (
                    <Alert className={message.type === 'success' ? 'border-green-500 bg-green-50 dark:bg-green-950/20 mb-4' : 'border-red-500 bg-red-50 dark:bg-red-950/20 mb-4'}>
                      <AlertDescription className={message.type === 'success' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>
                        {message.text}
                      </AlertDescription>
                    </Alert>
                  )}
                  <Tabs value={selectedRunId || undefined} onValueChange={setSelectedRunId}>
                  <TabsList className="grid w-full" style={{ gridTemplateColumns: `repeat(${processingRuns.length}, 1fr)` }}>
                    {processingRuns.map((run, index) => (
                      <TabsTrigger key={run.id} value={run.id}>
                        Run {processingRuns.length - index}
                      </TabsTrigger>
                    ))}
                  </TabsList>

                  {processingRuns.map((run) => (
                    <TabsContent key={run.id} value={run.id} className="mt-4">

                      {/* Status Header */}
                      <Alert className={
                      run.status === 'success' 
                        ? 'border-green-500 bg-green-50 dark:bg-green-950/20' 
                        : run.status === 'processing'
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20'
                        : 'border-red-500 bg-red-50 dark:bg-red-950/20'
                    }>
                      <div className="flex items-center gap-2">
                        {run.status === 'success' ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : run.status === 'processing' ? (
                          <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        <AlertDescription className={
                          run.status === 'success' 
                            ? 'text-green-700 dark:text-green-400' 
                            : run.status === 'processing'
                            ? 'text-blue-700 dark:text-blue-400'
                            : 'text-red-700 dark:text-red-400'
                        }>
                          <strong>
                            {run.status === 'success' 
                              ? `Success: All ${run.chunks_created} chunks processed`
                              : run.status === 'processing'
                              ? `Processing: ${run.chunks_processed} of ${run.chunks_created} chunks processed`
                              : `Failed: Only ${run.chunks_processed} of ${run.chunks_created} chunks processed`
                            }
                          </strong>
                          {run.error_message && (
                            <div className="mt-2 text-sm">
                              Error: {run.error_message}
                            </div>
                          )}
                        </AlertDescription>
                      </div>
                    </Alert>

                    {/* Processing Stats */}
                    <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <div className="text-sm text-muted-foreground">Processed At</div>
                        <div className="text-sm font-medium">{formatDate(run.processed_at)}</div>
                      </div>
                      <div>
                        <div className="text-sm text-muted-foreground">Duration</div>
                        <div className="text-sm font-medium">{formatDuration(run.processing_duration_seconds)}</div>
                      </div>
                      <div>
                        <div className="text-sm text-muted-foreground">Chunks Processed</div>
                        <div className="text-sm font-medium">
                          {run.chunks_processed} / {run.chunks_created}
                        </div>
                      </div>
                      <div>
                        <div className="text-sm text-muted-foreground">Insights Created</div>
                        <div className="text-sm font-medium">{run.total_insights_created}</div>
                      </div>
                    </div>

                    {/* Detailed Stats */}
                    <div className="mt-4 p-4 bg-muted rounded-lg">
                      <div className="flex flex-col gap-2 text-sm">
                        <div>
                          <span className="text-muted-foreground">Chunks with insights:</span>{' '}
                          <span className="font-medium">{run.chunks_with_insights}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Chunks without insights:</span>{' '}
                          <span className="font-medium">{run.chunks_without_insights}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Average insights/chunk:</span>{' '}
                          <span className="font-medium">
                            {run.chunks_with_insights > 0
                              ? (run.total_insights_created / run.chunks_with_insights).toFixed(1)
                              : '0'
                            }
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="mt-6 flex gap-2 justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleAutoTag}
                        disabled={isAutoTagging}
                      >
                        {isAutoTagging ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            Tagging...
                          </>
                        ) : (
                          <>
                            <Tag className="h-4 w-4 mr-2" />
                            Auto-Tag Insights
                          </>
                        )}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteRun(run.id)}
                        disabled={deletingRunId === run.id}
                      >
                        {deletingRunId === run.id ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            Deleting...
                          </>
                        ) : (
                          <>
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete Run
                          </>
                        )}
                      </Button>
                    </div>
                    {message && (
                      <div className="mt-4">
                        <Alert className={message.type === 'success' ? 'border-green-500 bg-green-50' : 'border-red-500 bg-red-50'}>
                          {message.type === 'success' ? (
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-600" />
                          )}
                          <AlertDescription className={message.type === 'success' ? 'text-green-800' : 'text-red-800'}>
                            {message.text}
                          </AlertDescription>
                        </Alert>
                      </div>
                    )}

                    {/* Chunks and Insights - Nested Toggle */}
                    <div className="mt-6">
                      <Card>
                        <Accordion type="single" collapsible className="w-full">
                          <AccordionItem value="chunks-insights" className="border-none">
                            <AccordionTrigger className="hover:no-underline px-6">
                              <CardHeader className="p-0">
                                <CardTitle className="text-lg">Chunks & Insights</CardTitle>
                              </CardHeader>
                            </AccordionTrigger>
                            <AccordionContent>
                              <CardContent className="pt-0">
                                <Accordion type="multiple" className="space-y-2">
                                  {runChunks.map((chunk) => {
                                    const hasInsights = chunk.insights.length > 0
                                    
                                    return (
                                      <AccordionItem key={`${chunk.locator}-${chunk.id}`} value={`${chunk.locator}-${chunk.id}`} className="border rounded-lg">
                                        <AccordionTrigger className="px-4 hover:no-underline">
                                          <div className="flex items-center gap-3 w-full">
                                            <Badge variant="outline">{chunk.locator}</Badge>
                                            <span className="text-sm text-muted-foreground">
                                              {chunk.content.length} chars
                                            </span>
                                            {hasInsights && (
                                              <Badge variant="secondary" className="text-xs">
                                                {chunk.insights.length} insight{chunk.insights.length !== 1 ? 's' : ''}
                                              </Badge>
                                            )}
                                            {!hasInsights && (
                                              <Badge variant="outline" className="text-xs text-muted-foreground">
                                                No insights
                                              </Badge>
                                            )}
                                          </div>
                                        </AccordionTrigger>
                                        <AccordionContent className="px-4 pb-4">
                                          <div className="mt-4 space-y-4">
                                            {/* Chunk Content */}
                                            <div>
                                              <div className="text-xs font-semibold text-muted-foreground mb-2">Chunk Content:</div>
                                              <div className="text-sm bg-muted p-3 rounded border font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                                                {chunk.content}
                                              </div>
                                            </div>

                                            {/* Insights */}
                                            {hasInsights ? (
                                              <div>
                                                <div className="text-xs font-semibold text-muted-foreground mb-2">
                                                  Insights ({chunk.insights.length}):
                                                </div>
                                                <div className="space-y-2">
                                                  {chunk.insights.map((insight) => (
                                                    <div key={insight.id} className="p-3 bg-background border rounded hover:border-primary/50 transition-colors">
                                                      <div className="flex items-start justify-between gap-2 mb-1">
                                                        <div className="flex items-start gap-2 flex-1">
                                                          {insight.importance && (
                                                            <div className="flex gap-0.5">
                                                              {[1, 2, 3].map((level) => (
                                                                <span
                                                                  key={level}
                                                                  className={`text-xs ${
                                                                    level <= insight.importance!
                                                                      ? 'text-primary'
                                                                      : 'text-muted-foreground/30'
                                                                  }`}
                                                                >
                                                                  ★
                                                                </span>
                                                              ))}
                                                            </div>
                                                          )}
                                                          {insight.insight_type && (
                                                            <Badge variant="outline" className="text-xs">
                                                              {insight.insight_type}
                                                            </Badge>
                                                          )}
                                                        </div>
                                                        <div className="flex gap-1">
                                                          {editingInsightId === insight.id ? (
                                                            <>
                                                              <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7"
                                                                onClick={() => handleSaveEdit(insight.id)}
                                                              >
                                                                <Check className="h-3 w-3 text-green-600" />
                                                              </Button>
                                                              <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7"
                                                                onClick={handleCancelEdit}
                                                              >
                                                                <X className="h-3 w-3 text-muted-foreground" />
                                                              </Button>
                                                            </>
                                                          ) : (
                                                            <>
                                                              <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7"
                                                                onClick={() => handleEditInsight(insight)}
                                                                title="Edit insight"
                                                              >
                                                                <Edit2 className="h-3 w-3" />
                                                              </Button>
                                                              <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7 text-destructive hover:text-destructive"
                                                                onClick={() => handleDeleteInsight(insight.id)}
                                                                disabled={deletingInsightId === insight.id}
                                                                title="Delete insight"
                                                              >
                                                                {deletingInsightId === insight.id ? (
                                                                  <Loader2 className="h-3 w-3 animate-spin" />
                                                                ) : (
                                                                  <Trash2 className="h-3 w-3" />
                                                                )}
                                                              </Button>
                                                            </>
                                                          )}
                                                        </div>
                                                      </div>
                                                      {editingInsightId === insight.id ? (
                                                        <Textarea
                                                          value={editingStatement}
                                                          onChange={(e) => setEditingStatement(e.target.value)}
                                                          className="text-sm min-h-[80px] mt-2"
                                                          autoFocus
                                                        />
                                                      ) : (
                                                        <p 
                                                          className="text-sm cursor-pointer hover:text-primary transition-colors"
                                                          onClick={() => handleEditInsight(insight)}
                                                        >
                                                          {insight.statement}
                                                        </p>
                                                      )}
                                                    </div>
                                                  ))}
                                                </div>
                                              </div>
                                            ) : (
                                              <div className="text-sm text-muted-foreground italic">
                                                No insights extracted from this chunk.
                                              </div>
                                            )}
                                          </div>
                                        </AccordionContent>
                                      </AccordionItem>
                                    )
                                  })}
                                </Accordion>
                              </CardContent>
                            </AccordionContent>
                          </AccordionItem>
                        </Accordion>
                      </Card>
                    </div>
                    </TabsContent>
                  ))}
                  </Tabs>
                </>
              )}
            </CardContent>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  )
}
