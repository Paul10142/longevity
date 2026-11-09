import { NextResponse } from "next/server"
import { stopKindOf } from "@/lib/guestNames"
import { claudeSpeakerLlm, suggestGuestVoice } from "@/lib/speakerRead"
import { suggestGuestSpeaker } from "@/lib/speakerReview"
import { loadSpeakerContext } from "@/lib/speakerReviewData"
import { bareNames, bareName, foldForMatch } from "@/lib/personName"

export const dynamic = "force-dynamic"

/**
 * A suggestion, never a write: which unnamed voice does a short Claude read of the first five minutes say
 * is the guest? One small model call (lib/llm.ts), made only when Paul clicks "Suggest". It needs exactly
 * one guest on the row and at least one unnamed voice; otherwise it says why it has nothing to suggest.
 * The page only highlights the answer. Nothing is saved.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const ctx = await loadSpeakerContext(id)
  if ("error" in ctx) return NextResponse.json({ error: ctx.error }, { status: ctx.error === "no such source" ? 404 : 500 })

  const host = ctx.hostLabel ?? (ctx.source.authors?.[0] ? bareName(ctx.source.authors[0]) : null)
  if (!host) return NextResponse.json({ label: null, why: "the show's host is not known for this episode" })
  const hostFold = foldForMatch(host)
  const guests = bareNames(ctx.source.authors?.slice(1) ?? [], name => foldForMatch(name) === hostFold)
  if (guests.length !== 1) {
    return NextResponse.json({ label: null, why: guests.length === 0 ? "no guest is listed on this episode" : "more than one guest is listed, so a single guest cannot be suggested" })
  }
  if (ctx.speakers.length === 0) return NextResponse.json({ label: null, why: "every voice already has a name" })

  try {
    const llm = claudeSpeakerLlm()
    const result = await suggestGuestSpeaker({
      turns: ctx.turns,
      host,
      guest: guests[0],
      read: (segments, h, g) => suggestGuestVoice({ segments, host: h, guest: g, llm }),
    })
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `the suggestion is unavailable: ${message.slice(0, 200)}` }, { status: stopKindOf(err) ? 503 : 500 })
  }
}
