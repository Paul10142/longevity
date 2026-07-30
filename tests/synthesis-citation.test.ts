import { test } from 'node:test'
import assert from 'node:assert/strict'
import { citationText } from '../lib/synthesis'

// citationText renders the reference strings that Fix 3 (enrichClinician) must
// deliver in full for every [R#] marker. It is pure formatting logic.

test('formats a full reference with <=3 authors joined', () => {
  const s = citationText({
    authors: ['Smith J', 'Doe A'],
    year: 2021,
    title: 'Exercise and longevity',
    journal: 'JAMA',
    doi: '10.1000/xyz',
  })
  assert.equal(s, 'Smith J, Doe A (2021). Exercise and longevity. JAMA https://doi.org/10.1000/xyz')
})

test('collapses >3 authors to "et al."', () => {
  const s = citationText({
    authors: ['A', 'B', 'C', 'D'],
    year: 2020,
    title: 'T',
    journal: 'J',
    doi: null,
  })
  assert.equal(s, 'A et al. (2020). T. J')
})

test('omits missing pieces (no authors, no year, no journal, no doi)', () => {
  const s = citationText({ authors: null, year: null, title: 'Solo title', journal: null, doi: null })
  assert.equal(s, 'Solo title.')
})

test('empty author array is treated as no authors', () => {
  const s = citationText({ authors: [], year: 2019, title: 'X', journal: null, doi: null })
  assert.equal(s, '(2019). X.')
})

test('collapses internal whitespace', () => {
  const s = citationText({ authors: ['One'], year: null, title: 'Y', journal: '', doi: null })
  assert.equal(s, 'One Y.')
  assert.ok(!/\s{2,}/.test(s))
})
