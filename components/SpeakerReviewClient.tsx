"use client"

import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export type SpeakerCardData = {
  label: string
  words: number
  turns: number
  /** Share of the unnamed voices' words, 0-100. */
  sharePct: number
  talksMost: boolean
  firstTurns: { at: string; text: string; href: string | null; linkLabel: string | null; timed: boolean }[]
}

/** `null` = "Not A Guest"; a string = a name from the episode; undefined = not answered yet. */
type Choice = string | null | undefined

type Props = {
  id: string
  /** The names that can be clicked (the host first, then the guests). */
  names: string[]
  speakers: SpeakerCardData[]
  /** What is already saved, label → name or null. */
  initial: Record<string, string | null>
  /** Why saving is off (migration not applied), or null. */
  saveDisabledReason: string | null
  canSuggest: boolean
}

export function SpeakerReviewClient({ id, names, speakers, initial, saveDisabledReason, canSuggest }: Props) {
  const [choice, setChoice] = useState<Record<string, Choice>>(() => ({ ...initial }))
  const [saved, setSaved] = useState<Record<string, string | null>>(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [suggestion, setSuggestion] = useState<{ label: string | null; why: string } | null>(null)
  const [suggesting, setSuggesting] = useState(false)

  const answered = speakers.filter(s => choice[s.label] !== undefined).length
  const dirty = useMemo(
    () => speakers.some(s => choice[s.label] !== undefined && (!(s.label in saved) || saved[s.label] !== choice[s.label])),
    [speakers, choice, saved]
  )

  function pick(label: string, value: Choice) {
    setMessage(null)
    setChoice(prev => ({ ...prev, [label]: prev[label] === value ? undefined : value }))
  }

  async function save() {
    setBusy(true)
    setMessage(null)
    const assignments: Record<string, string | null> = {}
    for (const s of speakers) if (choice[s.label] !== undefined) assignments[s.label] = choice[s.label] as string | null
    try {
      const res = await fetch(`/api/admin/speakers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments }),
      })
      const body = (await res.json()) as { error?: string; saved?: Record<string, { name: string | null }> }
      if (!res.ok) throw new Error(body.error ?? `save failed (${res.status})`)
      const next: Record<string, string | null> = {}
      for (const [label, a] of Object.entries(body.saved ?? {})) next[label] = a.name
      setSaved(next)
      setMessage({
        tone: "ok",
        text: "Saved. The names reach the transcript when the runner re-attaches this episode; nothing in the transcript has changed yet.",
      })
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function suggest() {
    setSuggesting(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/admin/speakers/${id}/suggest`, { method: "POST" })
      const body = (await res.json()) as { error?: string; label?: string | null; why?: string }
      if (!res.ok) throw new Error(body.error ?? `suggestion failed (${res.status})`)
      setSuggestion({ label: body.label ?? null, why: body.why ?? "" })
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : String(e) })
    } finally {
      setSuggesting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {canSuggest && (
          <Button variant="outline" size="sm" onClick={suggest} disabled={suggesting}>
            {suggesting ? "Reading…" : "Suggest A Guest"}
          </Button>
        )}
        {suggestion && (
          <p className="text-sm text-muted-foreground">
            {suggestion.label ? (
              <>
                {suggestion.why}. Check it against what you hear.
              </>
            ) : (
              <>No suggestion: {suggestion.why}.</>
            )}
          </p>
        )}
      </div>

      {speakers.map(s => {
        const picked = choice[s.label]
        return (
          <Card key={s.label} className={cn(suggestion?.label === s.label && "border-foreground/60")}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-xl">{s.label}</CardTitle>
                <Badge variant="secondary">{s.sharePct}% Of The Unnamed Talking</Badge>
                <Badge variant="outline">{s.words.toLocaleString()} Words</Badge>
                <Badge variant="outline">{s.turns} {s.turns === 1 ? "Turn" : "Turns"}</Badge>
                {s.talksMost && <Badge variant="outline">Talks The Most</Badge>}
                {suggestion?.label === s.label && <Badge>Suggested Guest</Badge>}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <p className="text-sm font-medium">First Things This Voice Says</p>
                {s.firstTurns.map((t, i) => (
                  <div key={i} className="rounded-md border bg-muted/30 p-3 text-sm">
                    <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="tabular-nums">At {t.at}</span>
                      {t.href && (
                        <a href={t.href} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline underline-offset-4">
                          {t.linkLabel}
                          {!t.timed && ` (Go To ${t.at})`}
                        </a>
                      )}
                    </div>
                    <p>{t.text}</p>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Who Is This?</p>
                <div className="flex flex-wrap gap-2">
                  {names.map(name => (
                    <Button
                      key={name}
                      type="button"
                      size="sm"
                      variant={picked === name ? "default" : "outline"}
                      aria-pressed={picked === name}
                      onClick={() => pick(s.label, name)}
                    >
                      {name}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant={picked === null ? "default" : "outline"}
                    aria-pressed={picked === null}
                    onClick={() => pick(s.label, null)}
                  >
                    Not A Guest (Ad / Clip / Producer)
                  </Button>
                </div>
                {s.label in saved && saved[s.label] === picked && (
                  <p className="text-xs text-muted-foreground">Saved: {saved[s.label] ?? "Not a guest"}</p>
                )}
              </div>
            </CardContent>
          </Card>
        )
      })}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} disabled={busy || !dirty || saveDisabledReason !== null}>
          {busy ? "Saving…" : "Save Speaker Names"}
        </Button>
        <span className="text-sm text-muted-foreground">
          {answered} of {speakers.length} answered
        </span>
        {saveDisabledReason && <span className="text-sm text-destructive">{saveDisabledReason}</span>}
        {message && (
          <span className={cn("text-sm", message.tone === "error" ? "text-destructive" : "text-emerald-700 dark:text-emerald-400")}>
            {message.text}
          </span>
        )}
      </div>
    </div>
  )
}
