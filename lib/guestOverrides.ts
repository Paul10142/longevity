/**
 * Guest lists a person has set by hand, which a re-read must never undo.
 *
 * WHY. Claude's reading of a title varies from run to run (the model is not
 * deterministic), so re-planning a show can quietly turn a row Paul corrected back into
 * the wrong one. An entry here is the final say for ONE episode: the reader does not
 * ask the model about it (`resolveGuests`), and `--apply` writes it even from a plan
 * made before the entry existed (`withOverrides`). Nothing else in the plan changes.
 *
 * SHAPE. `key` is the feed key the plan uses (`fmf-0108`, `attia-0274`), `guests` is the
 * whole guest list in `authors` form (every guest as the show writes them, credentials
 * attached as ONE element; the host is added in front by the plan and never listed here),
 * and `why` says who decided and when, so a later reader can tell a decision from a
 * guess. An empty `guests` means "no guest, host only".
 *
 * ADDING ONE. Add the entry and its reason in the same commit that records the decision.
 * `tests/guestNameCases.test.ts` checks every entry (a registered show, a unique key, a
 * real name that is not the host, no credential as its own element).
 *
 * NOT HERE. The 17 older `fmf-<guest-slug>` rows (`transcript_origin='published'`, from
 * the August published-transcript path) hold the host as `Dr. Rhonda Patrick`. Their
 * keys are not feed keys, so the plan never reads or writes them and a re-run cannot
 * undo them; an entry would never match, which is why none is listed.
 */

export type GuestOverride = {
  key: string
  guests: readonly string[]
  why: string
}

const PAUL_2026_11_08 = 'set by hand, confirmed by Paul 2026-11-08'

export const GUEST_OVERRIDES: readonly GuestOverride[] = [
  // FoundMyFitness: the guest the model drops or misreads.
  { key: 'fmf-0108', guests: ['Brady Holmer'], why: `${PAUL_2026_11_08} (the model reads the episode as host-only)` },
  { key: 'fmf-0098', guests: ['Brady Holmer'], why: `${PAUL_2026_11_08} (the same guest as #108)` },
  { key: 'fmf-0044', guests: ['Mike Maser'], why: `${PAUL_2026_11_08} (the model reads the episode as host-only)` },
  { key: 'fmf-0052', guests: ['Kevin Rose'], why: `${PAUL_2026_11_08} (the model reads the episode as host-only)` },
  { key: 'fmf-0068', guests: ['Dr. Bill Harris'], why: `${PAUL_2026_11_08} ("Dr. Bill Harris", the title's spelling, not William)` },
  { key: 'fmf-0019', guests: ['Dr. Darya Rose', 'Kevin Rose'], why: `${PAUL_2026_11_08} (the title writes only "Dr. Darya"; the notes give the surname)` },
  { key: 'fmf-0069', guests: ['Roger Seheult', 'Kyle Allred'], why: `${PAUL_2026_11_08} (Kyle Allred is named only in the notes)` },
  { key: 'fmf-0073', guests: ['Kyle Allred'], why: `${PAUL_2026_11_08} (Kyle Allred is named only in the notes)` },
  // The Drive: a pseudonymous guest keeps the channel name the show attaches to the first name.
  { key: 'attia-0274', guests: ['Derek, More Plates More Dates'], why: `${PAUL_2026_11_08} (a pseudonymous guest keeps his channel name)` },
  { key: 'attia-0291', guests: ['Derek, More Plates More Dates'], why: `${PAUL_2026_11_08} (a pseudonymous guest keeps his channel name)` },
]

/** The overrides as a lookup by feed key. */
export function overridesByKey(list: readonly GuestOverride[] = GUEST_OVERRIDES): Map<string, GuestOverride> {
  return new Map(list.map(o => [o.key, o]))
}
