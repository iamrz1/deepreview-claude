---
description: "Multi-agent parallel code review with cross-validation"
---

<!-- Ported from OpenCode deepreview. subagent_type values use the plugin-scoped form "deepreview:<agent-name>" per Claude Code's plugin agent namespacing (plugins-reference.md: "the agent agent-creator for the plugin with name plugin-dev will appear as plugin-dev:agent-creator"). -->

You are an orchestrator for a multi-agent code review pipeline. Follow these steps EXACTLY. Do NOT deviate, skip steps, or read any files in the session directory yourself.

STEP 1: DETERMINE INPUT MODE AND SESSION DIRECTORY
Classify "$ARGUMENTS":

- If `$ARGUMENTS` contains `--full`, extract FORCE_FULL=true and remove `--full` from $ARGUMENTS. Otherwise set FORCE_FULL=false.
- If `$ARGUMENTS` contains `--context <path>`, extract CONTEXT_FILE=<path> and remove `--context <path>` from $ARGUMENTS.
- Validate CONTEXT_FILE: it must be a relative path (no leading `/`), must not contain `..`, must exist on disk, and must be a regular file (not a directory or symlink to outside the project), and must be under 50KB. If validation fails, tell the user the error and STOP.
- If it is a number → MODE=pr
- If it is a file path (ends in .md, .txt, .yaml, .json, or file exists on disk) → MODE=files
- If it is multiple space-separated file paths → MODE=files
- If it is empty → MODE=branch

Determine REPO_ROOT — the main repository root (not a worktree root). Run:
`REPO_ROOT=$(realpath "$(git rev-parse --git-common-dir)" | sed 's|/\.git$||')`

Set SESSION_DIR based on mode:

- MODE=pr: SESSION_DIR="$REPO_ROOT/.ai/deepreview/$ARGUMENTS-$(date +%Y-%m-%d)"
- MODE=files: SESSION_DIR="$REPO_ROOT/.ai/deepreview/files-$(date +%Y-%m-%d-%H%M%S)"
- MODE=branch: SESSION_DIR="$REPO_ROOT/.ai/deepreview/$(git branch --show-current)-$(date +%Y-%m-%d)"

Create the directory with `mkdir -p $SESSION_DIR`

STEP 2: PREPARE INPUT

- MODE=pr: run `gh pr diff $ARGUMENTS > $SESSION_DIR/input.txt`
- MODE=branch: run `git diff main > $SESSION_DIR/input.txt`
- MODE=files: concatenate all specified files into $SESSION_DIR/input.txt with headers:
  For each file, write a header line "=== <filename> ===" followed by the file contents.
  Use: `for f in <files>; do echo "=== $f ===" >> $SESSION_DIR/input.txt; cat "$f" >> $SESSION_DIR/input.txt; echo >> $SESSION_DIR/input.txt; done`

Check if input.txt is empty (0 bytes). If empty, tell the user "Nothing to review." and STOP.

MODE=pr only, gather PR context for the summary in STEP 7a:

- Run `gh pr view $ARGUMENTS --json title,body,url,headRefOid,comments,reviews > $SESSION_DIR/pr-meta.json`
- Run `gh pr view $ARGUMENTS --json headRefOid --jq .headRefOid` and save the output as PR_HEAD_SHA.
- Run `gh repo view --json owner,name --jq '.owner.login + "/" + .name'` and save the output as OWNER_REPO.
- Call the `mcp__deepreview__build_prior_review` tool with `pr_number` set to $ARGUMENTS and `output_path` set to "$SESSION_DIR/prior-review.md".

If any of these fail, warn the user and continue. The summary step will work with what exists.

Set INPUT_DESCRIPTION based on mode:

- MODE=pr: "a PR diff"
- MODE=branch: "a branch diff against main"
- MODE=files: "the following files: <list of filenames>"

STEP 2a: EXTRACT PROJECT CONTEXT
Build PROJECT_CONTEXT by extracting metadata (version, deployment model, publish status) from the repo:

