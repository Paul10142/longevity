"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { youtubeTimestampUrl } from "@/lib/youtubeUtils"

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
  direct_quote: string | null
  locator: string
  start_ms: number | null
  evidence_type: string
  confidence: string
  source: { id: string; title: string; type: string; url: string | null } | null
}

type Reference = {
  id: string
  title: string
  authors: string[] | null
  year: number | null
  journal: string | null
  url: string | null
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
  const [references, setReferences] = useState<Reference[]>([])

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && members === null) {
      const res = await fetch(`/api/claims/${claim.id}/members`, { cache: "no-store" })
      const data = await res.json()
      setMembers(data.members || [])
      setReferences(data.references || [])
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
                  {(() => {
                    // Deep-link to the moment in the video only when the source
                    // is a YouTube URL AND this insight carries a start_ms.
                    const label = formatMs(m.start_ms) ?? m.locator
                    const deepLink = youtubeTimestampUrl(m.source?.url, m.start_ms)
                    return deepLink ? (
                      <a
                        href={deepLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 opacity-70 hover:opacity-100 hover:underline"
                        title="Jump to this moment in the video"
                      >
                        {label} ↗
                      </a>
                    ) : (
                      <span className="ml-2 opacity-70">{label}</span>
                    )
                  })()}
                </div>
                {m.direct_quote ? (
                  <blockquote className="mt-1 border-l-2 border-muted-foreground/30 pl-2 italic">“{m.direct_quote}”</blockquote>
                ) : (
                  <div className="mt-0.5">{m.statement}</div>
                )}
              </div>
            ))
          )}
          {references.length > 0 && (
            <div className="pt-1">
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Referenced literature</div>
              {references.map((r) => (
                <div key={r.id} className="text-xs mt-1">
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {r.title}
                    </a>
                  ) : (
                    r.title
                  )}
                  <span className="text-muted-foreground">
                    {r.journal ? ` · ${r.journal}` : ""}{r.year ? ` (${r.year})` : ""}
                  </span>
                </div>
              ))}
            </div>
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
