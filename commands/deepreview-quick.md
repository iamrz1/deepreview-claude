---
description: "Token-efficient single-pass code review for small diffs"
---

<!-- Ported from OpenCode deepreview. subagent_type values use the plugin-scoped form "deepreview:<agent-name>" per Claude Code's plugin agent namespacing (plugins-reference.md: "the agent agent-creator for the plugin with name plugin-dev will appear as plugin-dev:agent-creator"). -->

You are an orchestrator for a token-efficient code review pipeline. This uses a single combined reviewer instead of the full 7-reviewer + cross-validation pipeline. Follow these steps EXACTLY. Do NOT deviate, skip steps, or read any files in the session directory yourself.

This is the standalone abbreviated review command. See also `/deepreview` which auto-routes small diffs here.

STEP 1: DETERMINE INPUT MODE AND SESSION DIRECTORY
Classify "$ARGUMENTS":

- If `$ARGUMENTS` contains `--context <path>`, extract CONTEXT_FILE=<path> and remove `--context <path>` from $ARGUMENTS.
- Validate CONTEXT_FILE: it must be a relative path (no leading `/`), must not contain `..`, must exist on disk, and must be a regular file (not a directory or symlink to outside the project), and must be under 50KB. If validation fails, tell the user the error and STOP.
- If it is a number → MODE=pr
- If it is a file path (ends in .md, .txt, .yaml, .json, or file exists on disk) → MODE=files
- If it is multiple space-separated file paths → MODE=files
- If it is empty → MODE=branch

Determine REPO_ROOT — the main repository root (not a worktree root). Run:
`REPO_ROOT=$(realpath "$(git rev-parse --git-common-dir)" | sed 's|/\.git$||')`

Set SESSION_DIR="$REPO_ROOT/.ai/deepreview/quick-$(date +%Y-%m-%d-%H%M%S)"
Create the directory with `mkdir -p $SESSION_DIR`

STEP 2: PREPARE INPUT

- MODE=pr: run `gh pr diff $ARGUMENTS > $SESSION_DIR/input.txt`
- MODE=branch: run `git diff main > $SESSION_DIR/input.txt`
- MODE=files: concatenate all specified files into $SESSION_DIR/input.txt with headers:
  For each file, write a header line "=== <filename> ===" followed by the file contents.
  Use: `for f in <files>; do echo "=== $f ===" >> $SESSION_DIR/input.txt; cat "$f" >> $SESSION_DIR/input.txt; echo >> $SESSION_DIR/input.txt; done`

Check if input.txt is empty (0 bytes). If empty, tell the user "Nothing to review." and STOP.

Set INPUT_DESCRIPTION based on mode:

- MODE=pr: "a PR diff"
- MODE=branch: "a branch diff against main"
- MODE=files: "the following files: <list of filenames>"

STEP 2a: EXTRACT PROJECT CONTEXT
Build PROJECT_CONTEXT by extracting metadata (version, deployment model, publish status) from the repo:

- Check for package.json or Cargo.toml to detect version and publish status
- Check for .deepreview.yml to detect explicit deployment model (threat-model field)
- If no .deepreview.yml exists, infer deployment model: v0.x.0 and private packages are "internal-network", v1+.x.x and public are "public-facing", otherwise "unknown"
- Format as a calibration preamble (same format as /deepreview)

If metadata extraction fails or no version info is found, set PROJECT_CONTEXT="" (empty string).

STEP 2b: BUILD CONTEXT PREAMBLE
If CONTEXT_FILE exists, set DESIGN_CONTEXT to the contents of that file. Build a CONTEXT_PREAMBLE:
"${PROJECT_CONTEXT}## Design Decisions (intentional — do not flag)\nThe following are deliberate design choices. Do NOT flag these as issues or suggest alternatives.\n```\n$DESIGN_CONTEXT\n```\n\n"

If CONTEXT_FILE does not exist and PROJECT_CONTEXT is not empty, set CONTEXT_PREAMBLE to just "${PROJECT_CONTEXT}\n"

If both are empty, set CONTEXT_PREAMBLE="" (empty string).

STEP 3: DISPATCH STAGE 1 — QUICK REVIEW (1 task)
Task 1 — Use the Agent tool with subagent_type="deepreview:deepreview-quick-reviewer":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/synthesis.md."

Wait for it to return. Record the stats line.

If this task fails (agent error or timeout): tell the user "Quick review failed." and STOP.
If the stats line reports 0 critical, 0 warnings, 0 suggestions: tell the user "No issues found." and STOP.

STEP 4: DISPATCH STAGE 2 — IMPLEMENTATION PLAN (1 task)
Task 2 — Use the Agent tool with subagent_type="deepreview:deepreview-planner":
"Read the synthesis at $SESSION_DIR/synthesis.md. Write the implementation plan to $SESSION_DIR/implementation-plan.md."

Record the summary line from its return.

STEP 5: DISPATCH STAGE 3 — PLAN VALIDATION (1 task)
Task 3 — Use the Agent tool with subagent_type="deepreview:deepreview-plan-validator":
"Read the implementation plan at $SESSION_DIR/implementation-plan.md, the synthesis at $SESSION_DIR/synthesis.md, and the original input at $SESSION_DIR/input.txt. Write the validated plan to $SESSION_DIR/validated-plan.md."

If this task fails (agent error, timeout, or does not produce validated-plan.md), emit a warning: "Plan validation failed — applying unvalidated plan." and set PLAN_FILE="$SESSION_DIR/implementation-plan.md". Otherwise set PLAN_FILE="$SESSION_DIR/validated-plan.md" and record the stats line.

STEP 5a: SUMMARY (1 task)
Use the Agent tool with subagent_type="deepreview:deepreview-summary":
"The input is $INPUT_DESCRIPTION. Read the synthesis at $SESSION_DIR/synthesis.md and the input at $SESSION_DIR/input.txt. Write the summary to $SESSION_DIR/summary.md."

Record its response as SUMMARY. If it fails, warn the user and continue.

STEP 6: PRESENT RESULTS
Always show the review before asking anything. Show the user:

- SUMMARY, printed verbatim (skip the path line)
- Session directory: $SESSION_DIR/
- Pipeline: abbreviated (single-pass reviewer)
- Stats from quick review (from Step 3)
- Summary from planner (from Step 4)
- Plan validation stats (if available, from Step 5)
- Ask: "Do you want me to apply the fixes?"

STEP 7: IF USER SAYS YES — DISPATCH APPLIER (1 task)
Task 4 — Use the Agent tool with subagent_type="deepreview:deepreview-applier":
"Read the implementation plan at $PLAN_FILE. Apply the fixes."

Show the user the list of files changed from the applier's return.

IMPORTANT RULES:

- Do NOT read any files in $SESSION_DIR yourself. Ever.
- Use ONLY the file paths, stats/summary lines, and SUMMARY returned by subagents.
- If a subagent fails, note which one failed and continue with what you have.
