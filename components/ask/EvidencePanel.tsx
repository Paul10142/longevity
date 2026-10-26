"use client"

import { useState } from "react"
import { ExternalLink, Play } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatTimestamp, timestampLink } from "@/lib/transcriptView"
import { isPublicUrl } from "@/lib/sourceLinks"
import { formatDate, memberDate, prettyLabel, sortMembers } from "@/components/ask/askLib"
import type { ClaimMember, Cited, MembersState } from "@/components/ask/types"

const SHOWN_AT_FIRST = 3

/**
 * One supporting quote: the verbatim words, who said them, the episode and
 * its date, and a link to that minute of the public video.
 *
 * Links come from the members payload, which carries public links only, and
 * are checked again here: a private feed URL is never rendered, whatever
 * ends up in the data. `timestampLink` returns null for one as well.
 */
function MemberCard({ m }: { m: ClaimMember }) {
  const src = m.source
  const date = formatDate(memberDate(m))
  const stamp = m.start_ms != null ? formatTimestamp(m.start_ms) : null
  const videoHref = timestampLink(src?.video_url, m.start_ms)
  const links = (src?.links ?? []).filter((l) => isPublicUrl(l.href) && !(videoHref && l.kind === "video"))

  return (
    <div role="listitem" className="space-y-2 rounded-lg border bg-card p-3">
      {m.direct_quote ? (
        <blockquote className="border-l-2 border-primary/40 pl-3 text-sm leading-relaxed">
          “{m.direct_quote}”
        </blockquote>
      ) : (
        <p className="text-sm leading-relaxed text-muted-foreground">
          No verbatim quote is stored for this one.
          {m.statement ? <> Summary: {m.statement}</> : null}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        {m.speaker ? (
          <>
            Attributed to <span className="font-medium text-foreground">{m.speaker}</span>
          </>
        ) : (
          "Speaker not recorded"
        )}
      </p>

      {src && (
        <p className="text-xs">
          <span className="font-medium text-foreground">{src.title}</span>
          {date && <span className="text-muted-foreground"> · {date}</span>}
        </p>
      )}

      {(videoHref || links.length > 0 || stamp) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {videoHref ? (
            <a
              href={videoHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              <Play className="h-3 w-3" aria-hidden />
              Watch at {stamp}
            </a>
          ) : (
            stamp && <span className="text-muted-foreground">At {stamp} (no public video)</span>
          )}
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" aria-hidden />
              {l.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

/** What the right-hand panel (or the mobile bottom sheet) shows for one citation. */
export function EvidenceContent({
  selection,
  state,
  onRetry,
}: {
  selection: Cited
  state: MembersState | undefined
  onRetry: () => void
}) {
  const [showAll, setShowAll] = useState(false)

  if (!state || state.status === "loading") {
    return (
      <div className="space-y-3" aria-busy="true">
        {selection.statement && <p className="text-sm font-medium leading-snug">{selection.statement}</p>}
        <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-16 animate-pulse rounded bg-muted" />
        <p className="text-xs text-muted-foreground">Loading the evidence…</p>
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="space-y-3">
        {selection.statement && <p className="text-sm font-medium leading-snug">{selection.statement}</p>}
        <p className="text-sm text-destructive">Could not load the evidence ({state.message}).</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try Again
        </Button>
      </div>
    )
  }

  const members = sortMembers(state.members)
  const statement = selection.statement ?? state.statement ?? members[0]?.statement ?? null
  const types = [...new Set(members.map((m) => m.evidence_type).filter((t): t is string => Boolean(t)))].slice(0, 3)
  const visible = showAll ? members : members.slice(0, SHOWN_AT_FIRST)

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {statement && <p className="text-sm font-medium leading-snug">{statement}</p>}
        {types.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {types.map((t) => (
              <Badge key={t} variant="secondary" className="text-xs">
                {prettyLabel(t)}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Supporting Quotes ({members.length})
        </h3>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No supporting quotes are stored for this claim.</p>
        ) : (
          <div role="list" className="space-y-3">
            {visible.map((m) => (
              <MemberCard key={m.raw_insight_id} m={m} />
            ))}
          </div>
        )}
        {members.length > SHOWN_AT_FIRST && (
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Show Fewer" : `Show ${members.length - SHOWN_AT_FIRST} More`}
          </Button>
        )}
      </div>
    </div>
  )
}

/** The desktop side panel: heading plus content, or the empty prompt. */
export function EvidencePanel({
  selection,
  state,
  onRetry,
}: {
  selection: Cited | null
  state: MembersState | undefined
  onRetry: () => void
}) {
  return (
    <section aria-label="Evidence" className="rounded-xl border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">
        {selection ? `Evidence for Citation ${selection.n}` : "Evidence"}
      </h2>
      {selection ? (
        // Keyed so "show more" resets when a different citation opens.
        <EvidenceContent key={selection.n} selection={selection} state={state} onRetry={onRetry} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Select a numbered citation in the brief to see the claim, the verbatim quote, who said it, the
          episode, and the exact moment in the video.
        </p>
      )}
    </section>
  )
}
