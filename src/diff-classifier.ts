import parseDiff from "parse-diff";

export interface Finding {
  path: string;
  line: number;
  startLine?: number;
  body: string;
  replyTo?: string;
}

export interface ClassifiedFinding extends Finding {
  tier: 1 | 2 | 3;
  /** Body with suggestion blocks stripped for rendering. Set for tier-1 findings with oversized suggestions and all tier-2 findings containing suggestions. Original `body` is used for ID computation. Set in review-helpers.ts, not in classifyFindings. */
  renderedBody?: string;
}

/** A classified finding that targets an existing thread for reply. */
export interface ReplyFinding extends ClassifiedFinding {
  replyTo: string;
}

interface FileHunks {
  hunks: { newStart: number; newLines: number }[];
}

/**
 * Classify findings into placement tiers based on the PR diff.
 *
 * Tier 1: line-level (line within a diff hunk's new-side range)
 * Tier 2: file-level (file in diff but line not in any hunk)
 * Tier 3: review body (file not in diff)
 */
// 5MB — diffs larger than this are truncated before parsing
const MAX_DIFF_SIZE = 5 * 1024 * 1024;

export function classifyFindings(findings: Finding[], diffText: string): ClassifiedFinding[] {
  let effectiveDiff = diffText;
  if (diffText.length > MAX_DIFF_SIZE) {
    console.warn(
      `WARN: Diff size (${(diffText.length / 1024 / 1024).toFixed(1)}MB) exceeds ${MAX_DIFF_SIZE / 1024 / 1024}MB limit. Truncating — some findings may be demoted to tier 3.`,
    );
    effectiveDiff = diffText.slice(0, MAX_DIFF_SIZE);
  }
  const parsed = parseDiff(effectiveDiff);
  const fileMap = buildFileMap(parsed);

  return findings.map((finding) => {
    const file = fileMap.get(finding.path);
    if (!file) {
      return { ...finding, tier: 3 as const };
    }

    const lineInHunk = file.hunks.some((hunk) => {
      return finding.line >= hunk.newStart && finding.line < hunk.newStart + hunk.newLines;
    });

    if (lineInHunk) {
      return { ...finding, tier: 1 as const };
    }
    return { ...finding, tier: 2 as const };
  });
}

/**
 * Build a map of file path → {hunks: [{newStart, newLines}]}
 */
function buildFileMap(parsedDiff: parseDiff.File[]): Map<string, FileHunks> {
  const map = new Map<string, FileHunks>();
  for (const file of parsedDiff) {
    const filePath = file.to === "/dev/null" ? file.from : file.to;
    if (filePath === undefined || filePath === "") continue;

    const hunks = file.chunks.map((chunk) => ({
      newStart: chunk.newStart,
      newLines: chunk.newLines,
    }));

    map.set(filePath, { hunks });
  }
  return map;
}
