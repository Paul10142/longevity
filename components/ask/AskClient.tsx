"use client"

import { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { AlertTriangle, Info, Loader2, RefreshCw, SearchX } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { AnswerBody } from "@/components/ask/AnswerBody"
import { FeedbackBar, FollowUps, GoDeeper, RelatedPages } from "@/components/ask/AskExtras"
import { EvidenceContent, EvidencePanel } from "@/components/ask/EvidencePanel"
import {
  askReducer,
  formatDate,
  initialAskState,
  normalizeStored,
  rankEpisodes,
  readNdjson,
  relatedFromSearch,
} from "@/components/ask/askLib"
import type { AskEvent, ClaimMember, MembersState, TopicLink } from "@/components/ask/types"

const EXAMPLES = [
  "How should I structure VO2 max training for a healthy 50-year-old?",
  "What do the experts recommend for lowering ApoB?",
  "Which sleep interventions have the strongest support?",
  "What is the role of zone 2 training in longevity?",
  "How much protein do older adults need to preserve muscle?",
  "What does the evidence say about creatine beyond muscle?",
]

const DESKTOP_QUERY = "(min-width: 768px)"
const subscribeDesktop = (cb: () => void) => {
  const mq = window.matchMedia(DESKTOP_QUERY)
  mq.addEventListener("change", cb)
  return () => mq.removeEventListener("change", cb)
}
/** False on the server and on phones: the evidence panel is a bottom sheet there. */
const useIsDesktop = () =>
  useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP_QUERY).matches, () => false)

/**
 * The fetch the page talks through. With `?mock=1` in development it is the
 * fake backend in mockAsk.ts; the import sits behind the NODE_ENV check, so a
 * production build contains neither the mock nor a way to switch it on.
 */
async function chooseFetch(mock: boolean): Promise<typeof fetch> {
  if (process.env.NODE_ENV !== "production" && mock) {
    const { mockFetch } = await import("@/components/ask/mockAsk")
    return mockFetch
  }
  return (input, init) => fetch(input, init)
}

async function errorMessage(res: Response): Promise<string> {
  if (res.status === 401) return "Your admin session has expired. Sign in again to ask questions."
  try {
    const data = await res.json()
    if (typeof data?.error === "string") return data.error
  } catch {
    // fall through
  }
  return `The request failed (${res.status}).`
}

const MEMBER_PREFETCH_PARALLEL = 4

