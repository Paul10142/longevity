"use client"

import { useRouter } from "next/navigation"
import { SourceEditor, type SourceEditorSource } from "./SourceEditor"

interface SourceEditorClientProps {
  source: SourceEditorSource
}

export function SourceEditorClient({ source }: SourceEditorClientProps) {
  const router = useRouter()

  const handleUpdate = async (updates: { title?: string; authors?: string[]; date?: string | null; url?: string | null }) => {
    const response = await fetch(`/api/admin/sources/${source.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to update source')
    }

    // Refresh the page to show updated data
    router.refresh()
  }

  return <SourceEditor source={source} onUpdate={handleUpdate} />
}
