import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { TopicTabs } from "@/components/TopicTabs"
import { TopicTree, type TreeNode } from "@/components/TopicTree"
import { isAdmin } from "@/lib/isAdmin"
import { subtreeClaimCounts, isVisibleCount } from "@/lib/topicVisibility"

export const dynamic = "force-dynamic"

type Row = {
  id: string
  name: string
  slug: string
  parent_id: string | null
  claim_count: number
  // Not selected until migration 018 is applied; optional so the future curator
  // override is type-wired without the read depending on the column.
  is_hidden?: boolean | null
}

// Build the nested subtree rooted at `parentId` from a flat childrenOf map.
function buildTree(parentId: string, childrenOf: Map<string, Row[]>): TreeNode[] {
  return (childrenOf.get(parentId) ?? [])
    .slice()
    .sort((a, b) => b.claim_count - a.claim_count || a.name.localeCompare(b.name))
    .map((r) => ({
      name: r.name,
      slug: r.slug,
      claim_count: r.claim_count,
      children: buildTree(r.id, childrenOf),
    }))
}

export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  if (!supabaseAdmin) return <div className="p-12">Not configured.</div>

  const admin = await isAdmin()

  const { data: topic } = await supabaseAdmin
    .from("topics")
    .select("id, name, slug, description, parent_id, status, merged_into_id")
    .eq("slug", slug)
    .single()

  if (!topic) notFound()

  // Follow merge redirect so old slugs keep working.
  if (topic.status === "archived" && topic.merged_into_id) {
    const { data: survivor } = await supabaseAdmin
      .from("topics")
      .select("slug")
      .eq("id", topic.merged_into_id)
      .single()
    if (survivor?.slug) redirect(`/topics/${survivor.slug}`)
  }
  if (topic.status === "archived") notFound()

  // All active topics (for the breadcrumb parent + the expandable subtree), plus
  // the generated article/protocol rows.
  const [{ data: allTopics }, { data: clin }, { data: pat }, { data: proto }] = await Promise.all([
    supabaseAdmin
      .from("topics")
      .select("id, name, slug, parent_id, claim_count")
      .eq("status", "active"),
    supabaseAdmin
      .from("topic_articles")
      .select("title, body_markdown, version")
      .eq("topic_id", topic.id)
      .eq("audience", "clinician")
      .order("version", { ascending: false })
      .limit(1),
    supabaseAdmin
      .from("topic_articles")
      .select("title, body_markdown, version")
      .eq("topic_id", topic.id)
      .eq("audience", "patient")
      .order("version", { ascending: false })
      .limit(1),
    supabaseAdmin
      .from("topic_protocols")
      .select("title, body_markdown, version")
      .eq("topic_id", topic.id)
      .order("version", { ascending: false })
      .limit(1),
  ])

  const rows = (allTopics ?? []) as Row[]
  const byId = new Map<string, Row>(rows.map((r) => [r.id, r]))

  // Visibility gate. A thin topic still exists but is not published to public
  // readers: reaching it directly shows a "still gathering research" stub rather
  // than a one-line article. Admins bypass the gate and see everything.
  const counts = subtreeClaimCounts(rows)
  const showTopic = (r: Row) => admin || isVisibleCount(counts.get(r.id) ?? 0, r.is_hidden)
  const topicVisible = admin || isVisibleCount(counts.get(topic.id) ?? 0)

  const childrenOf = new Map<string, Row[]>()
  for (const r of rows) {
    if (!r.parent_id) continue
    if (!showTopic(r)) continue // hide thin descendants from the public subtree explorer
    if (!childrenOf.has(r.parent_id)) childrenOf.set(r.parent_id, [])
    childrenOf.get(r.parent_id)!.push(r)
  }

  const parent = topic.parent_id ? byId.get(topic.parent_id) : null
  const subtree = buildTree(topic.id, childrenOf)

  // Hidden topic reached directly by a public reader: keep it existing, but show
  // an unpublished stub instead of a thin article. (Visibility is monotonic up
  // the tree, so a visible parent breadcrumb is always safe to link.)
  if (!topicVisible) {
    return (
      <div className="min-h-screen bg-background">
        <main className="container mx-auto px-4 py-10">
          <div className="max-w-4xl mx-auto">
            <nav className="text-sm text-muted-foreground mb-4 flex items-center gap-1.5">
              <Link href="/topics" className="hover:underline">Library</Link>
            </nav>
            <h1 className="text-3xl font-bold tracking-tight">{topic.name}</h1>
            <div className="mt-6 rounded-md border border-border/60 bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
              This topic isn&apos;t published yet — we&apos;re still gathering research on it.
              Check back soon.
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-10">
        <div className="max-w-4xl mx-auto">
          <nav className="text-sm text-muted-foreground mb-4 flex items-center gap-1.5">
            <Link href="/topics" className="hover:underline">Library</Link>
            {parent && (
              <>
                <span>/</span>
                <Link href={`/topics/${parent.slug}`} className="hover:underline">{parent.name}</Link>
              </>
            )}
          </nav>

          <h1 className="text-3xl font-bold tracking-tight">{topic.name}</h1>
          {topic.description && <p className="text-muted-foreground mt-2">{topic.description}</p>}

          {subtree.length > 0 && (
            <div className="mt-4 rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Explore this topic
              </h2>
              <TopicTree nodes={subtree} isAdmin={admin} />
            </div>
          )}

          {!clin?.[0] && !pat?.[0] && !proto?.[0] && (
            <div className="mt-6 rounded-md border border-border/60 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              No written article for this topic yet{admin ? " — showing the underlying evidence below as it accumulates." : "."}
            </div>
          )}

          <div className="mt-8">
            <TopicTabs
              topicId={topic.id}
              clinician={clin?.[0] ?? null}
              patient={pat?.[0] ?? null}
              protocol={proto?.[0] ?? null}
              isAdmin={admin}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
