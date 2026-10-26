/**
 * Development-only stand-in for the Ask the Library backend: a fake `fetch`
 * that speaks the §6.7 NDJSON contract and the claim-members payload, so the
 * page can be built and checked without the real /api/ask.
 *
 * Switched on with `/ask?mock=1`, and only when NODE_ENV is not production
 * (AskClient imports this module behind that check, so it is not bundled into
 * a production build). The text below is placeholder copy, not medical content.
 *
 * Trigger words in the question pick the scenario:
 *   "bitcoin" / "weather"  → not covered      "thin"   → thin-evidence banner
 *   "cached"               → cached answer    "error"  → error mid-stream
 */
import type { AskEvent, ClaimMember, Cited } from "./types"

const BODY = `### Bottom Line
Placeholder answer for layout checks. Higher-intensity aerobic work raises VO2 max more than easy volume alone, and the library's experts agree it is worth the time [1][2].

### What To Do
- Placeholder dose: a few hard intervals once or twice a week, on top of easy aerobic volume [1, 3].
- Keep most of the weekly volume easy so the hard days stay hard [3].

### Key Points
Aerobic capacity is one of the strongest predictors of how long a person lives, and the gap between the lowest and average fitness groups is larger than between average and high [2][4]. Strength work matters alongside it, because the same experts tie muscle mass to function late in life [5].

### Where Experts Differ
One expert argues for four-minute intervals, while another reports similar gains from shorter sprints with more repetitions; both are stated here without merging the numbers [1][6].

### What The Library Does Not Cover
Placeholder: no claim in the library addresses training in patients with heart failure.`

const FOLLOW_UPS = [
  "How does zone 2 training fit alongside VO2 max intervals?",
  "What is a realistic VO2 max target by age?",
  "How should intervals be adjusted after sixty?",
]

const CITED: Cited[] = [1, 2, 3, 4, 5, 6].map((n) => ({
  n,
  claim_id: `mock-claim-${n}`,
  statement: [
    "Interval sessions at near-maximal effort raise VO2 max more than steady easy work alone.",
    "Low cardiorespiratory fitness carries a larger mortality risk than most conventional risk factors.",
    "Most weekly aerobic volume should be easy, with a small share at high intensity.",
    "The mortality gap is steepest between the lowest fitness group and the average group.",
    "Muscle mass and strength in later life predict independence and survival.",
    "Short repeated sprints can produce VO2 max gains similar to four-minute intervals.",
  ][n - 1],
}))

const TOPICS = [
  { name: "Exercise", slug: "exercise" },
  { name: "Cardiorespiratory Fitness", slug: "cardiorespiratory-fitness" },
  { name: "Healthy Aging", slug: "healthy-aging" },
]

const VIDEO = (id: string) => `https://www.youtube.com/watch?v=${id}`

