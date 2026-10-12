#!/bin/sh
# Vercel "Ignored Build Step" (vercel.json ignoreCommand).
# Exit 0 = skip the build, exit 1 = build.
#
# Skips a deployment only when every file changed since the last successful
# deployment of this branch is one the site never reads: docs/, tests/,
# scratchpad/, .claude/ and the notes at the repo root (*.md). Each skipped
# build is one less stored copy against the account's deployment storage.
# eval/ is NOT skipped: the admin pages import eval/*.json.
#
# Anything uncertain builds: no previous deployment, a commit missing from
# Vercel's shallow clone, a redeploy of the same commit, or a git error.

prev="$VERCEL_GIT_PREVIOUS_SHA"
[ -n "$prev" ] || exit 1

if ! git cat-file -e "$prev^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=100 origin "$prev" 2>/dev/null || exit 1
  git cat-file -e "$prev^{commit}" 2>/dev/null || exit 1
fi

changed=$(git diff --name-only "$prev" HEAD) || exit 1
# Nothing changed = a deliberate redeploy (e.g. to pick up an env var): build.
[ -n "$changed" ] || exit 1

if printf '%s\n' "$changed" | grep -qvE '^(docs/|tests/|scratchpad/|\.claude/|[^/]+\.md$)'; then
  echo "Site files changed since $prev: building."
  exit 1
fi

echo "Only docs/notes/tests changed since $prev: skipping build."
exit 0
