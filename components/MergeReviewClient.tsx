"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

type ClaimSide = {
  id: string
  canonical_statement: string
  context_note: string | null
  member_count: number
  source_count: number
}

type Member = {
  raw_insight_id: string
  matched_by: string
  statement: string
  direct_quote: string | null
  locator: string
  start_ms: number | null
  evidence_type: string
  confidence: string
  source: { id: string; title: string; type: string; url: string | null } | null
}

type Review = {
  id: string
  similarity: number | null
  model_verdict: "SAME" | "DIFFERENT" | "UNSURE" | null
  model_confidence: number | null
  model_reasoning: string | null
  created_at: string
  claim: ClaimSide
  candidate: ClaimSide
}

function formatMs(ms: number | null): string | null {
  if (ms == null) return null
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`
}

function ClaimCard({ label, claim }: { label: string; claim: ClaimSide }) {
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<Member[] | null>(null)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && members === null) {
      const res = await fetch(`/api/claims/${claim.id}/members`, { cache: "no-store" })
      const data = await res.json()
      setMembers(data.members || [])
    }
  }

  return (
    <div className="flex-1 min-w-0 rounded-md border p-3">
      <div className="text-xs font-semibold text-muted-foreground mb-1">{label}</div>
      {/* The canonical claim — our rewrite, not a quote */}
      <p className="text-sm">{claim.canonical_statement}</p>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mt-0.5">
        Our rewrite
      </div>
      {claim.context_note && (
        <p className="text-xs text-muted-foreground mt-1">{claim.context_note}</p>
      )}

      <button
        type="button"
        onClick={toggle}
        className="text-xs text-muted-foreground mt-2 inline-flex items-center gap-1 hover:text-foreground"
      >
        <span className="w-3 shrink-0">{open ? "▾" : "▸"}</span>
        {claim.member_count} member{claim.member_count === 1 ? "" : "s"} · {claim.source_count} source
        {claim.source_count === 1 ? "" : "s"}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {members === null ? (
            <p className="text-xs text-muted-foreground pl-4">Loading sources…</p>
          ) : members.length === 0 ? (
            <p className="text-xs text-muted-foreground pl-4">No source records.</p>
          ) : (
            <>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 pl-4">
                Verbatim from the sources — the claim above is our rewrite of these
              </p>
              {members.map((m) => (
                <div key={m.raw_insight_id} className="text-xs border-l-2 pl-3 py-1">
                  <div className="text-muted-foreground">
                    {m.source ? (
                      m.source.url ? (
                        <a
                          href={m.source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline font-medium"
                        >
                          {m.source.title}
                        </a>
                      ) : (
                        <span className="font-medium">{m.source.title}</span>
                      )
                    ) : (
                      <span>Unknown source</span>
                    )}
                    <span className="ml-2 opacity-70">{formatMs(m.start_ms) ?? m.locator}</span>
                  </div>
                  {m.direct_quote ? (
                    <blockquote className="mt-1 border-l-2 border-muted-foreground/30 pl-2 italic">
                      “{m.direct_quote}”
                    </blockquote>
                  ) : (
                    <div className="mt-0.5">{m.statement}</div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function MergeReviewClient() {
  const [reviews, setReviews] = useState<Review[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/reviews", { cache: "no-store" })
      const data = await res.json()
      setReviews(data.reviews || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function decide(id: string, action: "accept" | "reject") {
    setBusy(id)
    try {
      const res = await fetch(`/api/admin/reviews/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      if (res.ok) setReviews((rs) => rs.filter((r) => r.id !== id))
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (reviews.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">
          No pending merge reviews. Borderline duplicates land here when consolidation is unsure.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {reviews.map((r) => (
        <Card key={r.id}>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs">
              {r.model_verdict && <Badge variant="secondary">{r.model_verdict}</Badge>}
              {r.model_confidence != null && (
                <span className="text-muted-foreground">conf {r.model_confidence.toFixed(2)}</span>
              )}
              {r.similarity != null && (
                <span className="text-muted-foreground">sim {r.similarity.toFixed(3)}</span>
              )}
            </div>
            {r.model_reasoning && <p className="text-xs italic text-muted-foreground">{r.model_reasoning}</p>}
            <div className="flex flex-col md:flex-row gap-3">
              <ClaimCard label="New (Provisional)" claim={r.claim} />
              <ClaimCard label="Existing Candidate" claim={r.candidate} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === r.id}
                onClick={() => decide(r.id, "reject")}
              >
                Keep Separate
              </Button>
              <Button size="sm" disabled={busy === r.id} onClick={() => decide(r.id, "accept")}>
                Merge (Same Claim)
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
