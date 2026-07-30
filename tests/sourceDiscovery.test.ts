/**
 * Pure-function tests for lib/sourceDiscovery.ts `parseGuests`.
 *
 * Convention: Attia episode titles put guests after a pipe —
 *   "#333 ‒ Some topic | Gayatri Devi, M.D."
 * sometimes several guests joined by "&" or "and", each with trailing
 * credentials to strip. Solo episodes/AMAs have no pipe and must yield [].
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGuests } from '../lib/sourceDiscovery'

test('parseGuests extracts a single guest and strips the M.D. credential', () => {
  assert.deepEqual(
    parseGuests('#333 ‒ Preventing cardiovascular disease | Gayatri Devi, M.D.'),
    ['Gayatri Devi'],
  )
})

test('parseGuests returns [] when the title has no pipe (solo / AMA)', () => {
  assert.deepEqual(parseGuests('AMA #56: Deep dive into sleep and recovery'), [])
})

test('parseGuests returns [] for an empty guest section (trailing pipe only)', () => {
  assert.deepEqual(parseGuests('Some topic |   '), [])
})

test('parseGuests splits multiple guests joined by an ampersand and strips credentials', () => {
  assert.deepEqual(
    parseGuests('#123 ‒ Longevity roundtable | Jane Doe, Ph.D. & John Smith, M.D.'),
    ['Jane Doe', 'John Smith'],
  )
})

test('parseGuests splits guests joined by the word "and"', () => {
  assert.deepEqual(
    parseGuests('#5 ‒ Metabolic health | Jane Roe and Mary Major'),
    ['Jane Roe', 'Mary Major'],
  )
})

test('parseGuests strips a variety of professional credentials', () => {
  assert.deepEqual(parseGuests('T | Sam Lee, D.O.'), ['Sam Lee'])
  assert.deepEqual(parseGuests('T | Ana Ruiz, M.P.H.'), ['Ana Ruiz'])
  assert.deepEqual(parseGuests('T | Kim Park, R.D.'), ['Kim Park'])
})

test('parseGuests keeps everything after the FIRST pipe as the guest tail (pipe is not a separator)', () => {
  // split('|').slice(1).join('|') means a title with two pipes rejoins the tail
  // verbatim: only "&"/"and" split guests, so the inner pipe stays in the name.
  // Real Attia titles carry exactly one pipe; this pins the documented behavior.
  assert.deepEqual(
    parseGuests('Deep | Dive | Jane Doe, M.D.'),
    ['Dive | Jane Doe'],
  )
})

test('parseGuests strips credentials written without periods (e.g. "MD")', () => {
  assert.deepEqual(parseGuests('T | Jane Doe, MD'), ['Jane Doe'])
})

test('parseGuests drops tails that do not look like a name (lowercase start)', () => {
  assert.deepEqual(parseGuests('Episode recap | podcast highlights'), [])
})

test('parseGuests drops tails longer than four words (not a person name)', () => {
  assert.deepEqual(parseGuests('T | This Is Way Too Long'), [])
})