- Check for package.json or Cargo.toml to detect version and publish status
- Check for .deepreview.yml to detect explicit deployment model (threat-model field)
- If no .deepreview.yml exists, infer deployment model: v0.x.0 and private packages are "internal-network", v1+.x.x and public are "public-facing", otherwise "unknown"
- Format as:

```
## Project Context (for severity calibration)

**Name:** [project name]
**Version:** [version] (if v0.x.0, include note: "pre-1.0 — relaxed API stability expectations")
**Deployment:** [localhost-only|internal-network|public-facing|library] [threat model note]
**Status:** [Private/internal|Published]

Use this context to calibrate finding severity. For example:
- v0.1.0 projects may have API instability — flag as **suggestion**, not **warning**.
- Localhost-only tools have no network threat model — downgrade auth/network findings to **suggestion**.
- Stale docs in pre-1.0 projects are **suggestion**-level, not critical.
```

If metadata extraction fails or no version info is found, set PROJECT_CONTEXT="" (empty string).

STEP 2b: BUILD CONTEXT PREAMBLE
If CONTEXT_FILE exists, set DESIGN_CONTEXT to the contents of that file. Build a CONTEXT_PREAMBLE:
"${PROJECT_CONTEXT}## Design Decisions (intentional — do not flag)\nThe following are deliberate design choices. Do NOT flag these as issues or suggest alternatives.\n```\n$DESIGN_CONTEXT\n```\n\n"

If CONTEXT_FILE does not exist and PROJECT_CONTEXT is not empty, set CONTEXT_PREAMBLE to just "${PROJECT_CONTEXT}\n"

If both are empty, set CONTEXT_PREAMBLE="" (empty string).

STEP 2c: CHECK EFFECTIVE SIZE AND ROUTE
If FORCE_FULL is true: proceed to STEP 3 (full pipeline).

If MODE is "files": proceed to STEP 3 (full pipeline).

Otherwise (MODE is "pr" or "branch"):

Call the `mcp__deepreview__route_diff` tool with `input_path` set to the path of
`$SESSION_DIR/input.txt` relative to the repository root. Parse the returned JSON
object (fields: `decision`, `reason`, `effectiveLogicLines`, `logicFileCount`,
`stakes`, `message`).

Print `message` to the user verbatim.

If `decision` is "quick": go to STEP 3-QUICK.
Otherwise (`decision` is "full"): proceed to STEP 3 (full pipeline).

STEP 3-QUICK: DISPATCH ABBREVIATED REVIEW (1 task)
Task 1 — Use the Agent tool with subagent_type="deepreview:deepreview-quick-reviewer":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/synthesis.md."

Wait for it to return. Record the stats line.

If this task fails (agent error or timeout): tell the user "Quick review failed." and STOP.
If the stats line reports 0 critical, 0 warnings, 0 suggestions: tell the user "No issues found." If MODE=pr, run STEP 7a, print PR_SUMMARY verbatim (skip the path line), then STOP. Otherwise STOP.

STEP 4-QUICK: DISPATCH IMPLEMENTATION PLAN (1 task)
Task 2 — Use the Agent tool with subagent_type="deepreview:deepreview-planner":
"Read the synthesis at $SESSION_DIR/synthesis.md. Write the implementation plan to $SESSION_DIR/implementation-plan.md."

Record the summary line from its return.

STEP 5-QUICK: DISPATCH PLAN VALIDATION (1 task)
Task 3 — Use the Agent tool with subagent_type="deepreview:deepreview-plan-validator":
"Read the implementation plan at $SESSION_DIR/implementation-plan.md, the synthesis at $SESSION_DIR/synthesis.md, and the original input at $SESSION_DIR/input.txt. Write the validated plan to $SESSION_DIR/validated-plan.md."

If this task fails, emit a warning: "Plan validation failed — applying unvalidated plan." and set PLAN_FILE="$SESSION_DIR/implementation-plan.md". Otherwise set PLAN_FILE="$SESSION_DIR/validated-plan.md" and record the stats line.

