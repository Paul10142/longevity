"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

type Branch = { id: string; name: string; parent_id: string | null }

/**
 * Order the curated topics as a tree so the dropdown reads as a hierarchy —
 * a flat alphabetical list makes "Supplements" and "Risks" look like peers.
 */
function nestBranches(branches: Branch[]): { branch: Branch; depth: number }[] {
  const byParent = new Map<string | null, Branch[]>()
  for (const b of branches) {
    const key = b.parent_id
    byParent.set(key, [...(byParent.get(key) ?? []), b])
  }
  const out: { branch: Branch; depth: number }[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const b of byParent.get(parentId) ?? []) {
      out.push({ branch: b, depth })
      walk(b.id, depth + 1)
    }
  }
  walk(null, 0)
  // Any curated topic whose parent isn't itself curated would be skipped by the
  // walk; append it rather than silently dropping it from the picker.
  const seen = new Set(out.map((o) => o.branch.id))
  for (const b of branches) if (!seen.has(b.id)) out.push({ branch: b, depth: 0 })
  return out
}

type Proposal = {
  id: string
  name: string
  proposed_parent_name: string | null
  proposed_parent_id: string | null
  rationale: string | null
  claim_count: number
  created_at: string
  sampleClaims: string[]
}

export function TopicProposalsClient() {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Per-proposal edits: the model's suggestion is a starting point.
  const [edits, setEdits] = useState<Record<string, { name: string; parentId: string }>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/topic-proposals", { cache: "no-store" })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`)
        return
      }
      setProposals(data.proposals || [])
      setBranches(data.branches || [])
      setEdits(
        Object.fromEntries(
          (data.proposals || []).map((p: Proposal) => [
            p.id,
            { name: p.name, parentId: p.proposed_parent_id ?? "" },
          ])
        )
      )
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load proposals")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function decide(id: string, action: "approve" | "reject") {
    setBusy(id)
    setError(null)
    try {
      const edit = edits[id]
      const res = await fetch(`/api/admin/topic-proposals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "approve"
            ? { action, name: edit?.name, parent_id: edit?.parentId || null }
            : { action }
        ),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`)
        return
      }
      setProposals((prev) => prev.filter((p) => p.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed")
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading proposals…</p>
  }

  return (
    <div className="space-y-4">
      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {proposals.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">No topics awaiting approval.</p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Tagging files claims into the existing tree on its own. A proposal appears here only
              when a claim genuinely has nowhere to go.
            </p>
          </CardContent>
        </Card>
      ) : (
        proposals.map((p) => {
          const edit = edits[p.id] ?? { name: p.name, parentId: "" }
          return (
            <Card key={p.id}>
              <CardContent className="py-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{p.name}</span>
                      <Badge variant="secondary" className="text-[10px]">
                        {p.claim_count} claim{p.claim_count === 1 ? "" : "s"}
                      </Badge>
                      {p.proposed_parent_name && (
                        <Badge variant="outline" className="text-[10px]">
                          suggested under {p.proposed_parent_name}
                        </Badge>
                      )}
                    </div>
                    {p.rationale && (
                      <p className="text-sm text-muted-foreground mt-1">{p.rationale}</p>
                    )}
                  </div>
                </div>

                {p.sampleClaims.length > 0 && (
                  <div className="border-l-2 pl-3 space-y-1">
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                      Claims that triggered this
                    </p>
                    {p.sampleClaims.map((s, i) => (
                      <p key={i} className="text-xs text-muted-foreground">
                        {s}
                      </p>
                    ))}
                    {p.claim_count > p.sampleClaims.length && (
                      <p className="text-xs text-muted-foreground/70">
                        …and {p.claim_count - p.sampleClaims.length} more
                      </p>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1 min-w-[200px]">
                    <label className="text-xs text-muted-foreground">Topic name</label>
                    <Input
                      value={edit.name}
                      onChange={(e) =>
                        setEdits((prev) => ({ ...prev, [p.id]: { ...edit, name: e.target.value } }))
                      }
                      className="h-9"
                    />
                  </div>
                  <div className="min-w-[200px]">
                    <label className="text-xs text-muted-foreground">Place under</label>
                    <select
                      value={edit.parentId}
                      onChange={(e) =>
                        setEdits((prev) => ({
                          ...prev,
                          [p.id]: { ...edit, parentId: e.target.value },
                        }))
                      }
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                    >
                      <option value="">Select a branch…</option>
                      {nestBranches(branches).map(({ branch, depth }) => (
                        <option key={branch.id} value={branch.id}>
                          {`${"  ".repeat(depth)}${depth > 0 ? "└ " : ""}${branch.name}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy === p.id || !edit.name.trim() || !edit.parentId}
                      onClick={() => decide(p.id, "approve")}
                    >
                      {busy === p.id ? "Working…" : "Approve"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === p.id}
                      onClick={() => decide(p.id, "reject")}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })
      )}
    </div>
  )
}