/** Claim 5 has no speaker, claim 6 has no video: both must render gracefully. */
const MEMBERS: Record<string, ClaimMember[]> = {
  "mock-claim-1": [
    {
      raw_insight_id: "m1a", evidence_type: "ExpertOpinion", confidence: "High",
      statement: "Near-maximal intervals are the most time-efficient way to raise VO2 max.",
      direct_quote: "If you want to move VO2 max, you have to spend time at the very top of your aerobic range. Four minutes hard, four minutes easy, and you repeat that four times.",
      start_ms: 3_725_000, speaker: "Dr. Alex Example", date: "2024-03-04",
      source: { id: "s-101", title: "Episode 101: Mock Episode on Aerobic Fitness", date: "2024-03-04", video_url: VIDEO("mock0101"), links: [{ kind: "article", label: "Episode page", href: "https://example.com/101" }, { kind: "video", label: "YouTube", href: VIDEO("mock0101") }] },
    },
    {
      raw_insight_id: "m1b", evidence_type: "RCT", confidence: "High",
      statement: "Interval training outperformed continuous training for VO2 max.",
      direct_quote: "In that trial the interval group improved their VO2 max by about twice as much as the group that just rode steadily.",
      start_ms: 1_204_000, speaker: "Dr. Sam Sample", date: "2025-01-12",
      source: { id: "s-202", title: "Episode 202: Mock Episode on Training Trials", date: "2025-01-12", video_url: VIDEO("mock0202"), links: [{ kind: "video", label: "YouTube", href: VIDEO("mock0202") }] },
    },
  ],
  "mock-claim-2": [
    {
      raw_insight_id: "m2a", evidence_type: "Cohort", confidence: "High",
      statement: "Low VO2 max is associated with higher all-cause mortality.",
      direct_quote: "Being in the bottom quartile of fitness carries a risk that is on par with smoking.",
      start_ms: 905_000, speaker: "Dr. Alex Example", date: "2024-03-04",
      source: { id: "s-101", title: "Episode 101: Mock Episode on Aerobic Fitness", date: "2024-03-04", video_url: VIDEO("mock0101"), links: [{ kind: "article", label: "Episode page", href: "https://example.com/101" }, { kind: "video", label: "YouTube", href: VIDEO("mock0101") }] },
    },
  ],
  "mock-claim-3": [
    {
      raw_insight_id: "m3a", evidence_type: "ExpertOpinion", confidence: "Medium",
      statement: "Roughly eighty percent of aerobic volume should be easy.",
      direct_quote: "Most of your week should feel conversational, and one or two sessions should feel brutal.",
      start_ms: 2_210_000, speaker: "Dr. Sam Sample", date: "2025-01-12",
      source: { id: "s-202", title: "Episode 202: Mock Episode on Training Trials", date: "2025-01-12", video_url: VIDEO("mock0202"), links: [{ kind: "video", label: "YouTube", href: VIDEO("mock0202") }] },
    },
    {
      raw_insight_id: "m3b", evidence_type: "ExpertOpinion", confidence: "Medium",
      statement: "Easy volume builds the base that makes hard days productive.",
      direct_quote: null, start_ms: null, speaker: "Dr. Pat Placeholder", date: "2023-09-30",
      source: { id: "s-303", title: "Episode 303: Mock Episode on Base Building", date: "2023-09-30", video_url: null, links: [{ kind: "search", label: "Find on peterattiamd.com", href: "https://peterattiamd.com/?s=%23303" }] },
    },
  ],
  "mock-claim-4": [
    {
      raw_insight_id: "m4a", evidence_type: "Cohort", confidence: "High",
      statement: "The largest mortality drop is from the lowest fitness group to the average.",
      direct_quote: "The biggest bang is moving from the bottom to just below average; that step alone is worth a fivefold difference.",
      start_ms: 960_000, speaker: "Dr. Alex Example", date: "2024-03-04",
      source: { id: "s-101", title: "Episode 101: Mock Episode on Aerobic Fitness", date: "2024-03-04", video_url: VIDEO("mock0101"), links: [{ kind: "article", label: "Episode page", href: "https://example.com/101" }, { kind: "video", label: "YouTube", href: VIDEO("mock0101") }] },
    },
  ],
  "mock-claim-5": [
    {
      raw_insight_id: "m5a", evidence_type: "Cohort", confidence: "Medium",
      statement: "Grip strength and lean mass predict survival in older adults.",
      direct_quote: "Muscle is the organ of longevity; the people who keep it are the people who stay independent.",
      start_ms: 4_410_000, speaker: null, date: null,
      source: { id: "s-404", title: "Episode 404: Mock Episode on Muscle", video_url: VIDEO("mock0404"), links: [{ kind: "video", label: "YouTube", href: VIDEO("mock0404") }] },
    },
  ],
  "mock-claim-6": [
    {
      raw_insight_id: "m6a", evidence_type: "RCT", confidence: "Medium",
      statement: "Repeated short sprints gave similar VO2 max gains to four-minute intervals.",
      direct_quote: "Thirty seconds on, a minute off, done enough times, got within a few percent of the four-by-four protocol.",
      start_ms: 1_800_000, speaker: "Dr. Sam Sample", date: "2025-01-12",
      source: { id: "s-202", title: "Episode 202: Mock Episode on Training Trials", date: "2025-01-12", video_url: VIDEO("mock0202"), links: [{ kind: "video", label: "YouTube", href: VIDEO("mock0202") }] },
    },
  ],
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(t)
      reject(new DOMException("Aborted", "AbortError"))
    })
  })

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })

