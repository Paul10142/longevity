"use client"

import { useMemo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import { CitationChip } from "@/components/ask/CitationChip"
import { citeNumber, prepareBody } from "@/components/ask/askLib"
import type { Cited } from "@/components/ask/types"

/**
 * The brief. The model's markdown is rendered as written; the only thing
 * added is that `[n]` markers become numbered chips. Attribution (who said
 * it, which episode) lives in the evidence panel behind each chip, never in
 * the prose.
 *
 * Any other link the model might emit is shown as plain text: the brief must
 * not carry links of its own.
 */
export function AnswerBody({
  body,
  streaming,
  cited,
  selected,
  onSelect,
}: {
  body: string
  streaming: boolean
  cited: Cited[]
  selected: number | null
  onSelect: (n: number) => void
}) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        const n = citeNumber(href)
        if (n === null) return <>{children}</>
        return (
          <CitationChip
            n={n}
            enabled={cited.some((c) => c.n === n)}
            active={selected === n}
            onClick={() => onSelect(n)}
          />
        )
      },
    }),
    [cited, selected, onSelect]
  )

  return (
    <div
      className={[
        "prose prose-neutral max-w-none dark:prose-invert",
        "prose-headings:font-semibold prose-h3:mb-2 prose-h3:mt-6 prose-h3:text-base",
        "prose-p:my-2 prose-p:leading-relaxed prose-li:my-1 prose-ul:my-2",
        "prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground",
      ].join(" ")}
    >
      <ReactMarkdown components={components}>{prepareBody(body, streaming)}</ReactMarkdown>
      {streaming && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-primary/60"
        />
      )}
    </div>
  )
}