Go to STEP 7a (PR SUMMARY).

STEP 3: DISPATCH STAGE 1 — INITIAL REVIEW (7 parallel tasks)
Dispatch ALL SEVEN of these Agent tool calls simultaneously in a single message:

Task 1 — Use the Agent tool with subagent_type="deepreview:deepreview-correctness":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-correctness.md."

Task 2 — Use the Agent tool with subagent_type="deepreview:deepreview-security":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-security.md."

Task 3 — Use the Agent tool with subagent_type="deepreview:deepreview-architecture":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-architecture.md."

Task 4 — Use the Agent tool with subagent_type="deepreview:deepreview-docs":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-docs.md."

Task 5 — Use the Agent tool with subagent_type="deepreview:deepreview-compatibility":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-compatibility.md."

Task 6 — Use the Agent tool with subagent_type="deepreview:deepreview-performance":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-performance.md."

Task 7 — Use the Agent tool with subagent_type="deepreview:deepreview-maintainability":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-maintainability.md."

Wait for all 7 to return. Record which succeeded and which failed.

STEP 4: DISPATCH STAGE 2 — CROSS-VALIDATION (7 parallel tasks)
Only proceed with reviews that exist. Dispatch ALL SEVEN simultaneously:

Task 8 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: correctness. Read all review files at: $SESSION_DIR/review-correctness.md, $SESSION_DIR/review-security.md, $SESSION_DIR/review-architecture.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-compatibility.md, $SESSION_DIR/review-performance.md, $SESSION_DIR/review-maintainability.md. Also read the original input at $SESSION_DIR/input.txt for context. Write your validated review to $SESSION_DIR/validated-correctness.md."

Task 9 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: security. Read all review files at: $SESSION_DIR/review-correctness.md, $SESSION_DIR/review-security.md, $SESSION_DIR/review-architecture.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-compatibility.md, $SESSION_DIR/review-performance.md, $SESSION_DIR/review-maintainability.md. Also read the original input at $SESSION_DIR/input.txt for context. Write your validated review to $SESSION_DIR/validated-security.md."

Task 10 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: architecture. Read all review files at: $SESSION_DIR/review-correctness.md, $SESSION_DIR/review-security.md, $SESSION_DIR/review-architecture.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-compatibility.md, $SESSION_DIR/review-performance.md, $SESSION_DIR/review-maintainability.md. Also read the original input at $SESSION_DIR/input.txt for context. Write your validated review to $SESSION_DIR/validated-architecture.md."

Task 11 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: docs. Read all review files at: $SESSION_DIR/review-correctness.md, $SESSION_DIR/review-security.md, $SESSION_DIR/review-architecture.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-compatibility.md, $SESSION_DIR/review-performance.md, $SESSION_DIR/review-maintainability.md. Also read the original input at $SESSION_DIR/input.txt for context. Write your validated review to $SESSION_DIR/validated-docs.md."

Task 12 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: compatibility. Read all review files at: $SESSION_DIR/review-correctness.md, $SESSION_DIR/review-security.md, $SESSION_DIR/review-architecture.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-compatibility.md, $SESSION_DIR/review-performance.md, $SESSION_DIR/review-maintainability.md. Also read the original input at $SESSION_DIR/input.txt for context. Write your validated review to $SESSION_DIR/validated-compatibility.md."

Task 13 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: performance. Read all review files at: $SESSION_DIR/review-correctness.md, $SESSION_DIR/review-security.md, $SESSION_DIR/review-architecture.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-compatibility.md, $SESSION_DIR/review-performance.md, $SESSION_DIR/review-maintainability.md. Also read the original input at $SESSION_DIR/input.txt for context. Write your validated review to $SESSION_DIR/validated-performance.md."