/** The NDJSON stream for one question, delivered in awkward chunks on purpose. */
function askStream(question: string, signal?: AbortSignal): Response {
  const enc = new TextEncoder()
  const notCovered = /bitcoin|weather/i.test(question)
  const thin = /thin/i.test(question)
  const cached = /cached/i.test(question)
  const fails = /error/i.test(question)

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Split some lines across two chunks so the line buffer is exercised.
      const send = async (event: AskEvent, split = false) => {
        const line = JSON.stringify(event) + "\n"
        if (split) {
          const mid = Math.floor(line.length / 2)
          controller.enqueue(enc.encode(line.slice(0, mid)))
          await sleep(15, signal)
          controller.enqueue(enc.encode(line.slice(mid)))
        } else {
          controller.enqueue(enc.encode(line))
        }
      }
      try {
        await sleep(700, signal)
        if (notCovered) {
          await send({ type: "not_covered", nearest_topics: TOPICS })
          controller.close()
          return
        }
        await send({
          type: "retrieval", count: thin ? 9 : 64, thin,
          ...(cached ? { cached: true, answered_at: "2026-10-20T14:30:00Z" } : {}),
        })
        if (cached) {
          await send({ type: "delta", text: BODY })
        } else {
          // Cut the prose at awkward points, including inside a [n] marker.
          for (let i = 0; i < BODY.length; ) {
            const size = 9 + ((i * 7) % 17)
            await send({ type: "delta", text: BODY.slice(i, i + size) }, i % 5 === 0)
            i += size
            await sleep(28, signal)
            if (fails && i > 300) {
              await send({ type: "error", message: "The model call failed (mock). Please try again." })
              controller.close()
              return
            }
          }
        }
        await send({
          type: "done", answer_id: "mock-1", cited: CITED, follow_ups: FOLLOW_UPS, latency_ms: 38_400,
          related_topics: TOPICS,
          ...(cached ? { cached: true, answered_at: "2026-10-20T14:30:00Z" } : {}),
        })
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } })
}

/** Drop-in for `fetch` that answers the four endpoints the Ask page uses. */
export const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://mock.local")
  const path = url.pathname
  const method = (init?.method ?? "GET").toUpperCase()
  console.debug("[mock ask]", method, path, init?.body ?? "")

  if (path === "/api/ask" && method === "POST") {
    const { question = "" } = JSON.parse(String(init?.body ?? "{}"))
    return askStream(String(question), init?.signal ?? undefined)
  }
  const stored = path.match(/^\/api\/ask\/([^/]+)$/)
  if (stored && method === "GET") {
    await sleep(200)
    if (stored[1] === "mock-nc") {
      return json({ id: "mock-nc", question: "What is the weather on Mars?", status: "not_covered", nearest_topics: TOPICS, created_at: "2026-10-24T09:00:00Z" })
    }
    return json({
      id: stored[1], question: "How should I structure VO2 max training for a healthy 50-year-old?", status: "answered",
      body_markdown: BODY, cited: CITED, follow_ups: FOLLOW_UPS, related_topics: TOPICS, created_at: "2026-10-24T09:00:00Z",
    })
  }
  if (/^\/api\/ask\/[^/]+\/feedback$/.test(path) && method === "POST") {
    await sleep(150)
    return json({ ok: true })
  }
  const members = path.match(/^\/api\/claims\/([^/]+)\/members$/)
  if (members && method === "GET") {
    await sleep(250 + (members[1].length % 3) * 150)
    const list = MEMBERS[members[1]]
    return list ? json({ members: list, references: [] }) : json({ error: "Not found (mock)" }, 404)
  }
  if (path === "/api/search" && method === "POST") {
    await sleep(120)
    return json({ results: [{ topic: TOPICS[0] }, { topic: TOPICS[1] }, { topic: TOPICS[0] }, { topic: null }] })
  }
  return json({ error: `No mock for ${method} ${path}` }, 404)
}
