import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SpeakerReviewClient } from "@/components/SpeakerReviewClient"
import type { SpeakerCardData } from "@/components/SpeakerReviewClient"
import { foldForMatch } from "@/lib/personName"
import { formatTimestamp, isUnnamedLabel, originalLink } from "@/lib/speakerReview"
import { loadSpeakerContext } from "@/lib/speakerReviewData"

export const dynamic = "force-dynamic"

export default async function SpeakerReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await loadSpeakerContext(id)

  const back = (
    <Link href="/admin/speakers">
      <Button variant="ghost" size="sm">← All Episodes</Button>
    </Link>
  )

  if ("error" in ctx) {
    return (
      <div className="min-h-screen bg-background">
        <main className="container mx-auto px-4 py-12">
          <div className="max-w-5xl mx-auto space-y-4">
            {back}
            <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{ctx.error}</p>
          </div>
        </main>
      </div>
    )
  }

  const { source, speakers, saved, allowed, turns, columnMissing, hostLabel } = ctx
  const extracted = source.processing_status === "succeeded"
  const original = originalLink(source, 0)
  const unnamedNow = new Set(speakers.map(s => s.label))
  const waiting = Object.entries(saved).filter(([label, a]) => a.name !== null && unnamedNow.has(label))
  const applied = Object.entries(saved).filter(([label, a]) => a.name !== null && !unnamedNow.has(label))
  const biggest = Math.max(0, ...speakers.map(s => s.words))

  const cards: SpeakerCardData[] = speakers.map(s => ({
    label: s.label,
    words: s.words,
    turns: s.turns,
    sharePct: Math.round(s.share * 100),
    talksMost: speakers.length > 1 && s.words === biggest,
    firstTurns: s.firstTurns.map(t => {
      const link = originalLink(source, t.start_ms)
      return { at: formatTimestamp(t.start_ms), text: t.text, href: link?.href ?? null, linkLabel: link?.label ?? null, timed: link?.timed ?? false }
    }),
  }))
  const initial = Object.fromEntries(Object.entries(saved).filter(([label]) => unnamedNow.has(label)).map(([label, a]) => [label, a.name]))
  const guests = allowed.filter(n => foldForMatch(n) !== foldForMatch(hostLabel ?? ""))
  const hasAudioOnlyOnMac = !!source.external_id && original && !original.timed

  return (
    <div className="min-h-screen bg-background">
      <main>
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-5xl mx-auto space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight">{source.title ?? "(untitled)"}</h1>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {source.external_id && <span className="font-mono text-xs">{source.external_id}</span>}
                  <Badge variant="outline">{extracted ? "Already Extracted" : source.processing_status === "pending" ? "Queued" : source.processing_status ?? "Unknown Status"}</Badge>
                  <span>Host: {hostLabel ?? "unknown"}</span>
                  <span>Guests listed: {guests.join(", ") || "none"}</span>
                </div>
                {original && (
                  <p className="text-sm">
                    <a href={original.href} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">
                      {original.timed ? "Open The Original" : original.label}
                    </a>
                  </p>
                )}
                {hasAudioOnlyOnMac && (
                  <p className="max-w-2xl text-xs text-muted-foreground">
                    This show’s audio is not stored online, so the link opens the episode page and each voice below says
                    where to listen. The audio file is on the runner’s Mac, in the audio folder named {source.external_id}.
                  </p>
                )}
              </div>
              {back}
            </div>

            {columnMissing && (
              <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                Migration 038 (the column that stores your answers) is not applied yet, so saving is off.
              </p>
            )}
            {extracted && (
              <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                This episode was already extracted. Saving still works, but a re-attach skips extracted episodes, so the
                names reach it only after it is retired and extracted again.
              </p>
            )}
            {waiting.length > 0 && (
              <p className="rounded-md border p-3 text-sm">
                Saved and waiting for the re-attach: {waiting.map(([label, a]) => `${label} → ${a.name}`).join("; ")}.
              </p>
            )}
            {applied.length > 0 && (
              <p className="rounded-md border p-3 text-sm">
                Already in the transcript: {applied.map(([, a]) => a.name).join(", ")}.
              </p>
            )}

            {speakers.length === 0 ? (
              <p className="rounded-md border p-4 text-sm text-muted-foreground">
                No voice in this transcript is still unnamed, so there is nothing to assign.
              </p>
            ) : (
              <SpeakerReviewClient
                id={source.id}
                names={allowed}
                speakers={cards}
                initial={initial}
                saveDisabledReason={columnMissing ? "Migration 038 is not applied" : null}
                canSuggest={guests.length === 1}
              />
            )}

            <details className="rounded-md border p-4">
              <summary className="cursor-pointer text-sm font-medium">Full Transcript ({turns.length.toLocaleString()} Turns)</summary>
              <div className="mt-4 space-y-3 text-sm">
                {turns.map((t, i) => {
                  const link = originalLink(source, t.start_ms)
                  return (
                    <p key={i}>
                      <span className="mr-2 text-xs tabular-nums text-muted-foreground">
                        {link?.timed ? (
                          <a href={link.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                            {formatTimestamp(t.start_ms)}
                          </a>
                        ) : (
                          formatTimestamp(t.start_ms)
                        )}
                      </span>
                      <strong className={isUnnamedLabel(t.label) ? "text-foreground" : "text-muted-foreground"}>{t.label}:</strong>{" "}
                      {t.text}
                    </p>
                  )
                })}
              </div>
            </details>
          </div>
        </div>
      </main>
    </div>
  )
}
