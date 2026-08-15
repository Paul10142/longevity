"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

type Flag = {
  id: string
  claim_id: string
  rule: string
  detail: string | null
  evidence: Record<string, unknown> | null
  created_at: string
  claims: { canonical_statement: string } | null
}

/**
 * Plain-English translation of each flag rule for a non-technical reviewer.
 * Keyed by the raw rule name stored in claim_flags.rule (see migrations 013/014
 * and scripts/flagClaims.ts).
 */
const RULE_LABELS: Record<string, string> = {
  extraction_fidelity: "May not match the source",
  merge_fidelity: "Merge may have invented a number",
  orphan_topic: "Not filed under a topic",
  manual: "Flagged by hand",
  standalone: "May not stand on its own",
  contradiction: "May contradict another fact",
}

function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? rule
}

/** Pull the offending span out of the evidence blob, if present. */
function offendingSpan(evidence: Record<string, unknown> | null): string | null {
  if (!evidence) return null
  const o = evidence.offending
  if (typeof o === "string" && o.trim()) return o
  return null
}

function FlagCard({
  flag,
  busy,
  onResolve,
}: {
  flag: Flag
  busy: boolean
  onResolve: (flagId: string, resolution: "approved" | "false_positive") => void
}) {
  const offending = offendingSpan(flag.evidence)
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* The claim itself — the thing being judged — leads. */}
        <p className="text-sm font-medium leading-snug">
          {flag.claims?.canonical_statement ?? "(claim text unavailable)"}
        </p>

        {flag.detail && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
              Why it was flagged
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{flag.detail}</p>
          </div>
        )}

        {offending && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
              Flagged text
            </div>
            <p className="text-xs italic mt-0.5">“{offending}”</p>
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          {/* "approved" = the FLAG is right (the insight really does misstate the
              source). The old label "Keep (looks fine)" read as the opposite and
              nearly steered a correct confirmation into a dismissal. */}
          <Button
            className="flex-1"
            disabled={busy}
            onClick={() => onResolve(flag.id, "approved")}
          >
            Confirm issue (insight misstates source)
          </Button>
          <Button
            className="flex-1"
            variant="outline"
            disabled={busy}
            onClick={() => onResolve(flag.id, "false_positive")}
          >
            Dismiss (flag is wrong — insight is fine)
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export function FlagReviewClient() {
  const [flags, setFlags] = useState<Flag[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/flags", { cache: "no-store" })
      const data = await res.json()
      setFlags(data.flags || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function resolve(flagId: string, resolution: "approved" | "false_positive") {
    setBusy(flagId)
    try {
      const res = await fetch("/api/admin/flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagId, resolution }),
      })
      // Optimistically drop the row on success.
      if (res.ok) setFlags((fs) => fs.filter((f) => f.id !== flagId))
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>

  if (flags.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">
          No flagged facts to review 🎉
        </CardContent>
      </Card>
    )
  }

  // Group by rule, preserving the rule order the API already sorted by.
  const groups: { rule: string; items: Flag[] }[] = []
  for (const f of flags) {
    const last = groups[groups.length - 1]
    if (last && last.rule === f.rule) last.items.push(f)
    else groups.push({ rule: f.rule, items: [f] })
  }

  return (
    <div className="space-y-8">
      {groups.map((g) => (
        <section key={g.rule} className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-semibold tracking-tight">{ruleLabel(g.rule)}</h2>
            <Badge variant="secondary">{g.items.length}</Badge>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {g.rule}
            </span>
          </div>
          <div className="space-y-3">
            {g.items.map((f) => (
              <FlagCard
                key={f.id}
                flag={f}
                busy={busy === f.id}
                onResolve={resolve}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
