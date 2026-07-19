"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

type Topic = {
  id: string
  name: string
  slug: string
  description: string | null
  parent_id: string | null
  created_by: "ai" | "human"
  reviewed_by_human: boolean
  claim_count: number
}

export function TopicsAuditClient() {
  const [topics, setTopics] = useState<Topic[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/topics", { cache: "no-store" })
    const data = await res.json()
    setTopics(data.topics || [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const { roots, childrenOf, byId } = useMemo(() => {
    const byId = new Map<string, Topic>()
    const childrenOf = new Map<string, Topic[]>()
    for (const t of topics) byId.set(t.id, t)
    for (const t of topics) {
      const key = t.parent_id && byId.has(t.parent_id) ? t.parent_id : "__root__"
      if (!childrenOf.has(key)) childrenOf.set(key, [])
      childrenOf.get(key)!.push(t)
    }
    const roots = childrenOf.get("__root__") ?? []
    return { roots, childrenOf, byId }
  }, [topics])

  async function act(id: string, body: Record<string, unknown>) {
    setBusy(id)
    try {
      const res = await fetch(`/api/admin/topics/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (res.ok) await load()
      else alert((await res.json()).error || "Action failed")
    } finally {
      setBusy(null)
    }
  }

  function TopicNode({ topic, depth }: { topic: Topic; depth: number }) {
    const children = childrenOf.get(topic.id) ?? []
    return (
      <div>
        <div
          className="flex items-center gap-2 py-1.5 border-b group"
          style={{ paddingLeft: `${depth * 20}px` }}
        >
          <span className="font-medium text-sm">{topic.name}</span>
          <span className="text-xs text-muted-foreground">{topic.claim_count}</span>
          {topic.created_by === "ai" && !topic.reviewed_by_human && (
            <Badge variant="secondary" className="text-[10px] py-0">AI</Badge>
          )}
          <div className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy === topic.id}
              onClick={() => {
                const name = prompt("Rename topic", topic.name)
                if (name && name.trim() && name !== topic.name) act(topic.id, { action: "rename", name })
              }}
            >rename</Button>
            <Button
              size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy === topic.id}
              onClick={() => {
                const options = topics.filter(t => t.id !== topic.id).map(t => t.name)
                const target = prompt(`Merge "${topic.name}" into which topic? Type its exact name.\n\n${options.join("\n")}`)
                const into = topics.find(t => t.name.toLowerCase() === (target ?? "").toLowerCase().trim())
                if (into) act(topic.id, { action: "merge", into_id: into.id })
                else if (target) alert("No topic with that exact name.")
              }}
            >merge</Button>
            <Button
              size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={busy === topic.id}
              onClick={() => {
                const target = prompt(`Re-parent "${topic.name}" under which topic? Blank = top level.`)
                if (target === null) return
                if (target.trim() === "") { act(topic.id, { action: "reparent", parent_id: null }); return }
                const parent = topics.find(t => t.name.toLowerCase() === target.toLowerCase().trim())
                if (parent) act(topic.id, { action: "reparent", parent_id: parent.id })
                else alert("No topic with that exact name.")
              }}
            >move</Button>
            <Button
              size="sm" variant="ghost" className="h-6 px-2 text-xs text-destructive" disabled={busy === topic.id}
              onClick={() => { if (confirm(`Archive "${topic.name}"? Its claims keep their other topics.`)) act(topic.id, { action: "archive" }) }}
            >archive</Button>
          </div>
        </div>
        {children.map(c => <TopicNode key={c.id} topic={c} depth={depth + 1} />)}
      </div>
    )
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (topics.length === 0) {
    return <p className="text-sm text-muted-foreground">No topics yet. Run tagging to generate the taxonomy.</p>
  }

  const aiUnreviewed = topics.filter(t => t.created_by === "ai" && !t.reviewed_by_human).length

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-3">
        {topics.length} topics · {aiUnreviewed} AI-created awaiting review. Hover a row for actions.
      </p>
      <div className="rounded-md border">
        {roots.map(t => <TopicNode key={t.id} topic={t} depth={0} />)}
      </div>
    </div>
  )
}
