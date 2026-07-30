/**
 * Pure-function tests for lib/taxonomy.ts `slugify`.
 *
 * slugify assigns a topic's stable URL/citation slug ONCE at creation. Only the
 * pure formatting is tested here; the uniqueness/collision loop lives in
 * createChildTopic and is DB-bound (queries `topics.slug`), so it is out of
 * scope for a pure-function unit test.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../lib/taxonomy'

test('slugify lowercases and hyphenates spaces', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('slugify collapses runs of punctuation and whitespace into a single hyphen', () => {
  assert.equal(slugify('Vitamin D  &  K2'), 'vitamin-d-k2')
})

test('slugify trims leading and trailing separators', () => {
  assert.equal(slugify('***Hello***'), 'hello')
  assert.equal(slugify('  Trim Me!  '), 'trim-me')
})

test('slugify replaces non-ASCII (unicode) characters as separators', () => {
  // "é" is not [a-z0-9], so it and the following space collapse to one hyphen.
  assert.equal(slugify('Café Society'), 'caf-society')
})

test('slugify treats emoji and other symbols as separators', () => {
  assert.equal(slugify('Sleep 😴 Health'), 'sleep-health')
})

test('slugify truncates to 60 characters', () => {
  const long = 'a'.repeat(100)
  const out = slugify(long)
  assert.equal(out.length, 60)
  assert.equal(out, 'a'.repeat(60))
})

test('slugify returns empty string for input with no alphanumerics', () => {
  // Callers guard this with `slugify(name) || 'topic'`; the function itself
  // yields '' so that fallback can fire.
  assert.equal(slugify('!!!'), '')
})

test('slugify preserves digits', () => {
  assert.equal(slugify('Omega 3 Fatty Acids'), 'omega-3-fatty-acids')
})