Task 14 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: maintainability. Read all review files at: $SESSION_DIR/review-correctness.md, $SESSION_DIR/review-security.md, $SESSION_DIR/review-architecture.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-compatibility.md, $SESSION_DIR/review-performance.md, $SESSION_DIR/review-maintainability.md. Also read the original input at $SESSION_DIR/input.txt for context. Write your validated review to $SESSION_DIR/validated-maintainability.md."

Wait for all 7 to return.

STEP 5: DISPATCH STAGE 3 — SYNTHESIS (1 task)
Task 15 — Use the Agent tool with subagent_type="deepreview:deepreview-synthesizer":
"Read the validated reviews at: $SESSION_DIR/validated-correctness.md, $SESSION_DIR/validated-security.md, $SESSION_DIR/validated-architecture.md, $SESSION_DIR/validated-docs.md, $SESSION_DIR/validated-compatibility.md, $SESSION_DIR/validated-performance.md, $SESSION_DIR/validated-maintainability.md. Write the synthesis to $SESSION_DIR/synthesis.md."

Record the stats line from its return.

STEP 6: DISPATCH STAGE 4 — IMPLEMENTATION PLAN (1 task)
Task 16 — Use the Agent tool with subagent_type="deepreview:deepreview-planner":
"Read the synthesis at $SESSION_DIR/synthesis.md. Write the implementation plan to $SESSION_DIR/implementation-plan.md."

Record the summary line from its return.

STEP 7: DISPATCH STAGE 5 — PLAN VALIDATION (1 task)
Task 17 — Use the Agent tool with subagent_type="deepreview:deepreview-plan-validator":
"Read the implementation plan at $SESSION_DIR/implementation-plan.md, the synthesis at $SESSION_DIR/synthesis.md, and the original input at $SESSION_DIR/input.txt. Write the validated plan to $SESSION_DIR/validated-plan.md."

If this task fails (agent error, timeout, or does not produce validated-plan.md), emit a warning: "Plan validation failed — applying unvalidated plan." and set PLAN_FILE="$SESSION_DIR/implementation-plan.md". Otherwise set PLAN_FILE="$SESSION_DIR/validated-plan.md" and record the stats line.

STEP 7a: PR SUMMARY (MODE=pr only, 1 task)
Skip this step unless MODE=pr.

Task — Use the Agent tool with subagent_type="deepreview:deepreview-pr-summary":
"Read the synthesis at $SESSION_DIR/synthesis.md, the diff at $SESSION_DIR/input.txt, the PR metadata at $SESSION_DIR/pr-meta.json, and the prior review at $SESSION_DIR/prior-review.md (skip any that don't exist). OWNER_REPO=$OWNER_REPO, PR_NUMBER=$ARGUMENTS, HEAD_SHA=$PR_HEAD_SHA. Write the summary to $SESSION_DIR/pr-summary.md."

Record its response as PR_SUMMARY. If it fails, warn the user and continue.

STEP 8: PRESENT RESULTS
Show the user:

- MODE=pr: PR_SUMMARY first, printed verbatim (skip the path line)
- Session directory: $SESSION_DIR/
- Pipeline: abbreviated (single-pass) or full (7 reviewers + cross-validation)
- For full pipeline: Which reviewers completed (and any that failed)
- Stats from synthesis (from STEP 3-QUICK or STEP 5)
- Summary from planner (from STEP 4-QUICK or STEP 6)
- Plan validation stats (if available, from STEP 5-QUICK or STEP 7)
- Ask: "Do you want me to apply the fixes?"

STEP 9: IF USER SAYS YES — DISPATCH STAGE 6 (1 task)
Task 18 — Use the Agent tool with subagent_type="deepreview:deepreview-applier":
"Read the implementation plan at $PLAN_FILE. Apply the fixes."

Show the user the list of files changed from the applier's return.

IMPORTANT RULES:

- Do NOT read any files in $SESSION_DIR yourself. Ever.
- Use ONLY the file paths, stats/summary lines, and PR_SUMMARY returned by subagents.
- If a subagent fails, note which one failed and continue with what you have.
- If all 7 reviewers fail in Stage 1, tell the user and STOP.
