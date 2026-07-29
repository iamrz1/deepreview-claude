---
description: "Run deepreview in a loop: review, apply fixes, re-review until clean"
---

<!-- Ported from OpenCode deepreview. subagent_type values use the plugin-scoped form "deepreview:<agent-name>" per Claude Code's plugin agent namespacing (plugins-reference.md: "the agent agent-creator for the plugin with name plugin-dev will appear as plugin-dev:agent-creator"). The "general" helper subagent below is mapped to Claude Code's built-in "general-purpose" agent type, which is NOT plugin-scoped. -->

You are an orchestrator that runs deepreview repeatedly until the code is clean. Follow these steps EXACTLY.

STEP 1: DETERMINE INPUT MODE
Parse "$ARGUMENTS" the same way as /deepreview:

- If it starts with `--context <path>`, extract CONTEXT_FILE=<path> and remove it from $ARGUMENTS before parsing the rest.
- Validate `CONTEXT_FILE`: it must be a relative path (no leading `/`), must not contain `..`, must exist on disk, and must be a regular file (not a directory or symlink to outside the project), and must be under 50KB. If validation fails, tell the user the error and STOP.
  _(Canonical source for `CONTEXT_FILE` validation rules. Keep `deepreview.md`, `deepreview-spec.md`, and `deepreview-spec-loop.md` in sync.)_
- If it is a number → MODE=pr, TARGET="$ARGUMENTS"
- If it is a file path or multiple file paths → MODE=files, TARGET="$ARGUMENTS"
- If it is empty → MODE=branch, TARGET=""

Set ITERATION=1
Set PRIOR_CONTEXT="" (empty — built up across iterations; holds both design context and prior findings)
Set CONSECUTIVE_ZERO_NEW=0 (tracks consecutive iterations with 0 new findings for deadlock detection)
Set ALL_SESSION_DIRS=[] (list of all session directories used, in order)
Set EXPIRED_ENTRIES=[] (calibration entries that have expired — collected at start, used at end)

Determine REPO_ROOT — the main repository root (not a worktree root). Run:
`REPO_ROOT=$(realpath "$(git rev-parse --git-common-dir)" | sed 's|/\.git$||')`

Extract PROJECT_CONTEXT by detecting project metadata (version, deployment model, publish status):

- Check for package.json or Cargo.toml to detect version and publish status
- Check for .deepreview.yml to detect explicit deployment model (threatModel field)
- If no .deepreview.yml exists, infer deployment model: v0.x.0 and private packages are "internal-network", v1+.x.x and public are "public-facing", otherwise "unknown"
- Format as a calibration preamble with version info, deployment model, and guidance for severity adjustment
- If metadata extraction fails or no version info is found, set PROJECT_CONTEXT="" (empty string)

Load learned calibration by calling the `mcp__deepreview__calibration_load` tool (no arguments needed — it uses the working directory). Parse the JSON response:

- If `preamble` is non-empty, append it to PROJECT_CONTEXT (after the static calibration guidelines)
- If `expired` is non-empty, store EXPIRED_ENTRIES for end-of-session prompting
- If the tool fails or returns empty, proceed without calibration (do not STOP)

Build PRIOR_CONTEXT:

- Start with PROJECT_CONTEXT (if non-empty)
- If CONTEXT_FILE exists, append:
  "## Design Decisions (intentional — do not flag)\nThe following are deliberate design choices. Do NOT flag these as issues or suggest alternatives.\n```\n" + contents of CONTEXT_FILE + "\n```\n"
- If neither PROJECT_CONTEXT nor CONTEXT_FILE exist, set PRIOR_CONTEXT="" (empty string)

STEP 2: RUN INITIAL DEEPREVIEW (full pipeline with cross-validation)
Run the full deepreview pipeline (Stages 1-5 from the deepreview command):

- Determine SESSION_DIR=`$REPO_ROOT/.ai/deepreview/loop-iter$ITERATION-$(date +%Y-%m-%d-%H%M%S)` and write input.txt
- Append SESSION_DIR to ALL_SESSION_DIRS
- Stage 1: 7 parallel reviewers — prepend PRIOR_CONTEXT (if non-empty) to each reviewer's prompt as "${PRIOR_CONTEXT}You are reviewing ... Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-{perspective}.md."
- Stage 2: 7 parallel validators (cross-validation)
  - Note: validators do NOT receive PRIOR_CONTEXT. This is intentional — validators independently verify reviewer claims without being influenced by design context.
