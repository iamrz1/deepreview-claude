---
description: "Multi-agent parallel spec/plan review with cross-validation"
---

<!-- Ported from OpenCode deepreview. subagent_type values use the plugin-scoped form "deepreview:<agent-name>" per Claude Code's plugin agent namespacing (plugins-reference.md: "the agent agent-creator for the plugin with name plugin-dev will appear as plugin-dev:agent-creator"). -->

You are an orchestrator for a multi-agent spec/plan review pipeline. Follow these steps EXACTLY. Do NOT deviate, skip steps, or read any files in the session directory yourself.

STEP 1: DETERMINE SESSION DIRECTORY

- If "$ARGUMENTS" starts with `--context <path>`, extract CONTEXT_FILE=<path> and remove it from $ARGUMENTS before parsing the rest.
- Validate CONTEXT_FILE: it must be a relative path (no leading `/`), must not contain `..`, must exist on disk, and must be a regular file (not a directory or symlink to outside the project), and must be under 50KB. If validation fails, tell the user the error and STOP.
- Determine REPO_ROOT — the main repository root (not a worktree root). Run:
  `REPO_ROOT=$(realpath "$(git rev-parse --git-common-dir)" | sed 's|/\.git$||')`
- Set SESSION_DIR="$REPO_ROOT/.ai/deepreview/spec-$(date +%Y-%m-%d-%H%M%S)"
- Create the directory with `mkdir -p $SESSION_DIR`

STEP 2: PREPARE INPUT

- If remaining "$ARGUMENTS" is empty, tell the user "Usage: /deepreview-spec [--context <file>] <file1> [file2 ...]" and STOP.
- Concatenate all specified files into $SESSION_DIR/input.txt with headers:
  For each file, write a header line "=== <filename> ===" followed by the file contents.
  Use: `for f in $ARGUMENTS; do echo "=== $f ===" >> $SESSION_DIR/input.txt; cat "$f" >> $SESSION_DIR/input.txt; echo >> $SESSION_DIR/input.txt; done`
- Check if input.txt is empty (0 bytes). If empty, tell the user "Files are empty — nothing to review." and STOP.

Set INPUT_DESCRIPTION="the following spec/plan files: $ARGUMENTS"

Extract PROJECT_CONTEXT by detecting project metadata (version, deployment model, publish status):

- Check for package.json or Cargo.toml to detect version and publish status
- Check for .deepreview.yml to detect explicit deployment model (threatModel field)
- If no .deepreview.yml exists, infer deployment model: v0.x.0 and private packages are "internal-network", v1+.x.x and public are "public-facing", otherwise "unknown"
- Format as a calibration preamble with version info, deployment model, and guidance for severity adjustment
- If metadata extraction fails or no version info is found, set PROJECT_CONTEXT="" (empty string)

Build CONTEXT_PREAMBLE:
If PROJECT_CONTEXT is not empty, start with: "${PROJECT_CONTEXT}\n"

If CONTEXT_FILE exists, append:
"## Design Decisions (intentional — do not flag)\nThe following are deliberate design choices. Do NOT flag these as issues or suggest alternatives.\n```\n$DESIGN_CONTEXT\n```\n\n"

If both PROJECT_CONTEXT and CONTEXT_FILE are empty, set CONTEXT_PREAMBLE="" (empty string).

STEP 3: DISPATCH STAGE 1 — INITIAL REVIEW (5 parallel tasks)
Dispatch ALL FIVE of these Agent tool calls simultaneously in a single message:

Task 1 — Use the Agent tool with subagent_type="deepreview:deepreview-spec-completeness":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-completeness.md."

Task 2 — Use the Agent tool with subagent_type="deepreview:deepreview-spec-consistency":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-consistency.md."

Task 3 — Use the Agent tool with subagent_type="deepreview:deepreview-spec-feasibility":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-feasibility.md."

Task 4 — Use the Agent tool with subagent_type="deepreview:deepreview-docs":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-docs.md."

Task 5 — Use the Agent tool with subagent_type="deepreview:deepreview-architecture":
"${CONTEXT_PREAMBLE}You are reviewing $INPUT_DESCRIPTION. Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-architecture.md."

Wait for all 5 to return. Record which succeeded and which failed.

STEP 4: DISPATCH STAGE 2 — CROSS-VALIDATION (5 parallel tasks)
Only proceed with reviews that exist. Dispatch ALL FIVE simultaneously:

