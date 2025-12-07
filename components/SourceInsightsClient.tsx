'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { InsightFilters } from './InsightFilters'
import { Edit2, Trash2, Check, X, Loader2, CheckCircle2, AlertCircle, Download } from 'lucide-react'

interface Insight {
  id: string
  statement: string
  context_note?: string | null
  evidence_type: string
  qualifiers?: Record<string, any>
  confidence?: 'high' | 'medium' | 'low'
  importance?: number
  actionability?: string
  primary_audience?: 'Patient' | 'Clinician' | 'Both'
  insight_type?: 'Protocol' | 'Explanation' | 'Mechanism' | 'Anecdote' | 'Warning' | 'Controversy' | 'Other'
  has_direct_quote?: boolean
  direct_quote?: string | null
  tone?: string
  locator: string
  timestamp?: string
  sharedWithSources?: string[]
  isShared?: boolean
  topics?: Array<{ id: string; name: string; slug: string }>
  referenceNumber?: number
  [key: string]: any
}

interface SourceInsightsClientProps {
  insights: Insight[]
  sourceId: string
}

// Helper to capitalize first letter of each word
const capitalizeWords = (str: string): string => {
  if (!str) return ''
  return str.split(' ').map(word => 
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(' ')
}

// Helper to format evidence type (handles camelCase like "ExpertOpinion" → "Expert Opinion")
const formatEvidenceType = (type: string): string => {
  if (!type) return ''
  // Special cases that should stay as-is or have specific formatting
  if (type === 'RCT') return 'RCT'
  if (type === 'MetaAnalysis') return 'Meta-Analysis'
  
  // Handle camelCase: insert space before capital letters, then capitalize
  const spaced = type.replace(/([a-z])([A-Z])/g, '$1 $2')
  return capitalizeWords(spaced)
}

export function SourceInsightsClient({ 
  insights,
  sourceId
}: SourceInsightsClientProps) {
  const [filteredInsights, setFilteredInsights] = useState<Insight[]>(insights)
  const [editingInsightId, setEditingInsightId] = useState<string | null>(null)
  const [editingStatement, setEditingStatement] = useState<string>('')
  const [deletingInsightId, setDeletingInsightId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [exporting, setExporting] = useState<'json' | 'csv' | null>(null)

  const handleExport = async (format: 'json' | 'csv') => {
    setExporting(format)
    setMessage(null)
    
    try {
      const response = await fetch(`/api/admin/insights/export?format=${format}&sourceId=${sourceId}&limit=10000`)
      
      console.log('Export response status:', response.status, 'ok:', response.ok)
      
      if (!response.ok) {
        const errorText = await response.text()
        console.error('Export error response:', errorText)
        let error
        try {
          error = JSON.parse(errorText)
        } catch {
          error = { error: errorText || 'Failed to export insights' }
        }
        throw new Error(error.error || 'Failed to export insights')
      }

      // Get the blob from the response
      let blob = await response.blob()
      
      // Verify blob has content
      if (blob.size === 0) {
        throw new Error('Export returned empty file')
      }
      
      // Ensure correct MIME type for the blob
      const mimeType = format === 'csv' 
        ? 'text/csv;charset=utf-8' 
        : 'application/json;charset=utf-8'
      
      // Recreate blob with explicit MIME type if needed
      if (!blob.type || blob.type === 'application/octet-stream') {
        blob = new Blob([blob], { type: mimeType })
      }
      
      console.log('Export blob size:', blob.size, 'type:', blob.type)
      
      // Get filename from Content-Disposition header or create a default one
      const contentDisposition = response.headers.get('Content-Disposition')
      let filename = `insights-export-${new Date().toISOString().split('T')[0]}.${format}`
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="(.+)"/)
        if (filenameMatch) {
          filename = filenameMatch[1]
        }
      }

      // Create a temporary URL and trigger download
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.setAttribute('download', filename) // Ensure download attribute is set
      
      // Append to body (some browsers require this)
      document.body.appendChild(a)
      
      // Trigger download with a small delay to ensure DOM is ready
      requestAnimationFrame(() => {
        a.click()
        console.log('Download triggered for:', filename, 'blob size:', blob.size)
        
        // Clean up after download starts
        setTimeout(() => {
          window.URL.revokeObjectURL(url)
          if (document.body.contains(a)) {
            document.body.removeChild(a)
          }
        }, 200)
      })
      
      setMessage({ type: 'success', text: `Exported ${format.toUpperCase()} file successfully` })
    } catch (error) {
      console.error('Export error:', error)
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to export insights'
      })
    } finally {
      setExporting(null)
    }
  }

  const handleEditInsight = (insight: Insight) => {
    setEditingInsightId(insight.id)
    setEditingStatement(insight.statement)
    setMessage(null)
  }

  const handleCancelEdit = () => {
    setEditingInsightId(null)
    setEditingStatement('')
    setMessage(null)
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">
          Insights ({filteredInsights.length})
        </h2>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => handleExport('json')}
            disabled={!!exporting}
          >
            {exporting === 'json' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Export JSON
          </Button>
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => handleExport('csv')}
            disabled={!!exporting}
          >
            {exporting === 'csv' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Export CSV
          </Button>
        </div>
      </div>

      {message && (
        <Alert variant={message.type === 'error' ? 'destructive' : 'default'}>
          {message.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <InsightFilters 
        insights={insights} 
        onFilteredInsightsChange={setFilteredInsights}
      />

      {filteredInsights.length > 0 ? (
        filteredInsights.map((insight: Insight) => (
          <Card key={insight.id} className={insight.importance === 3 ? 'border-2 border-primary/30' : ''}>
            <CardContent className="pt-6">
              {/* Header with importance indicator */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    {/* Reference Number - Prominently displayed */}
                    {insight.referenceNumber && (
                      <Badge variant="default" className="text-xs font-mono font-bold bg-primary">
                        #{insight.referenceNumber}
                      </Badge>
                    )}
                    {/* Importance indicator (1-3 stars) */}
                    <div className="flex gap-0.5">
                      {[1, 2, 3].map((level) => (
                        <span
                          key={level}
                          className={`text-sm ${
                            level <= (insight.importance ?? 2)
                              ? 'text-primary'
                              : 'text-muted-foreground/30'
                          }`}
                        >
                          ★
                        </span>
                      ))}
                    </div>
                    {/* Insight type badge */}
                    <Badge variant="outline" className="text-xs">
                      {insight.insight_type}
                    </Badge>
                    {/* Actionability */}
                    {insight.actionability && insight.actionability !== 'Background' && (
                      <Badge 
                        variant={insight.actionability === 'High' ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {insight.actionability} Actionability
                      </Badge>
                    )}
                  </div>
                  
                  {editingInsightId === insight.id ? (
                    <div className="space-y-2 mb-2">
                      <Textarea
                        value={editingStatement}
                        onChange={(e) => setEditingStatement(e.target.value)}
                        className="min-h-[100px]"
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => handleSaveEdit(insight.id)}
                          disabled={!editingStatement.trim()}
                        >
                          <Check className="mr-2 h-4 w-4" />
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleCancelEdit}
                        >
                          <X className="mr-2 h-4 w-4" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-lg font-medium mb-2">
                      {insight.statement}
                    </p>
                  )}
                  
                  {/* Direct quote if present */}
                  {insight.has_direct_quote && insight.direct_quote && (
                    <blockquote className="border-l-4 border-primary/30 pl-4 my-3 italic text-muted-foreground">
                      "{insight.direct_quote}"
                    </blockquote>
                  )}
                  
                  {insight.context_note && (
                    <p className="text-sm text-muted-foreground mb-3">
                      {insight.context_note}
                    </p>
                  )}
                  {insight.isShared && insight.sharedWithSources && insight.sharedWithSources.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-2 italic">
                      Also found in: {insight.sharedWithSources.join(', ')}
                    </p>
                  )}
                  
                  {/* Topics/Concepts this insight is connected to */}
                  {insight.topics && insight.topics.length > 0 && (
                    <div className="mt-4 pt-4 border-t">
                      <div className="flex flex-wrap gap-1">
                        {insight.topics.map((topic: any) => (
                          <Link key={topic.id} href={`/topics/${topic.slug}`}>
                            <Badge variant="secondary" className="text-xs hover:bg-primary/20">
                              {topic.name}
                            </Badge>
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="ml-4 shrink-0 flex flex-col items-end gap-2">
                  <Badge variant="outline">
                    {insight.locator}
                  </Badge>
                  {insight.timestamp && (
                    <span className="text-xs text-muted-foreground">
                      ~{insight.timestamp}
                    </span>
                  )}
                  {editingInsightId !== insight.id && (
                    <div className="flex flex-col gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditInsight(insight)}
                        disabled={!!editingInsightId || !!deletingInsightId}
                      >
                        <Edit2 className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteInsight(insight.id)}
                        disabled={editingInsightId === insight.id || deletingInsightId === insight.id || !!editingInsightId}
                      >
                        {deletingInsightId === insight.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 items-center mt-4 pt-4 border-t">
                <Badge variant="secondary">
                  {formatEvidenceType(insight.evidence_type)}
                </Badge>
                <Badge
                  variant={
                    insight.confidence === "high"
                      ? "default"
                      : insight.confidence === "medium"
                      ? "secondary"
                      : "outline"
                  }
                >
                  {capitalizeWords(insight.confidence || '')} Confidence
                </Badge>
                {/* Primary audience */}
                {insight.primary_audience && insight.primary_audience !== 'Both' && (
                  <Badge variant="outline" className="text-xs">
                    For {insight.primary_audience}s
                  </Badge>
                )}
                {/* Tone */}
                {insight.tone && insight.tone !== 'Neutral' && (
                  <span className="text-xs text-muted-foreground">
                    Tone: {insight.tone}
                  </span>
                )}
              </div>

              {insight.qualifiers &&
                Object.keys(insight.qualifiers).length > 0 && (
                  <div className="mt-4 pt-4 pb-4 border-t border-b">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      {Object.entries(insight.qualifiers).map(
                        ([key, value]: [string, any]) =>
                          value && (
                            <div key={key}>
                              <strong className="capitalize">
                                {key.replace(/_/g, " ")}:
                              </strong>{" "}
                              {String(value)}
                            </div>
                          )
                      )}
                    </div>
                  </div>
                )}
            </CardContent>
          </Card>
        ))
      ) : (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">
              No insights match the selected filters.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
