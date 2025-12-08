'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Clock, CheckCircle2, XCircle } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface ProgressState {
  stage: 'idle' | 'embeddings' | 'clustering' | 'complete'
  embeddings: {
    total: number
    processed: number
    errors: number
  }
  clustering: {
    total: number
    processed: number
    clustersCreated: number
    membersAdded: number
    mergeIntoUniqueSuggestions: number
    errors: number
    batchesProcessed: number
  }
  message?: string
}

interface JobStatus {
  currentJob: {
    id: string
    started_at: string
    completed_at: string | null
    status: 'processing' | 'completed' | 'failed'
    embeddings_total: number
    embeddings_processed: number
    embeddings_errors: number
    clustering_total: number
    clustering_processed: number
    clusters_created: number
    members_added: number
    merge_into_unique_suggestions: number
    clustering_errors: number
    batches_processed: number
    error_message: string | null
  } | null
  needsEmbeddings: boolean
  missingEmbeddingsCount: number
  needsClustering: boolean
  unclusteredInsightsCount: number
}

export function ClusterAllButton() {
  const router = useRouter()
  const [isClustering, setIsClustering] = useState(false)
  const [progress, setProgress] = useState<ProgressState>({
    stage: 'idle',
    embeddings: { total: 0, processed: 0, errors: 0 },
    clustering: { total: 0, processed: 0, clustersCreated: 0, membersAdded: 0, mergeIntoUniqueSuggestions: 0, errors: 0, batchesProcessed: 0 }
  })
  const [error, setError] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null)
  const [isLoadingStatus, setIsLoadingStatus] = useState(true)

  // Fetch job status on mount and periodically
  useEffect(() => {
    let isMounted = true
    
    const fetchStatus = async () => {
      try {
        const response = await fetch('/api/admin/insights/cluster-all/status')
        if (!response.ok) {
          throw new Error(`Status check failed: ${response.status}`)
        }
        const data = await response.json()
        
        if (!isMounted) return
        
        setJobStatus(data)
        
        // If there's a processing job, load its progress (but only if we're not actively streaming)
        if (data.currentJob && data.currentJob.status === 'processing' && !isClustering) {
          setProgress({
            stage: 'clustering', // Will show both if embeddings were done
            embeddings: {
              total: data.currentJob.embeddings_total,
              processed: data.currentJob.embeddings_processed,
              errors: data.currentJob.embeddings_errors
            },
            clustering: {
              total: data.currentJob.clustering_total,
              processed: data.currentJob.clustering_processed,
              clustersCreated: data.currentJob.clusters_created,
              membersAdded: data.currentJob.members_added,
              mergeIntoUniqueSuggestions: data.currentJob.merge_into_unique_suggestions,
              errors: data.currentJob.clustering_errors,
              batchesProcessed: data.currentJob.batches_processed
            }
          })
          setIsClustering(true)
        }
      } catch (err) {
        console.error('Error fetching job status:', err)
        // Don't set error state for status polling failures - just log
      } finally {
        if (isMounted) {
          setIsLoadingStatus(false)
        }
      }
    }

    fetchStatus()
    
    // Poll every 5 seconds if there's a processing job, but NOT if we're actively streaming (isClustering from SSE)
    const interval = setInterval(() => {
      // Only poll if we're not actively streaming progress via SSE
      if (!isClustering && (jobStatus?.currentJob?.status === 'processing' || !jobStatus)) {
        fetchStatus()
      }
    }, 5000)

    return () => {
      isMounted = false
      clearInterval(interval)
    }
  }, [jobStatus?.currentJob?.status, isClustering])

  const handleClusterAll = async () => {
    setIsClustering(true)
    setError(null)
    // Don't reset progress immediately - let it update from SSE
    // But initialize if needed
    if (progress.stage === 'idle') {
      setProgress({
        stage: 'embeddings',
        embeddings: { total: 0, processed: 0, errors: 0 },
        clustering: { total: 0, processed: 0, clustersCreated: 0, membersAdded: 0, mergeIntoUniqueSuggestions: 0, errors: 0, batchesProcessed: 0 }
      })
    }

    try {
      const response = await fetch('/api/admin/insights/cluster-all', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream'
        },
        body: JSON.stringify({ batchSize: 500, maxBatches: 10, skipEmbeddings: false })
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to start clustering' }))
        throw new Error(errorData.error || 'Failed to cluster insights')
      }

      // Handle Server-Sent Events stream
      if (response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let readerClosed = false
        
        const cleanup = () => {
          if (!readerClosed) {
            readerClosed = true
            reader.cancel().catch(() => {
              // Ignore errors when canceling
            })
          }
        }
        
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              cleanup()
              break
            }
            
            const chunk = decoder.decode(value, { stream: true })
            const lines = chunk.split('\n')
            
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6))
                  
                  if (data.done) {
                    cleanup()
                    setProgress(prev => ({
                      ...prev,
                      stage: 'complete',
                      message: data.message
                    }))
                    // Refresh the page after a short delay to show new clusters
                    setTimeout(() => {
                      router.refresh()
                    }, 2000)
                    setIsClustering(false)
                    return
                  }
                  
                  if (data.error) {
                    cleanup()
                    throw new Error(data.error)
                  }
                  
                  if (data.stage === 'embeddings') {
                    setProgress(prev => ({
                      ...prev,
                      stage: data.complete ? 'clustering' : 'embeddings',
                      embeddings: {
                        total: data.total || prev.embeddings.total,
                        processed: data.processed || prev.embeddings.processed,
                        errors: data.errors || prev.embeddings.errors
                      },
                      message: data.message
                    }))
                  } else if (data.stage === 'clustering') {
                    setProgress(prev => ({
                      ...prev,
                      stage: data.complete ? 'complete' : 'clustering',
                      clustering: {
                        total: data.total !== undefined ? data.total : prev.clustering.total,
                        processed: data.processed !== undefined ? data.processed : prev.clustering.processed,
                        clustersCreated: data.clustersCreated !== undefined ? data.clustersCreated : prev.clustering.clustersCreated,
                        membersAdded: data.membersAdded !== undefined ? data.membersAdded : prev.clustering.membersAdded,
                        mergeIntoUniqueSuggestions: data.mergeIntoUniqueSuggestions !== undefined ? data.mergeIntoUniqueSuggestions : prev.clustering.mergeIntoUniqueSuggestions,
                        errors: data.errors !== undefined ? data.errors : prev.clustering.errors,
                        batchesProcessed: data.batchesProcessed !== undefined ? data.batchesProcessed : prev.clustering.batchesProcessed
                      }
                    }))
                    
                    if (data.complete) {
                      setProgress(prev => ({
                        ...prev,
                        message: `Generated ${prev.embeddings.processed} embeddings, processed ${prev.clustering.processed} insights, created ${prev.clustering.clustersCreated} clusters, ${prev.clustering.mergeIntoUniqueSuggestions} merge-into-unique suggestions`
                      }))
                      // Refresh job status to get final results
                      setTimeout(async () => {
                        try {
                          const statusResponse = await fetch('/api/admin/insights/cluster-all/status')
                          if (statusResponse.ok) {
                            const statusData = await statusResponse.json()
                            setJobStatus(statusData)
                          }
                        } catch (err) {
                          console.error('Error refreshing job status:', err)
                        }
                        router.refresh()
                      }, 2000)
                      setIsClustering(false)
                    }
                  }
                } catch (e) {
                  console.error('Error parsing SSE data:', e)
                }
              }
            }
          }
        } catch (streamError) {
          cleanup()
          console.error('Error reading stream:', streamError)
          setIsClustering(false)
          setError(streamError instanceof Error ? streamError.message : 'Failed to process clustering job')
        }
      } else {
        // Fallback: regular JSON response (shouldn't happen with streaming)
        const data = await response.json()
        setProgress(prev => ({
          ...prev,
          stage: 'complete',
          message: data.message
        }))
        setTimeout(() => {
          router.refresh()
        }, 2000)
        setIsClustering(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setIsClustering(false)
    }
  }

  const embeddingsProgress = progress.embeddings.total > 0 
    ? (progress.embeddings.processed / progress.embeddings.total) * 100 
    : 0
  
  const clusteringProgress = progress.clustering.total > 0 
    ? (progress.clustering.processed / progress.clustering.total) * 100 
    : 0

  const currentJob = jobStatus?.currentJob
  const isJobRunning = currentJob?.status === 'processing'

  return (
    <div className="space-y-4">
      {/* Current Job Status - Always show if we have data */}
      {!isLoadingStatus && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Job Status</CardTitle>
              {currentJob ? (
                <Badge variant={
                  currentJob.status === 'processing' ? 'secondary' :
                  currentJob.status === 'completed' ? 'default' :
                  'destructive'
                }>
                  {currentJob.status === 'processing' && <Clock className="mr-1 h-3 w-3" />}
                  {currentJob.status === 'completed' && <CheckCircle2 className="mr-1 h-3 w-3" />}
                  {currentJob.status === 'failed' && <XCircle className="mr-1 h-3 w-3" />}
                  {currentJob.status}
                </Badge>
              ) : (
                <Badge variant="outline">No active job</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {currentJob ? (
              <>
                <div className="text-sm text-muted-foreground">
                  Started: {new Date(currentJob.started_at).toLocaleString()}
                  {currentJob.completed_at && (
                    <> • Completed: {new Date(currentJob.completed_at).toLocaleString()}</>
                  )}
                </div>
                
                {currentJob.status === 'processing' && (
                  <div className="space-y-4">
                    {currentJob.embeddings_total > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span>Embeddings</span>
                          <span>{currentJob.embeddings_processed} / {currentJob.embeddings_total}</span>
                        </div>
                        <Progress value={(currentJob.embeddings_processed / currentJob.embeddings_total) * 100} />
                      </div>
                    )}
                    {currentJob.clustering_total > 0 && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span>Clustering</span>
                          <span>{currentJob.clustering_processed} / {currentJob.clustering_total}</span>
                        </div>
                        <Progress value={(currentJob.clustering_processed / currentJob.clustering_total) * 100} />
                      </div>
                    )}
                  </div>
                )}
                
                {currentJob.status === 'completed' && (
                  <div className="text-sm space-y-1">
                    <div>Embeddings: {currentJob.embeddings_processed} / {currentJob.embeddings_total}</div>
                    <div>Clustering: {currentJob.clustering_processed} / {currentJob.clustering_total}</div>
                    <div>Clusters created: {currentJob.clusters_created}</div>
                    <div>Merge suggestions: {currentJob.merge_into_unique_suggestions}</div>
                  </div>
                )}
                
                {currentJob.status === 'failed' && currentJob.error_message && (
                  <div className="text-sm text-red-600 dark:text-red-400">
                    Error: {currentJob.error_message}
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm text-muted-foreground">
                No clustering job has been run yet. Click "Cluster All Insights" to start.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Needs Processing Info */}
      {!isLoadingStatus && jobStatus && !isJobRunning && (
        <Card>
          <CardContent className="pt-6">
            <div className="text-sm space-y-2">
              {jobStatus.needsEmbeddings && (
                <div className="text-muted-foreground">
                  {jobStatus.missingEmbeddingsCount} insights need embeddings
                </div>
              )}
              {jobStatus.needsClustering && (
                <div className="text-muted-foreground">
                  {jobStatus.unclusteredInsightsCount} insights need clustering
                </div>
              )}
              {!jobStatus.needsEmbeddings && !jobStatus.needsClustering && (
                <div className="text-green-600 dark:text-green-400">
                  All insights are up to date!
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Button
        onClick={handleClusterAll}
        disabled={isClustering || isJobRunning}
        variant="default"
      >
        {isClustering || isJobRunning ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Processing...
          </>
        ) : (
          'Cluster All Insights'
        )}
      </Button>

      {isClustering && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Processing Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Embeddings Progress */}
            {(progress.stage === 'embeddings' || progress.stage === 'clustering' || progress.stage === 'complete') && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">Generating Embeddings</span>
                  <span className="text-muted-foreground">
                    {progress.embeddings.processed} / {progress.embeddings.total}
                    {progress.embeddings.errors > 0 && ` (${progress.embeddings.errors} errors)`}
                  </span>
                </div>
                <Progress value={embeddingsProgress} />
                {progress.embeddings.total === 0 && (progress.stage === 'embeddings' || progress.stage === 'clustering' || progress.stage === 'complete') && (
                  <p className="text-xs text-muted-foreground">All insights already have embeddings</p>
                )}
              </div>
            )}

            {/* Clustering Progress */}
            {(progress.stage === 'clustering' || progress.stage === 'complete') && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">Clustering Insights</span>
                  <span className="text-muted-foreground">
                    {progress.clustering.processed} / {progress.clustering.total}
                    {progress.clustering.errors > 0 && ` (${progress.clustering.errors} errors)`}
                  </span>
                </div>
                <Progress value={clusteringProgress} />
                <div className="grid grid-cols-2 gap-4 text-xs text-muted-foreground mt-2">
                  <div>Clusters created: <span className="font-medium">{progress.clustering.clustersCreated}</span></div>
                  <div>Members added: <span className="font-medium">{progress.clustering.membersAdded}</span></div>
                  <div>Merge suggestions: <span className="font-medium">{progress.clustering.mergeIntoUniqueSuggestions}</span></div>
                  <div>Batches: <span className="font-medium">{progress.clustering.batchesProcessed}</span></div>
                </div>
              </div>
            )}

            {progress.message && (
              <p className="text-sm text-green-600 dark:text-green-400">{progress.message}</p>
            )}
          </CardContent>
        </Card>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  )
}
