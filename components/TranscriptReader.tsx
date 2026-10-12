import { formatTimestamp, timestampLink, type TranscriptView } from "@/lib/transcriptView"
import { cn } from "@/lib/utils"

/**
 * A transcript laid out for reading: one block per speaker turn, a blank line
 * between turns, the speaker in bold, and a `[1:02:15]` stamp at the start of
 * each turn that links to that moment in the video when we know the video.
 *
 * Arial 16px with generous leading and a ~72-character measure, by request.
 * The whole transcript renders (100–200k characters is a few hundred
 * paragraphs — no virtualisation needed). No hooks, so the same component
 * serves the pop-up and the full page.
 */

const READER_STYLE: React.CSSProperties = {
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSize: "16px",
  lineHeight: 1.75,
  maxWidth: "72ch",
}

export function TranscriptReader({
  view,
  videoUrl,
  className,
}: {
  view: TranscriptView
  videoUrl: string | null
  className?: string
}) {
  if (view.turns.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        No transcript yet.
      </p>
    )
  }

  return (
    <div className={cn("space-y-6", className)} style={READER_STYLE}>
      {view.turns.map((turn, i) => {
        const stamp = turn.start_ms === null ? null : formatTimestamp(turn.start_ms)
        const href = turn.start_ms === null ? null : timestampLink(videoUrl, turn.start_ms)
        return (
          <p key={i} className="whitespace-pre-line">
            {stamp && (
              href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mr-2 tabular-nums text-muted-foreground hover:text-primary hover:underline"
                  title="Open the video at this moment"
                >
                  [{stamp}]
                </a>
              ) : (
                <span className="mr-2 tabular-nums text-muted-foreground">[{stamp}]</span>
              )
            )}
            {turn.speaker && <strong>{turn.speaker}:</strong>}
            {turn.speaker && " "}
            {turn.text}
          </p>
        )
      })}
    </div>
  )
}
