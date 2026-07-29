# deepreview (Claude Code plugin)

Multi-agent parallel code/spec review for [Claude Code](https://claude.com/claude-code). Spawns
specialized review agents, cross-validates findings, synthesizes results, and produces an
actionable implementation plan.

> [!NOTE]
> This is an independent, community port of [`mechanai/deepreview`](https://github.com/mechanai/deepreview)
> (originally built for [OpenCode](https://opencode.ai)) to the Claude Code plugin format. It is
> not an official Anthropic plugin.

## Install

Add this repository as a plugin marketplace, then install the plugin:

```
/plugin marketplace add mechanai/deepreview-claude
/plugin install deepreview@deepreview-claude
```

(While developing locally before the repo is pushed, add it by local path instead:
`/plugin marketplace add /path/to/deepreview-claude`.)

The plugin bundles its agents and commands directly — Claude Code auto-discovers them from the
plugin manifest, so no separate setup/symlink step is needed (unlike the OpenCode version).

## Usage

```
/deepreview                   # Review current branch vs main
/deepreview 123               # Review PR #123
/deepreview file1.ts file2.ts # Review specific files
/deepreview --context decisions.md   # Review with design context (suppresses known decisions)
/deepreview --full            # Force the full pipeline (skip auto-detection)

/deepreview-quick             # Abbreviated review (single-pass, 3 subagents)
/deepreview-quick 123         # Abbreviated review of PR #123

/deepreview-loop              # Review + fix loop (repeats until clean or 5 iterations)
/deepreview-loop 123          # Same, targeting a PR
/deepreview-loop --context decisions.md       # Loop with design context
/deepreview-spec-loop --context decisions.md spec.md  # Spec loop with design context

/deepreview-pr-review 123     # Review PR and post findings as a pending GitHub review
/deepreview-pr-review --prior-review findings.md 123  # Include manual prior review
/deepreview-pr-review --no-prior 123                  # Skip auto-fetching prior context from GitHub

/deepreview-spec spec.md                  # Spec-focused review (completeness, consistency, feasibility)
/deepreview-spec --context decisions.md spec.md  # Spec review with design context
/deepreview-spec-loop spec.md             # Spec review + fix loop
```

All commands accept a branch diff, PR number, or file path(s). The `-loop` variants
apply fixes automatically and re-review until no findings remain. Pauses on plateaus
(same finding persists across iterations).

For changes that are small in _effective_ size, `/deepreview` automatically uses the
abbreviated path (single-pass reviewer, ~80% fewer tokens). Effective size discounts
generated, mechanical, and snapshot churn so a large protobuf/codegen/snapshot refactor
still routes here, while a high-stakes change (auth, migrations, concurrency, public
API) always gets the full pipeline regardless of size. Use `--full` to force the full
pipeline.

## Pipeline

```mermaid
graph LR
    A[7 Reviewers] --> B[7 Validators]
    B --> C[Synthesizer]
    C --> D[Planner]
    D --> E[Applier]
```

For small effective-size changes, the abbreviated path collapses this to:

```mermaid
graph LR
    A[Quick Reviewer] --> D[Planner]
    D --> E[Applier]
```

Stages communicate via files on disk — the orchestrator never reads review content into
its own context, keeping token usage minimal.

## Calibration

deepreview learns from validator severity adjustments over time. When validators
consistently downgrade the same category of finding (e.g., "missing auth" in a
localhost-only tool), the system proposes calibration entries at the end of each
review session.

### How it works

1. **Session end:** The orchestrator compares reviewer severity to synthesized
   (post-validation) severity
2. **Proposal:** Systematic downgrades are proposed as calibration entries
3. **User confirms:** You approve, edit, or reject the proposed changes
4. **Next session:** Approved calibration is injected into reviewer prompts,
   reducing severity inflation

### Configuration

Local calibration (personal, gitignored):

```yaml
# .ai/deepreview/calibration.yml
version: 1
settings:
  expiryDays: 30 # days before unconfirmed entries expire
entries:
  - id: "cal-001"
    pattern: "missing authentication"
    context: "localhost-only server"
    originalSeverity: "warning"
    adjustedSeverity: "suggestion"
    observedCount: 4
    lastConfirmed: "2026-06-28"
    createdAt: "2026-06-01"
```

### Sharing calibration with your team

To share calibration entries, add them to `.deepreview.yml` under the `calibration:` key:

```yaml
# .deepreview.yml
threatModel: localhost-only
calibration:
  settings:
    expiryDays: 60
  entries:
    - id: "shared-001"
      pattern: "missing authentication"
      context: "localhost-only server"
      originalSeverity: "warning"
      adjustedSeverity: "suggestion"
      observedCount: 4
      lastConfirmed: "2026-06-28"
      createdAt: "2026-06-01"
```

Local entries override shared entries when both match the same `pattern` + `context`.

### Review agents

| Agent                       | Code review                            | Spec review                                  |
| --------------------------- | --------------------------------------- | --------------------------------------------- |
| correctness / completeness  | Logic bugs, edge cases, error handling  | Gaps, missing edge cases, undefined behavior  |
| security / consistency      | Vulnerabilities, threat vectors         | Contradictions, name mismatches, type drift   |
| architecture                | Patterns, coupling, complexity          | Patterns, coupling, complexity                |
| maintainability / —         | Naming, nesting, dead code, style       | —                                              |
| docs                        | Comment quality, stale claims           | Comment quality, stale claims                 |
| compatibility / feasibility | Breaking changes, API contracts         | Implicit dependencies, can it be built        |
| performance / —             | N+1 queries, leaks, hot paths           | —                                              |

## Requirements

- [Claude Code](https://claude.com/claude-code)
- [Node.js](https://nodejs.org/) >= 22 (to run the bundled MCP server)
- `git`
- `gh` CLI (only for PR commands)

## Configuration

### Verification (formatting, linting, tests)

After applying fixes, the applier agent runs formatting, linting, and tests. It auto-detects
commands based on what exists in your project root:

| File detected  | Format           | Lint                               | Test            |
| -------------- | ---------------- | ----------------------------------- | --------------- |
| `mise.toml`    | `mise run fmt`   | `mise run lint` / `mise run check`  | `mise run test` |
| `package.json` | `npm run format` | `npm run lint`                      | `npm run test`  |
| `Makefile`     | `make fmt`       | `make lint`                         | `make test`     |

If your project uses different commands (e.g., `cargo fmt`, `ruff check --fix`),
specify them in `AGENTS.md`. The applier looks for commands labeled **Format**, **Lint**, and
**Test** (or similar). For example:

```markdown
- **Format:** `cargo fmt`
- **Lint:** `cargo clippy -- -D warnings`
- **Tests:** `cargo test`
```

The applier checks `AGENTS.md` (or `CLAUDE.md`) first, falling back to auto-detection.
If no commands are found and no config files exist, verification is skipped.

When lint fails, the applier attempts to fix errors in the files it modified (up to 2 retry
cycles) before reporting the failure.

## Architecture notes (differences from the OpenCode version)

- **No setup script.** Claude Code plugins auto-discover `agents/` and `commands/` bundled in the
  plugin, so there's no equivalent of the OpenCode symlink-install step.
- **Custom tools are an MCP server**, not inline TypeScript `tool()` registrations. `mcp-server/`
  bundles the same review-routing, calibration, and GitHub-posting logic from `src/` behind five
  MCP tools (`route_diff`, `post_review`, `build_prior_review`, `calibration_load`,
  `calibration_save`), started automatically via `.mcp.json` when the plugin is enabled. The
  bundled `mcp-server/dist/index.mjs` is committed so the plugin works immediately after install
  with no build step.
- **Coarser per-agent permissions.** Claude Code restricts subagents by tool (`Read`, `Write`,
  `Edit`, `Bash`, ...), not by specific shell command pattern the way OpenCode's
  `permission.bash` allowlist did. Each agent's system prompt now states explicitly which shell
  commands it may run (e.g., "only `git log`/`git blame`/`git show`") since that's the only
  enforcement surface available — this is a norm, not a hard sandbox, so treat it as best-effort.
- **Subagent dispatch** uses the Agent tool's `subagent_type` parameter in place of OpenCode's
  Task tool `subagent_type` — functionally equivalent, same names.

## Development

This project uses [Bun](https://bun.sh/) for building and testing, and [mise](https://mise.jdx.dev/)
for task running.

```bash
bun install
mise run test
mise run lint
mise run fmt
mise run build   # rebuilds mcp-server/dist/index.mjs — commit the result
```

## License

MIT
