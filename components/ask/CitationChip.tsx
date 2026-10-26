import { cn } from "@/lib/utils"

/**
 * The numbered `[n]` chip in the answer text. Opens that citation in the
 * evidence panel. Disabled while the answer is still streaming (the claim ids
 * arrive with the final `done` event) and when the number resolves to no claim.
 */
export function CitationChip({
  n,
  enabled,
  active,
  onClick,
}: {
  n: number
  enabled: boolean
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      aria-label={`Open citation ${n}`}
      aria-pressed={active}
      title={enabled ? "Show the evidence for this point" : "Evidence is available once the answer finishes"}
      className={cn(
        "mx-0.5 inline-flex h-6 min-w-6 -translate-y-px items-center justify-center rounded-full border px-1.5 align-baseline md:h-5 md:min-w-5",
        "text-[11px] font-semibold leading-none tabular-nums transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        enabled
          ? active
            ? "border-primary bg-primary text-primary-foreground"
            : "border-primary/30 bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground"
          : "cursor-default border-border bg-muted text-muted-foreground"
      )}
    >
      {n}
    </button>
  )
}
