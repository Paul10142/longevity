"use client"

import { Suspense, useCallback, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { SearchBar } from "@/components/SearchBar"
import { Badge } from "@/components/ui/badge"

type Result = {
  id: string
  statement: string
  similarity: number
  topic: { name: string; slug: string } | null
}

function SearchResults() {
  const params = useSearchParams()
  const q = params.get("q") ?? ""
  const [results, setResults] = useState<Result[]>([])
  const [loading, setLoading] = useState(false)
  const [ran, setRan] = useState(false)

  const run = useCallback(async (query: string) => {
    if (!query.trim()) return
    setLoading(true)
    setRan(true)
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      })
      const data = await res.json()
      setResults(data.results || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (q) run(q)
  }, [q, run])

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold tracking-tight mb-4">Search</h1>
      <SearchBar className="mb-8 max-w-xl" placeholder="Search across every claim…" />

      {q && <p className="text-sm text-muted-foreground mb-4">Results for “{q}”</p>}
      {loading && <p className="text-sm text-muted-foreground">Searching…</p>}
      {!loading && ran && results.length === 0 && (
        <p className="text-sm text-muted-foreground">No matching claims.</p>
      )}

      <div className="space-y-3">
        {results.map((r) => (
          <div key={r.id} className="border-b pb-3">
            <p className="text-sm">{r.statement}</p>
            <div className="mt-1.5 flex items-center gap-2">
              {r.topic ? (
                <Link href={`/topics/${r.topic.slug}`}>
                  <Badge variant="secondary" className="text-xs hover:bg-muted">{r.topic.name}</Badge>
                </Link>
              ) : (
                <span className="text-xs text-muted-foreground">untagged</span>
              )}
              <span className="text-xs text-muted-foreground">{(r.similarity * 100).toFixed(0)}% match</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function SearchPage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-12">
        <Suspense fallback={<p className="text-center text-muted-foreground">Loading…</p>}>
          <SearchResults />
        </Suspense>
      </main>
    </div>
  )
}
