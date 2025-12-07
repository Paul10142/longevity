"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react"

interface Insight {
  id: string
  statement: string
  context_note?: string | null
  evidence_type: string
  confidence: string
  importance?: number
  insight_type?: string
  sourceTitle: string
  isLinked: boolean
}

interface ConceptInsightTaggerProps {
  conceptId: string
  insights: Insight[]
}

export function ConceptInsightTagger({ conceptId, insights }: ConceptInsightTaggerProps) {
  const [selectedInsights, setSelectedInsights] = useState<Set<string>>(new Set())
  const [isSaving, setIsSaving] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

  // Initialize with currently linked insights
  useEffect(() => {
    const linkedIds = insights.filter(i => i.isLinked).map(i => i.id)
    setSelectedInsights(new Set(linkedIds))
  }, [insights])

  const toggleInsight = (insightId: string) => {
    setSelectedInsights(prev => {
      const next = new Set(prev)
      if (next.has(insightId)) {
        next.delete(insightId)
      } else {
        next.add(insightId)
      }
      return next
    })
  }

  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const handleSave = async () => {
    setIsSaving(true)
    setSaveMessage(null)
    try {
      const response = await fetch(`/api/admin/concepts/${conceptId}/insights`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          insight_ids: Array.from(selectedInsights),
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to save')
      }

      const result = await response.json()
      
      // Show success message
      setSaveMessage({ type: 'success', text: result.message || 'Links updated successfully!' })
      
      // Refresh page after a short delay to show the message
      setTimeout(() => {
        window.location.reload()
      }, 1500)
    } catch (error) {
      console.error("Error saving:", error)
      setSaveMessage({ 
        type: 'error', 
        text: error instanceof Error ? error.message : 'Failed to save changes. Please try again.' 
      })
      setIsSaving(false)
    }
  }

  // Filter insights by search query
  const filteredInsights = insights.filter(insight =>
    insight.statement.toLowerCase().includes(searchQuery.toLowerCase()) ||
    insight.sourceTitle.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="space-y-4">
      {/* Success/Error Message */}
      {saveMessage && (
        <Alert className={saveMessage.type === 'success' ? 'border-green-500 bg-green-50' : 'border-red-500 bg-red-50'}>
          {saveMessage.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          ) : (
            <AlertCircle className="h-4 w-4 text-red-600" />
          )}
          <AlertDescription className={saveMessage.type === 'success' ? 'text-green-800' : 'text-red-800'}>
            {saveMessage.text}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between">
        <div className="flex-1 max-w-md">
          <input
            type="text"
            placeholder="Search insights..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 border rounded-md bg-background"
          />
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">
            {selectedInsights.size} of {insights.length} selected
          </span>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {filteredInsights.length > 0 ? (
          filteredInsights.map((insight) => (
            <Card key={insight.id} className={selectedInsights.has(insight.id) ? 'border-primary' : ''}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={selectedInsights.has(insight.id)}
                    onCheckedChange={() => toggleInsight(insight.id)}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Badge variant="outline" className="text-xs">
                        {insight.sourceTitle}
                      </Badge>
                      {insight.insight_type && (
                        <Badge variant="secondary" className="text-xs">
                          {insight.insight_type}
                        </Badge>
                      )}
                      {insight.importance && (
                        <span className="text-xs text-muted-foreground">
                          {'★'.repeat(insight.importance)}
                        </span>
                      )}
                      {insight.confidence && (
                        <Badge 
                          variant={insight.confidence === 'high' ? 'default' : 'secondary'}
                          className="text-xs"
                        >
                          {insight.confidence} confidence
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm font-medium mb-1">{insight.statement}</p>
                    {insight.context_note && (
                      <p className="text-xs text-muted-foreground">{insight.context_note}</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">
                {searchQuery ? "No insights match your search." : "No insights available."}
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

