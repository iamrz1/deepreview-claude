# Upstream path map (mechanai/deepreview → deepreview-claude)

This repo is a restructured port, not a git-history fork: upstream targets OpenCode,
this repo targets the Claude Code plugin format. There is no shared git history, so
changes can't be `git merge`d — they have to be mapped and reconciled file by file.
Verified against upstream `df147af0b4354d43aa80cc75c2c68a129c5db1b2` (2026-07-22).

Update this file whenever the reconcile step discovers a new path or a mapping stops
holding — it's the thing that saves the next sync from re-deriving all of this.

## Direct 1:1 mappings (same filename, same content model)

| Upstream path | This repo | Notes |
|---|---|---|
| `.opencode/agents/*.md` | `agents/*.md` | Same filenames. Frontmatter dialect may still differ slightly (OpenCode agent config vs Claude Code agent config) — check the frontmatter block, not just the body, before overwriting wholesale. |
| `.opencode/commands/*.md` | `commands/*.md` | Same filenames. Same frontmatter caveat as agents. |
| `src/*.ts` / `src/*.test.ts` | `src/*.ts` / `src/*.test.ts` | Platform-agnostic review logic, shared verbatim in most cases. If the repo file has no local drift from the old upstream content, a direct overwrite with the new upstream content is safe. |

## Local-only additions (no upstream counterpart)

Keep these when reconciling. Do not delete them because upstream lacks them.

| This repo | Notes |
|---|---|
| `agents/deepreview-summary.md` | Final review summary (description, assessment, issue table, GitHub links for PRs). |
| `commands/deepreview.md` | Local rework. `/deepreview <PR#>` absorbed upstream's `/deepreview-pr-review`: prior-review flags and fetch, `pr-meta.json`, the summary (STEP 7a, all modes), the post/apply choice (STEPs 8-10), and the preview + "yes" before posting. Do not overwrite this file from upstream. Merge upstream changes into it by hand. |
| STEP 5a in `commands/deepreview-quick.md` | Dispatches `deepreview-summary` and prints it. Re-apply after overwriting from upstream. |
| `src/review-guard.ts`, `src/review-guard.test.ts`, and its call in `src/graphql.ts` | Blocks any GraphQL call that would submit a PR review. Keep the call in `graphql()` when taking upstream changes to `src/graphql.ts`. |

## Merged on purpose (upstream file → where it lives here)

| Upstream path | This repo |
|---|---|
| `.opencode/commands/deepreview-pr-review.md` | PR mode of `commands/deepreview.md`. Port upstream changes there. Do not recreate the file. |

## Excluded on purpose (do not port)

| Upstream path | Why excluded |
|---|---|
| `src/setup.ts`, `src/setup.test.ts` | OpenCode-specific install/symlink step. The plugin manifest (`.claude-plugin/`) makes this unnecessary in Claude Code — see README's "no separate setup/symlink step" note. |
| `.github/workflows/*`, `.github/scripts/*` | Upstream's npm/OpenCode release pipeline. This repo publishes via the Claude Code plugin marketplace instead. |
| `.shellcheckrc`, `mise.lock` | No shell scripts to lint here; lockfile intentionally not vendored. |
| `AGENTS.md` (root) | OpenCode-specific contributor doc. If its *content* changes in a way that reflects a real behavior change (not OpenCode mechanics), fold that into `README.md`'s relevant section instead of copying the file. |

## Structural translation (not 1:1 — needs judgment)

`.opencode/plugins/deepreview.ts` (OpenCode plugin, `@opencode-ai/plugin`) →
`mcp-server/src/index.ts` (MCP server, `@modelcontextprotocol/sdk`).

Both files are thin wiring layers over the same `src/*.ts` logic, registering one
tool per exported capability. The translation rule per tool entry:

| OpenCode plugin | MCP server |
|---|---|
| `tool: { "deepreview-<name>": tool({ description, args, execute }) }` | `server.registerTool("<name>", { description, inputSchema }, handler)` — tool id drops the `deepreview-` prefix and is snake_case (e.g. `deepreview-post-review` → `post_review`; Claude Code itself re-adds a plugin-scoped prefix at call time, e.g. `mcp__plugin_deepreview_deepreview__post_review`). |
| `args: { x: tool.schema.string()... }` | `inputSchema: { x: z.string()... }` — same shape, different schema builder (`tool.schema.*` vs `z.*` from `zod`). |
| `async execute(args, context) { ...; return summaryString }` | `async (args) => { ...; return textResult(summaryString) }` — wrap success in `textResult()`, replace `context.directory` with `process.cwd()`. |
| `throw err` on failure | `return errorResult(err)` (sets `isError: true` instead of throwing) — MCP tools report errors in-band, not via exceptions. |

When upstream adds a new `deepreview-<name>` tool or changes an existing one's
`args`/`description`/`execute` body, add or update the matching `registerTool` block
in `mcp-server/src/index.ts` following this table, then re-run `mise run build` to
regenerate `mcp-server/dist/index.mjs` (checked in, must stay in sync with `src/index.ts`).

## Unrecognized paths

If a diff touches a path not covered above (new top-level directory, renamed file,
etc.), do not guess a destination. Call it out explicitly in the PR description under
"Needs manual attention" and leave the corresponding repo-side change undone rather
than fabricating a mapping.
