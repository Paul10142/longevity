"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"

type Item = {
  n: number
  id: string
  source: string
  statement: string
  context: string | null
  quote: string | null
  quote_verified: boolean
  chunk: string
  judge_verdict: string
  judge_offending: string
  judge_reasoning: string
  label: string | null
  /** Paul and the judge disagree and he has not looked again since they were compared. */
  needs_recheck: boolean
}

const VERDICTS = [
  { v: "FAITHFUL", hint: "Fully supported by the transcript excerpt", tone: "ok" },
  { v: "ADDED_DETAIL", hint: "States something the excerpt does not", tone: "flag" },
  { v: "DROPPED_QUALIFIER", hint: "Loses a caveat that changes the meaning", tone: "warn" },
  { v: "UNRESOLVED_REFERENCE", hint: "Leans on context the excerpt lacks", tone: "warn" },
] as const

const toneClasses: Record<string, string> = {
  ok: "data-[sel=true]:bg-emerald-700 data-[sel=true]:text-white data-[sel=true]:border-emerald-700",
  flag: "data-[sel=true]:bg-red-700 data-[sel=true]:text-white data-[sel=true]:border-red-700",
  warn: "data-[sel=true]:bg-amber-700 data-[sel=true]:text-white data-[sel=true]:border-amber-700",
}

const NEW_BATCH_PREFIX = "New batch: "

type StatusFilter = "all" | "unlabeled" | "labeled" | "new"
const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unlabeled", label: "Unlabeled Only" },
  { key: "labeled", label: "Labeled Only" },
  { key: "new", label: "New Batch Only" },
]

const VERDICT_FILTERS = [
  { key: "all", label: "All Verdicts" },
  { key: "FAITHFUL", label: "Faithful" },
  { key: "ADDED_DETAIL", label: "Added Detail" },
  { key: "DROPPED_QUALIFIER", label: "Dropped Qualifier" },
  { key: "UNRESOLVED_REFERENCE", label: "Unresolved Reference" },
  { key: "UNSURE", label: "Unsure" },
] as const

const titleCase = (v: string) =>
  v.toLowerCase().split("_").map(w => w[0].toUpperCase() + w.slice(1)).join(" ")

const isNewBatch = (i: Item) => i.source.startsWith(NEW_BATCH_PREFIX)

const chipClass = (on: boolean) =>
  `min-h-[44px] rounded-md border px-3 text-sm font-medium transition-colors ${
    on ? "bg-foreground text-background border-foreground" : "bg-background hover:border-foreground/40"
  }`

