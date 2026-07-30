/**
 * Deterministic renderer: sentence-block article model → markdown string.
 * synthesis-v4 spec §5.2 ("extend `outlineToMarkdown` to emit each block kind")
 * and §5.4 (reader-facing rendering rules). Phase 3 plumbing — NOT yet wired into
 * the live synthesis path.
 *
 * This is the assembly-only counterpart to the model's authorship: the model
 * places the sentences (spec §2 — it contributes syntax, never substance), and
 * this function only *arranges* them into markdown. It invents no prose, adds no
 * facts, and never emits a `claim_ids` array into reader-facing text.
 *
 * Reader-facing rules honoured (spec §5.1, §5.4):
 *  - `sourced`, `synthesis`, and `connective` sentences render identically — the
 *    reader must never think about provenance. The kind distinction survives only
 *    in the structured model, for the admin/review layer.
 *  - Primary-literature reference markers (`[R1]`) inside sentence text are left
 *    untouched — those are citations to studies, not to our ingested sources.
 *  - Internal claim-id UUID tokens are never rendered. The model is instructed to
 *    keep them out of `text`, but we strip any that leaked, exactly as the
 *    existing `outlineToMarkdown` does (defensive; keeps the renderer the single
 *    choke point).
 *
 * Output mirrors the existing `outlineToMarkdown` (`lib/synthesis.ts`) where the
 * shapes overlap: `## <section title>`, blocks separated by a blank line, and a
 * deterministic `## References` section built from verified data.
 */

import type {
  BlockArticle,
  Block,
  Sentence,
  Section,
  Reference,
} from './blocks'
import { sentencesOf } from './blocks'

/** UUID token pattern — the internal claim-id form the model may accidentally
 * echo into prose (e.g. "…male factors [d5d0e719-…]."). Mirrors the regex in
 * `lib/synthesis.ts:stripInlineClaimIds`. `[R#]` markers do not match. */
const CLAIM_ID_TOKEN =
  /\s*\[[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\]/g

/** Strip any inline claim-id UUID tokens and tidy the whitespace they leave
 * behind. Leaves `[R#]` reference markers untouched. Pure. */
function cleanText(text: string): string {
  return text
    .replace(CLAIM_ID_TOKEN, '')
    .replace(/ +([.,;:)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Reader-facing text of a single sentence, regardless of kind. */
function sentenceText(s: Sentence): string {
  return cleanText(s.text)
}

/** Escape a table cell so pipes/newlines don't break the GFM table grid. */
function tableCell(text: string): string {
  return cleanText(text).replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

/**
 * Render one block to a markdown fragment (no trailing blank line — the caller
 * joins fragments with `\n\n`). Returns `null` for a block that produces nothing
 * (e.g. an empty prose block), so empties are dropped rather than emitting stray
 * blank lines.
 */
function renderBlock(block: Block): string | null {
  switch (block.kind) {
    case 'prose': {
      // Sentences in a prose block combine into ONE paragraph, joined by a
      // single space — the model decides sentence boundaries; we only assemble.
      const text = block.sentences
        .map(sentenceText)
        .filter(Boolean)
        .join(' ')
      return text || null
    }

    case 'bullets': {
      const lines = block.items
        .map(sentenceText)
        .filter(Boolean)
        .map(t => `- ${t}`)
      return lines.length ? lines.join('\n') : null
    }

    case 'key_takeaways': {
      // A distinct block kind, so it gets a labelled bullet list rather than
      // being indistinguishable from a plain `bullets` block. (Spec §5.2 lists
      // it separately but doesn't prescribe markup; bold label + bullets is the
      // simplest faithful rendering.)
      const lines = block.items
        .map(sentenceText)
        .filter(Boolean)
        .map(t => `- ${t}`)
      if (!lines.length) return null
      return `**Key Takeaways**\n\n${lines.join('\n')}`
    }

    case 'callout': {
      // Rendered as a blockquote with a bold tone label. Sentences join into one
      // quoted paragraph.
      const body = block.sentences
        .map(sentenceText)
        .filter(Boolean)
        .join(' ')
      if (!body) return null
      const label = block.tone === 'caution' ? 'Caution' : 'Note'
      return `> **${label}:** ${body}`
    }

    case 'heading': {
      // Our documented addition (see blocks.ts): an in-section sub-heading for
      // §5.1 sub-sectioning. H3, since sections are H2.
      const t = cleanText(block.text)
      return t ? `### ${t}` : null
    }

    case 'table': {
      if (!block.headers.length) return null
      const header = `| ${block.headers.map(tableCell).join(' | ')} |`
      const divider = `| ${block.headers.map(() => '---').join(' | ')} |`
      const rows = block.rows.map(
        row => `| ${row.map(tableCell).join(' | ')} |`
      )
      // claim_ids are attribution metadata (admin/cross-linking) — never
      // rendered into the reader-facing table.
      return [header, divider, ...rows].join('\n')
    }

    case 'figure': {
      const alt = cleanText(block.alt)
      const image = `![${alt}](${block.ref})`
      const captionParts: string[] = []
      const caption = cleanText(block.caption)
      if (caption) captionParts.push(caption)
      if (block.source) captionParts.push(`Source: ${cleanText(block.source)}`)
      if (!captionParts.length) return image
      // Caption as an emphasised line under the image.
      return `${image}\n\n*${captionParts.join(' — ')}*`
    }
  }
}

/** Render a section: `## <title>` followed by its non-empty blocks. */
function renderSection(section: Section): string[] {
  const parts: string[] = [`## ${cleanText(section.title)}`]
  for (const block of section.blocks ?? []) {
    const rendered = renderBlock(block)
    if (rendered) parts.push(rendered)
  }
  return parts
}

/**
 * Render the deterministic References section from verified data — byte-for-byte
 * the same format as `outlineToMarkdown` in `lib/synthesis.ts` (`## References`,
 * then `<n>. <citation>` lines with the `R` prefix stripped from the marker).
 * Never model-authored.
 */
function renderReferences(references: Reference[]): string[] {
  const parts: string[] = ['## References']
  for (const r of references) {
    parts.push(`${r.marker.replace('R', '')}. ${r.citation}`)
  }
  return parts
}

/**
 * Render a full sentence-block article to markdown. Pure and deterministic:
 * identical input always yields identical output, and the function depends on
 * nothing but its argument.
 */
export function renderArticleToMarkdown(article: BlockArticle): string {
  const parts: string[] = []
  for (const section of article.sections ?? []) {
    parts.push(...renderSection(section))
  }
  if (article.references && article.references.length) {
    parts.push(...renderReferences(article.references))
  }
  return parts.join('\n\n')
}
