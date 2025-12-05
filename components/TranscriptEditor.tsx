"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Edit2, Save, X, ChevronDown, ChevronUp, Loader2, CheckCircle2, AlertCircle } from "lucide-react"

interface TranscriptEditorProps {
  sourceId: string
  transcript: string | null
  onUpdate: (transcript: string) => Promise<void>
}

export function TranscriptEditor({ sourceId, transcript, onUpdate }: TranscriptEditorProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [transcriptText, setTranscriptText] = useState(transcript || "")
  const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const handleSave = async () => {
    setIsSaving(true)
    setSaveMessage(null)
    try {
      await onUpdate(transcriptText)
      setSaveMessage({ type: 'success', text: 'Transcript saved successfully' })
      setIsEditing(false)
      setTimeout(() => setSaveMessage(null), 3000)
    } catch (error) {
      console.error("Error saving transcript:", error)
      setSaveMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to save transcript'
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setTranscriptText(transcript || "")
    setIsEditing(false)
    setSaveMessage(null)
  }

  const hasTranscript = transcript && transcript.length > 0

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <CardTitle>Transcript</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {hasTranscript && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="h-4 w-4 mr-1" />
                    Collapse
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4 mr-1" />
                    Expand
                  </>
                )}
              </Button>
            )}
            {!isEditing && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsEditing(true)}
              >
                <Edit2 className="h-4 w-4 mr-2" />
                {hasTranscript ? 'Edit' : 'Add'} Transcript
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {saveMessage && (
          <Alert className={`mb-4 ${saveMessage.type === 'success' ? 'border-green-500 bg-green-50' : 'border-red-500 bg-red-50'}`}>
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

        {isEditing ? (
          <div className="space-y-4">
            <div>
              <Textarea
                value={transcriptText}
                onChange={(e) => setTranscriptText(e.target.value)}
                rows={isExpanded ? 30 : 15}
                className="font-mono text-sm"
                placeholder="Paste the full transcript text here..."
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                {transcriptText.trim().split(/\s+/).filter(w => w.length > 0).length.toLocaleString()} words, {transcriptText.length.toLocaleString()} characters, {transcriptText.split('\n').length} lines
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={handleCancel}
                  disabled={isSaving}
                >
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={isSaving}
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4 mr-2" />
                      Save
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        ) : hasTranscript ? (
          <div className="space-y-4">
            {isExpanded ? (
              <div className="relative">
                <Textarea
                  value={transcript}
                  readOnly
                  rows={30}
                  className="font-mono text-sm bg-muted/50"
                />
              </div>
            ) : (
              <div className="relative">
                <Textarea
                  value={transcript}
                  readOnly
                  rows={10}
                  className="font-mono text-sm bg-muted/50"
                />
                <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-background to-transparent pointer-events-none" />
              </div>
            )}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {transcript.trim().split(/\s+/).filter(w => w.length > 0).length.toLocaleString()} words
              </span>
              <span>
                {transcript.split('\n').length} lines
              </span>
              <span>
                {transcript.trim().split(/\s+/).filter(w => w.length > 0).length > 999 
                  ? `${transcript.length.toLocaleString()} characters`
                  : `${Math.round(transcript.length / 1000)}k characters`}
              </span>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-muted-foreground">
            <p className="mb-4">This source was created before transcript storage was implemented.</p>
            <p className="text-sm mb-4">The transcript was used to create chunks and insights, but the original text was not saved.</p>
            <Button onClick={() => setIsEditing(true)} variant="default">
              Add Transcript
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
