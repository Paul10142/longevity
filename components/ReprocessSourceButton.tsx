"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Loader2, RefreshCw } from "lucide-react"

// v2: reprocessing just wipes this source's raw insights and enqueues an
// extract_source job — progress is visible in the processing queue panel.
export function ReprocessSourceButton({ sourceId }: { sourceId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    if (!confirm("Re-extract this source? Its existing raw insights are deleted and a fresh extraction job is queued.")) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/sources/${sourceId}/reprocess`, { method: "POST" })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`)
        return
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button variant="outline" size="sm" onClick={handleClick} disabled={busy}>
        {busy ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Queuing…
          </>
        ) : (
          <>
            <RefreshCw className="mr-2 h-4 w-4" />
            Re-extract
          </>
        )}
      </Button>
      {error && <span className="text-sm text-destructive">{error}</span>}
    </div>
  )
}
