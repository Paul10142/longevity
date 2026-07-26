"use client"

import { useState } from "react"
import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

export type TreeNode = {
  name: string
  slug: string
  claim_count: number
  children: TreeNode[]
}

function TreeRow({ node, isAdmin, depth }: { node: TreeNode; isAdmin: boolean; depth: number }) {
  const hasChildren = node.children.length > 0
  // Expand the first level by default so a topic's main ideas are visible at a glance.
  const [open, setOpen] = useState(depth === 0)

  return (
    <li>
      <div className="flex items-center gap-1 py-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted text-muted-foreground"
          >
            <ChevronRight className={cn("h-4 w-4 transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" aria-hidden />
        )}

        <Link
          href={`/topics/${node.slug}`}
          className="text-sm text-foreground/90 hover:text-primary hover:underline"
        >
          {node.name}
        </Link>

        {isAdmin && (
          <span className="text-xs text-muted-foreground tabular-nums ml-1.5">
            {node.claim_count}
          </span>
        )}
      </div>

      {hasChildren && open && (
        <ul className="ml-5 border-l border-border/50 pl-2">
          {node.children.map((c) => (
            <TreeRow key={c.slug} node={c} isAdmin={isAdmin} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** Expandable tree of a topic's subtopics ("ideas"). Claim counts are admin-only. */
export function TopicTree({ nodes, isAdmin }: { nodes: TreeNode[]; isAdmin: boolean }) {
  if (nodes.length === 0) return null
  return (
    <ul className="mt-4">
      {nodes.map((n) => (
        <TreeRow key={n.slug} node={n} isAdmin={isAdmin} depth={0} />
      ))}
    </ul>
  )
}