- Stage 3: Synthesizer
- Stage 4: Implementation planner
- Stage 5: Plan validator — dispatch plan-validator with implementation-plan.md, synthesis.md, and input.txt.
  If it fails, warn and set PLAN_FILE="$SESSION_DIR/implementation-plan.md".
  Otherwise set PLAN_FILE="$SESSION_DIR/validated-plan.md".

Record the stats from the synthesis return: count of critical, warning, and suggestion findings.

STEP 3: CHECK EXIT CONDITION

Parse the stats line from the synthesizer. If it contains novelty metrics (the `| N new, N recurring, N regression` suffix), use NOVELTY MODE. Otherwise use LEGACY MODE.

NOVELTY MODE (iter2+ only):

A) CONVERGENCE EXIT: If `0 new AND 0 regression`:

- Tell the user: "deepreview-loop converged after $ITERATION iteration(s). No new findings detected."
- Go to STEP 6 (calibration proposal), then STOP.

B) DEADLOCK (synthesizer signal): If `0 new AND N recurring (N > 0) AND 0 regression` for 2 consecutive iterations:

- Tell the user: "Deadlock detected: $N recurring findings persist with no new issues found across 2 iterations:"
- List the recurring findings from the synthesis.
- Ask: "How would you like to resolve these? Options: skip these findings, provide guidance, or stop the loop."
- Follow the user's instruction.

C) DEADLOCK (orchestrator fallback): Compare this iteration's findings (file:line + issue title) against the previous iteration's findings. If they match BUT the synthesizer did NOT signal deadlock (i.e., it classified some as [NEW]):

- Log warning: "Note: deterministic check found matching findings, but synthesizer classified them as new. Trusting synthesizer classification."
- Do NOT trigger deadlock. Continue.

D) Otherwise: proceed to STEP 4.

Tracking: If `0 new`, increment CONSECUTIVE_ZERO_NEW. If `> 0 new`, reset CONSECUTIVE_ZERO_NEW to 0. Deadlock (B) triggers when CONSECUTIVE_ZERO_NEW >= 2 AND recurring > 0.

LEGACY MODE (fallback when synthesizer omits novelty metrics):

Warn the user: "Synthesizer did not return novelty metrics — falling back to legacy convergence detection."

DEADLOCK CHECK (iter 2+ only):
Compare this iteration's findings (file:line + issue title) against the previous iteration's findings. If two consecutive iterations produce the SAME findings:

- Tell the user: "Deadlock detected: the following findings persist across iterations:"
- List the repeated findings.
- Ask: "How would you like to resolve these? Options: skip these findings, provide guidance, or stop the loop."
- Follow the user's instruction.

If the synthesis/review has 0 critical AND 0 warning AND 0 suggestion findings:

- Tell the user: "deepreview-loop complete after $ITERATION iteration(s). No findings remain."
- Go to STEP 6 (calibration proposal), then STOP.

STEP 4: APPLY ALL FIXES
Dispatch the applier automatically — do NOT ask the user for permission.
Use the Agent tool with subagent_type="deepreview:deepreview-applier":
"Read the implementation plan at $PLAN_FILE. Apply the fixes."

Wait for the applier to return. Parse the applier's response for VERIFICATION status.

STEP 4b: HANDLE VERIFICATION RESULTS
If the applier reports VERIFICATION: FAIL:

- Show the user the error summary from the applier's response
- Ask: "Applied fixes failed verification (lint/test). Options: revert and skip failing fix, continue anyway, or stop?"
- If revert:
  1. Run `git checkout -- .` to undo all changes from this iteration.
  2. Note which fix failed, add it to a SKIP_LIST, and re-run the planner without that fix, writing to `$SESSION_DIR/implementation-plan-retry.md`.
  3. Dispatch plan-validator — Use the Agent tool with subagent_type="deepreview:deepreview-plan-validator":
     "Read the implementation plan at $SESSION_DIR/implementation-plan-retry.md, the synthesis at $SESSION_DIR/synthesis.md, and the original input at $SESSION_DIR/input.txt. Write the validated plan to $SESSION_DIR/validated-plan.md. Note: the following findings were intentionally excluded due to verification failures: [SKIP_LIST]"
      If it fails, set PLAN_FILE="$SESSION_DIR/implementation-plan-retry.md".
     Otherwise set PLAN_FILE="$SESSION_DIR/validated-plan.md".
  4. Pass PLAN_FILE to the applier.
