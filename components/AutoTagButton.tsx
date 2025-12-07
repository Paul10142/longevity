'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, CheckCircle2, AlertCircle, Tag } from 'lucide-react'

export function AutoTagButton() {
  const [isLoading, setIsLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const handleAutoTag = async () => {
    setIsLoading(true)
    setMessage(null)

    try {
      const response = await fetch('/api/admin/insights/autotag-batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ limit: 200 }), // Process up to 200 insights
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
    } catch (error) {
      console.error('Error triggering auto-tagging:', error)
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to trigger auto-tagging. Please try again.'
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-2">
      {message && (
        <Alert className={message.type === 'success' ? 'border-green-500 bg-green-50' : 'border-red-500 bg-red-50'}>
          {message.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          ) : (
            <AlertCircle className="h-4 w-4 text-red-600" />
          )}
          <AlertDescription className={message.type === 'success' ? 'text-green-800' : 'text-red-800'}>
            {message.text}
          </AlertDescription>
        </Alert>
      )}
      <Button 
        onClick={handleAutoTag} 
        disabled={isLoading}
        variant="outline"
      >
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Tagging...
          </>
        ) : (
          <>
            <Tag className="mr-2 h-4 w-4" />
            Auto-Tag Insights
          </>
        )}
      </Button>
    </div>
  )
}

