'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { ReprocessButton } from '@/components/ReprocessButton'

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
  locator: string
  content: string
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
  chunks: Array<{ locator: string; content: string }>
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

  // Show card if we have runs or if transcript exists (to show reprocess button)
  if (processingRuns.length === 0 && !hasTranscript) {
    return null
  }

  const selectedRun = processingRuns.find(r => r.id === selectedRunId) || processingRuns[0]

  // Get chunks for this run (all chunks, ordered by locator)
  const runChunks = chunks
    .map(chunk => ({
      ...chunk,
      insights: insightsByLocator[chunk.locator] || []
    }))
    .sort((a, b) => {
      const aNum = parseInt(a.locator.replace('seg-', ''))
      const bNum = parseInt(b.locator.replace('seg-', ''))
      return aNum - bNum
    })

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
                  <div className="mb-2">
                    <h3 className="text-sm font-semibold mb-1">Reprocess Transcript</h3>
                    <p className="text-sm text-muted-foreground mb-4">
                      Delete existing chunks and insights, then regenerate them from the current transcript.
                    </p>
                  </div>
                  <ReprocessButton sourceId={sourceId} />
                </div>
              )}
              {processingRuns.length > 0 && (
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
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <span className="text-muted-foreground">Chunks with insights:</span>{' '}
                          <span className="font-medium">{run.chunks_with_insights}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Chunks without insights:</span>{' '}
                          <span className="font-medium">{run.chunks_without_insights}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Success rate:</span>{' '}
                          <span className="font-medium">
                            {run.chunks_created > 0 
                              ? `${Math.round((run.chunks_processed / run.chunks_created) * 100)}%`
                              : '0%'
                            }
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Avg insights/chunk:</span>{' '}
                          <span className="font-medium">
                            {run.chunks_with_insights > 0
                              ? (run.total_insights_created / run.chunks_with_insights).toFixed(1)
                              : '0'
                            }
                          </span>
                        </div>
                      </div>
                    </div>

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
                                      <AccordionItem key={chunk.locator} value={chunk.locator} className="border rounded-lg">
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
                                                    <div key={insight.id} className="p-3 bg-background border rounded">
                                                      <div className="flex items-start gap-2 mb-1">
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
                                                      <p className="text-sm">{insight.statement}</p>
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
              )}
            </CardContent>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  )
}
