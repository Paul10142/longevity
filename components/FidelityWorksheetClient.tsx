"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
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
}

const VERDICTS = [
  { v: "FAITHFUL", hint: "Fully supported by the transcript excerpt", tone: "ok" },
  { v: "ADDED_DETAIL", hint: "States something the excerpt does not", tone: "flag" },
  { v: "DROPPED_QUALIFIER", hint: "Loses a caveat that changes the meaning", tone: "warn" },
  { v: "UNRESOLVED_REFERENCE", hint: "Leans on context the excerpt lacks", tone: "warn" },
] as const

const toneClasses: Record<string, string> = {
  ok: "data-[sel=true]:bg-emerald-600 data-[sel=true]:text-white data-[sel=true]:border-emerald-600",
  flag: "data-[sel=true]:bg-red-600 data-[sel=true]:text-white data-[sel=true]:border-red-600",
  warn: "data-[sel=true]:bg-amber-500 data-[sel=true]:text-white data-[sel=true]:border-amber-500",
}

export function FidelityWorksheetClient() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showJudge, setShowJudge] = useState(false)
  // Pair ids with a save in flight, so a slow network can't double-fire.
  const saving = useRef(new Set<string>())

  useEffect(() => {
    fetch("/api/admin/fidelity")
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(d => setItems(d.items))
      .catch(e => setError(String(e)))
  }, [])

  const labeled = useMemo(() => (items ?? []).filter(i => i.label).length, [items])

  async function setLabel(item: Item, label: string) {
    if (saving.current.has(item.id)) return
    const next = item.label === label ? null : label // click again to clear
    saving.current.add(item.id)
    // Optimistic; revert on failure.
    setItems(prev => prev!.map(i => (i.id === item.id ? { ...i, label: next } : i)))
    try {
      const res = await fetch("/api/admin/fidelity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair_id: item.id, label: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      setItems(prev => prev!.map(i => (i.id === item.id ? { ...i, label: item.label } : i)))
      setError("A label failed to save — check your connection and click it again.")
    } finally {
      saving.current.delete(item.id)
    }
  }

  function jumpToUnlabeled() {
    const first = (items ?? []).find(i => !i.label)
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
        <Button size="sm" variant="outline" onClick={jumpToUnlabeled} disabled={labeled === items.length}>
          Next unlabeled
        </Button>
        <label className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showJudge} onChange={e => setShowJudge(e.target.checked)} />
          reveal the AI judge&apos;s take (label first — your ruling should be independent)
        </label>
        <a className="ml-auto" href="/api/admin/fidelity?export=goldset" download="extraction-goldset.json">
          <Button size="sm" variant="secondary">Export gold set ↓</Button>
        </a>
        {error && <span className="text-xs text-destructive w-full">{error}</span>}
      </div>

      {items.map(item => (
        <Card key={item.id} id={`pair-${item.n}`} className={item.label ? "opacity-80" : ""}>
          <CardContent className="pt-5 space-y-3">
            <div className="text-xs text-muted-foreground">
              #{item.n} · {item.source}
              {!item.quote_verified && (
                <span className="ml-2 text-amber-600">quote could not be verified against the transcript</span>
              )}
            </div>

            <p className="font-medium leading-snug">{item.statement}</p>
            {item.context && <p className="text-sm text-muted-foreground">Context: {item.context}</p>}
            {item.quote && (
              <blockquote className="text-sm border-l-2 pl-3 italic text-muted-foreground">
                &ldquo;{item.quote}&rdquo;
              </blockquote>
            )}

            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground select-none">Transcript excerpt</summary>
              <p className="mt-2 whitespace-pre-wrap text-muted-foreground max-h-72 overflow-y-auto">{item.chunk}</p>
            </details>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {VERDICTS.map(({ v, hint, tone }) => (
                <button
                  key={v}
                  data-sel={item.label === v}
                  title={hint}
                  onClick={() => setLabel(item, v)}
                  className={`rounded-md border px-2 py-2 text-xs font-medium transition-colors hover:border-foreground/40 ${toneClasses[tone]}`}
                >
                  {v.replaceAll("_", " ")}
                </button>
              ))}
            </div>

            {showJudge && (
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
