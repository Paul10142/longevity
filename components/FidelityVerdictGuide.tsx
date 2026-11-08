"use client"

import { useEffect, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"

const STORAGE_KEY = "fidelity-verdict-guide-open"

const VERDICT_GUIDE = [
  {
    name: "FAITHFUL",
    dot: "bg-emerald-500",
    meaning:
      "The statement only says things the excerpt backs up. Rewording and compressing are fine — it just can't add, drop, or stretch meaning.",
    example: "The extraction did its job.",
  },
  {
    name: "ADDED DETAIL",
    dot: "bg-red-500",
    meaning:
      "The statement contains something the excerpt never said — a number, mechanism, recommendation, or stronger certainty.",
    example:
      "Excerpt: “sleep affects metabolism” → Statement: “sleep deprivation raises insulin resistance by 30%.” The 30% came from nowhere.",
  },
  {
    name: "DROPPED QUALIFIER",
    dot: "bg-amber-500",
    meaning:
      "A caveat that changes the meaning got lost, making the claim broader or stronger than the source.",
    example: "Excerpt: “this may help in postmenopausal women” → Statement: “this helps.”",
  },
  {
    name: "UNRESOLVED REFERENCE",
    dot: "bg-amber-500",
    meaning:
      "The statement leans on context the excerpt doesn't contain (“this approach”, “the study”), so it can't stand alone or be verified.",
    example: "You can't check it against what's shown.",
  },
] as const

/** The "what each verdict means" card. Open or closed is remembered in this browser. */
export function FidelityVerdictGuide() {
  const [open, setOpen] = useState(true)

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "closed") setOpen(false)
    } catch {
      // storage blocked: stay open
    }
  }, [])

  function toggle() {
    const next = !open
    setOpen(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "open" : "closed")
    } catch {
      // not remembered; still works for this visit
    }
  }

  return (
    <Card>
      <CardContent className="pt-2 pb-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="fidelity-verdict-guide"
          className="flex min-h-[44px] w-full items-center justify-between gap-3 text-left text-sm font-medium"
        >
          <span>What Each Verdict Means</span>
          <span className="text-foreground/70">
            {open ? "Hide" : "Show"} <span aria-hidden>{open ? "▲" : "▼"}</span>
          </span>
        </button>
        {open && (
          <div id="fidelity-verdict-guide" className="pb-3 pt-2">
            <p className="text-sm font-medium mb-3">
              On each card: the <strong>Claim</strong> on the left is what the AI <em>extracted</em>; the{" "}
              <strong>Quote from the Episode</strong> on the right is what was <em>actually said</em>. The{" "}
              <strong>Transcript Excerpt</strong> at the bottom has the full passage around it. Your question is
              always — does the claim stay inside what the quote and excerpt support?
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {VERDICT_GUIDE.map(v => (
                <div key={v.name} className="text-sm">
                  <div className="flex items-center gap-2 font-semibold">
                    <span className={`h-2.5 w-2.5 rounded-full ${v.dot}`} />
                    {v.name}
                  </div>
                  <p className="text-muted-foreground mt-0.5">{v.meaning}</p>
                  <p className="text-xs text-muted-foreground/80 mt-0.5 italic">{v.example}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Rule of thumb: <strong>ADDED</strong> = says too much · <strong>DROPPED</strong> = promises too
              much · <strong>UNRESOLVED</strong> = depends on something you can&apos;t see. When torn between
              FAITHFUL and a violation, pick the violation — the judge is supposed to be strict.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
