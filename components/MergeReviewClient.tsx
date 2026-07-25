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

/**
 * The adjudicator's reasoning is shown to the reviewer — but when the local
 * `claude` CLI crashes, that field holds the raw error (which embeds the entire
 * system prompt as the failed command line). Never surface that wall of text;
 * replace it with a plain status. Root-cause fix lives with the dedup pipeline.
 */
function readableReasoning(r: Review): { text: string; failed: boolean } | null {
  if (!r.model_reasoning) return null
  const failed = /adjudication failed|claude cli failed|command failed/i.test(r.model_reasoning)
  if (failed) {
    return { text: "Automatic duplicate-check couldn’t run — please decide manually.", failed: true }
  }
  return { text: r.model_reasoning, failed: false }
}

/**
 * One side of the pair. Sources are always shown (no toggle): each claim here is
 * our rewrite, and the reviewer needs the verbatim source quotes to judge it. We
 * show them flat — source name, then the quote in italics — with no member/source
 * counter, since for these provisional pairs "member" and "source" are the same
 * thing and the duplication only confused things.
 */
function ClaimCard({ label, claim }: { label: string; claim: ClaimSide }) {
  const [members, setMembers] = useState<Member[] | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/claims/${claim.id}/members`, { cache: "no-store" })
        const data = await res.json()
        if (!cancelled) setMembers(data.members || [])
      } catch {
        if (!cancelled) setMembers([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [claim.id])

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

      <div className="mt-3 space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Verbatim from the source{members && members.length === 1 ? "" : "s"}
        </div>
        {members === null ? (
          <p className="text-xs text-muted-foreground">Loading sources…</p>
        ) : members.length === 0 ? (
          <p className="text-xs text-muted-foreground">No source records.</p>
        ) : (
          members.map((m) => (
            <div key={m.raw_insight_id} className="text-xs">
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
                {(formatMs(m.start_ms) ?? m.locator) && (
                  <span className="ml-2 opacity-70">{formatMs(m.start_ms) ?? m.locator}</span>
                )}
              </div>
              <p className="italic mt-0.5">“{m.direct_quote || m.statement}”</p>
            </div>
          ))
        )}
      </div>
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
      {reviews.map((r) => {
        const reasoning = readableReasoning(r)
        return (
          <Card key={r.id}>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs">
                {reasoning?.failed ? (
                  <Badge variant="destructive">Needs review</Badge>
                ) : (
                  r.model_verdict && <Badge variant="secondary">{r.model_verdict}</Badge>
                )}
                {!reasoning?.failed && r.model_confidence != null && (
                  <span className="text-muted-foreground">conf {r.model_confidence.toFixed(2)}</span>
                )}
                {r.similarity != null && (
                  <span className="text-muted-foreground">sim {r.similarity.toFixed(3)}</span>
                )}
              </div>
              {reasoning && (
                <p className="text-xs italic text-muted-foreground">{reasoning.text}</p>
              )}
              {/* Existing Candidate on the LEFT, New (Provisional) on the RIGHT —
                  reads more naturally: what we have, then what came in. */}
              <div className="flex flex-col md:flex-row gap-3">
                <ClaimCard label="Existing Candidate" claim={r.candidate} />
                <ClaimCard label="New (Provisional)" claim={r.claim} />
              </div>
              {/* Keep Separate (left) vs Merge (right), full-width and larger. */}
              <div className="flex gap-3 pt-1">
                <Button
                  className="flex-1"
                  variant="outline"
                  disabled={busy === r.id}
                  onClick={() => decide(r.id, "reject")}
                >
                  Keep Separate
                </Button>
                <Button
                  className="flex-1"
                  disabled={busy === r.id}
                  onClick={() => decide(r.id, "accept")}
                >
                  Merge (Same Claim)
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
