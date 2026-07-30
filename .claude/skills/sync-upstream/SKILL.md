---
name: sync-upstream
description: Pull new changes from upstream mechanai/deepreview (OpenCode), reconcile them into this repo's Claude Code plugin layout, and open a draft PR against iamrz1/deepreview-claude:main.
---

This is a maintainer workflow for keeping this port in sync with
[`mechanai/deepreview`](https://github.com/mechanai/deepreview). It is a **project
skill** (checked into `.claude/skills/`) so anyone who clones this repo can run
`/sync-upstream` and get the same workflow — it is not part of the plugin shipped to
end users of `/deepreview`.

Upstream has no shared git history with this repo (it was a one-time restructuring
port, not a fork), so a plain `git merge` will not work. Instead this skill tracks a
**vendor branch** (`vendor/mechanai-deepreview`) that always points at the last
upstream commit we fetched, and diffs it against the new upstream HEAD to get an
exact, clean changeset to reconcile — see `.claude/skills/sync-upstream/PATH_MAP.md`
for the file-mapping and translation rules between the two layouts.

## Preconditions

1. Working tree is clean and on `main` (`git status --porcelain` empty). If not, stop
   and tell the user — do not stash or discard their work automatically.
2. `gh auth status` succeeds (needed to push and open the PR later).

## Steps

### 1. Check for new upstream commits

Run `.claude/skills/sync-upstream/scripts/update-vendor-branch.sh`. It fetches
`mechanai/deepreview`, moves the local `vendor/mechanai-deepreview` branch to the new
HEAD, and prints:

- `STATUS=UP_TO_DATE` or `STATUS=CHANGES_AVAILABLE`
- `OLD_SHA` / `NEW_SHA`
- the upstream commit log between them
- `git diff --name-status` between them

If `STATUS=UP_TO_DATE`, report that to the user and stop — no branch or PR needed.

### 2. Create the sync branch

```
git checkout -b sync/upstream-<short-new-sha> main
```

### 3. Reconcile each changed file

Read `.claude/skills/sync-upstream/PATH_MAP.md` first. For every path in the
`git diff --name-status OLD_SHA NEW_SHA` output:

- **Direct 1:1 paths** (`.opencode/agents/*.md` → `agents/*.md`,
  `.opencode/commands/*.md` → `commands/*.md`, `src/*.ts` → `src/*.ts`): compare the
  current repo file against the file at `OLD_SHA` (`git show OLD_SHA:<upstream-path>`).
  If they match (no local drift), apply the upstream change directly — either
  overwrite with the `NEW_SHA` content, or apply the upstream diff hunk if the repo
  file has diverged and needs a manual merge instead of a blind overwrite.
- **Excluded paths** (`src/setup.ts`, `.github/*`, `.shellcheckrc`, `mise.lock`):
  skip, and note the skip (with reason) in the PR description.
- **`AGENTS.md` / `README.md`**: read the upstream diff for behavior-relevant content
  (not OpenCode-mechanics content) and fold it into the matching `README.md` section
  by hand — do not overwrite `README.md`, it has diverged structurally (Claude plugin
  install instructions, etc.).
- **`.opencode/plugins/deepreview.ts`**: translate into `mcp-server/src/index.ts`
  following the per-tool translation table in `PATH_MAP.md`. After editing, run
  `mise run build` to regenerate `mcp-server/dist/index.mjs` and include it in the
  commit — it's checked in and must stay in sync with the source.
- **Anything not covered by `PATH_MAP.md`**: do not guess a destination. Leave it
  unapplied and list it under "Needs manual attention" in the PR description. If you
  identify a durable new mapping while investigating, add it to `PATH_MAP.md` so the
  next sync doesn't have to re-derive it.

### 4. Validate

Run `mise run lint`, `mise run fmt`, and `mise run test` (or the equivalent
`bun`/`mise` scripts in `package.json`). Fix straightforward failures; if something
requires a judgment call beyond mechanical translation, leave it and flag it in the
PR description instead of guessing.

### 5. Record the new sync point

Update `.claude/skills/sync-upstream/state.json`: set `last_synced_upstream_sha` to
`NEW_SHA` and `last_synced_at` to today's date. This file must be part of the commit —
it's how the next run knows where to start from.

### 6. Commit, push, open the PR

Commit using Conventional Commits, e.g.:

```
chore(sync): reconcile upstream mechanai/deepreview@<short-new-sha>
```

Push the branch and open a **draft** PR against `iamrz1/deepreview-claude:main`:

```
gh pr create --draft --base main --head sync/upstream-<short-new-sha> \
  --title "chore(sync): reconcile upstream mechanai/deepreview@<short-new-sha>" \
  --body "..."
```

The PR body must include:

- The upstream commit log included in this sync (from step 1).
- Files reconciled automatically, and how (overwrite vs. manual merge).
- Files skipped on purpose, with the reason (per `PATH_MAP.md`).
- Anything under "Needs manual attention" from step 3, with enough detail for a
  human reviewer to finish the job — this is a draft PR precisely because layout
  translation is judgment-based and deserves a human pass before merge.

Report the PR URL back to the user when done.
