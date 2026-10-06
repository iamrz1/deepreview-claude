# deepreview (Claude Code plugin)

Multi-agent parallel code review for [Claude Code](https://claude.com/claude-code). Spawns
specialized review agents, cross-validates findings, synthesizes results, and produces an
actionable implementation plan.

> [!NOTE]
> Based on [`mechanai/deepreview`](https://github.com/mechanai/deepreview) by Mark Lee, built for
> [OpenCode](https://opencode.ai). Thanks to Mark for the original design and review pipeline.
> This version is maintained independently by Rezoan Tamal ([@iamrz1](https://github.com/iamrz1)) and does not
> track upstream. It is not an official Anthropic plugin.

## Install

Add this repository as a plugin marketplace, then install the plugin:

```
/plugin marketplace add iamrz1/deepreview-claude
/plugin install deepreview@deepreview-claude
```

For local development, add it by path instead: `/plugin marketplace add /path/to/deepreview-claude`.

To update after a new release: `claude plugin update deepreview@deepreview-claude`, then restart
Claude Code.

## Usage

```
/deepreview                # Review current branch vs main
/deepreview 123            # Review PR #123
/deepreview file1.ts       # Review specific files
/deepreview --quick        # Force the single-pass reviewer
/deepreview --full         # Force the full pipeline
/deepreview --loop         # Review, apply all fixes, re-review until clean (also works with a PR or files)
```

Given a PR number, `/deepreview` reads existing PR comments and review threads so it
does not repeat them. It then prints a PR summary: what the PR does, whether it does it
well (approach, correctness, and fit with the codebase), what earlier reviewers asked
for, and an issue table. Each row links to the exact line on GitHub, and rows follow the
order of GitHub's "Files changed" tab. It then asks whether to post the findings as a
pending GitHub review, apply fixes locally, or both.

Every review is shown to you before anything else happens. Before posting, deepreview
prints the exact comments and waits for a "yes". Comments are always posted as a
**pending** review. deepreview never submits it. The MCP server blocks any submit call,
so you always make the final call in the GitHub UI.

Without `--loop`, deepreview always asks before applying fixes. With `--loop`, it prints
each round's summary, applies every fix without asking, and reviews again. It stops when
no new findings appear, and asks you on deadlocks, failed lint/tests, diff growth, or
after 5 rounds. `--loop` never posts to GitHub. For a PR, check out its branch first.

For changes that are small in _effective_ size, `/deepreview` automatically uses the
abbreviated path (single-pass reviewer, ~80% fewer tokens). Effective size discounts
generated, mechanical, and snapshot churn so a large protobuf/codegen/snapshot refactor
still routes here, while a high-stakes change (auth, migrations, concurrency, public
API) always gets the full pipeline regardless of size. Use `--full` or `--quick` to
override the choice.

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
`--loop` run. Calibration is loaded and learned in `--loop` runs only.

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

| Agent           | Focus                                  |
| --------------- | -------------------------------------- |
| correctness     | Logic bugs, edge cases, error handling |
| security        | Vulnerabilities, threat vectors        |
| architecture    | Patterns, coupling, complexity         |
| maintainability | Naming, nesting, dead code, style      |
| docs            | Comment quality, stale claims          |
| compatibility   | Breaking changes, API contracts        |
| performance     | N+1 queries, leaks, hot paths          |

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
| -------------- | ---------------- | ---------------------------------- | --------------- |
| `mise.toml`    | `mise run fmt`   | `mise run lint` / `mise run check` | `mise run test` |
| `package.json` | `npm run format` | `npm run lint`                     | `npm run test`  |
| `Makefile`     | `make fmt`       | `make lint`                        | `make test`     |

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

## Architecture

- **Command and agents.** Claude Code discovers `commands/` and `agents/` from the plugin
  manifest. The orchestrator in `commands/deepreview.md` dispatches agents with the Agent
  tool's `subagent_type` (`deepreview:<agent-name>`).
- **MCP server.** `mcp-server/` exposes the logic in `src/` as five MCP tools (`route_diff`,
  `post_review`, `build_prior_review`, `calibration_load`, `calibration_save`), started via
  `.mcp.json` when the plugin is enabled. The bundle `mcp-server/dist/index.mjs` is committed so
  the plugin works with no build step.
- **Agent permissions.** Claude Code limits subagents by tool (`Read`, `Write`, `Edit`, `Bash`),
  not by shell command. Each agent's prompt states which commands it may run. This is a norm,
  not a sandbox.

## Development

This project uses [Bun](https://bun.sh/) for building and testing, and [mise](https://mise.jdx.dev/)
for task running.

```bash
bun install
mise run test
mise run lint
mise run fmt
mise run build   # rebuilds mcp-server/dist/index.mjs — commit the result
mise run reinstall  # rebuild, then reinstall the plugin into Claude Code (restart after)
```

## License

MIT
