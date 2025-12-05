"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Loader2, AlertCircle, CheckCircle2, RefreshCw } from "lucide-react"

interface ReprocessButtonProps {
  sourceId: string
}

type ProcessingStatus =
  | { type: 'idle' }
  | { type: 'creating'; message: string }
  | { type: 'chunking'; message: string; progress?: number; total?: number }
  | { type: 'extracting'; message: string; progress?: number; total?: number; insightsCreated?: number }
  | { type: 'success'; message: string }
  | { type: 'error'; message: string; details?: string }

export function ReprocessButton({ sourceId }: ReprocessButtonProps) {
  const [status, setStatus] = useState<ProcessingStatus>({ type: 'idle' })
  const [isProcessing, setIsProcessing] = useState(false)

  const handleReprocess = async () => {
    if (!confirm('This will delete all existing chunks and insights for this source and regenerate them from the transcript. Continue?')) {
      return
    }

    setIsProcessing(true)
    setStatus({ type: 'creating', message: 'Starting reprocessing...' })

    try {
      const response = await fetch(`/api/admin/sources/${sourceId}/reprocess`, {
        method: "POST",
        headers: {
          "Accept": "text/event-stream",
        },
      })

      if (!response.ok) {
        try {
          const error = await response.json()
          setStatus({
            type: 'error',
            message: error.error || "Failed to reprocess source",
            details: error.details || null
          })
        } catch {
          setStatus({
            type: 'error',
            message: `HTTP ${response.status}: ${response.statusText}`
          })
        }
        setIsProcessing(false)
        return
      }

      // Handle Server-Sent Events stream
      if (response.body) {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })
            const lines = chunk.split('\n')

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6))

                  if (data.status) {
                    setStatus(data.status)
                  }

                  if (data.done) {
                    if (data.status?.type === 'error') {
                      // Error occurred - don't reload, keep error visible
                      setStatus(data.status)
                      setIsProcessing(false)
                      return
                    } else {
                      // Success - reload after delay
                      setStatus({
                        type: 'success',
                        message: 'Reprocessing complete! Page will refresh...'
                      })
                      setTimeout(() => {
                        window.location.reload()
                      }, 2000)
                      return
                    }
                  }
                  
                  // Handle error status updates during processing
                  if (data.status?.type === 'error') {
                    setStatus(data.status)
                    setIsProcessing(false)
                    return
                  }
                } catch (e) {
                  console.error('Error parsing SSE data:', e)
                }
              }
            }
          }
        } catch (streamError) {
          console.error('Error reading stream:', streamError)
          setStatus({
            type: 'error',
            message: 'Error receiving progress updates',
            details: streamError instanceof Error ? streamError.message : undefined
          })
        }
      }
    } catch (error) {
      console.error("Error reprocessing source:", error)
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : "Unknown error occurred",
        details: error instanceof Error ? error.stack : undefined
      })
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <div className="space-y-4">
      <Button
        onClick={handleReprocess}
        disabled={isProcessing}
        variant="outline"
        className="w-full sm:w-auto"
      >
        {isProcessing ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Reprocessing...
          </>
        ) : (
          <>
            <RefreshCw className="mr-2 h-4 w-4" />
            Reprocess Transcript
          </>
        )}
      </Button>

      {status.type !== 'idle' && (
        <Alert className={status.type === 'error' ? 'border-red-500 bg-red-50 dark:bg-red-950/20' : status.type === 'success' ? 'border-green-500' : ''}>
          {status.type === 'error' ? (
            <AlertCircle className="h-4 w-4 text-red-500" />
          ) : status.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-green-500" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          <AlertTitle className={status.type === 'error' ? 'text-red-700 dark:text-red-400' : ''}>
            {status.type === 'creating' && 'Starting Reprocessing'}
            {status.type === 'chunking' && 'Processing Transcript'}
            {status.type === 'extracting' && 'Extracting Insights'}
            {status.type === 'success' && 'Success!'}
            {status.type === 'error' && 'Processing Failed'}
          </AlertTitle>
          <AlertDescription className={status.type === 'error' ? 'text-red-700 dark:text-red-300' : ''}>
            {status.message}
            {status.type === 'chunking' && status.total !== undefined && (
              <div className="mt-2">
                <p className="text-sm font-medium">
                  Total chunks: {status.total}
                </p>
              </div>
            )}
            {status.type === 'extracting' && status.progress !== undefined && status.total !== undefined && (
              <div className="mt-3 space-y-2">
                <div className="w-full bg-secondary rounded-full h-3">
                  <div
                    className="bg-primary h-3 rounded-full transition-all duration-300"
                    style={{ width: `${Math.min((status.progress / status.total) * 100, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="font-medium">
                    Chunks: {status.progress} / {status.total}
                  </span>
                  <span className="text-muted-foreground">
                    {Math.round((status.progress / status.total) * 100)}%
                  </span>
                </div>
                {status.insightsCreated !== undefined && (
                  <p className="text-sm text-muted-foreground">
                    Insights created: <span className="font-medium">{status.insightsCreated}</span>
                  </p>
                )}
              </div>
            )}
            {status.details && (
              <details className="mt-2 text-xs" open={status.type === 'error'}>
                <summary className="cursor-pointer font-semibold">
                  {status.type === 'error' ? 'Error Details (Click to collapse)' : 'Details'}
                </summary>
                <pre className="mt-2 p-3 bg-destructive/10 dark:bg-destructive/20 rounded overflow-auto max-h-64 text-xs">
                  {status.details}
                </pre>
              </details>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