function AskInner() {
  const params = useSearchParams()
  const mock = process.env.NODE_ENV !== "production" && params.get("mock") === "1"
  const idParam = params.get("id")

  const [state, dispatch] = useReducer(askReducer, initialAskState)
  const [input, setInput] = useState(params.get("q") ?? "")
  const [selected, setSelected] = useState<number | null>(null)
  const [members, setMembers] = useState<Record<string, MembersState>>({})
  const [searchTopics, setSearchTopics] = useState<TopicLink[]>([])
  const isDesktop = useIsDesktop()

  const abortRef = useRef<AbortController | null>(null)
  const requestedRef = useRef(new Set<string>())
  const answerIdRef = useRef<string | null>(null)
  const idParamRef = useRef<string | null>(idParam)
  useEffect(() => {
    answerIdRef.current = state.answerId
    idParamRef.current = idParam
  })

  const busy = state.phase === "retrieving" || state.phase === "streaming"

  // ── Members (evidence) ───────────────────────────────────────────────────
  const loadMembers = useCallback(
    async (claimId: string, force = false) => {
      if (!force && requestedRef.current.has(claimId)) return
      requestedRef.current.add(claimId)
      setMembers((prev) => ({ ...prev, [claimId]: { status: "loading" } }))
      try {
        const f = await chooseFetch(mock)
        const res = await f(`/api/claims/${claimId}/members`, { cache: "no-store" })
        if (!res.ok) throw new Error(await errorMessage(res))
        const data = await res.json()
        const list: ClaimMember[] = Array.isArray(data?.members) ? data.members.filter(Boolean) : []
        const claim = data?.claim ?? {}
        const statement: string | null =
          [claim.canonical_statement, claim.statement, data?.statement].find((s) => typeof s === "string") ?? null
        setMembers((prev) => ({ ...prev, [claimId]: { status: "ok", members: list, statement } }))
      } catch (err) {
        requestedRef.current.delete(claimId)
        setMembers((prev) => ({
          ...prev,
          [claimId]: { status: "error", message: err instanceof Error ? err.message : "unknown error" },
        }))
      }
    },
    [mock]
  )

  // ── Asking ───────────────────────────────────────────────────────────────
  const ask = useCallback(
    async (question: string, opts?: { refresh?: boolean }) => {
      const q = question.trim()
      if (!q) return
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl

      setInput(q)
      setSelected(null)
      setMembers({})
      setSearchTopics([])
      requestedRef.current.clear()
      dispatch({ type: "start", question: q })
      // The address bar no longer describes the old answer.
      if (idParamRef.current) window.history.replaceState(null, "", mock ? "/ask?mock=1" : "/ask")

      try {
        const f = await chooseFetch(mock)
        const res = await f("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q, ...(opts?.refresh ? { refresh: true } : {}) }),
          signal: ctrl.signal,
        })
        if (!res.ok || !res.body) {
          dispatch({ type: "error", message: await errorMessage(res) })
          return
        }
        let finished = false
        await readNdjson(res.body, (event: AskEvent) => {
          if (event.type === "done" || event.type === "not_covered" || event.type === "error") finished = true
          dispatch(event)
        })
        if (!finished) dispatch({ type: "error", message: "The answer stopped early. Please try again." })
      } catch (err) {
        if (ctrl.signal.aborted) return
        dispatch({ type: "error", message: err instanceof Error ? err.message : "Something went wrong." })
      }
    },
    [mock]
  )

  // Open a stored answer: /ask?id=… (shared links and the admin log).
  useEffect(() => {
    if (!idParam || answerIdRef.current === idParam) return
    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl
    requestedRef.current.clear()
    dispatch({ type: "start", question: "" })
    ;(async () => {
      try {
        const f = await chooseFetch(mock)
        const res = await f(`/api/ask/${encodeURIComponent(idParam)}`, { cache: "no-store", signal: ctrl.signal })
        if (!res.ok) throw new Error(await errorMessage(res))
        const stored = normalizeStored(await res.json())
        if (!stored) throw new Error("That answer could not be read.")
        setInput(stored.question)
        setSelected(null)
        setMembers({})
        dispatch({ type: "loaded", answer: stored })
      } catch (err) {
        if (ctrl.signal.aborted) return
        dispatch({ type: "error", message: err instanceof Error ? err.message : "That answer could not be loaded." })
      }
    })()
    return () => ctrl.abort()
  }, [idParam, mock])

  // A finished answer becomes linkable: /ask?id=… reopens it.
  useEffect(() => {
    if (state.phase !== "done" || !state.answerId || idParamRef.current === state.answerId) return
    window.history.replaceState(null, "", `/ask?id=${encodeURIComponent(state.answerId)}${mock ? "&mock=1" : ""}`)
  }, [state.phase, state.answerId, mock])

  // Fetch the evidence behind every citation up front: "Go deeper" ranks
  // episodes across all of them, and opening a chip is then instant.
  useEffect(() => {
    if (state.phase !== "done") return
    const queue = state.cited.map((c) => c.claim_id)
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await loadMembers(id)
    }
    for (let i = 0; i < MEMBER_PREFETCH_PARALLEL; i++) void worker()
  }, [state.phase, state.cited, loadMembers])

  // Related pages: use the ones the stream named; otherwise group the topic
  // tags on the semantic-search hits for the question.
  useEffect(() => {
    if (state.phase !== "done" || state.relatedTopics.length > 0 || !state.question) return
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const f = await chooseFetch(mock)
        const res = await f("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: state.question }),
          signal: ctrl.signal,
        })
        if (!res.ok) return
        const data = await res.json()
        setSearchTopics(relatedFromSearch(Array.isArray(data?.results) ? data.results : []))
      } catch {
        // Related pages are a nicety; the brief stands without them.
      }
    })()
    return () => ctrl.abort()
  }, [state.phase, state.relatedTopics.length, state.question, mock])

  const selectCitation = useCallback(
    (n: number) => {
      setSelected(n)
      const claim = state.cited.find((c) => c.n === n)
      if (claim) void loadMembers(claim.claim_id)
    },
    [state.cited, loadMembers]
  )

  const postFeedback = useCallback(
    async (body: { rating: 1 | -1; note?: string }) => {
      if (!state.answerId) return false
      try {
        const f = await chooseFetch(mock)
        const res = await f(`/api/ask/${encodeURIComponent(state.answerId)}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        return res.ok
      } catch {
        return false
      }
    },
    [state.answerId, mock]
  )

  const selection = selected !== null ? (state.cited.find((c) => c.n === selected) ?? null) : null
  const selectionState = selection ? members[selection.claim_id] : undefined
  const episodes = useMemo(() => rankEpisodes(state.cited, members), [state.cited, members])
  const episodesLoading = state.cited.some((c) => {
    const s = members[c.claim_id]
    return !s || s.status === "loading"
  })
  const related = state.relatedTopics.length > 0 ? state.relatedTopics : searchTopics
  const answeredOn = formatDate(state.answeredAt)

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Ask the Library</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          Ask a clinical question and get a short brief built only from vetted claims in the library. Every
          numbered citation opens the quote, the speaker and the moment in the video.
        </p>
        {mock && (
          <p className="mt-2 inline-block rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            Mock Stream (Development Only): this is placeholder text, not library content.
          </p>
        )}
      </header>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) void ask(input)
        }}
      >
        <Label htmlFor="ask-question">Your Question</Label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <Textarea
            id="ask-question"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                if (!busy) void ask(input)
              }
            }}
            rows={2}
            maxLength={600}
            placeholder="e.g. How should I structure VO2 max training for a healthy 50-year-old?"
            className="min-h-[3.5rem] resize-y sm:flex-1"
          />
          <Button type="submit" size="lg" disabled={busy || !input.trim()} className="sm:w-28">
            {busy ? <Loader2 className="animate-spin" aria-label="Working" /> : "Ask"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Example questions">
          {EXAMPLES.map((q) => (
            <Button
              key={q}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto whitespace-normal py-1.5 text-left text-xs font-normal"
              disabled={busy}
              onClick={() => void ask(q)}
            >
              {q}
            </Button>
          ))}
        </div>
      </form>

      <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6" aria-live="polite">
          {state.phase === "retrieving" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Searching the library…
            </p>
          )}

          {(state.phase === "streaming" || state.phase === "done") && (
            <article className="space-y-4 rounded-xl border bg-card p-5 md:p-6">
              {state.question && <p className="text-sm font-medium text-muted-foreground">{state.question}</p>}

              {state.thin && (
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertTitle>Thin Evidence</AlertTitle>
                  <AlertDescription>
                    The library holds only a few findings on this question, so read this as a starting point, not a
                    full review.
                  </AlertDescription>
                </Alert>
              )}

              {state.cached && (
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
                  <span>{answeredOn ? `Answered ${answeredOn}.` : "Answered earlier."}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    disabled={busy || !state.question}
                    onClick={() => void ask(state.question, { refresh: true })}
                  >
                    <RefreshCw /> Refresh
                  </Button>
                </div>
              )}

              {state.phase === "streaming" && state.retrievalCount !== null && state.body === "" && (
                <p className="text-sm text-muted-foreground">
                  Reading {state.retrievalCount} relevant findings…
                </p>
              )}

              <AnswerBody
                body={state.body}
                streaming={state.phase === "streaming"}
                cited={state.cited}
                selected={selected}
                onSelect={selectCitation}
              />

              {state.phase === "done" && (
                <p className="text-xs text-muted-foreground">
                  {state.cited.length} {state.cited.length === 1 ? "citation" : "citations"}
                  {state.latencyMs !== null && !state.cached ? ` · ${Math.round(state.latencyMs / 1000)} s` : ""}
                </p>
              )}

              {state.phase === "done" && state.answerId && (
                <FeedbackBar key={state.answerId} answerId={state.answerId} post={postFeedback} />
              )}
            </article>
          )}

          {state.phase === "not_covered" && (
            <div className="space-y-4">
              <Alert>
                <SearchX className="h-4 w-4" />
                <AlertTitle>Not Covered by the Library</AlertTitle>
                <AlertDescription>
                  The library does not hold enough vetted evidence to answer this question, and it will not guess
                  from general knowledge. The question has been logged so the gap can be filled.
                </AlertDescription>
              </Alert>
              {state.nearestTopics.length > 0 && (
                <section aria-label="Nearest Topics" className="space-y-2">
                  <h2 className="text-sm font-semibold">Nearest Topics</h2>
                  <div role="list" className="flex flex-wrap gap-2">
                    {state.nearestTopics.map((t) => (
                      <div role="listitem" key={t.slug}>
                        <Link
                          href={`/topics/${t.slug}`}
                          className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium text-primary hover:bg-muted"
                        >
                          {t.name}
                        </Link>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {state.phase === "error" && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Something Went Wrong</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{state.error}</p>
                {state.question && (
                  <Button variant="outline" size="sm" onClick={() => void ask(state.question)}>
                    Try Again
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          {state.phase === "done" && (
            <>
              <FollowUps questions={state.followUps} onAsk={(q) => void ask(q)} />
              <GoDeeper episodes={episodes} loading={episodesLoading} />
              <RelatedPages topics={related} />
            </>
          )}
        </div>

        {/* Desktop: a sticky side panel. Phones get the bottom sheet below. */}
        <aside className="hidden md:block">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto">
            <EvidencePanel
              selection={selection}
              state={selectionState}
              onRetry={() => selection && void loadMembers(selection.claim_id, true)}
            />
          </div>
        </aside>
      </div>

      <Sheet open={!isDesktop && selection !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl px-4 pb-8">
          <SheetHeader className="text-left">
            <SheetTitle>{selection ? `Evidence for Citation ${selection.n}` : "Evidence"}</SheetTitle>
            <SheetDescription>The claim, who said it, and where to watch.</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            {selection && (
              <EvidenceContent
                key={selection.n}
                selection={selection}
                state={selectionState}
                onRetry={() => void loadMembers(selection.claim_id, true)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

export function AskClient() {
  return (
    <Suspense fallback={<p className="text-center text-muted-foreground">Loading…</p>}>
      <AskInner />
    </Suspense>
  )
}
