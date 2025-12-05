"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Loader2, AlertCircle, CheckCircle2, Plus, X as XIcon } from "lucide-react"

const COMMON_AUTHORS = [
  "Dr. Peter Attia",
  "Dr. Andrew Huberman",
  "Dr. Andy Galpin",
  "Dr. Rhonda Patrick"
]

type ProcessingStatus = 
  | { type: 'idle' }
  | { type: 'creating'; message: string }
  | { type: 'chunking'; message: string; progress?: number; total?: number }
  | { type: 'extracting'; message: string; progress?: number; total?: number; insightsCreated?: number }
  | { type: 'success'; message: string }
  | { type: 'error'; message: string; details?: string }

export default function NewSourcePage() {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [status, setStatus] = useState<ProcessingStatus>({ type: 'idle' })
  const [formData, setFormData] = useState({
    type: "podcast",
    title: "",
    authors: [] as string[],
    date: "",
    url: "",
    transcript: "",
  })
  const [newAuthor, setNewAuthor] = useState("")

  const addAuthor = (author: string) => {
    if (author && !formData.authors.includes(author)) {
      setFormData({
        ...formData,
        authors: [...formData.authors, author],
      })
    }
    setNewAuthor("")
  }

  const removeAuthor = (authorToRemove: string) => {
    setFormData({
      ...formData,
      authors: formData.authors.filter((a) => a !== authorToRemove),
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setStatus({ type: 'creating', message: 'Creating source...' })

    try {
      setStatus({ type: 'creating', message: 'Creating source in database...' })
      
      const response = await fetch("/api/admin/sources", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream", // Request streaming updates
        },
        body: JSON.stringify({
          ...formData,
          authors: formData.authors || [],
        }),
      })

      if (!response.ok) {
        // Try to parse error as JSON first
        try {
          const error = await response.json()
          setStatus({ 
            type: 'error', 
            message: error.error || "Failed to create source",
            details: error.details || error.hint || null
          })
        } catch {
          setStatus({ 
            type: 'error', 
            message: `HTTP ${response.status}: ${response.statusText}`
          })
        }
        setIsSubmitting(false)
        return
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
                  
                  if (data.status) {
                    setStatus(data.status)
                  }
                  
                  if (data.done) {
                    cleanup()
                    setStatus({ 
                      type: 'success', 
                      message: 'Processing complete! Redirecting...' 
                    })
                    setTimeout(() => router.push(`/admin/sources`), 1500)
                    return
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
          setStatus({ 
            type: 'error', 
            message: 'Error receiving progress updates',
            details: streamError instanceof Error ? streamError.message : undefined
          })
        }
      } else {
        // Fallback: regular JSON response (shouldn't happen with streaming)
        const data = await response.json()
        setStatus({ type: 'success', message: 'Processing complete! Redirecting...' })
        setTimeout(() => router.push(`/admin/sources`), 1500)
      }
    } catch (error) {
      console.error("Error creating source:", error)
      setStatus({ 
        type: 'error', 
        message: error instanceof Error ? error.message : "Unknown error occurred",
        details: error instanceof Error ? error.stack : undefined
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <main>
      <div className="container mx-auto px-4 py-12">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-bold mb-8">New Source</h1>

          <form onSubmit={handleSubmit}>
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>Source Information</CardTitle>
                <CardDescription>Enter details about the source</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="type">Type</Label>
                  <select
                    id="type"
                    value={formData.type}
                    onChange={(e) =>
                      setFormData({ ...formData, type: e.target.value })
                    }
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    required
                  >
                    <option value="podcast">Podcast</option>
                    <option value="book">Book</option>
                    <option value="video">Video</option>
                    <option value="article">Article</option>
                  </select>
                </div>

                <div>
                  <Label htmlFor="title">Title *</Label>
                  <Input
                    id="title"
                    value={formData.title}
                    onChange={(e) =>
                      setFormData({ ...formData, title: e.target.value })
                    }
                    required
                  />
                </div>

                <div>
                  <Label>Authors</Label>
                  <div className="mt-2 space-y-3">
                    {/* Quick-add buttons for common authors */}
                    <div>
                      <p className="text-sm text-muted-foreground mb-2">Quick Add:</p>
                      <div className="flex flex-wrap gap-2">
                        {COMMON_AUTHORS.map((author) => (
                          <Button
                            key={author}
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => addAuthor(author)}
                            disabled={formData.authors.includes(author)}
                            className="text-xs"
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            {author}
                          </Button>
                        ))}
                      </div>
                    </div>

                    {/* Current authors */}
                    {formData.authors.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {formData.authors.map((author) => (
                          <Badge
                            key={author}
                            variant="secondary"
                            className="flex items-center gap-1 pr-1"
                          >
                            {author}
                            <button
                              onClick={() => removeAuthor(author)}
                              className="ml-1 hover:bg-destructive/20 rounded-full p-0.5"
                              type="button"
                            >
                              <XIcon className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                      </div>
                    )}

                    {/* Add custom author */}
                    <div className="flex gap-2">
                      <Input
                        placeholder="Add author name..."
                        value={newAuthor}
                        onChange={(e) => setNewAuthor(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            if (newAuthor.trim()) {
                              addAuthor(newAuthor.trim())
                            }
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          if (newAuthor.trim()) {
                            addAuthor(newAuthor.trim())
                          }
                        }}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div>
                  <Label htmlFor="date">Date</Label>
                  <Input
                    id="date"
                    type="date"
                    value={formData.date}
                    onChange={(e) =>
                      setFormData({ ...formData, date: e.target.value })
                    }
                  />
                </div>

                <div>
                  <Label htmlFor="url">URL (optional)</Label>
                  <Input
                    id="url"
                    type="url"
                    value={formData.url}
                    onChange={(e) =>
                      setFormData({ ...formData, url: e.target.value })
                    }
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Transcript</CardTitle>
                <CardDescription>Paste the full transcript text</CardDescription>
              </CardHeader>
              <CardContent>
                <div>
                  <Label htmlFor="transcript">Transcript *</Label>
                  <Textarea
                    id="transcript"
                    value={formData.transcript}
                    onChange={(e) =>
                      setFormData({ ...formData, transcript: e.target.value })
                    }
                    rows={20}
                    className="font-mono text-sm"
                    required
                  />
                </div>
              </CardContent>
            </Card>

            {/* Status Display */}
            {status.type !== 'idle' && (
              <Card className="mt-6">
                <CardContent className="pt-6">
                  {status.type === 'creating' && (
                    <Alert>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <AlertTitle>Creating Source</AlertTitle>
                      <AlertDescription>{status.message}</AlertDescription>
                    </Alert>
                  )}
                  
                  {status.type === 'chunking' && (
                    <Alert>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <AlertTitle>Processing Transcript</AlertTitle>
                      <AlertDescription>
                        {status.message}
                        {status.total !== undefined && (
                          <div className="mt-2">
                            <p className="text-sm font-medium">
                              Total chunks: {status.total}
                            </p>
                          </div>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                  
                  {status.type === 'extracting' && (
                    <Alert>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <AlertTitle>Extracting Insights</AlertTitle>
                      <AlertDescription>
                        {status.message}
                        {status.progress !== undefined && status.total !== undefined && (
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
                        <p className="text-xs text-muted-foreground mt-3">
                          ⏱️ Processing in real-time. Please don't close this page.
                        </p>
                      </AlertDescription>
                    </Alert>
                  )}
                  
                  {status.type === 'success' && (
                    <Alert className="border-green-500">
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                      <AlertTitle className="text-green-700">Success!</AlertTitle>
                      <AlertDescription className="text-green-600">
                        {status.message}
                      </AlertDescription>
                    </Alert>
                  )}
                  
                  {status.type === 'error' && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>Error</AlertTitle>
                      <AlertDescription>
                        {status.message}
                        {status.details && (
                          <details className="mt-2 text-xs">
                            <summary className="cursor-pointer">Details</summary>
                            <pre className="mt-2 p-2 bg-destructive/10 rounded overflow-auto">
                              {status.details}
                            </pre>
                          </details>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>
            )}

            <div className="flex gap-4 mt-6">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  "Create Source & Process"
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.back()}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      </div>
      </main>
    </div>
  )
}

