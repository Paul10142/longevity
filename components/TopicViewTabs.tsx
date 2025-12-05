"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, AlertCircle, Trash2, CheckCircle2 } from "lucide-react"
import ReactMarkdown from "react-markdown"
import Link from "next/link"
import { cn } from "@/lib/utils"

interface TopicViewTabsProps {
  patientArticle: any | null
  clinicianArticle: any | null
  evidenceView: React.ReactNode
  conceptSlug: string
  showAdminTools: boolean
  conceptId: string
  allInsightsForAdmin: any[]
}

export function TopicViewTabs({ 
  patientArticle, 
  clinicianArticle, 
  evidenceView,
  conceptSlug,
  showAdminTools,
  conceptId,
  allInsightsForAdmin
}: TopicViewTabsProps) {
  const [activeView, setActiveView] = useState<'patient' | 'clinician' | 'evidence' | 'admin'>(
    patientArticle ? 'patient' : clinicianArticle ? 'clinician' : 'evidence'
  )
  const [deleteMessage, setDeleteMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [deletingInsightId, setDeletingInsightId] = useState<string | null>(null)
  const [isTransitioning, setIsTransitioning] = useState(false)

  const handleViewChange = (newView: 'patient' | 'clinician' | 'evidence' | 'admin') => {
    setIsTransitioning(true)
    setTimeout(() => {
      setActiveView(newView)
      setTimeout(() => setIsTransitioning(false), 50)
    }, 150)
  }

  const handleGenerateArticles = async () => {
    if (!confirm('This will regenerate both clinician and patient articles. Continue?')) {
      return
    }

    try {
      const response = await fetch(`/api/admin/topics/${conceptSlug}/generate-articles`, {
        method: 'POST',
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to generate articles')
      }

      const result = await response.json()
      alert(`Success: ${result.message}`)
      window.location.reload()
    } catch (error) {
      console.error('Error generating articles:', error)
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const handleDeleteInsight = async (insightId: string) => {
    if (!confirm('Are you sure you want to delete this insight? This will hide it from all views.')) {
      return
    }

    setDeletingInsightId(insightId)
    setDeleteMessage(null)

    try {
      const response = await fetch(`/api/admin/insights/${insightId}/delete`, {
        method: 'POST',
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to delete insight')
      }

      setDeleteMessage({ type: 'success', text: 'Insight deleted successfully' })
      setTimeout(() => {
        window.location.reload()
      }, 1000)
    } catch (error) {
      console.error('Error deleting insight:', error)
      setDeleteMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to delete insight'
      })
      setDeletingInsightId(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* Success/Error Message */}
      {deleteMessage && (
        <Alert className={deleteMessage.type === 'success' ? 'border-green-500 bg-green-50' : 'border-red-500 bg-red-50'}>
          {deleteMessage.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4 text-green-600" />
          ) : (
            <AlertCircle className="h-4 w-4 text-red-600" />
          )}
          <AlertDescription className={deleteMessage.type === 'success' ? 'text-green-800' : 'text-red-800'}>
            {deleteMessage.text}
          </AlertDescription>
        </Alert>
      )}

      {/* Tabs and Content Container */}
      <div className="mt-4">
        {/* View Tabs */}
        <div className="flex items-end gap-0 pt-2">
          {/* Always show Patient and Clinician tabs, even if articles don't exist yet */}
          <button
            onClick={() => handleViewChange('patient')}
            disabled={!patientArticle}
            className={cn(
              "relative px-4 py-2.5 text-sm font-medium transition-all duration-300 ease-in-out",
              "rounded-t-lg border border-b-0 border-transparent",
              "disabled:cursor-not-allowed disabled:opacity-50",
              activeView === 'patient'
                ? "bg-white text-foreground border-x-2 border-t-2 border-primary/30 -mb-[2px] z-10"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            )}
          >
            Patient View
          </button>
          <button
            onClick={() => handleViewChange('clinician')}
            disabled={!clinicianArticle}
            className={cn(
              "relative px-4 py-2.5 text-sm font-medium transition-all duration-300 ease-in-out",
              "rounded-t-lg border border-b-0 border-transparent",
              "disabled:cursor-not-allowed disabled:opacity-50",
              activeView === 'clinician'
                ? "bg-white text-foreground border-x-2 border-t-2 border-primary/30 -mb-[2px] z-10"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            )}
          >
            Clinician View
          </button>
          <button
            onClick={() => handleViewChange('evidence')}
            className={cn(
              "relative px-4 py-2.5 text-sm font-medium transition-all duration-300 ease-in-out",
              "rounded-t-lg border border-b-0 border-transparent",
              activeView === 'evidence'
                ? "bg-white text-foreground border-x-2 border-t-2 border-primary/30 -mb-[2px] z-10"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            )}
          >
            Evidence
          </button>
          {showAdminTools && (
            <button
              onClick={() => handleViewChange('admin')}
              className={cn(
                "relative px-4 py-2.5 text-sm font-medium transition-all duration-300 ease-in-out",
                "rounded-t-lg border border-b-0 border-transparent",
                activeView === 'admin'
                  ? "bg-white text-foreground border-x-2 border-t-2 border-primary/30 -mb-[2px] z-10"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
              )}
            >
              Admin
            </button>
          )}
          {showAdminTools && (
            <div className="ml-auto mb-2 mr-4">
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateArticles}
              >
                {patientArticle && clinicianArticle ? 'Regenerate Articles' : 'Generate Articles'}
              </Button>
            </div>
          )}
        </div>

        {/* Inner Content Frame - highlighted when active */}
        <div className={cn(
          "rounded-lg border transition-all duration-300 ease-in-out",
          "bg-card shadow-sm",
          activeView === 'patient' && "border-2 border-primary/30 shadow-lg ring-1 ring-primary/10",
          activeView === 'clinician' && "border-2 border-primary/30 shadow-lg ring-1 ring-primary/10",
          activeView === 'evidence' && "border-2 border-primary/30 shadow-lg ring-1 ring-primary/10",
          activeView === 'admin' && "border-2 border-primary/30 shadow-lg ring-1 ring-primary/10"
        )}>
          <div
            key={`content-${activeView}`}
            className={cn(
              "transition-opacity duration-300 ease-in-out",
              isTransitioning ? "opacity-0" : "opacity-100"
            )}
          >
            {activeView === 'patient' && (
              patientArticle ? (
                <CardContent className="pt-6 prose prose-lg max-w-none border-0">
                  <ReactMarkdown>{patientArticle.body_markdown}</ReactMarkdown>
                </CardContent>
              ) : (
                <CardContent className="py-12 text-center border-0">
                  <p className="text-muted-foreground mb-4">
                    Patient article has not been generated yet.
                  </p>
                  {showAdminTools && (
                    <Button onClick={handleGenerateArticles} variant="default">
                      Generate Articles
                    </Button>
                  )}
                </CardContent>
              )
            )}

            {activeView === 'clinician' && (
              clinicianArticle ? (
                <CardContent className="pt-6 prose prose-lg max-w-none border-0">
                  <ReactMarkdown>{clinicianArticle.body_markdown}</ReactMarkdown>
                </CardContent>
              ) : (
                <CardContent className="py-12 text-center border-0">
                  <p className="text-muted-foreground mb-4">
                    Clinician article has not been generated yet.
                  </p>
                  {showAdminTools && (
                    <Button onClick={handleGenerateArticles} variant="default">
                      Generate Articles
                    </Button>
                  )}
                </CardContent>
              )
            )}

            {activeView === 'evidence' && (
              <div className="p-6">
                {evidenceView}
              </div>
            )}

            {activeView === 'admin' && showAdminTools && (
              <div className="p-6">
                <AdminInsightView 
                  insights={allInsightsForAdmin || []}
                  conceptId={conceptId}
                  onDelete={handleDeleteInsight}
                  deletingInsightId={deletingInsightId}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Helper component for admin insight view
function AdminInsightView({ 
  insights, 
  conceptId, 
  onDelete, 
  deletingInsightId 
}: { 
  insights: any[]
  conceptId: string
  onDelete: (id: string) => void
  deletingInsightId: string | null
}) {
  // Group insights by source (same as evidence view)
  const insightsBySource: Record<string, any> = {}
  
  insights.forEach((item: any) => {
    const insight = item.insights || item
    if (!insight?.id) return

    const sourceLinks = insight.insight_sources || []
    sourceLinks.forEach((link: any) => {
      const source = link.sources
      if (!source) return

      const sourceId = source.id
      if (!insightsBySource[sourceId]) {
        insightsBySource[sourceId] = {
          source: source,
          insights: []
        }
      }

      // Collect all concepts for this insight (from the nested structure)
      const concepts = insight.concepts || []
      
      insightsBySource[sourceId].insights.push({
        ...insight,
        locator: link.locator,
        concepts: concepts
      })
    })
  })

  // Also need to fetch all concepts for each insight
  // For now, we'll show what we have from the query

  const sourcesList = Object.values(insightsBySource)

  if (sourcesList.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">No insights found for admin view.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-8">
      {sourcesList.map(({ source, insights: sourceInsights }: any) => (
        <div key={source.id}>
          <div className="mb-4 flex items-center gap-2">
            <h2 className="text-2xl font-semibold">{source.title}</h2>
            <Badge variant="secondary" className="capitalize">{source.type}</Badge>
            <Link 
              href={`/sources/${source.id}`}
              className="text-sm text-muted-foreground hover:text-primary"
            >
              View source →
            </Link>
          </div>

          <div className="space-y-4">
            {sourceInsights.map((insight: any) => (
              <Card 
                key={insight.id} 
                className={`${insight.importance === 3 ? 'border-2 border-primary/30' : ''} ${insight.deleted_at ? 'opacity-50' : ''}`}
              >
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        {insight.deleted_at && (
                          <Badge variant="destructive" className="text-xs">Deleted</Badge>
                        )}
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
                        <Badge variant="outline" className="text-xs">
                          {insight.insight_type || 'Explanation'}
                        </Badge>
                      </div>
                      
                      <p className="text-lg font-medium mb-2">{insight.statement}</p>
                      
                      {insight.context_note && (
                        <p className="text-sm text-muted-foreground mb-3">{insight.context_note}</p>
                      )}

                      {/* Concept Tags */}
                      <div className="mb-3">
                        <span className="text-xs text-muted-foreground mr-2">Tagged to:</span>
                        {insight.concepts && insight.concepts.length > 0 ? (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {insight.concepts.map((concept: any) => (
                              <Link key={concept.id} href={`/topics/${concept.slug}`}>
                                <Badge variant="secondary" className="text-xs hover:bg-primary/20">
                                  {concept.name}
                                </Badge>
                              </Link>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">No concepts tagged</span>
                        )}
                      </div>
                    </div>
                    <div className="ml-4 shrink-0 flex flex-col gap-2">
                      <Badge variant="outline">{insight.locator}</Badge>
                      {!insight.deleted_at && (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => onDelete(insight.id)}
                          disabled={deletingInsightId === insight.id}
                        >
                          {deletingInsightId === insight.id ? (
                            <>
                              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                              Deleting...
                            </>
                          ) : (
                            <>
                              <Trash2 className="mr-2 h-3 w-3" />
                              Delete
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 items-center">
                    <Badge variant="secondary">{insight.evidence_type}</Badge>
                    <Badge
                      variant={
                        insight.confidence === "high"
                          ? "default"
                          : insight.confidence === "medium"
                          ? "secondary"
                          : "outline"
                      }
                    >
                      {insight.confidence} confidence
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
