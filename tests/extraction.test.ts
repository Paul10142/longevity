/**
 * Unit tests for the pure extraction helpers.
 *
 *   npm test
 *
 * resolveQuote is the trust-critical one: it decides whether a model-proposed
 * `direct_quote` is REALLY in the source chunk (verbatim, or verbatim after
 * folding smart punctuation / whitespace), and refuses to store one that isn't.
 * A regression here = the product presenting a fabricated citation as the
 * source's own words, which is the exact failure the whole system exists to
 * prevent. These cases lock in each branch of that logic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveQuote, splitIntoChunks } from '../lib/extraction'

test('resolveQuote: exact substring is located with correct offsets', () => {
  const content = 'the quick brown fox jumps'
  const r = resolveQuote(content, 'quick brown')
  assert.equal(r.text, 'quick brown')
  assert.equal(r.start, 4)
  assert.equal(r.end, 15)
  assert.equal(content.slice(r.start!, r.end!), 'quick brown')
})

test('resolveQuote: nothing to resolve → null', () => {
  for (const raw of [null, undefined, '', '   ']) {
    const r = resolveQuote('some content here', raw)
    assert.deepEqual(r, { text: null, start: null, end: null })
  }
})

test('resolveQuote: a quote absent from the chunk is dropped, not stored', () => {
  const r = resolveQuote('hello world, this is the transcript', 'goodbye cruel world')
  assert.equal(r.text, null)
  assert.equal(r.start, null)
})

test('resolveQuote: smart punctuation folds to a match, offsets index the real text', () => {
  const content = 'she said "it is fine" and left'          // straight quotes in source
  const raw = 'said “it is fine”'                    // curly quotes from the model
  const r = resolveQuote(content, raw)
  assert.equal(r.text, raw)                                    // returns the model's text…
  assert.ok(r.start !== null && r.end !== null)
  // …but the offsets point at the real (straight-quote) span in the source.
  assert.equal(content.slice(r.start!, r.end!), 'said "it is fine"')
})

test('resolveQuote: collapsed whitespace still matches', () => {
  const content = 'protein\n\n   intake   matters here'
  const r = resolveQuote(content, 'protein intake matters')
  assert.ok(r.text !== null && r.start !== null, 'folded-whitespace quote should resolve')
})

test('resolveQuote: ellipsis-joined quote resolves only if EVERY fragment is verbatim', () => {
  const content = 'alpha beta gamma delta epsilon'
  const ok = resolveQuote(content, 'alpha ... gamma')
  assert.equal(ok.text, 'alpha ... gamma')
  assert.equal(ok.start, 0)

  const bad = resolveQuote(content, 'alpha ... nonsense-not-present')
  assert.equal(bad.text, null, 'one missing fragment invalidates the whole citation')
})

test('resolveQuote: a verbatim prefix (≥40 chars) survives when the tail is invented', () => {
  const prefix = 'The mitochondria is the powerhouse of the cell'   // 46 chars, in the source
  const content = `${prefix}, as every textbook notes.`
  const r = resolveQuote(content, `${prefix} and it also cures every disease`)
  assert.ok(r.text !== null, 'should keep the verifiable prefix')
  assert.ok(prefix.startsWith(r.text!.slice(0, 20)), 'kept text is a prefix of the quote')
  assert.ok(content.includes(r.text!), 'kept text is verbatim in the source')
  assert.ok(r.text!.length >= 40, 'kept prefix respects the 40-char floor')
})

test('resolveQuote: a too-short unlocatable quote is dropped (no sub-40 citations)', () => {
  const r = resolveQuote('completely unrelated source text about sleep', 'short bit')
  assert.equal(r.text, null)
})

test('splitIntoChunks: short text returns a single trimmed chunk', () => {
  const chunks = splitIntoChunks('  a short transcript  ', 1000, 100)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], 'a short transcript')
})

test('splitIntoChunks: long text splits into multiple chunks, each a substring of the source', () => {
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
  const chunks = splitIntoChunks(words, 200, 40)
  assert.ok(chunks.length > 1, 'long text should split')
  for (const c of chunks) {
    assert.ok(c.length > 0, 'no empty chunk')
    // Each chunk's collapsed form appears in the collapsed source (chunks are
    // contiguous slices; trimming is the only transform).
    assert.ok(words.includes(c.trim()) || words.replace(/\s+/g, ' ').includes(c.replace(/\s+/g, ' ').trim()),
      'chunk is a verbatim slice of the source')
  }
})

test('splitIntoChunks: empty input yields no chunks', () => {
  assert.deepEqual(splitIntoChunks('', 100, 20), [])
})
