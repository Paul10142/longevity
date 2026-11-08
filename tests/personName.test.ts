/**
 * Unit tests for lib/personName.ts: the name as a show writes it (credentials and all)
 * and the bare name that transcript labels, model prompts and stored speakers use.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bareName,
  bareNames,
  credentialRun,
  foldForMatch,
  honorificBefore,
  isCredentialOnly,
  splitName,
  stripHonorifics,
} from '../lib/personName'

test('splitName separates the honorific, the bare name and every credential, in the order written', () => {
  assert.deepEqual(splitName('Dr. Sally Greenwald, M.D., M.P.H.'), { honorific: 'Dr.', bare: 'Sally Greenwald', credentials: ['M.D.', 'M.P.H.'] })
  assert.deepEqual(splitName('Max Diehn, M.D. Ph.D.'), { honorific: '', bare: 'Max Diehn', credentials: ['M.D.', 'Ph.D.'] })
  assert.deepEqual(splitName('Arthur Brooks Ph.D.'), { honorific: '', bare: 'Arthur Brooks', credentials: ['Ph.D.'] })
  assert.deepEqual(splitName('Tom Dayspring, M.D., FACP, FNLA'), { honorific: '', bare: 'Tom Dayspring', credentials: ['M.D.', 'FACP', 'FNLA'] })
  assert.deepEqual(splitName('Jane Roe'), { honorific: '', bare: 'Jane Roe', credentials: [] })
})

test('splitName keeps Jr., II and surnames or words that look like credentials', () => {
  assert.equal(splitName('Martin Luther King, Jr.').bare, 'Martin Luther King, Jr.')
  assert.equal(splitName('Martin Luther King, Jr., M.D.').bare, 'Martin Luther King, Jr.')
  assert.equal(splitName('Peter Attia III').bare, 'Peter Attia III')
  assert.equal(splitName('Tran Do').bare, 'Tran Do')
  assert.equal(splitName('Jane Ma').bare, 'Jane Ma')
  assert.equal(splitName('Jane Roe, DO').bare, 'Jane Roe')
  assert.equal(splitName('Visiting Washington D.C. Tour').bare, 'Visiting Washington D.C. Tour')
})

test('splitName reads a credential it does not know, written in capitals after a comma, but not a role', () => {
  assert.deepEqual(splitName('Jane Roe, FRSA'), { honorific: '', bare: 'Jane Roe', credentials: ['FRSA'] })
  assert.equal(splitName('Jane Roe, Founder of Acme').bare, 'Jane Roe')
  assert.deepEqual(splitName('Jane Roe, Founder of Acme').credentials, [])
})

test('bareName and stripHonorifics are the same function', () => {
  assert.equal(stripHonorifics, bareName)
  assert.equal(bareName('Dr. Vivek Murthy, M.D.'), 'Vivek Murthy')
  assert.equal(bareName('  Jane   Roe  '), 'Jane Roe')
})

test('isCredentialOnly is true for a fragment made only of credentials, never for a name', () => {
  for (const frag of ['M.P.H.', 'MD', 'Ph.D.', 'M.D., M.P.H.', 'L.C.S.W.', 'D.C.', 'M.B.A']) assert.ok(isCredentialOnly(frag), frag)
  for (const name of ['Jane Roe', 'Tran Do', 'Dr. Jane Roe', 'Jane Roe, M.D.', '', '  ']) assert.ok(!isCredentialOnly(name), name)
})

test('credentialRun copies what the text writes right after a name, with its own punctuation', () => {
  assert.equal(credentialRun(', M.D., M.P.H. | Podcast'), ', M.D., M.P.H.')
  assert.equal(credentialRun(' Ph.D. (Pt. 2)'), ' Ph.D.')
  assert.equal(credentialRun(', M.D. Ph.D.: why'), ', M.D. Ph.D.')
  assert.equal(credentialRun(', MD, and Tony Robbins'), ', MD')
  assert.equal(credentialRun(',M.D.,  Ph.D.'), ', M.D., Ph.D.')
  assert.equal(credentialRun(' on sleep'), '')
  assert.equal(credentialRun(''), '')
})

test('credentialRun does not read the start of a longer word as a credential', () => {
  assert.equal(credentialRun(' MDMA and psychedelics'), '')
  assert.equal(credentialRun(', MSG and sodium'), '')
  assert.equal(credentialRun(' Doe'), '')
  assert.equal(credentialRun(' MD MDMA'), ' MD')
})

test('credentialRun never keeps the front of a longer dotted credential: M.S.P.T. is not M.S.', () => {
  assert.equal(credentialRun(', M.S.P.T., C.S.C.S. | Podcast'), ', M.S.P.T., C.S.C.S.')
  // Unknown to the list and not in the vocabulary: nothing is kept rather than a truncated piece.
  assert.equal(credentialRun(', M.S.X.Y. | Podcast'), '')
  assert.equal(credentialRun(', M.S.X.Y. | Podcast', ['M.S.X.Y.']), ', M.S.X.Y.')
  assert.equal(splitName('Jeff Cavaliere, M.S.P.T., C.S.C.S.').bare, 'Jeff Cavaliere')
  assert.deepEqual(splitName('Jane Roe, M.S.X.Y.').credentials, ['M.S.X.Y.'])
})

test('credentialRun drops a sentence full stop after a dotless credential only', () => {
  assert.equal(credentialRun(', MD. She is'), ', MD')
  assert.equal(credentialRun(', M.D. She is'), ', M.D.')
  assert.equal(credentialRun(', FACP. She is'), ', FACP')
})

test('credentialRun accepts a credential from the vocabulary but only if it looks like one', () => {
  assert.equal(credentialRun(', FRSA (Pt. 2)'), '')
  assert.equal(credentialRun(', FRSA (Pt. 2)', ['FRSA']), ', FRSA')
  assert.equal(credentialRun(', Founder of Acme', ['Founder']), '')
})

test('honorificBefore finds a Dr. or Prof. written just before a position, as written', () => {
  const t = 'GUEST | Dr. Ben Bikman: insulin'
  assert.equal(honorificBefore(t, t.indexOf('Ben')), 'Dr.')
  assert.equal(honorificBefore('Prof Jane Roe', 5), 'Prof')
  assert.equal(honorificBefore('Sandr Jane Roe', 6), '', 'Dr must not be the end of another word')
  assert.equal(honorificBefore('Jane Roe', 0), '')
})

test('bareNames: bare, no lone credentials, no repeats, nobody excluded, null-safe', () => {
  assert.deepEqual(bareNames(['Sally Greenwald, M.D., M.P.H.', 'M.P.H.', 'sally greenwald', 'Dr. Jane Roe', null, '', undefined]), ['Sally Greenwald', 'Jane Roe'])
  assert.deepEqual(bareNames(['Peter Attia, M.D.', 'Matt Walker, Ph.D.'], n => /attia/i.test(n)), ['Matt Walker'])
})

test('foldForMatch folds case, accents, special letters and punctuation', () => {
  assert.equal(foldForMatch('Iñigo San-Millán'), 'inigo san millan')
  assert.equal(foldForMatch('Søberg'), foldForMatch('Soberg'))
  assert.equal(foldForMatch('M.D., Ph.D.'), 'm d ph d')
})
