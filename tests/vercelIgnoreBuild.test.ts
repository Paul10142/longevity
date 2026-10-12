/**
 * scripts/vercel-ignore-build.sh — Vercel's "Ignored Build Step" (vercel.json
 * `ignoreCommand`): exit 0 skips the build, exit 1 builds. A skip that should
 * have been a build leaves a code change off the live site with no error
 * anywhere, so every "build" case is pinned as hard as the "skip" ones. Each
 * case runs the real script in a throwaway git repository.
 *
 *   npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SCRIPT = join(process.cwd(), 'scripts/vercel-ignore-build.sh')

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=test',
      '-c', 'user.email=test@example.com',
      '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: dir, encoding: 'utf8' },
  ).trim()
}

function write(dir: string, file: string, body = `${file}\n`): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true })
  writeFileSync(join(dir, file), body)
}

/** A repo with a site file and a doc in its first commit; returns that commit. */
function repo(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vercel-ignore-'))
  git(dir, 'init', '--quiet')
  // Long enough that git recognises a move of it as a rename.
  write(dir, 'lib/flags.ts', Array.from({ length: 40 }, (_, i) => `export const f${i} = ${i}`).join('\n'))
  write(dir, 'docs/NOTES.md')
  write(dir, 'README.md')
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', 'base')
  return { dir, base: git(dir, 'rev-parse', 'HEAD') }
}

function commit(dir: string, change: () => void): void {
  change()
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', 'change')
}

/** 0 = Vercel skips the build, 1 = Vercel builds. */
function run(dir: string, prev: string | undefined): number | null {
  const env = { ...process.env }
  delete env.VERCEL_GIT_PREVIOUS_SHA
  if (prev !== undefined) env.VERCEL_GIT_PREVIOUS_SHA = prev
  return spawnSync('sh', [SCRIPT], { cwd: dir, env, encoding: 'utf8' }).status
}

for (const [label, file] of [
  ['a doc under docs/', 'docs/NOTES.md'],
  ['a test', 'tests/x.test.ts'],
  ['a scratchpad file', 'scratchpad/x.txt'],
  ['agent instructions', '.claude/skills/x/SKILL.md'],
  ['a root-level note', 'BACKLOG.md'],
]) {
  test(`skips when only ${label} changed`, () => {
    const { dir, base } = repo()
    commit(dir, () => write(dir, file, 'edited\n'))
    assert.equal(run(dir, base), 0)
  })
}

for (const [label, file] of [
  ['a site file', 'lib/flags.ts'],
  ['a markdown file outside docs/ and the root', 'lib/README.md'],
  ['an eval file the admin pages import', 'eval/extraction-goldset.json'],
  ['a public asset', 'public/robots.txt'],
  ['the Vercel config', 'vercel.json'],
  ['this script', 'scripts/vercel-ignore-build.sh'],
  ['a migration', 'supabase/migrations_v2/099_x.sql'],
]) {
  test(`builds when ${label} changed`, () => {
    const { dir, base } = repo()
    commit(dir, () => write(dir, file, 'edited\n'))
    assert.equal(run(dir, base), 1)
  })
}

test('builds when a doc change and a site change are mixed', () => {
  const { dir, base } = repo()
  commit(dir, () => {
    write(dir, 'docs/NOTES.md', 'edited\n')
    write(dir, 'app/page.tsx', 'edited\n')
  })
  assert.equal(run(dir, base), 1)
})

test('compares against the last deployed commit, not just the newest one', () => {
  // A code commit whose build Vercel cancelled, then a docs-only commit on
  // top: HEAD^..HEAD looks docs-only, but the code change never went live.
  const { dir, base } = repo()
  commit(dir, () => write(dir, 'app/page.tsx', 'edited\n'))
  commit(dir, () => write(dir, 'docs/NOTES.md', 'edited\n'))
  assert.equal(run(dir, base), 1)
})

test('builds when a site file is moved into docs/', () => {
  // Git reports a move as one path (the new one) unless renames are off,
  // which would read as docs-only and leave the site with the old file.
  const { dir, base } = repo()
  commit(dir, () => git(dir, 'mv', 'lib/flags.ts', 'docs/flags.ts'))
  assert.equal(run(dir, base), 1)
})

test('builds when Vercel gives no previous deployment', () => {
  const { dir } = repo()
  commit(dir, () => write(dir, 'docs/NOTES.md', 'edited\n'))
  assert.equal(run(dir, undefined), 1)
  assert.equal(run(dir, ''), 1)
})

test('builds when the previous commit cannot be found or fetched', () => {
  const { dir } = repo()
  commit(dir, () => write(dir, 'docs/NOTES.md', 'edited\n'))
  assert.equal(run(dir, '0123456789abcdef0123456789abcdef01234567'), 1)
})

test('builds a redeploy of the same commit', () => {
  const { dir } = repo()
  assert.equal(run(dir, git(dir, 'rev-parse', 'HEAD')), 1)
})
