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

function ClaimCard({ label, claim }: { label: string; claim: ClaimSide }) {
  return (
    <div className="flex-1 min-w-0 rounded-md border p-3">
      <div className="text-xs font-semibold text-muted-foreground mb-1">{label}</div>
      <p className="text-sm">{claim.canonical_statement}</p>
      {claim.context_note && (
        <p className="text-xs text-muted-foreground mt-1">{claim.context_note}</p>
      )}
      <div className="text-xs text-muted-foreground mt-2">
        {claim.member_count} member{claim.member_count === 1 ? "" : "s"} · {claim.source_count} source
        {claim.source_count === 1 ? "" : "s"}
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
              <ClaimCard label="New (provisional)" claim={r.claim} />
              <ClaimCard label="Existing candidate" claim={r.candidate} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={busy === r.id}
                onClick={() => decide(r.id, "reject")}
              >
                Keep separate
              </Button>
              <Button size="sm" disabled={busy === r.id} onClick={() => decide(r.id, "accept")}>
                Merge (same claim)
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
