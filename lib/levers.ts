// Lifestyle Academy's 5 core health levers.
//
// Levers are an *editorial* surface: the copy below is hand-maintained here,
// not generated. Each lever points at a top-level topic by slug, and is
// resolved against the live `topics` table at request time so the cards can
// link into the knowledge engine.
//
// Topics are AI-managed (created, renamed, merged, archived by the pipeline),
// so we deliberately do NOT read display copy from them — only the id and
// claim count. A lever whose topic is missing or archived is skipped rather
// than rendered as a dead link.

import { supabaseAdmin } from "./supabaseServer"

export type Lever = {
  id: string
  name: string
  tagline: string
  description: string
  primaryBenefits: string[]
  topicSlug: string
  topicId: string
  claimCount: number
}

type LeverConfig = Omit<Lever, "topicId" | "claimCount">

// Order here is the display order on /start.
//
// TODO(copy): the `tagline`, `description`, and `primaryBenefits` strings below
// are UNREVIEWED PLACEHOLDER copy. The originals lived in the v1 `concepts`
// table and were lost when it was dropped; these were drafted to get the public
// /start grid rendering again. Rewrite before treating them as final — this is
// public-facing marketing copy.
//
// NOTE: `id` values are referenced by PRIORITY_TO_LEVERS in app/start/page.tsx
// for the "what matters most" highlighting — keep them stable.
const LEVER_CONFIG: LeverConfig[] = [
  {
    id: "sleep",
    name: "Sleep",
    tagline: "The foundation everything else is built on.",
    description:
      "Sleep duration, timing, and quality shape how well every other lever works — from training recovery to appetite regulation to mood.",
    primaryBenefits: [
      "Sharper focus and steadier mood",
      "Better recovery from training",
      "More stable appetite and energy",
    ],
    topicSlug: "sleep-circadian-rhythm",
  },
  {
    id: "exercise",
    name: "Exercise",
    tagline: "The single most powerful lever for healthspan.",
    description:
      "Cardiorespiratory fitness and strength are among the strongest predictors of how long you stay healthy and independent.",
    primaryBenefits: [
      "Protects strength and mobility with age",
      "Improves cardiovascular and metabolic health",
      "Supports mood and cognition",
    ],
    topicSlug: "exercise",
  },
  {
    id: "nutrition",
    name: "Nutrition",
    tagline: "What you eat, and how much — not the latest diet.",
    description:
      "Energy balance, protein sufficiency, and food quality drive most of the outcome. The details matter far less than the fundamentals.",
    primaryBenefits: [
      "Supports a healthy body composition",
      "Preserves muscle as you age",
      "Improves metabolic markers",
    ],
    topicSlug: "nutrition",
  },
  {
    id: "mental-health",
    name: "Mental & Emotional Health",
    tagline: "Stress, connection, and purpose are health variables.",
    description:
      "Psychological wellbeing is not separate from physical health — it shapes sleep, eating, activity, and long-term risk.",
    primaryBenefits: [
      "Lower stress load",
      "Stronger relationships and sense of purpose",
      "Better adherence to every other lever",
    ],
    topicSlug: "mental-health",
  },
  {
    id: "drugs-supplements",
    name: "Medications & Supplements",
    tagline: "Useful at the margins — after the basics are in place.",
    description:
      "Some drugs and supplements have real evidence behind them. Most do not, and none substitute for the other four levers.",
    primaryBenefits: [
      "Separates evidence from marketing",
      "Targets specific, measurable gaps",
      "Flags interactions and real risks",
    ],
    topicSlug: "medications-supplements",
  },
]

/**
 * Get all levers, resolved against the live topics table.
 *
 * Levers whose topic is missing or archived are omitted, so every card that
 * renders has a working destination. Returns [] when Supabase is not
 * configured (e.g. during a build with no env) rather than throwing.
 */
export async function getAllLevers(): Promise<Lever[]> {
  if (!supabaseAdmin) {
    return []
  }

  const slugs = LEVER_CONFIG.map((lever) => lever.topicSlug)

  const { data: topics, error } = await supabaseAdmin
    .from("topics")
    .select("id, slug, claim_count")
    .in("slug", slugs)
    .eq("status", "active")

  if (error) {
    throw new Error(`Error fetching lever topics: ${error.message}`)
  }

  type LeverTopicRow = { id: string; slug: string; claim_count: number | null }

  const bySlug = new Map<string, LeverTopicRow>(
    ((topics ?? []) as LeverTopicRow[]).map((topic) => [topic.slug, topic])
  )

  const levers = LEVER_CONFIG.flatMap((lever) => {
    const topic = bySlug.get(lever.topicSlug)
    if (!topic) {
      console.warn(
        `Lever "${lever.id}" has no active topic for slug "${lever.topicSlug}" — skipping.`
      )
      return []
    }
    return [{ ...lever, topicId: topic.id, claimCount: topic.claim_count ?? 0 }]
  })

  return levers
}
