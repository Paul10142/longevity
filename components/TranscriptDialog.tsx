"use client"

import { useEffect, useState } from "react"
import { Button, type ButtonProps } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { EpisodeLinks } from "@/components/EpisodeLinks"
import { TranscriptReader } from "@/components/TranscriptReader"
import { describeTranscriptView } from "@/lib/transcriptView"
import { transcriptHeading, type TranscriptPayload } from "@/lib/transcriptPayload"

/**
 * A "Transcript" button that opens the readable transcript in a pop-up.
 *
 * The transcript is fetched when the pop-up first opens, not when the page
 * renders: the sources table has hundreds of rows and a transcript is 100–200k
 * characters, so loading them all up front is exactly what the table was
 * rebuilt to avoid. The result is kept, so reopening is instant.
 *
 * "Open in a new tab" goes to the full page at /admin/sources/[id]/transcript,
 * so insights and transcript can sit side by side.
 */
export function TranscriptDialog({
  sourceId,
  title,
  label = "Transcript",
  variant = "outline",
  size = "sm",
  className,
}: {
  sourceId: string
  title?: string | null
  label?: string
  variant?: ButtonProps["variant"]
  size?: ButtonProps["size"]
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [payload, setPayload] = useState<TranscriptPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || payload || loading) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/admin/sources/${sourceId}/transcript`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error || `Could not load the transcript (${res.status})`)
        }
        return (await res.json()) as TranscriptPayload
      })
      .then((data) => {
        if (!cancelled) setPayload(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the transcript")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `payload`/`loading` are guards, not triggers: fetch once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceId])

  const fullPageHref = `/admin/sources/${sourceId}/transcript`
  const heading = payload ? transcriptHeading(payload) : (title ?? "Transcript")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size} className={className}>
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-4xl flex-col gap-0 p-0">
        <DialogHeader className="border-b px-6 pb-4 pr-12 pt-6 text-left">
          <DialogTitle className="leading-snug">{heading}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1 text-sm text-muted-foreground">
              <span>{payload ? describeTranscriptView(payload.view) : "Transcript"}</span>
              {payload && <EpisodeLinks links={payload.links} />}
              <Button asChild variant="outline" size="sm" className="ml-auto">
                <a href={fullPageHref} target="_blank" rel="noopener noreferrer">
                  Open in a new tab
                </a>
              </Button>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {loading && <p className="text-sm text-muted-foreground">Loading the transcript…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {payload && !loading && <TranscriptReader view={payload.view} videoUrl={payload.videoUrl} />}
        </div>
      </DialogContent>
    </Dialog>
  )
}
