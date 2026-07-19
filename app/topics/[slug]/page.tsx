import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabaseServer"
import { TopicTabs } from "@/components/TopicTabs"

export const dynamic = "force-dynamic"

export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  if (!supabaseAdmin) return <div className="p-12">Not configured.</div>

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

  // Breadcrumb parent + subtopics.
  const [{ data: parent }, { data: children }, { data: clin }, { data: pat }, { data: proto }] =
    await Promise.all([
      topic.parent_id
        ? supabaseAdmin.from("topics").select("name, slug").eq("id", topic.parent_id).single()
        : Promise.resolve({ data: null }),
      supabaseAdmin
        .from("topics")
        .select("name, slug, claim_count")
        .eq("parent_id", topic.id)
        .eq("status", "active")
        .order("claim_count", { ascending: false }),
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

          {children && children.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {children.map((c: { name: string; slug: string; claim_count: number }) => (
                <Link
                  key={c.slug}
                  href={`/topics/${c.slug}`}
                  className="text-xs rounded-full border px-3 py-1 hover:bg-muted"
                >
                  {c.name} <span className="opacity-60">{c.claim_count}</span>
                </Link>
              ))}
            </div>
          )}

          <div className="mt-8">
            <TopicTabs
              topicId={topic.id}
              clinician={clin?.[0] ?? null}
              patient={pat?.[0] ?? null}
              protocol={proto?.[0] ?? null}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