export function FidelityWorksheetClient() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showJudge, setShowJudge] = useState(false)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [verdictFilter, setVerdictFilter] = useState<string>("all")
  // Cards labeled while a status filter is on stay put until the filter changes,
  // so a mis-click can be undone instead of the card vanishing.
  const [kept, setKept] = useState<Set<string>>(new Set())
  // Pair ids with a save in flight, so a slow network can't double-fire.
  const saving = useRef(new Set<string>())

  useEffect(() => {
    fetch("/api/admin/fidelity")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => setItems(d.items))
      .catch(e => setError(String(e)))
  }, [])

  const labeled = useMemo(() => (items ?? []).filter(i => i.label).length, [items])
  const rechecks = useMemo(() => (items ?? []).filter(i => i.needs_recheck).length, [items])

  const visible = useMemo(
    () =>
      (items ?? []).filter(i => {
        const statusOk =
          statusFilter === "all" ||
          kept.has(i.id) ||
          (statusFilter === "unlabeled" && !i.label) ||
          (statusFilter === "labeled" && !!i.label) ||
          (statusFilter === "new" && isNewBatch(i))
        // The verdict filter only exists while the judge's take is revealed.
        const verdictOk = !showJudge || verdictFilter === "all" || i.judge_verdict === verdictFilter
        return statusOk && verdictOk
      }),
    [items, statusFilter, verdictFilter, showJudge, kept]
  )
  const verdictCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of items ?? []) m.set(i.judge_verdict, (m.get(i.judge_verdict) ?? 0) + 1)
    return m
  }, [items])

  function changeStatus(next: StatusFilter) {
    setStatusFilter(next)
    setKept(new Set())
  }
  function toggleJudge(on: boolean) {
    setShowJudge(on)
    // Hiding the judge also drops its filter, so the default view is blind again.
    if (!on) setVerdictFilter("all")
  }
  function resetFilters() {
    setStatusFilter("all")
    setVerdictFilter("all")
    setKept(new Set())
  }

  async function save(item: Item, next: string | null) {
    if (saving.current.has(item.id)) return
    saving.current.add(item.id)
    setKept(prev => new Set(prev).add(item.id))
    // Optimistic; revert on failure. Any save is a fresh look, so it settles a re-check.
    setItems(prev => prev!.map(i => (i.id === item.id ? { ...i, label: next, needs_recheck: false } : i)))
    try {
      const res = await fetch("/api/admin/fidelity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair_id: item.id, label: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      setItems(prev =>
        prev!.map(i => (i.id === item.id ? { ...i, label: item.label, needs_recheck: item.needs_recheck } : i))
      )
      setError("A label failed to save — check your connection and click it again.")
    } finally {
      saving.current.delete(item.id)
    }
  }

  // Click a selected label again to clear it.
  const setLabel = (item: Item, label: string) => save(item, item.label === label ? null : label)

  function jumpTo(pred: (i: Item) => boolean) {
    const first = visible.find(pred)
    if (!first) return
    document.getElementById(`pair-${first.n}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  if (error && !items) return <p className="text-sm text-destructive">Failed to load: {error}</p>
  if (!items) return <p className="text-sm text-muted-foreground">Loading pairs…</p>

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-background/95 backdrop-blur border-b flex items-center gap-3 flex-wrap">
        <span className="text-sm font-medium tabular-nums">
          {labeled}/{items.length} labeled
        </span>
        <div className="h-1.5 w-40 rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-foreground/70 rounded-full" style={{ width: `${(100 * labeled) / items.length}%` }} />
        </div>
        <Button
          size="sm"
          variant="outline"
          className="min-h-[44px]"
          onClick={() => jumpTo(i => !i.label)}
          disabled={!visible.some(i => !i.label)}
        >
          Next unlabeled
        </Button>
        {rechecks > 0 && (
          <Button size="sm" className="min-h-[44px]" onClick={() => jumpTo(i => i.needs_recheck)}>
            Next re-check ({rechecks} left)
          </Button>
        )}
        <label className="text-xs text-muted-foreground flex items-center gap-2 cursor-pointer min-h-[44px]">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={showJudge}
            onChange={e => toggleJudge(e.target.checked)}
          />
          <span>
            reveal the AI judge&apos;s take (label first — your ruling should be independent)
            <span className="block">Ticking this unlocks the Judge Verdict filter below.</span>
          </span>
        </label>
        <a className="ml-auto" href="/api/admin/fidelity?export=goldset" download="extraction-goldset.json">
          <Button size="sm" variant="secondary" className="min-h-[44px]">Export gold set ↓</Button>
        </a>
        {error && <span className="text-xs text-destructive w-full">{error}</span>}
      </div>

      <div className="space-y-3" aria-label="Filters">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium mr-1">Show:</span>
          {STATUS_FILTERS.map(f => (
            <button
              key={f.key}
              aria-pressed={statusFilter === f.key}
              onClick={() => changeStatus(f.key)}
              className={chipClass(statusFilter === f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {showJudge && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium mr-1">Judge Verdict:</span>
            {VERDICT_FILTERS.filter(f => f.key !== "UNSURE" || (verdictCounts.get(f.key) ?? 0) > 0).map(f => (
              <button
                key={f.key}
                aria-pressed={verdictFilter === f.key}
                onClick={() => setVerdictFilter(f.key)}
                className={chipClass(verdictFilter === f.key)}
              >
                {f.label}
                {f.key !== "all" && <span className="ml-1.5 tabular-nums opacity-80">{verdictCounts.get(f.key) ?? 0}</span>}
              </button>
            ))}
          </div>
        )}
        {visible.length !== items.length && (
          <p className="text-sm text-muted-foreground">
            Showing {visible.length} of {items.length} · order unchanged
          </p>
        )}
      </div>

      {visible.length === 0 && (
        <Card>
          <CardContent className="pt-5 flex flex-wrap items-center gap-3">
            <p className="text-sm">No cards match these filters.</p>
            <Button size="sm" variant="outline" className="min-h-[44px]" onClick={resetFilters}>
              Clear Filters
            </Button>
          </CardContent>
        </Card>
      )}

      {visible.map(item => (
        <Card
          key={item.id}
          id={`pair-${item.n}`}
          className={item.needs_recheck ? "border-amber-500" : ""}
        >
          <CardContent className="pt-5 space-y-3">
            {item.needs_recheck && (
              <div className="text-xs rounded-md bg-amber-500/10 border border-amber-500/40 p-3 space-y-2">
                <p>
                  <span className="font-semibold">Re-check:</span> you ruled{" "}
                  <strong>{item.label?.replaceAll("_", " ")}</strong>, the AI judge ruled{" "}
                  <strong>{item.judge_verdict.replaceAll("_", " ")}</strong>. Read its reasoning below, then keep
                  your ruling or pick a different one.
                </p>
                <Button size="sm" variant="outline" onClick={() => save(item, item.label)}>
                  Keep my ruling
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                #{item.n} · {isNewBatch(item) ? item.source.slice(NEW_BATCH_PREFIX.length) : item.source}
              </span>
              {isNewBatch(item) && (
                <Badge className="border-transparent bg-violet-700 text-white hover:bg-violet-700">New Batch</Badge>
              )}
              {!item.quote_verified && (
                <span className="text-amber-700 dark:text-amber-400">
                  quote could not be verified against the transcript
                </span>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <section
                aria-label="Claim"
                className="rounded-lg border border-sky-300 bg-sky-50 p-4 dark:border-sky-800 dark:bg-sky-950/40"
              >
                <h3 className="inline-block rounded-full bg-sky-800 px-2.5 py-0.5 text-xs font-semibold text-white">
                  Claim
                </h3>
                <p className="mt-2 text-base font-semibold leading-snug text-foreground">{item.statement}</p>
              </section>

              <section
                aria-label="Quote from the Episode"
                className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30"
              >
                <h3 className="inline-block rounded-full bg-amber-800 px-2.5 py-0.5 text-xs font-semibold text-white">
                  Quote from the Episode
                </h3>
                {item.quote ? (
                  <blockquote className="mt-2 border-l-4 border-amber-500 pl-3 font-serif text-sm italic leading-relaxed text-foreground/90">
                    &ldquo;{item.quote}&rdquo;
                  </blockquote>
                ) : (
                  <p className="mt-2 text-sm italic text-foreground/80">No direct quote was recorded for this claim.</p>
                )}
                {item.context && (
                  <p className="mt-3 text-sm text-foreground/80">
                    <span className="font-semibold">Context Note:</span> {item.context}
                  </p>
                )}
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer select-none py-2 font-medium text-foreground/80">
                    Transcript Excerpt
                  </summary>
                  <p className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap text-foreground/80">{item.chunk}</p>
                </details>
              </section>
            </div>

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {VERDICTS.map(({ v, hint, tone }) => (
                <button
                  key={v}
                  data-sel={item.label === v}
                  aria-pressed={item.label === v}
                  title={hint}
                  onClick={() => setLabel(item, v)}
                  className={`min-h-[44px] rounded-md border px-2 py-2 text-sm font-medium transition-colors hover:border-foreground/40 ${toneClasses[tone]}`}
                >
                  {titleCase(v)}
                </button>
              ))}
            </div>

            {(showJudge || item.needs_recheck) && (
              <div className="text-xs rounded-md bg-muted/50 p-3 space-y-1">
                <div>
                  <span className="font-semibold">Judge:</span> {item.judge_verdict}
                  {item.judge_offending && <span> — offending: &ldquo;{item.judge_offending}&rdquo;</span>}
                </div>
                {item.judge_reasoning && <div className="text-muted-foreground">{item.judge_reasoning}</div>}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