- If continue: proceed to STEP 5 (the next iteration's reviewers will likely catch the introduced error).
- If stop: STOP.

If the applier reports VERIFICATION: PASS (or no verification was possible): proceed to STEP 5.

STEP 5: INCREMENT AND RE-REVIEW
Set ITERATION = ITERATION + 1

If ITERATION > 5:

- Tell the user: "deepreviewloop hit iteration limit (5). Remaining findings may require manual intervention or a design decision."
- Show the latest stats.
- Ask the user: "Continue for more iterations, or stop here?"
- If user says stop → Go to STEP 6 (calibration proposal), then STOP.
- If user says continue → reset limit to ITERATION + 5 and proceed.

Create new session directory: SESSION_DIR="$REPO_ROOT/.ai/deepreview/loop-iter$ITERATION-$(date +%Y-%m-%d-%H%M%S)"
Run `mkdir -p $SESSION_DIR`
Append SESSION_DIR to ALL_SESSION_DIRS

Prepare fresh input:

- MODE=pr or MODE=branch: run `git diff main > $SESSION_DIR/input.txt`
- MODE=files: re-read the same files into `$SESSION_DIR/input.txt`

Check if input.txt is empty. If empty, tell user "Nothing to review — all changes resolved." and STOP.

STEP 5a: DIFF SIZE DIVERGENCE CHECK
Compare the size of the new input.txt to the previous iteration's input.txt (in bytes or lines).
If the new input is more than 50% larger than the previous iteration's input:

- Tell the user: "Divergence warning: diff grew from ~N to ~M lines (X% increase). The applier may be adding more code than it's fixing."
- Ask: "Continue with the larger diff, or revert last iteration's changes?"
- If revert: run `git checkout -- .`, STOP.
- If continue: proceed.

STEP 5b: BUILD PRIOR CONTEXT
Accumulate findings from ALL previous iterations into PRIOR_CONTEXT so no finding is re-reported.

To build this, dispatch a helper task that reads ALL previous syntheses AND implementation plans:
NOTE: Interpolate the actual directory paths from ALL_SESSION_DIRS into this task string — the subagent cannot access your variables.
Task — Use the Agent tool with subagent_type="general-purpose":
"Read the synthesis files AND implementation plan files from these directories: [LIST EACH PATH FROM ALL_SESSION_DIRS EXCLUDING CURRENT]. If any file does not exist, skip it. Extract:

## Prior Findings (already reported — do not re-report or verify)

For each finding, include the title, category, location, AND a 1-sentence mechanism description explaining what the underlying problem is:

- [Short Issue Title] ([category]) — [file:line] — [1-sentence description of the underlying mechanism/problem]

Example:

- Missing semaphore guard (architecture) — src/module.rs:245 — concurrent operations share mutable state without synchronization

## Known Issue Locations (same file:line = likely same issue — justify if reporting again)

List every file:line from Prior Findings in a condensed location-first index:

- [file:line] — [condensed mechanism] ([category])

## Applied Fixes (changes made by previous iterations — new bugs here are regressions)

- [Fix title from implementation plan] — [file:line] (applied in iter N)

## Covered Regions (already examined — prioritize elsewhere)

- [file:line-range] (pad each finding's file:line by 20 lines in each direction)

Deduplicate findings that appear in multiple syntheses. Return ONLY these four sections, nothing else."

Set PRIOR_CONTEXT to the returned text. Validate that it contains "## Prior Findings" — if not, warn the user ("Helper returned malformed prior context — proceeding without deduplication") and set PRIOR_CONTEXT="". If CONTEXT_FILE exists, prepend:
"## Design Decisions (intentional — do not flag)\nThe following are deliberate design choices. Do NOT flag these as issues or suggest alternatives.\n```\n" + contents of CONTEXT_FILE + "\n```\n\n"

STEP 5c: RUN REVIEW WITH CROSS-VALIDATION

Stage 1 — DISPATCH 7 PARALLEL REVIEWERS:
Each reviewer prompt MUST include PRIOR_CONTEXT and the novelty-seeking framing below.

The REVIEWER_PREAMBLE for all iter2+ reviewers is:
"Your goal is to find issues that PREVIOUS reviewers missed. Do NOT re-report, verify, or comment on prior findings.

When you encounter a potential issue:

1. Check "Known Issue Locations" — if your finding is at or near a listed location, it is almost certainly already reported. Only report it if the mechanism is genuinely different (not just differently worded).
2. Check "Prior Findings" — if your finding matches an existing mechanism description (even at a different location), it is a variant of an already-reported issue. Do not report it.

If you find a bug in code listed under 'Applied Fixes', flag it as a regression.

$PRIOR_CONTEXT

Find genuinely new issues. You may find different issues in covered regions, but prioritize areas not yet examined."

Task 1 — Use the Agent tool with subagent_type="deepreview:deepreview-correctness":
"$REVIEWER_PREAMBLE

Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-correctness.md."

Task 2 — Use the Agent tool with subagent_type="deepreview:deepreview-security":
"$REVIEWER_PREAMBLE

Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-security.md."

Task 3 — Use the Agent tool with subagent_type="deepreview:deepreview-architecture":
"$REVIEWER_PREAMBLE

Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-architecture.md."

Task 4 — Use the Agent tool with subagent_type="deepreview:deepreview-docs":
"$REVIEWER_PREAMBLE

Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-docs.md."

Task 5 — Use the Agent tool with subagent_type="deepreview:deepreview-compatibility":
"$REVIEWER_PREAMBLE

Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-compatibility.md."

Task 6 — Use the Agent tool with subagent_type="deepreview:deepreview-performance":
"$REVIEWER_PREAMBLE

Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-performance.md."

Task 7 — Use the Agent tool with subagent_type="deepreview:deepreview-maintainability":
"$REVIEWER_PREAMBLE

Read the content at $SESSION_DIR/input.txt. Write your review to $SESSION_DIR/review-maintainability.md."

Wait for all 7. Record which succeeded.

STEP 5d: VERIFY REVIEWER OUTPUT
Check how many review files were actually written. Run: `ls $SESSION_DIR/review-*.md 2>/dev/null | wc -l`

- If 0 files exist: Tell the user "All reviewers failed to produce output. This usually means the diff is too large for subagent context windows or there was an infrastructure failure." STOP.
- If 1-2 files exist: Warn the user "Only N/7 reviewers produced output. Proceeding with partial results." Continue with what exists.
- If 3+ files exist: Proceed normally.

Stage 2 — DISPATCH 7 PARALLEL VALIDATORS (cross-validation):
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

Stage 3 — DISPATCH SYNTHESIZER:
Extract PRIOR_FINDINGS_SECTION from PRIOR_CONTEXT: include only the "## Prior Findings" and "## Applied Fixes" sections (not "Known Issue Locations" or "Covered Regions" — those are for reviewers only).

If PRIOR_FINDINGS_SECTION is non-empty, include the novelty classification header in the synthesizer prompt. If empty (helper returned malformed context), omit the header — the synthesizer will operate in standard mode and the orchestrator MUST use LEGACY MODE for this iteration's exit check.

Task 15 — Use the Agent tool with subagent_type="deepreview:deepreview-synthesizer":

- If PRIOR_FINDINGS_SECTION is non-empty:
  "## Prior Findings for Novelty Classification
  $PRIOR_FINDINGS_SECTION

  Read the validated reviews at: $SESSION_DIR/validated-correctness.md, $SESSION_DIR/validated-security.md, $SESSION_DIR/validated-architecture.md, $SESSION_DIR/validated-docs.md, $SESSION_DIR/validated-compatibility.md, $SESSION_DIR/validated-performance.md, $SESSION_DIR/validated-maintainability.md (skip any that don't exist). Write the synthesis to $SESSION_DIR/synthesis.md."

- If PRIOR_FINDINGS_SECTION is empty:
  "Read the validated reviews at: $SESSION_DIR/validated-correctness.md, $SESSION_DIR/validated-security.md, $SESSION_DIR/validated-architecture.md, $SESSION_DIR/validated-docs.md, $SESSION_DIR/validated-compatibility.md, $SESSION_DIR/validated-performance.md, $SESSION_DIR/validated-maintainability.md (skip any that don't exist). Write the synthesis to $SESSION_DIR/synthesis.md."

Record the stats line.

Stage 4 — DISPATCH PLANNER:
Task 16 — Use the Agent tool with subagent_type="deepreview:deepreview-planner":
"Read the synthesis at $SESSION_DIR/synthesis.md. Write the implementation plan to $SESSION_DIR/implementation-plan.md."

Record the summary line.

Stage 5 — DISPATCH PLAN VALIDATOR:
Task 17 — Use the Agent tool with subagent_type="deepreview:deepreview-plan-validator":
"Read the implementation plan at $SESSION_DIR/implementation-plan.md, the synthesis at $SESSION_DIR/synthesis.md, and the original input at $SESSION_DIR/input.txt. Write the validated plan to $SESSION_DIR/validated-plan.md."

If this task fails, emit a warning: "Plan validation failed — applying unvalidated plan." and set PLAN_FILE="$SESSION_DIR/implementation-plan.md". Otherwise set PLAN_FILE="$SESSION_DIR/validated-plan.md" and record the stats line.

Go to STEP 3.

STEP 6: PROPOSE CALIBRATION UPDATES (runs after any exit — clean exit, deadlock, or iteration limit)

Skip this step if ITERATION == 1 AND the exit was a clean exit (0 findings on first pass means nothing to calibrate).

Compare reviewer severity to synthesized severity from the LAST completed iteration:

1. Read the reviewer files ($SESSION_DIR/review-\*.md) from the last iteration
2. Read the synthesis file ($SESSION_DIR/synthesis.md) from the last iteration
3. For each finding in the synthesis, identify if ANY reviewer originally flagged it at a HIGHER severity
4. Only consider DOWNGRADES (reviewer said "critical" or "warning", synthesis says lower)

For each detected downgrade pattern:

- Check if it matches an existing calibration entry (from EXPIRED_ENTRIES or active entries loaded at start)
  - If yes: increment observedCount, set lastConfirmed to today
  - If new: create a proposed entry with observedCount=1

If there are proposed updates (new or incremented entries) OR expired entries to remove:

- Call `mcp__deepreview__calibration_load` to get current entries
- Present to user:

```
Calibration update proposed:

- NEW: "[pattern]" in [context]: [originalSeverity] → [adjustedSeverity]
- UPDATED: "[pattern]" in [context]: observed N→N+1, re-confirmed
- EXPIRED: "[pattern]" (last confirmed N days ago) — will be removed

Accept these changes? [y/n/edit]
```

- If user approves: merge proposed entries with existing active entries (removing expired ones), then call `mcp__deepreview__calibration_save` with the merged entries
- If user says "edit": let them modify the proposal, then save
- If user rejects: skip saving

If no adjustments were detected and no entries expired, skip this step silently.

IMPORTANT RULES:

- Do NOT read any review/synthesis/plan files yourself during STEPS 1-5. Exception: STEP 6 (calibration proposal) requires reading reviewer and synthesis files to detect severity adjustments.
- Use ONLY the file paths and stats/summary lines returned by subagents (during STEPS 1-5).
- Apply ALL findings (critical, warning, AND suggestion) — the goal is a clean review.
- Do NOT ask the user for permission to apply fixes. Apply automatically.
- DO ask the user if: iteration limit is hit, deadlock is detected, verification fails, or diff size diverges.
- Iteration 2+ MUST include cross-validation, MUST include PRIOR_CONTEXT, and MUST use novelty-seeking framing.
- Iteration 2+ MUST NOT tell reviewers to "verify" or "check status of" prior findings.
- Each iteration uses a NEW session directory — never reuse a previous one.
- If --context file is provided, include its contents under "Design Decisions" in PRIOR_CONTEXT for ALL iterations (including iter1).
- If all reviewers produce zero output files, STOP immediately — do not continue to synthesis.
