"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { FlagContext, Part, ContextTurn } from "@/lib/flagReview"

type Flag = {
  id: string
  claim_id: string
  rule: string
  detail: string | null
  evidence: Record<string, unknown> | null
  created_at: string
  needs_video_check_at?: string | null
  claims: { canonical_statement: string } | null
}

type Tab = "todo" | "video"
type Action = "approve" | "reject" | "edit" | "needs_video_check"

const RULE_LABELS: Record<string, string> = {
  extraction_fidelity: "May Not Match the Source",
  merge_fidelity: "Merge May Have Invented a Number",
  orphan_topic: "Not Filed Under a Topic",
  manual: "Flagged by Hand",
  standalone: "May Not Stand on Its Own",
  contradiction: "May Contradict Another Fact",
}
const VERDICT_LABELS: Record<string, string> = {
  ADDED_DETAIL: "Added Detail",
  DROPPED_QUALIFIER: "Dropped Hedge",
}

const ruleLabel = (rule: string) => RULE_LABELS[rule] ?? rule
const verdictOf = (f: Flag): string | null => {
  const v = f.evidence?.verdict
  return typeof v === "string" ? v : null
}
const verdictLabel = (v: string | null) => (v ? VERDICT_LABELS[v] ?? v : null)

/** Marked text: the offending phrase in red, the claim's quoted span in yellow. */
function Marked({ parts, tone }: { parts: Part[]; tone: "offending" | "quote" }) {
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark
            key={i}
            className={cn(
              "rounded px-0.5 text-foreground",
              tone === "offending" ? "bg-red-200 dark:bg-red-900/60" : "bg-yellow-200 dark:bg-yellow-700/60"
            )}
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

function stamp(ms: number | null): string {
  if (ms === null) return ""
  const t = Math.floor(ms / 1000)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = String(t % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

function TurnView({ turn }: { turn: ContextTurn }) {
  return (
    <div className={cn("text-sm leading-relaxed", turn.role !== "claim" && "text-muted-foreground")}>
      <div className="text-[11px] text-muted-foreground/80 mb-0.5">
        {turn.speaker ? <span className="font-medium">{turn.speaker}</span> : null}
        {turn.speaker && turn.start_ms !== null ? " · " : null}
        {turn.start_ms !== null ? stamp(turn.start_ms) : null}
      </div>
      <p>
        {turn.clippedStart ? "… " : ""}
        <Marked parts={turn.parts} tone="quote" />
        {turn.clippedEnd ? " …" : ""}
      </p>
    </div>
  )
}

function ContextPanel({ ctx }: { ctx: FlagContext }) {
  const { context } = ctx
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        From the Transcript
      </h3>
      {context.kind === "none" ? (
        <p className="text-sm text-muted-foreground">
          No transcript text could be found for this claim.
        </p>
      ) : (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          {context.turns.map((t, i) => (
            <TurnView key={i} turn={t} />
          ))}
        </div>
      )}
      {context.kind !== "none" && !context.quoteFound && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          The claim’s quoted passage could not be located in this text, so nothing is highlighted. The
          passage below is the closest match by time.
        </p>
      )}
      {context.kind === "chunk" && (
        <p className="text-xs text-muted-foreground">
          This episode has no timed transcript; showing the passage the judge read.
        </p>
      )}
    </section>
  )
}

function WhereToWatch({ ctx }: { ctx: FlagContext }) {
  const title = ctx.source?.title ?? "Unknown episode"
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Where to Watch
      </h3>
      <p className="text-sm">
        <span className="font-medium">{title}</span>
        {ctx.source?.date ? <span className="text-muted-foreground"> · {ctx.source.date}</span> : null}
        {ctx.timestampLabel ? <span className="text-muted-foreground"> · at {ctx.timestampLabel}</span> : null}
      </p>
      {ctx.videoUrl ? (
        <a
          href={ctx.videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          Open the Video 30 Seconds Before This Claim ↗
        </a>
      ) : (
        <p className="text-xs text-muted-foreground">
          No YouTube video is on file for this episode
          {ctx.timestampLabel ? `; the claim is at ${ctx.timestampLabel}` : ""}.
          {ctx.links.map((l) => (
            <a
              key={l.kind}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 text-primary hover:underline"
            >
              {l.label} ↗
            </a>
          ))}
        </p>
      )}
    </section>
  )
}

export function FlagReviewClient() {
  const [flags, setFlags] = useState<Flag[]>([])
  const [videoCheckAvailable, setVideoCheckAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>("todo")
  const [verdict, setVerdict] = useState<string>("all")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [contexts, setContexts] = useState<Record<string, FlagContext | { error: string }>>({})
  const inflight = useRef<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/flags", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Could not load flags")
      setFlags(data.flags || [])
      setVideoCheckAvailable(data.videoCheckAvailable !== false)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load flags")
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const fetchContext = useCallback(async (id: string) => {
    if (inflight.current.has(id)) return
    inflight.current.add(id)
    try {
      const res = await fetch(`/api/admin/flags/${id}/context`, { cache: "no-store" })
      const data = await res.json()
      setContexts((c) => ({ ...c, [id]: res.ok ? data.context : { error: data.error || "Could not load context" } }))
    } catch (err) {
      setContexts((c) => ({ ...c, [id]: { error: err instanceof Error ? err.message : "Could not load context" } }))
    } finally {
      inflight.current.delete(id)
    }
  }, [])

  const counts = useMemo(() => {
    const video = flags.filter((f) => f.needs_video_check_at).length
    return { todo: flags.length - video, video }
  }, [flags])

  const verdicts = useMemo(() => {
    const set = new Set<string>()
    for (const f of flags) {
      const v = verdictOf(f)
      if (v) set.add(v)
    }
    return [...set].sort()
  }, [flags])

  const visible = useMemo(
    () =>
      flags.filter((f) => {
        if (tab === "video" ? !f.needs_video_check_at : f.needs_video_check_at) return false
        if (verdict !== "all" && verdictOf(f) !== verdict) return false
        return true
      }),
    [flags, tab, verdict]
  )

  // Keep a valid selection; fetch context for it and the next one in line.
  const selected = visible.find((f) => f.id === selectedId) ?? visible[0] ?? null
  const selectedIndex = selected ? visible.indexOf(selected) : -1
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])
  useEffect(() => {
    if (!selected) return
    fetchContext(selected.id)
    const next = visible[selectedIndex + 1]
    if (next) fetchContext(next.id)
  }, [selected, selectedIndex, visible, fetchContext])
  useEffect(() => {
    setEditing(false)
    setMessage(null)
  }, [selectedId])

  const ctxEntry = selected ? contexts[selected.id] : undefined
  const ctx = ctxEntry && !("error" in ctxEntry) ? ctxEntry : null
  const ctxError = ctxEntry && "error" in ctxEntry ? ctxEntry.error : null

  const move = useCallback(
    (delta: number) => {
      if (selectedIndex < 0) return
      const n = visible[selectedIndex + delta]
      if (n) setSelectedId(n.id)
    },
    [selectedIndex, visible]
  )

  const act = useCallback(
    async (action: Action, statement?: string) => {
      if (!selected || busy) return
      setBusy(true)
      setMessage(null)
      try {
        const res = await fetch("/api/admin/flags", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flagId: selected.id, action, statement }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          // 409 "already resolved": another tab got there first; drop it from the list.
          if (res.status === 409 && /already resolved/i.test(data.error || "")) {
            setFlags((fs) => fs.filter((f) => f.id !== selected.id))
          }
          setMessage(data.error || "That did not save")
          return
        }
        const nextId = visible[selectedIndex + 1]?.id ?? visible[selectedIndex - 1]?.id ?? null
        if (action === "needs_video_check") {
          setFlags((fs) => fs.map((f) => (f.id === selected.id ? { ...f, needs_video_check_at: new Date().toISOString() } : f)))
        } else {
          setFlags((fs) => fs.filter((f) => f.id !== selected.id))
        }
        setSelectedId(nextId)
        setEditing(false)
        if (data.embeddingRefreshed === false) {
          setMessage("Wording saved. Search will pick up the new wording after the next refresh.")
        }
      } finally {
        setBusy(false)
      }
    },
    [selected, busy, visible, selectedIndex]
  )

  // Keyboard: A approve, R reject, E edit, V needs video check, J/K or arrows move.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT")) return
      if (e.metaKey || e.ctrlKey || e.altKey || !selected) return
      const k = e.key.toLowerCase()
      if (k === "a") act("approve")
      else if (k === "r") act("reject")
      else if (k === "v" && tab === "todo" && videoCheckAvailable) act("needs_video_check")
      else if (k === "e") {
        e.preventDefault()
        setDraft(selected.claims?.canonical_statement ?? "")
        setEditing(true)
      } else if (k === "j" || k === "arrowdown") move(1)
      else if (k === "k" || k === "arrowup") move(-1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selected, act, move, tab, videoCheckAvailable])

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (loadError) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">{loadError}</CardContent>
      </Card>
    )
  }
  if (flags.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">No flagged facts to review 🎉</CardContent>
      </Card>
    )
  }

  const claimText = selected?.claims?.canonical_statement ?? "(claim text unavailable)"

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border p-0.5">
          {(
            [
              ["todo", `To Review (${counts.todo})`],
              ["video", `Needs Video Check (${counts.video})`],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded px-3 py-1.5 text-sm font-medium",
                tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {verdicts.length > 1 && (
          <select
            aria-label="Filter by Verdict"
            value={verdict}
            onChange={(e) => setVerdict(e.target.value)}
            className="rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="all">All Verdicts</option>
            {verdicts.map((v) => (
              <option key={v} value={v}>
                {verdictLabel(v)}
              </option>
            ))}
          </select>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          Keys: A approve · R reject · E edit · V video check · J / K next / previous
        </span>
      </div>

      {!videoCheckAvailable && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Needs Video Check is switched off until migration 036 is applied to the database.
        </p>
      )}

      {!selected ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {tab === "video" ? "Nothing is waiting on a video check." : "Nothing left to review here."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-5 p-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {selectedIndex + 1} of {visible.length}
              </span>
              <Badge variant="secondary">{ruleLabel(selected.rule)}</Badge>
              {verdictLabel(verdictOf(selected)) && <Badge variant="outline">{verdictLabel(verdictOf(selected))}</Badge>}
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => move(-1)} disabled={selectedIndex <= 0}>
                  ← Previous
                </Button>
                <Button size="sm" variant="ghost" onClick={() => move(1)} disabled={selectedIndex >= visible.length - 1}>
                  Next →
                </Button>
              </div>
            </div>

            {/* 1. The claim and the judge's reason. */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">The Claim</h3>
              <p className="text-base font-medium leading-snug">
                {ctx ? <Marked parts={ctx.canonical} tone="offending" /> : claimText}
              </p>
              {ctx?.judgedStatement && (
                <div>
                  <div className="text-[11px] text-muted-foreground">What the judge checked (the extracted statement)</div>
                  <p className="text-sm leading-snug">
                    <Marked parts={ctx.judgedStatement} tone="offending" />
                  </p>
                </div>
              )}
              {selected.detail && (
                <div className="rounded-md border-l-2 border-red-400 bg-red-50 px-3 py-2 text-sm dark:bg-red-950/30">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Why It Was Flagged</div>
                  {selected.detail}
                </div>
              )}
              {ctx && !ctx.memberMatched && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  The exact statement the judge read is no longer on this claim, so the transcript below comes from its
                  earliest source ({ctx.memberCount} in all).
                </p>
              )}
            </section>

            {/* 2 and 3. Transcript and video. */}
            {ctxError ? (
              <p className="text-sm text-destructive">{ctxError}</p>
            ) : !ctx ? (
              <p className="text-sm text-muted-foreground">Loading the transcript…</p>
            ) : (
              <>
                <ContextPanel ctx={ctx} />
                <WhereToWatch ctx={ctx} />
              </>
            )}

            {/* 4. Resolution. */}
            {editing ? (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Edit the Wording</h3>
                <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} autoFocus />
                <div className="flex gap-2">
                  <Button disabled={busy || !draft.trim()} onClick={() => act("edit", draft)}>
                    Save and Approve
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </section>
            ) : (
              <div className="sticky bottom-0 -mx-5 flex flex-col gap-2 border-t bg-card/95 px-5 py-3 backdrop-blur sm:flex-row sm:flex-wrap">
                <Button disabled={busy} onClick={() => act("approve")}>
                  Approve As Is
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setDraft(claimText)
                    setEditing(true)
                  }}
                >
                  Edit and Approve
                </Button>
                <Button variant="outline" disabled={busy} onClick={() => act("reject")}>
                  Reject
                </Button>
                {tab === "todo" && (
                  <Button
                    variant="ghost"
                    disabled={busy || !videoCheckAvailable}
                    onClick={() => act("needs_video_check")}
                  >
                    Needs Video Check
                  </Button>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Approve As Is puts the claim back in articles. Reject keeps it hidden. Edit and Approve saves your wording
              and puts it back. Needs Video Check keeps it hidden and moves it to its own list.
            </p>
            {message && <p className="text-sm text-destructive">{message}</p>}
          </CardContent>
        </Card>
      )}

      {/* Queue */}
      {visible.length > 1 && (
        <div className="max-h-72 overflow-y-auto rounded-md border divide-y">
          {visible.slice(0, 200).map((f, i) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setSelectedId(f.id)}
              className={cn(
                "block w-full px-3 py-2 text-left text-xs hover:bg-muted/50",
                f.id === selected?.id && "bg-muted"
              )}
            >
              <span className="mr-2 text-muted-foreground">{i + 1}.</span>
              {verdictLabel(verdictOf(f)) && (
                <span className="mr-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {verdictLabel(verdictOf(f))}
                </span>
              )}
              {(f.claims?.canonical_statement ?? "").slice(0, 140)}
            </button>
          ))}
          {visible.length > 200 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">…and {visible.length - 200} more</div>
          )}
        </div>
      )}
    </div>
  )
}