Task 6 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: completeness. Read all review files at: $SESSION_DIR/review-completeness.md, $SESSION_DIR/review-consistency.md, $SESSION_DIR/review-feasibility.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-architecture.md. Write your validated review to $SESSION_DIR/validated-completeness.md."

Task 7 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: consistency. Read all review files at: $SESSION_DIR/review-completeness.md, $SESSION_DIR/review-consistency.md, $SESSION_DIR/review-feasibility.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-architecture.md. Write your validated review to $SESSION_DIR/validated-consistency.md."

Task 8 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: feasibility. Read all review files at: $SESSION_DIR/review-completeness.md, $SESSION_DIR/review-consistency.md, $SESSION_DIR/review-feasibility.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-architecture.md. Write your validated review to $SESSION_DIR/validated-feasibility.md."

Task 9 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: docs. Read all review files at: $SESSION_DIR/review-completeness.md, $SESSION_DIR/review-consistency.md, $SESSION_DIR/review-feasibility.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-architecture.md. Write your validated review to $SESSION_DIR/validated-docs.md."

Task 10 — Use the Agent tool with subagent_type="deepreview:deepreview-validator":
"Your perspective: architecture. Read all review files at: $SESSION_DIR/review-completeness.md, $SESSION_DIR/review-consistency.md, $SESSION_DIR/review-feasibility.md, $SESSION_DIR/review-docs.md, $SESSION_DIR/review-architecture.md. Write your validated review to $SESSION_DIR/validated-architecture.md."

Wait for all 5 to return.

STEP 5: DISPATCH STAGE 3 — SYNTHESIS (1 task)
Task 11 — Use the Agent tool with subagent_type="deepreview:deepreview-synthesizer":
"Read the validated reviews at: $SESSION_DIR/validated-completeness.md, $SESSION_DIR/validated-consistency.md, $SESSION_DIR/validated-feasibility.md, $SESSION_DIR/validated-docs.md, $SESSION_DIR/validated-architecture.md. Write the synthesis to $SESSION_DIR/synthesis.md."

Record the stats line from its return.

STEP 6: DISPATCH STAGE 4 — IMPLEMENTATION PLAN (1 task)
Task 12 — Use the Agent tool with subagent_type="deepreview:deepreview-planner":
"Read the synthesis at $SESSION_DIR/synthesis.md. The original input is a spec/plan document, not code. Write an implementation plan that describes what changes to make to the spec/plan document itself (not code changes). Write to $SESSION_DIR/implementation-plan.md."

Record the summary line from its return.

STEP 7: DISPATCH STAGE 5 — PLAN VALIDATION (1 task)
Task 13 — Use the Agent tool with subagent_type="deepreview:deepreview-plan-validator":
"Read the implementation plan at $SESSION_DIR/implementation-plan.md, the synthesis at $SESSION_DIR/synthesis.md, and the original input at $SESSION_DIR/input.txt. Write the validated plan to $SESSION_DIR/validated-plan.md."

If this task fails (agent error, timeout, or does not produce validated-plan.md), emit a warning: "Plan validation failed — applying unvalidated plan." and set PLAN_FILE="$SESSION_DIR/implementation-plan.md". Otherwise set PLAN_FILE="$SESSION_DIR/validated-plan.md" and record the stats line.

STEP 8: PRESENT RESULTS
Show the user:

- Session directory: $SESSION_DIR/
- Which reviewers completed (and any that failed)
- Stats from synthesis (the stats line from Step 5)
- Summary from planner (the summary line from Step 6)
- Plan validation stats (if available, from Step 7)
- Ask: "Do you want me to apply the fixes to the spec?"

STEP 9: IF USER SAYS YES — DISPATCH STAGE 6 (1 task)
Task 14 — Use the Agent tool with subagent_type="deepreview:deepreview-applier":
"Read the implementation plan at $PLAN_FILE. Apply the fixes."

Show the user the list of files changed from the applier's return.

IMPORTANT RULES:

- Do NOT read any files in $SESSION_DIR yourself. Ever.
- Use ONLY the file paths and stats/summary lines returned by subagents.
- If a subagent fails, note which one failed and continue with what you have.
- If all 5 reviewers fail in Stage 1, tell the user and STOP.
