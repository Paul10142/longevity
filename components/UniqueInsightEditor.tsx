'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Edit2, Check, X } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface UniqueInsightEditorProps {
  uniqueInsightId: string
  currentStatement: string
}

export function UniqueInsightEditor({
  uniqueInsightId,
  currentStatement
}: UniqueInsightEditorProps) {
  const router = useRouter()
  const [isEditing, setIsEditing] = useState(false)
  const [editedStatement, setEditedStatement] = useState(currentStatement)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!editedStatement.trim()) {
      setError('Statement cannot be empty')
      return
    }

    if (editedStatement.trim() === currentStatement) {
      setIsEditing(false)
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      const response = await fetch(`/api/admin/insights/unique/${uniqueInsightId}/update`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonical_statement: editedStatement.trim() })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to update unique insight')
      }

      // Success - refresh the page
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setEditedStatement(currentStatement)
    setIsEditing(false)
    setError(null)
  }

  if (isEditing) {
    return (
      <div className="space-y-2">
        <Textarea
          value={editedStatement}
          onChange={(e) => setEditedStatement(e.target.value)}
          className="min-h-[100px] text-lg"
          disabled={isSaving}
        />
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
        <div className="flex gap-2">
          <Button
            onClick={handleSave}
            disabled={isSaving}
            size="sm"
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Check className="mr-2 h-4 w-4" />
                Save
              </>
            )}
          </Button>
          <Button
            onClick={handleCancel}
            disabled={isSaving}
            variant="outline"
            size="sm"
          >
            <X className="mr-2 h-4 w-4" />
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-lg">{currentStatement}</p>
      <Button
        onClick={() => setIsEditing(true)}
        variant="outline"
        size="sm"
      >
        <Edit2 className="mr-2 h-4 w-4" />
        Edit Statement
      </Button>
    </div>
  )
}
