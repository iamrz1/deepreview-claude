/** Line-level placement requested when creating a review thread. */
export interface RequestedPlacement {
  line: number;
  startLine: number | undefined;
}

/** Placement GitHub actually applied, read back from the created thread. */
export interface ActualPlacement {
  /** Thread subject type reported by GitHub (e.g. "LINE" or "FILE"). */
  subjectType: string;
  /** New-side line of the thread's first comment, or null if unavailable. */
  line: number | null;
  startLine: number | null;
}

/**
 * Detect when GitHub silently changed a requested line-level thread placement.
 *
 * GitHub accepts `addPullRequestReviewThread` for lines outside the diff without
 * erroring, promoting the thread to file-level (or repositioning the anchor). This
 * compares the requested placement against the thread GitHub actually created.
 *
 * @returns a human-readable reason string when a promotion/reposition occurred,
 *          or `null` when the requested line-level placement was honored.
 */
export function detectLinePromotion(
  requested: RequestedPlacement,
  actual: ActualPlacement,
): string | null {
  if (actual.subjectType.toUpperCase() !== "LINE") {
    return `requested line ${requested.line} but GitHub created a file-level thread (subjectType=${actual.subjectType}) — the line is not part of the diff`;
  }
  // Trust the LINE subject when GitHub does not report a concrete comment line.
  if (actual.line === null) return null;
  if (actual.line !== requested.line) {
    return `requested line ${requested.line} but GitHub anchored the thread to line ${actual.line}`;
  }
  return null;
}
