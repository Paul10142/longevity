"use client"

import { useState } from "react"
import Link from "next/link"
import { ThumbsDown, ThumbsUp } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { isPublicUrl } from "@/lib/sourceLinks"
import { formatDate } from "@/components/ask/askLib"
import type { Episode, TopicLink } from "@/components/ask/types"

/** The three suggested next questions; each re-asks. */
export function FollowUps({ questions, onAsk }: { questions: string[]; onAsk: (q: string) => void }) {
  if (questions.length === 0) return null
  return (
    <section aria-label="Follow-Up Questions" className="space-y-2">
      <h2 className="text-sm font-semibold">Follow-Up Questions</h2>
      <div className="flex flex-col gap-2">
        {questions.slice(0, 3).map((q) => (
          <Button
            key={q}
            variant="outline"
            className="h-auto justify-start whitespace-normal py-2 text-left font-normal"
            onClick={() => onAsk(q)}
          >
            {q}
          </Button>
        ))}
      </div>
    </section>
  )
}

/** Episodes behind the answer, most-cited first. */
export function GoDeeper({ episodes, loading }: { episodes: Episode[]; loading: boolean }) {
  if (episodes.length === 0 && !loading) return null
  return (
    <section aria-label="Go Deeper" className="space-y-2">
      <h2 className="text-sm font-semibold">Go Deeper</h2>
      <p className="text-xs text-muted-foreground">Episodes behind this brief, ranked by how many citations they support.</p>
      {episodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Finding the episodes…</p>
      ) : (
        <div role="list" className="divide-y rounded-lg border bg-card">
          {episodes.slice(0, 8).map((e) => {
            const date = formatDate(e.date)
            return (
              <div role="listitem" key={e.id} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                {e.href && isPublicUrl(e.href) ? (
                  <a href={e.href} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">
                    {e.title}
                  </a>
                ) : (
                  <span className="font-medium">{e.title}</span>
                )}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {e.citations} {e.citations === 1 ? "citation" : "citations"}
                  {date ? ` · ${date}` : ""}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/** Library pages (topic articles) that exist for the subject. */
export function RelatedPages({ topics }: { topics: TopicLink[] }) {
  if (topics.length === 0) return null
  return (
    <section aria-label="Related Pages" className="space-y-2">
      <h2 className="text-sm font-semibold">Related Pages</h2>
      <div className="flex flex-wrap gap-2">
        {topics.map((t) => (
          <Link key={t.slug} href={`/topics/${t.slug}`}>
            <Badge variant="secondary" className="px-3 py-1 text-sm font-medium hover:bg-muted">
              {t.name}
            </Badge>
          </Link>
        ))}
      </div>
    </section>
  )
}

type FeedbackStatus = "idle" | "sending" | "sent" | "error"

/** Thumbs up/down on a finished brief, with an optional note. */
export function FeedbackBar({ answerId, post }: { answerId: string; post: (body: { rating: 1 | -1; note?: string }) => Promise<boolean> }) {
  const [rating, setRating] = useState<1 | -1 | null>(null)
  const [note, setNote] = useState("")
  const [status, setStatus] = useState<FeedbackStatus>("idle")
  const [noteSent, setNoteSent] = useState(false)

  const send = async (r: 1 | -1, text?: string) => {
    setStatus("sending")
    const ok = await post({ rating: r, ...(text ? { note: text } : {}) })
    setStatus(ok ? "sent" : "error")
    return ok
  }

  const rate = async (r: 1 | -1) => {
    setRating(r)
    setNoteSent(false)
    await send(r)
  }

  return (
    <div className="space-y-2 border-t pt-4" data-answer-id={answerId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Was this brief helpful?</span>
        <Button
          variant={rating === 1 ? "default" : "outline"}
          size="sm"
          aria-pressed={rating === 1}
          aria-label="Helpful"
          onClick={() => rate(1)}
          disabled={status === "sending"}
        >
          <ThumbsUp />
        </Button>
        <Button
          variant={rating === -1 ? "default" : "outline"}
          size="sm"
          aria-pressed={rating === -1}
          aria-label="Not helpful"
          onClick={() => rate(-1)}
          disabled={status === "sending"}
        >
          <ThumbsDown />
        </Button>
        {status === "sent" && <span className="text-xs text-muted-foreground">Thanks, saved.</span>}
        {status === "error" && <span className="text-xs text-destructive">Could not save that. Try again.</span>}
      </div>
      {rating !== null && !noteSent && (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!note.trim()) return
            if (await send(rating, note.trim())) setNoteSent(true)
          }}
        >
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={rating === -1 ? "What was wrong or missing? (optional)" : "Anything to add? (optional)"}
            aria-label="Add a note"
          />
          <Button type="submit" variant="outline" size="sm" className="h-10" disabled={!note.trim() || status === "sending"}>
            Send Note
          </Button>
        </form>
      )}
    </div>
  )
}
