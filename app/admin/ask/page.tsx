import Link from "next/link"
import { Button } from "@/components/ui/button"
import { AskAnswersTable, type AskAnswerRow } from "@/components/ask/AskAnswersTable"
import { supabaseAdmin } from "@/lib/supabaseServer"

export const dynamic = "force-dynamic"

/**
 * ASK THE LIBRARY, the log. One row per question a physician asked: what
 * happened to it (answered, not covered, failed), how long it took, what it
 * cost in tokens, how well the audit says it stuck to the evidence, and what
 * the reader thought. "Not Covered" is the content roadmap: every question the
 * library could not answer. Each row opens the stored answer at /ask?id=.
 */

const FILTERS = [
  { value: "all", label: "All" },
  { value: "answered", label: "Answered" },
  { value: "not_covered", label: "Not Covered" },
  { value: "failed", label: "Failed" },
] as const

const LIMIT = 200
const COLUMNS = "id, question, status, latency_ms, input_tokens, output_tokens, groundedness_score, created_at"

type RawRow = Omit<AskAnswerRow, "feedback" | "dangling_markers"> & { dangling_markers?: number | null }

/** Table or column not there yet: the backend migration has not been applied. */
const NOT_SET_UP = new Set(["42P01", "PGRST205"])

async function loadRows(status: string): Promise<{ rows: AskAnswerRow[] } | { problem: string }> {
  const fetchRows = async (cols: string) => {
    let q = supabaseAdmin.from("ask_answers").select(cols).order("created_at", { ascending: false }).limit(LIMIT)
    if (status !== "all") q = q.eq("status", status)
    return q
  }

  // `dangling_markers` is a count the backend records per answer; read it when
  // the column exists and carry on without it when it does not.
  let res = await fetchRows(`${COLUMNS}, dangling_markers`)
  if (res.error?.code === "42703") res = await fetchRows(COLUMNS)
  if (res.error) {
    if (res.error.code && NOT_SET_UP.has(res.error.code)) {
      return { problem: "The answers table does not exist yet. Apply the Ask the Library migration to turn this log on." }
    }
    return { problem: res.error.message }
  }

  const raw = (res.data ?? []) as unknown as RawRow[]
  const feedback = new Map<string, { up: number; down: number }>()
  if (raw.length > 0) {
    const fb = await supabaseAdmin.from("ask_feedback").select("answer_id, rating").in("answer_id", raw.map((r) => r.id))
    for (const f of (fb.data ?? []) as { answer_id: string; rating: number }[]) {
      const cur = feedback.get(f.answer_id) ?? { up: 0, down: 0 }
      if (f.rating > 0) cur.up += 1
      else cur.down += 1
      feedback.set(f.answer_id, cur)
    }
  }
  return {
    rows: raw.map((r) => ({
      ...r,
      dangling_markers: r.dangling_markers ?? null,
      feedback: feedback.get(r.id) ?? { up: 0, down: 0 },
    })),
  }
}

/** Development only: sample rows so the table can be checked without a database. */
const MOCK_ROWS: AskAnswerRow[] = [
  { id: "mock-1", question: "How should I structure VO2 max training for a healthy 50-year-old?", status: "answered", latency_ms: 38_400, input_tokens: 21_300, output_tokens: 1_050, groundedness_score: 0.94, dangling_markers: 0, created_at: "2026-10-25T14:02:00Z", feedback: { up: 2, down: 0 } },
  { id: "mock-2", question: "What do the experts recommend for lowering ApoB?", status: "answered", latency_ms: 52_100, input_tokens: 24_800, output_tokens: 1_210, groundedness_score: 0.71, dangling_markers: 3, created_at: "2026-10-25T13:40:00Z", feedback: { up: 0, down: 1 } },
  { id: "mock-nc", question: "What is the weather on Mars?", status: "not_covered", latency_ms: 6_200, input_tokens: 900, output_tokens: 0, groundedness_score: null, dangling_markers: null, created_at: "2026-10-24T09:00:00Z", feedback: { up: 0, down: 0 } },
  { id: "mock-3", question: "Which sleep interventions have the strongest support?", status: "failed", latency_ms: 61_000, input_tokens: 19_000, output_tokens: 0, groundedness_score: null, dangling_markers: null, created_at: "2026-10-23T18:10:00Z", feedback: { up: 0, down: 0 } },
]

export default async function AskLogPage({ searchParams }: { searchParams: Promise<{ status?: string; mock?: string }> }) {
  const sp = await searchParams
  const status = FILTERS.some((f) => f.value === sp.status) ? (sp.status as string) : "all"
  const mock = process.env.NODE_ENV !== "production" && sp.mock === "1"

  let result: { rows: AskAnswerRow[] } | { problem: string }
  if (mock) {
    result = { rows: MOCK_ROWS.filter((r) => status === "all" || r.status === status) }
  } else if (!supabaseAdmin) {
    result = { problem: "Supabase is not configured on this server." }
  } else {
    result = await loadRows(status)
  }

  const filterHref = (value: string) => {
    const qs = new URLSearchParams()
    if (value !== "all") qs.set("status", value)
    if (mock) qs.set("mock", "1")
    const s = qs.toString()
    return s ? `/admin/ask?${s}` : "/admin/ask"
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-12">
        <div className="mx-auto max-w-6xl space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Ask the Library Log</h1>
              <p className="mt-1 max-w-2xl text-muted-foreground">
                Every question asked, with how it went. Not Covered rows are the gaps in the library: the
                questions it could not answer.
              </p>
            </div>
            <div className="flex gap-2">
              <Link href="/ask">
                <Button variant="outline" size="sm">Ask a Question</Button>
              </Link>
              <Link href="/admin">
                <Button variant="ghost" size="sm">← Admin</Button>
              </Link>
            </div>
          </div>

          <nav aria-label="Filter by status" className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <Link key={f.value} href={filterHref(f.value)}>
                <Button variant={status === f.value ? "default" : "outline"} size="sm">
                  {f.label}
                </Button>
              </Link>
            ))}
          </nav>

          {"problem" in result ? (
            <p className="rounded-md border p-4 text-sm text-muted-foreground">{result.problem}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {result.rows.length === LIMIT ? `Latest ${LIMIT} questions shown.` : `${result.rows.length} shown.`}
                {mock ? " Sample rows (development only)." : ""}
              </p>
              <AskAnswersTable rows={result.rows} linkSuffix={mock ? "&mock=1" : ""} />
            </>
          )}
        </div>
      </main>
    </div>
  )
}
