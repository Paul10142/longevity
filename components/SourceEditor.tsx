"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Edit2, Save, X, Plus, X as XIcon } from "lucide-react"

const COMMON_AUTHORS = [
  "Dr. Peter Attia",
  "Dr. Andrew Huberman",
  "Dr. Andy Galpin",
  "Dr. Rhonda Patrick"
]

interface SourceEditorProps {
  source: {
    id: string
    title: string
    authors: string[]
    date: string | null
    url: string | null
    type: string
  }
  onUpdate: (updates: { title?: string; authors?: string[]; date?: string | null; url?: string | null }) => Promise<void>
}

export function SourceEditor({ source, onUpdate }: SourceEditorProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [formData, setFormData] = useState({
    title: source.title,
    authors: [...source.authors],
    date: source.date || "",
    url: source.url || "",
  })
  const [newAuthor, setNewAuthor] = useState("")

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await onUpdate({
        title: formData.title,
        authors: formData.authors,
        date: formData.date || null,
        url: formData.url || null,
      })
      setIsEditing(false)
    } catch (error) {
      console.error("Error saving:", error)
      alert("Failed to save changes. Please try again.")
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setFormData({
      title: source.title,
      authors: [...source.authors],
      date: source.date || "",
      url: source.url || "",
    })
    setNewAuthor("")
    setIsEditing(false)
  }

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

  if (!isEditing) {
    return (
      <Card className="mb-8">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <CardTitle className="text-3xl mb-2">{source.title}</CardTitle>
              <div className="flex flex-wrap gap-2 mt-2">
                <Badge variant="secondary" className="capitalize">{source.type}</Badge>
                {source.date && (
                  <Badge variant="outline">
                    {new Date(source.date).toLocaleDateString('en-US', { 
                      month: '2-digit', 
                      day: '2-digit', 
                      year: 'numeric' 
                    })}
                  </Badge>
                )}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(true)}
              className="ml-4"
            >
              <Edit2 className="h-4 w-4 mr-2" />
              Edit
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {source.authors && source.authors.length > 0 && (
            <p className="text-muted-foreground mb-2">
              <strong>Authors:</strong> {source.authors.join(", ")}
            </p>
          )}
          {source.url && (
            <p className="text-muted-foreground">
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {source.url}
              </a>
            </p>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mb-8 border-2 border-primary/30">
      <CardHeader>
        <div className="flex items-center justify-between mb-4">
          <CardTitle>Edit Source</CardTitle>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
              disabled={isSaving}
            >
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={isSaving}
            >
              <Save className="h-4 w-4 mr-2" />
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            className="mt-1"
          />
        </div>

        <div>
          <Label htmlFor="date">Date</Label>
          <Input
            id="date"
            type="date"
            value={formData.date}
            onChange={(e) => setFormData({ ...formData, date: e.target.value })}
            className="mt-1"
          />
        </div>

        <div>
          <Label htmlFor="url">URL</Label>
          <Input
            id="url"
            type="url"
            value={formData.url}
            onChange={(e) => setFormData({ ...formData, url: e.target.value })}
            className="mt-1"
            placeholder="https://..."
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
                  if (e.key === "Enter" && newAuthor.trim()) {
                    e.preventDefault()
                    addAuthor(newAuthor.trim())
                  }
                }}
                className="flex-1"
              />
              <Button
                variant="outline"
                onClick={() => {
                  if (newAuthor.trim()) {
                    addAuthor(newAuthor.trim())
                  }
                }}
                disabled={!newAuthor.trim()}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
