import Link from "next/link"
import { supabaseAdmin } from "@/lib/supabaseServer"

export const dynamic = "force-dynamic"

type TopicNode = {
  id: string
  name: string
  slug: string
  description: string | null
  parent_id: string | null
  claim_count: number
}

// Total claims for a topic including its descendants.
function rollup(id: string, childrenOf: Map<string, TopicNode[]>, byId: Map<string, TopicNode>): number {
  let total = byId.get(id)?.claim_count ?? 0
  for (const c of childrenOf.get(id) ?? []) total += rollup(c.id, childrenOf, byId)
  return total
}

export default async function PublicTopicsPage() {
  if (!supabaseAdmin) return <div className="p-12">Not configured.</div>

  const { data } = await supabaseAdmin
    .from("topics")
    .select("id, name, slug, description, parent_id, claim_count")
    .eq("status", "active")
    .order("name")
  const topics = (data ?? []) as TopicNode[]

  const byId = new Map<string, TopicNode>()
  const childrenOf = new Map<string, TopicNode[]>()
  for (const t of topics) byId.set(t.id, t)
  for (const t of topics) {
    const key = t.parent_id && byId.has(t.parent_id) ? t.parent_id : "__root__"
    if (!childrenOf.has(key)) childrenOf.set(key, [])
    childrenOf.get(key)!.push(t)
  }
  const roots = (childrenOf.get("__root__") ?? []).sort(
    (a, b) => rollup(b.id, childrenOf, byId) - rollup(a.id, childrenOf, byId)
  )

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-12">
        <div className="max-w-5xl mx-auto">
          <h1 className="text-4xl font-bold tracking-tight">Medical Library</h1>
          <p className="text-muted-foreground mt-2 mb-10 max-w-2xl">
            Evidence woven together from books, podcasts, and articles — organized by topic, with
            every statement traceable to its source.
          </p>

          <div className="grid gap-6 md:grid-cols-2">
            {roots.map((domain) => {
              const children = (childrenOf.get(domain.id) ?? []).sort((a, b) => b.claim_count - a.claim_count)
              const total = rollup(domain.id, childrenOf, byId)
              return (
                <div key={domain.id} className="rounded-lg border p-5">
                  <Link href={`/topics/${domain.slug}`} className="group flex items-baseline justify-between">
                    <h2 className="text-lg font-semibold group-hover:underline">{domain.name}</h2>
                    <span className="text-xs text-muted-foreground shrink-0 ml-2">{total} claims</span>
                  </Link>
                  {children.length > 0 && (
                    <ul className="mt-3 space-y-1">
                      {children.slice(0, 8).map((c) => (
                        <li key={c.id}>
                          <Link
                            href={`/topics/${c.slug}`}
                            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                          >
                            {c.name}
                            <span className="text-xs ml-1.5 opacity-60">{c.claim_count}</span>
                          </Link>
                        </li>
                      ))}
                      {children.length > 8 && (
                        <li className="text-xs text-muted-foreground">+{children.length - 8} more</li>
                      )}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </main>
    </div>
  )
}
