"use client"

import { useRouter } from "next/navigation"
import { TranscriptEditor } from "./TranscriptEditor"

interface TranscriptEditorClientProps {
  sourceId: string
  transcript: string | null
}

export function TranscriptEditorClient({ sourceId, transcript }: TranscriptEditorClientProps) {
  const router = useRouter()

  const handleUpdate = async (transcript: string) => {
    try {
      const response = await fetch(`/api/admin/sources/${sourceId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ transcript }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to update transcript")
      }

      router.refresh()
    } catch (error) {
      console.error("Error updating transcript:", error)
      throw error
    }
  }

  return <TranscriptEditor sourceId={sourceId} transcript={transcript} onUpdate={handleUpdate} />
}

