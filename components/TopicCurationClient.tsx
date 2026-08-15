"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

type ApiTopic = {
  id: string
  name: string
  slug: string
  description: string | null
  parent_id: string | null
  created_by: "ai" | "human"
  reviewed_by_human: boolean
  claim_count: number
  created_at: string
  is_spine: boolean
}

// A staged operation. `label` is display-only; the server ignores it.
type PlanOp =
  | { type: "rename"; id: string; name: string; label: string }
  | { type: "reparent"; id: string; parent_id: string | null; label: string }
  | { type: "merge"; id: string; into_id: string; label: string }
  | { type: "archive"; id: string; label: string }
  | { type: "review"; id: string; label: string }

type Node = {
  id: string
  name: string
  parent_id: string | null
  claim_count: number
  is_spine: boolean
  created_by: "ai" | "human"
  reviewed_by_human: boolean
  removed: boolean
}

const MAX_DEPTH = 3 // Paul's rule: max 3 levels deep.

export function TopicCurationClient() {
  const [base, setBase] = useState<ApiTopic[]>([])
  const [loading, setLoading] = useState(true)
  const [plan, setPlan] = useState<PlanOp[]>([])
  const [applying, setApplying] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; mode: "merge" | "nest" } | null>(null)
  // A modifier-free drop opens a chooser instead of committing immediately —
  // Shift-during-drag is unreliable on macOS and invisible to discover.
  const [pendingDrop, setPendingDrop] = useState<{ sourceId: string; targetId: string } | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/topics", { cache: "no-store" })
    const data = await res.json()
    setBase((data.topics || []) as ApiTopic[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // ---- Replay the plan onto a working copy so Paul sees the result as he stages. ----
  const { nodes, childrenOf, roots, byId, depthOf } = useMemo(() => {
    const map = new Map<string, Node>()
    for (const t of base) {
      map.set(t.id, {
        id: t.id,
        name: t.name,
        parent_id: t.parent_id,
        claim_count: t.claim_count,
        is_spine: t.is_spine,
        created_by: t.created_by,
        reviewed_by_human: t.reviewed_by_human,
        removed: false,
      })
    }
    const alive = (id: string) => map.get(id) && !map.get(id)!.removed
    for (const op of plan) {
      const n = map.get(op.id)
      if (!n || n.removed) continue
      if (op.type === "rename") {
        n.name = op.name
      } else if (op.type === "reparent") {
        n.parent_id = op.parent_id
      } else if (op.type === "archive") {
        // lift children to this node's parent, then remove it
        for (const c of map.values()) if (c.parent_id === op.id && !c.removed) c.parent_id = n.parent_id
        n.removed = true
      } else if (op.type === "merge") {
        const dst = map.get(op.into_id)
        if (!dst || dst.removed) continue
        for (const c of map.values()) if (c.parent_id === op.id && !c.removed) c.parent_id = dst.id
        dst.claim_count += n.claim_count
        n.removed = true
      } else if (op.type === "review") {
        n.reviewed_by_human = true
      }
    }
    void alive
    const nodes = [...map.values()].filter((n) => !n.removed)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const childrenOf = new Map<string, Node[]>()
    for (const n of nodes) {
      const key = n.parent_id && byId.has(n.parent_id) ? n.parent_id : "__root__"
      if (!childrenOf.has(key)) childrenOf.set(key, [])
      childrenOf.get(key)!.push(n)
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    const roots = (childrenOf.get("__root__") ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
    // precompute depth (root = 1)
    const depthOf = new Map<string, number>()
    const walk = (n: Node, d: number, seen: Set<string>) => {
      if (seen.has(n.id)) return
      seen.add(n.id)
      depthOf.set(n.id, d)
      for (const c of childrenOf.get(n.id) ?? []) walk(c, d + 1, seen)
    }
    for (const r of roots) walk(r, 1, new Set())
    return { nodes, childrenOf, roots, byId, depthOf }
  }, [base, plan])

  // Is `maybeAncestor` an ancestor of (or equal to) `id` in the working tree?
  const isAncestor = useCallback(
    (maybeAncestor: string, id: string): boolean => {
      let cursor: string | null = id
      const seen = new Set<string>()
      while (cursor) {
        if (cursor === maybeAncestor) return true
        if (seen.has(cursor)) return true
        seen.add(cursor)
        cursor = byId.get(cursor)?.parent_id ?? null
      }
      return false
    },
    [byId]
  )

  // ---- Staging ----
  function stageMerge(srcId: string, dstId: string) {
    if (srcId === dstId) return
    const src = byId.get(srcId)
    const dst = byId.get(dstId)
    if (!src || !dst) return
    if (isAncestor(srcId, dstId)) {
      setResult(`Can't merge "${src.name}" into its own descendant.`)
      return
    }
    setPlan((p) => [...p, { type: "merge", id: srcId, into_id: dstId, label: `Merge "${src.name}" → "${dst.name}"` }])
  }

  function stageReparent(srcId: string, parentId: string | null) {
    const src = byId.get(srcId)
    if (!src) return
    if (parentId === srcId) return
    if (src.parent_id === parentId) return // no-op
    if (parentId && isAncestor(srcId, parentId)) {
      setResult(`Can't move "${src.name}" under its own descendant.`)
      return
    }
    const to = parentId ? byId.get(parentId)?.name ?? "?" : "top level"
    setPlan((p) => [
      ...p,
      { type: "reparent", id: srcId, parent_id: parentId, label: `Move "${src.name}" → ${parentId ? `under "${to}"` : "top level"}` },
    ])
  }

  function stageRename(id: string, name: string) {
    const n = byId.get(id)
    if (!n) return
    const trimmed = name.trim()
    if (!trimmed || trimmed === n.name) return
    setPlan((p) => [...p, { type: "rename", id, name: trimmed, label: `Rename "${n.name}" → "${trimmed}"` }])
  }

  /** Toggle a staged sign-off: check stages "reviewed as-is", uncheck removes it. */
  function toggleReview(id: string) {
    const n = byId.get(id)
    if (!n) return
    setPlan((p) => {
      const existing = p.findIndex((op) => op.type === "review" && op.id === id)
      if (existing >= 0) return p.filter((_, i) => i !== existing)
      const name = base.find((b) => b.id === id)?.name ?? n.name
      return [...p, { type: "review", id, label: `Mark "${name}" reviewed` }]
    })
  }

  function stageArchive(id: string) {
    const n = byId.get(id)
    if (!n) return
    setPlan((p) => [...p, { type: "archive", id, label: `Archive "${n.name}"` }])
  }

  function removeOp(index: number) {
    setPlan((p) => p.filter((_, i) => i !== index))
  }

  async function apply() {
    if (plan.length === 0) return
    if (!confirm(`Apply ${plan.length} change${plan.length === 1 ? "" : "s"} to the live taxonomy?`)) return
    setApplying(true)
    setResult(null)
    try {
      const res = await fetch("/api/admin/topics/curate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operations: plan.map(({ label, ...op }) => { void label; return op }) }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResult(data.error || "Apply failed")
      } else {
        setResult(
          data.failed?.length
            ? `Applied ${data.applied}, ${data.failed.length} failed: ${data.failed.map((f: { error: string }) => f.error).join("; ")}`
            : `Applied all ${data.applied} changes.`
        )
        setPlan([])
        await load()
      }
    } finally {
      setApplying(false)
    }
  }

  // ---- Drag helpers ----
  function onRowDragOver(e: React.DragEvent, id: string) {
    if (!draggedId || draggedId === id) return
    e.preventDefault()
    const mode = e.shiftKey ? "nest" : "merge"
    if (dropHint?.id !== id || dropHint?.mode !== mode) setDropHint({ id, mode })
  }
  function onRowDrop(e: React.DragEvent, id: string) {
    e.preventDefault()
    if (!draggedId || draggedId === id) return
    if (e.shiftKey) {
      // Shift still works as a power-user fast path when the browser delivers it.
      stageReparent(draggedId, id)
    } else {
      // Ask instead of assuming: merge and nest are both common intents.
      setPendingDrop({ sourceId: draggedId, targetId: id })
    }
    setDropHint(null)
    setDraggedId(null)
  }

  function resolvePendingDrop(mode: "merge" | "nest" | "cancel") {
    if (!pendingDrop) return
    if (mode === "merge") stageMerge(pendingDrop.sourceId, pendingDrop.targetId)
    else if (mode === "nest") stageReparent(pendingDrop.sourceId, pendingDrop.targetId)
    setPendingDrop(null)
  }
  const pendingSourceName = pendingDrop ? byId.get(pendingDrop.sourceId)?.name ?? null : null
  const isReviewStaged = useCallback(
    (id: string) => plan.some((op) => op.type === "review" && op.id === id),
    [plan]
  )

  const stats = useMemo(() => {
    const overDepth = [...depthOf.entries()].filter(([, d]) => d > MAX_DEPTH).length
    const aiUnreviewed = nodes.filter((n) => n.created_by === "ai" && !n.reviewed_by_human).length
    const maxDepth = Math.max(0, ...depthOf.values())
    return { topics: nodes.length, roots: roots.length, overDepth, aiUnreviewed, maxDepth }
  }, [nodes, roots, depthOf])

  if (loading) return <p className="text-sm text-muted-foreground">Loading taxonomy…</p>

  // Split roots into two balanced columns.
  const mid = Math.ceil(roots.length / 2)
  const columns = [roots.slice(0, mid), roots.slice(mid)]

  return (
    <div className="flex gap-6">
      {/* Board */}
      <div className="flex-1 min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span><b className="text-foreground">{stats.topics}</b> topics</span>
          <span><b className="text-foreground">{stats.roots}</b> pillars</span>
          <span>max depth <b className={stats.maxDepth > MAX_DEPTH ? "text-destructive" : "text-foreground"}>{stats.maxDepth}</b></span>
          {stats.overDepth > 0 && <span className="text-destructive">{stats.overDepth} over max-3</span>}
          <span><b className="text-foreground">{stats.aiUnreviewed}</b> AI-unreviewed</span>
          <span className="ml-auto italic">Drop = merge · hold Shift = nest under · drop on a pillar header = move into pillar</span>
        </div>

        {/* Promote-to-top-level dropzone */}
        <div
          onDragOver={(e) => { if (draggedId) { e.preventDefault(); setDropHint({ id: "__top__", mode: "nest" }) } }}
          onDrop={(e) => { e.preventDefault(); if (draggedId) { stageReparent(draggedId, null); setDropHint(null); setDraggedId(null) } }}
          className={`mb-3 rounded-md border border-dashed px-3 py-1.5 text-xs transition-colors ${
            dropHint?.id === "__top__" ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground"
          }`}
        >
          ⤴ Drop here to promote to a top-level pillar
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {columns.map((col, ci) => (
            <div key={ci} className="space-y-4">
              {col.map((root) => (
                <div key={root.id} className="rounded-lg border bg-card">
                  <div
                    onDragOver={(e) => { if (draggedId && draggedId !== root.id) { e.preventDefault(); setDropHint({ id: root.id, mode: "nest" }) } }}
                    onDrop={(e) => { e.preventDefault(); if (draggedId && draggedId !== root.id) { stageReparent(draggedId, root.id); setDropHint(null); setDraggedId(null) } }}
                    className={`flex items-center gap-2 border-b px-3 py-2 rounded-t-lg transition-colors ${
                      dropHint?.id === root.id && dropHint.mode === "nest" ? "bg-primary/15" : "bg-muted/40"
                    }`}
                  >
                    <RowName node={root} editing={editingId === root.id} onEdit={() => setEditingId(root.id)}
                      onCommit={(v) => { stageRename(root.id, v); setEditingId(null) }} onCancel={() => setEditingId(null)} bold />
                    {root.is_spine && <Badge variant="outline" className="text-[10px] py-0">pillar</Badge>}
                    <span className="text-xs text-muted-foreground">{root.claim_count}</span>
                    <button className="ml-auto text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => stageArchive(root.id)} title="Archive">✕</button>
                  </div>
                  <div className="p-1.5">
                    {(childrenOf.get(root.id) ?? []).map((c) => (
                      <TopicRow key={c.id} node={c} depth={2} childrenOf={childrenOf} depthOf={depthOf}
                        draggedId={draggedId} dropHint={dropHint} editingId={editingId}
                        setDraggedId={setDraggedId} setDropHint={setDropHint} setEditingId={setEditingId}
                        onRowDragOver={onRowDragOver} onRowDrop={onRowDrop}
                        stageRename={stageRename} stageArchive={stageArchive}
                        pendingDrop={pendingDrop} resolvePendingDrop={resolvePendingDrop}
                        pendingSourceName={pendingSourceName} toggleReview={toggleReview} isReviewStaged={isReviewStaged} />
                    ))}
                    {(childrenOf.get(root.id) ?? []).length === 0 && (
                      <p className="px-2 py-1 text-xs text-muted-foreground italic">no subtopics</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Change-plan sidebar */}
      <div className="w-72 shrink-0">
        <div className="sticky top-4 rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">Change plan</span>
            <Badge variant={plan.length ? "default" : "secondary"}>{plan.length}</Badge>
          </div>
          <div className="max-h-[50vh] overflow-y-auto p-2 space-y-1">
            {plan.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">Drag topics to stage merges, moves, renames. Nothing is written until you Apply.</p>}
            {plan.map((op, i) => (
              <div key={i} className="flex items-start gap-1.5 rounded border px-2 py-1 text-xs">
                <span className="flex-1">{op.label}</span>
                <button className="text-muted-foreground hover:text-destructive" onClick={() => removeOp(i)} title="Remove">✕</button>
              </div>
            ))}
          </div>
          <div className="border-t p-2 space-y-2">
            <Button className="w-full" size="sm" disabled={plan.length === 0 || applying} onClick={apply}>
              {applying ? "Applying…" : `Apply ${plan.length || ""}`.trim()}
            </Button>
            <Button className="w-full" size="sm" variant="ghost" disabled={plan.length === 0 || applying} onClick={() => setPlan([])}>
              Discard
            </Button>
            {result && <p className="text-xs text-muted-foreground">{result}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

function RowName({
  node, editing, onEdit, onCommit, onCancel, bold,
}: {
  node: Node; editing: boolean; onEdit: () => void; onCommit: (v: string) => void; onCancel: () => void; bold?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select() } }, [editing])
  if (editing) {
    return (
      <input
        ref={ref}
        defaultValue={node.name}
        className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-sm"
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit((e.target as HTMLInputElement).value)
          if (e.key === "Escape") onCancel()
        }}
        onBlur={(e) => onCommit(e.target.value)}
      />
    )
  }
  return (
    <span
      className={`cursor-text truncate ${bold ? "font-semibold text-sm" : "text-sm"}`}
      onClick={onEdit}
      title="Click to rename"
    >
      {node.name}
    </span>
  )
}

function TopicRow({
  node, depth, childrenOf, depthOf, draggedId, dropHint, editingId,
  setDraggedId, setDropHint, setEditingId, onRowDragOver, onRowDrop, stageRename, stageArchive,
  pendingDrop, resolvePendingDrop, pendingSourceName, toggleReview, isReviewStaged,
}: {
  node: Node; depth: number
  childrenOf: Map<string, Node[]>; depthOf: Map<string, number>
  draggedId: string | null; dropHint: { id: string; mode: "merge" | "nest" } | null; editingId: string | null
  setDraggedId: (v: string | null) => void
  setDropHint: (v: { id: string; mode: "merge" | "nest" } | null) => void
  setEditingId: (v: string | null) => void
  onRowDragOver: (e: React.DragEvent, id: string) => void
  onRowDrop: (e: React.DragEvent, id: string) => void
  stageRename: (id: string, name: string) => void
  stageArchive: (id: string) => void
  pendingDrop: { sourceId: string; targetId: string } | null
  resolvePendingDrop: (mode: "merge" | "nest" | "cancel") => void
  pendingSourceName: string | null
  toggleReview: (id: string) => void
  isReviewStaged: (id: string) => boolean
}) {
  const children = childrenOf.get(node.id) ?? []
  const d = depthOf.get(node.id) ?? depth
  const overDepth = d > MAX_DEPTH
  const isDropTarget = dropHint?.id === node.id
  const editing = editingId === node.id
  return (
    <div>
      <div
        draggable={!editing}
        onDragStart={(e) => { setDraggedId(node.id); e.dataTransfer.effectAllowed = "move" }}
        onDragEnd={() => { setDraggedId(null); setDropHint(null) }}
        onDragOver={(e) => onRowDragOver(e, node.id)}
        onDragLeave={() => { if (dropHint?.id === node.id) setDropHint(null) }}
        onDrop={(e) => onRowDrop(e, node.id)}
        className={`group flex items-center gap-2 rounded px-2 py-1 ${editing ? "" : "cursor-grab"} ${
          isDropTarget
            ? dropHint.mode === "merge"
              ? "ring-2 ring-primary bg-primary/10"
              : "ring-2 ring-amber-400 bg-amber-400/10"
            : "hover:bg-muted/50"
        } ${draggedId === node.id ? "opacity-40" : ""}`}
        style={{ marginLeft: `${(depth - 2) * 16}px` }}
      >
        <span className="text-muted-foreground/50 text-xs select-none">⠿</span>
        <RowName node={node} editing={editing} onEdit={() => setEditingId(node.id)}
          onCommit={(v) => { stageRename(node.id, v); setEditingId(null) }} onCancel={() => setEditingId(null)} />
        <span className="text-xs text-muted-foreground">{node.claim_count}</span>
        {node.created_by === "ai" && !node.reviewed_by_human && (
          <>
            <Badge variant="secondary" className="text-[10px] py-0 px-1">AI</Badge>
            <button
              className="text-xs text-muted-foreground hover:text-foreground"
              title="Sign off this topic as-is (stages into the plan)"
              onClick={(e) => { e.stopPropagation(); toggleReview(node.id) }}
            >☐ approve</button>
          </>
        )}
        {isReviewStaged(node.id) && (
          <button
            className="text-xs"
            title="Sign-off staged — click to undo"
            onClick={(e) => { e.stopPropagation(); toggleReview(node.id) }}
          >✅</button>
        )}
        {overDepth && <Badge variant="destructive" className="text-[10px] py-0 px-1">L{d}</Badge>}
        {isDropTarget && (
          <span className="ml-1 text-[10px] text-muted-foreground">{dropHint.mode === "merge" ? "merge in" : "nest under"}</span>
        )}
        <button className="ml-auto text-xs text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
          onClick={() => stageArchive(node.id)} title="Archive">✕</button>
      </div>
      {pendingDrop?.targetId === node.id && (
        <div
          className="my-1 flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 shadow-sm"
          style={{ marginLeft: `${(depth - 2) * 16 + 16}px` }}
        >
          <span className="text-xs text-muted-foreground">
            “{pendingSourceName}” → “{node.name}”:
          </span>
          <Button size="sm" className="h-7 text-xs" onClick={() => resolvePendingDrop("merge")}>
            Merge into it
          </Button>
          <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={() => resolvePendingDrop("nest")}>
            Nest under it
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => resolvePendingDrop("cancel")}>
            Cancel
          </Button>
        </div>
      )}
      {children.map((c) => (
        <TopicRow key={c.id} node={c} depth={depth + 1} childrenOf={childrenOf} depthOf={depthOf}
          draggedId={draggedId} dropHint={dropHint} editingId={editingId}
          setDraggedId={setDraggedId} setDropHint={setDropHint} setEditingId={setEditingId}
          onRowDragOver={onRowDragOver} onRowDrop={onRowDrop}
          stageRename={stageRename} stageArchive={stageArchive}
          pendingDrop={pendingDrop} resolvePendingDrop={resolvePendingDrop}
          pendingSourceName={pendingSourceName} toggleReview={toggleReview} isReviewStaged={isReviewStaged} />
      ))}
    </div>
  )
}
