"use client"

import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"

export type SourceInsightRow = {
  id: string
  locator: string
  start_ms: number | null
  statement: string
  context_note: string | null
  direct_quote: string | null
  evidence_type: string
  confidence: string
  importance: number | null
  actionability: string | null
  insight_type: string | null
  claim: {
    id: string
    canonical_statement: string
    source_count: number
  } | null
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

function timestampHref(sourceUrl: string | null, ms: number | null): string | null {
  if (!sourceUrl || ms == null) return null
  if (!/youtube\.com|youtu\.be/.test(sourceUrl)) return null
  const sep = sourceUrl.includes("?") ? "&" : "?"
  return `${sourceUrl}${sep}t=${Math.floor(ms / 1000)}`
}

const IMPORTANCE_LABEL: Record<number, string> = { 1: "Core", 2: "Useful", 3: "Peripheral" }

export function SourceRawInsightsClient({
  insights,
  sourceUrl,
}: {
  insights: SourceInsightRow[]
  sourceUrl: string | null
}) {
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState("all")
  const [evidenceFilter, setEvidenceFilter] = useState("all")

  const insightTypes = useMemo(
    () => Array.from(new Set(insights.map((i) => i.insight_type).filter(Boolean))).sort() as string[],
    [insights]
  )
  const evidenceTypes = useMemo(
    () => Array.from(new Set(insights.map((i) => i.evidence_type).filter(Boolean))).sort(),
    [insights]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return insights.filter((i) => {
      if (typeFilter !== "all" && i.insight_type !== typeFilter) return false
      if (evidenceFilter !== "all" && i.evidence_type !== evidenceFilter) return false
      if (q) {
        const haystack = `${i.statement} ${i.context_note ?? ""} ${i.direct_quote ?? ""}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [insights, search, typeFilter, evidenceFilter])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">
          Raw insights
          <span className="text-muted-foreground text-sm font-normal">
            {" "}· {filtered.length === insights.length
              ? insights.length
              : `${filtered.length} of ${insights.length}`}
          </span>
        </CardTitle>
        <div className="flex flex-wrap gap-2 pt-2">
          <Input
            placeholder="Search statements, notes, quotes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs h-9"
          />
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[150px] h-9">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {insightTypes.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={evidenceFilter} onValueChange={setEvidenceFilter}>
            <SelectTrigger className="w-[160px] h-9">
              <SelectValue placeholder="Evidence" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All evidence</SelectItem>
              {evidenceTypes.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {insights.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No insights extracted yet. Run an extraction from the processing panel above.
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No insights match the current filters.
          </p>
        ) : (
          <div className="space-y-1">
            {filtered.map((insight, index) => {
              const ts = formatMs(insight.start_ms)
              const href = timestampHref(sourceUrl, insight.start_ms)
              return (
                <div key={insight.id} className="border-b last:border-0 py-3">
                  <div className="flex items-start gap-3">
                    <span className="text-xs text-muted-foreground mt-0.5 w-8 shrink-0 text-right">
                      #{index + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">{insight.statement}</p>
                      {insight.context_note && (
                        <p className="text-xs text-muted-foreground mt-1">{insight.context_note}</p>
                      )}
                      {insight.direct_quote && (
                        <blockquote className="mt-1.5 border-l-2 border-muted-foreground/30 pl-2 text-xs italic text-muted-foreground">
                          “{insight.direct_quote}”
                        </blockquote>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        {insight.insight_type && (
                          <Badge variant="secondary" className="text-[10px] py-0">{insight.insight_type}</Badge>
                        )}
                        <Badge variant="outline" className="text-[10px] py-0">{insight.evidence_type}</Badge>
                        {insight.importance != null && IMPORTANCE_LABEL[insight.importance] && (
                          <Badge variant="outline" className="text-[10px] py-0">
                            {IMPORTANCE_LABEL[insight.importance]}
                          </Badge>
                        )}
                        {insight.claim && insight.claim.source_count > 1 && (
                          <Badge variant="default" className="text-[10px] py-0">
                            Claim in {insight.claim.source_count} sources
                          </Badge>
                        )}
                        <span className="text-[11px] text-muted-foreground ml-auto">
                          {href ? (
                            <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
                              {ts}
                            </a>
                          ) : (
                            ts ?? insight.locator
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
