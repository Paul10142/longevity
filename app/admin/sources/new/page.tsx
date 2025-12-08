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
import { Loader2, AlertCircle, CheckCircle2, Plus, X as XIcon, Youtube } from "lucide-react"
import { extractYouTubeVideoId, isValidYouTubeUrl } from "@/lib/youtubeUtils"

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
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [transcriptSource, setTranscriptSource] = useState<"paste" | "file" | "youtube">("paste")
  const [youtubeUrl, setYoutubeUrl] = useState("")
  const [isFetchingTranscript, setIsFetchingTranscript] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  const handleFileSelect = (file: File | null) => {
    if (file) {
      // Validate file type
      const fileName = file.name.toLowerCase()
      const validExtensions = ['.epub', '.txt', '.html', '.htm', '.pdf']
      const isValid = validExtensions.some(ext => fileName.endsWith(ext))
      
      if (!isValid) {
        setStatus({
          type: 'error',
          message: `Invalid file type. Supported formats: EPUB, TXT, HTML, PDF`
        })
        return
      }
      
      setSelectedFile(file)
      setStatus({ type: 'idle' })
    }
  }

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    if (transcriptSource !== "file") {
      setTranscriptSource("file")
    }

    const files = e.dataTransfer.files
    if (files && files.length > 0) {
      handleFileSelect(files[0])
    }
  }

  const handleFetchYouTubeTranscript = async () => {
    if (!youtubeUrl.trim()) {
      setStatus({
        type: 'error',
        message: 'Please enter a YouTube URL'
      })
      return
    }

    const videoId = extractYouTubeVideoId(youtubeUrl)
    if (!videoId) {
      setStatus({
        type: 'error',
        message: 'Invalid YouTube URL. Please enter a valid YouTube video link.'
      })
      return
    }

    setIsFetchingTranscript(true)
    setStatus({ type: 'idle' })

    try {
      const response = await fetch('/api/admin/youtube-transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ videoId }),
      })

      if (!response.ok) {
        const error = await response.json()
        
        if (response.status === 429) {
          const retryAfter = error.retryAfter
          setStatus({
            type: 'error',
            message: `Rate limit exceeded. Please wait ${retryAfter || 10} seconds before trying again.`
          })
        } else {
          setStatus({
            type: 'error',
            message: error.error || 'Failed to fetch transcript from YouTube'
          })
        }
        setIsFetchingTranscript(false)
        return
      }

      const data = await response.json()

      if (!data.success || !data.transcript) {
        setStatus({
          type: 'error',
          message: 'No transcript found for this video. The video may not have captions available.'
        })
        setIsFetchingTranscript(false)
        return
      }

      // Auto-populate form fields with metadata
      const updates: Partial<typeof formData> = {
        transcript: data.transcript,
      }

      // Update title if available and not already set
      if (data.metadata?.title && !formData.title) {
        updates.title = data.metadata.title
      }

      // Update date if available and not already set
      if (data.metadata?.date && !formData.date) {
        // Parse date - API might return various formats
        try {
          const dateValue = new Date(data.metadata.date)
          if (!isNaN(dateValue.getTime())) {
            updates.date = dateValue.toISOString().split('T')[0] // Format as YYYY-MM-DD
          }
        } catch {
          // If date parsing fails, skip it
        }
      }

      // Update URL if not already set
      if (!formData.url) {
        updates.url = youtubeUrl
      }

      // Update authors if channel name is available and not already in authors
      if (data.metadata?.channel && !formData.authors.includes(data.metadata.channel)) {
        updates.authors = [...formData.authors, data.metadata.channel]
      }

      // Set source type to "video" if not already set
      if (formData.type !== "video") {
        updates.type = "video"
      }

      setFormData({
        ...formData,
        ...updates,
      })

      setStatus({
        type: 'success',
        message: 'Transcript fetched successfully! Review and edit the fields below before submitting.'
      })
    } catch (error) {
      console.error('Error fetching YouTube transcript:', error)
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'An unexpected error occurred'
      })
    } finally {
      setIsFetchingTranscript(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    // Manual validation for file upload
    if (transcriptSource === "file" && !selectedFile) {
      setStatus({
        type: 'error',
        message: 'Please select a file to upload or switch to another mode.'
      })
      return
    }
    
    // Manual validation for pasted transcript
    if (transcriptSource === "paste" && !formData.transcript.trim()) {
      setStatus({
        type: 'error',
        message: 'Please enter transcript text or switch to another mode.'
      })
      return
    }

    // Manual validation for YouTube transcript
    if (transcriptSource === "youtube" && !formData.transcript.trim()) {
      setStatus({
        type: 'error',
        message: 'Please fetch the YouTube transcript first or switch to another mode.'
      })
      return
    }
    
    setIsSubmitting(true)
    setStatus({ type: 'creating', message: 'Creating source...' })

    try {
      setStatus({ type: 'creating', message: 'Creating source in database...' })
      
      // Use FormData if file is selected, otherwise use JSON
      let body: FormData | string
      let headers: HeadersInit

      if (selectedFile && transcriptSource === "file") {
        // File upload mode
        const uploadFormData = new FormData()
        uploadFormData.append("type", formData.type)
        uploadFormData.append("title", formData.title)
        uploadFormData.append("authors", JSON.stringify(formData.authors || []))
        if (formData.date) uploadFormData.append("date", formData.date)
        if (formData.url) uploadFormData.append("url", formData.url)
        uploadFormData.append("file", selectedFile)
        
        body = uploadFormData
        headers = {
          "Accept": "text/event-stream", // Request streaming updates
        }
      } else {
        // JSON mode (existing behavior)
        body = JSON.stringify({
          ...formData,
          authors: formData.authors || [],
        })
        headers = {
          "Content-Type": "application/json",
          "Accept": "text/event-stream", // Request streaming updates
        }
      }
      
      const response = await fetch("/api/admin/sources", {
        method: "POST",
        headers,
        body,
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
                <CardDescription>
                  Upload a file (EPUB, TXT, HTML), paste the transcript text, or fetch from YouTube
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Source selection */}
                <div className="flex gap-4">
                  <Button
                    type="button"
                    variant={transcriptSource === "paste" ? "default" : "outline"}
                    onClick={() => {
                      setTranscriptSource("paste")
                      setSelectedFile(null)
                      setYoutubeUrl("")
                    }}
                  >
                    Paste Text
                  </Button>
                  <Button
                    type="button"
                    variant={transcriptSource === "file" ? "default" : "outline"}
                    onClick={() => {
                      setTranscriptSource("file")
                      setFormData({ ...formData, transcript: "" })
                      setYoutubeUrl("")
                    }}
                  >
                    Upload File
                  </Button>
                  <Button
                    type="button"
                    variant={transcriptSource === "youtube" ? "default" : "outline"}
                    onClick={() => {
                      setTranscriptSource("youtube")
                      setSelectedFile(null)
                      setFormData({ ...formData, transcript: "" })
                    }}
                  >
                    <Youtube className="h-4 w-4 mr-2" />
                    YouTube Link
                  </Button>
                </div>

                {transcriptSource === "file" ? (
                  <div>
                    <Label htmlFor="file">Upload File *</Label>
                    <div
                      onDragEnter={handleDragEnter}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      className={`
                        mt-2 border-2 border-dashed rounded-lg p-8 text-center transition-colors
                        ${isDragging 
                          ? 'border-primary bg-primary/5' 
                          : 'border-border hover:border-primary/50'
                        }
                        ${selectedFile ? 'border-primary/50' : ''}
                      `}
                    >
                      <input
                        ref={fileInputRef}
                        id="file"
                        type="file"
                        accept=".epub,.txt,.html,.htm,.pdf"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          handleFileSelect(file ?? null)
                        }}
                        className="hidden"
                      />
                      {selectedFile ? (
                        <div className="space-y-2">
                          <p className="text-sm font-medium text-primary">
                            ✓ {selectedFile.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSelectedFile(null)
                              if (fileInputRef.current) {
                                fileInputRef.current.value = ''
                              }
                            }}
                            className="mt-2"
                          >
                            Remove File
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-sm text-muted-foreground">
                            {isDragging ? 'Drop file here' : 'Drag and drop a file here, or click to browse'}
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => fileInputRef.current?.click()}
                          >
                            Browse Files
                          </Button>
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Supported formats: EPUB, TXT, HTML, PDF
                    </p>
                  </div>
                ) : transcriptSource === "youtube" ? (
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="youtube-url">YouTube Video URL *</Label>
                      <div className="flex gap-2 mt-2">
                        <Input
                          id="youtube-url"
                          type="url"
                          placeholder="https://www.youtube.com/watch?v=..."
                          value={youtubeUrl}
                          onChange={(e) => setYoutubeUrl(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault()
                              handleFetchYouTubeTranscript()
                            }
                          }}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          onClick={handleFetchYouTubeTranscript}
                          disabled={isFetchingTranscript || !youtubeUrl.trim()}
                        >
                          {isFetchingTranscript ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              Fetching...
                            </>
                          ) : (
                            "Fetch Transcript"
                          )}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        Enter a YouTube video URL to automatically fetch the transcript and video metadata
                      </p>
                    </div>
                    {formData.transcript && (
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
                        <p className="text-xs text-muted-foreground mt-2">
                          Transcript fetched from YouTube. You can review and edit it before submitting.
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
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
                      required={transcriptSource === "paste"}
                    />
                  </div>
                )}
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

