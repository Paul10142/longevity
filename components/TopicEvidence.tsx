"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

type Claim = {
  id: string
  canonical_statement: string
  context_note: string | null
  best_evidence_type: string | null
  max_importance: number | null
  member_count: number
  source_count: number
}

type Member = {
  raw_insight_id: string
  matched_by: string
  statement: string
  locator: string
  start_ms: number | null
  evidence_type: string
  confidence: string
  source: { id: string; title: string; type: string; url: string | null } | null
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

function ClaimRow({ claim }: { claim: Claim }) {
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
    <div className="border-b py-3">
      <button className="w-full text-left flex items-start gap-3" onClick={toggle}>
        <span className="text-muted-foreground mt-0.5 text-xs w-3 shrink-0">{open ? "▾" : "▸"}</span>
        <span className="flex-1">
          <span className="text-sm">{claim.canonical_statement}</span>
          <span className="ml-2 inline-flex gap-1.5 align-middle">
            {claim.best_evidence_type && (
              <Badge variant="outline" className="text-[10px] py-0">{claim.best_evidence_type}</Badge>
            )}
            {claim.source_count > 1 && (
              <Badge variant="secondary" className="text-[10px] py-0">{claim.source_count} sources</Badge>
            )}
          </span>
        </span>
      </button>

      {open && (
        <div className="pl-6 mt-2 space-y-2">
          {members === null ? (
            <p className="text-xs text-muted-foreground">Loading sources…</p>
          ) : members.length === 0 ? (
            <p className="text-xs text-muted-foreground">No source records.</p>
          ) : (
            members.map((m) => (
              <div key={m.raw_insight_id} className="text-xs border-l-2 pl-3 py-1">
                <div className="text-muted-foreground">
                  {m.source ? (
                    m.source.url ? (
                      <a href={m.source.url} target="_blank" rel="noopener noreferrer" className="hover:underline font-medium">
                        {m.source.title}
                      </a>
                    ) : (
                      <span className="font-medium">{m.source.title}</span>
                    )
                  ) : (
                    <span>Unknown source</span>
                  )}
                  <span className="ml-2 opacity-70">
                    {formatMs(m.start_ms) ?? m.locator}
                  </span>
                </div>
                <div className="mt-0.5">{m.statement}</div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function TopicEvidence({ topicId }: { topicId: string }) {
  const [claims, setClaims] = useState<Claim[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)

  const loadPage = useCallback(async (p: number) => {
    setLoading(true)
    const res = await fetch(`/api/topics/${topicId}/evidence?page=${p}`, { cache: "no-store" })
    const data = await res.json()
    setClaims((prev) => (p === 0 ? data.claims : [...prev, ...data.claims]))
    setTotal(data.total || 0)
    setLoading(false)
  }, [topicId])

  useEffect(() => {
    loadPage(0)
  }, [loadPage])

  const hasMore = claims.length < total

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-3">
        {total} claims · click any to trace it back to its sources
      </p>
      <div>
        {claims.map((c) => <ClaimRow key={c.id} claim={c} />)}
      </div>
      {loading && <p className="text-sm text-muted-foreground mt-4">Loading…</p>}
      {!loading && hasMore && (
        <Button
          variant="outline"
          className="mt-4"
          onClick={() => { const next = page + 1; setPage(next); loadPage(next) }}
        >
          Load more ({total - claims.length} remaining)
        </Button>
      )}
    </div>
  )
}
