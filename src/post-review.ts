import { type ClassifiedFinding, type ReplyFinding } from "./diff-classifier.ts";
import { type PrInfo, execFileAsync } from "./graphql.ts";
import {
  type PendingReview,
  findPendingReview,
  createPendingReview,
  updateReviewBody,
  addLineThread,
  addFileThread,
  updateReviewComment,
  replyToThread,
} from "./review-api.ts";
import {
  findingId,
  embedFindingId,
  extractFindingId,
  buildReviewBody,
  classifyAndLog,
} from "./review-helpers.ts";
import { mapBatch, withRateLimitRetry } from "./batch-retry.ts";
import { loadAndValidatePr } from "./load-pr.ts";
import { detectLinePromotion } from "./thread-placement.ts";

export interface PostReviewOptions {
  threadsPath: string;
  prNumber: number;
  dryRun?: boolean;
  skipIds?: string[];
  expectedSha?: string;
  cwd?: string;
  diffText?: string;
}

export interface PostReviewResult {
  summary: string;
  failed: string[];
}

const MAX_INLINE_FINDINGS = 200;

async function updateExistingThreads(
  existingReview: PendingReview,
  findings: ClassifiedFinding[],
): Promise<Set<string>> {
  const existingComments = existingReview.comments.nodes;
  const existingById = new Map<string, { id: string; body: string }>();
  for (const c of existingComments) {
    const id = extractFindingId(c.body);
    if (id !== null) existingById.set(id, c);
  }

  const toUpdate: Array<{ finding: ClassifiedFinding; commentId: string; id: string }> = [];
  for (const f of findings) {
    const id = findingId(f.path, f.startLine, f.line, f.body);
    const existing = existingById.get(id);
    if (existing) {
      toUpdate.push({ finding: f, commentId: existing.id, id });
    }
  }

  await mapBatch(toUpdate, async ({ finding, commentId, id }) => {
    const body = embedFindingId(finding.renderedBody ?? finding.body, id);
    await updateReviewComment(commentId, body);
  });

  console.log(`Updated ${toUpdate.length} existing threads.`);
  return new Set(toUpdate.map(({ id }) => id));
}

async function postThread(
  reviewId: string,
  finding: ClassifiedFinding,
  body: string,
): Promise<void> {
  if (finding.tier === 1) {
    const placement = await addLineThread(
      reviewId,
      finding.path,
      finding.line,
      finding.startLine,
      body,
    );
    const reason = detectLinePromotion(
      { line: finding.line, startLine: finding.startLine },
      placement,
    );
    if (reason !== null) {
      // Throw so withRateLimitRetry records this finding as failed rather than
      // silently reporting a line-level thread that GitHub did not honor.
      throw new Error(`${finding.path}: ${reason}`);
    }
  } else {
    await addFileThread(reviewId, finding.path, body);
  }
}

async function postWithRetry(
  reviewId: string,
  finding: ClassifiedFinding,
  body: string,
): Promise<boolean> {
  return withRateLimitRetry(
    async () => postThread(reviewId, finding, body),
    `${finding.path}:${finding.line}`,
  );
}

async function postInlineThreads(
  reviewId: string,
  inlineFindings: ClassifiedFinding[],
  updatedIds: Set<string>,
  maxThreads: number = MAX_INLINE_FINDINGS,
): Promise<string[]> {
  const pending = inlineFindings.filter(
    (f) => !updatedIds.has(findingId(f.path, f.startLine, f.line, f.body)),
  );

  if (pending.length > maxThreads) {
    console.warn(
      `WARN: ${pending.length} inline findings exceed limit of ${maxThreads}. Truncating.`,
    );
  }
  const capped = pending.slice(0, maxThreads);

  const results = await mapBatch(capped, async (f) => {
    const id = findingId(f.path, f.startLine, f.line, f.body);
    const body = embedFindingId(f.renderedBody ?? f.body, id);
    const ok = await postWithRetry(reviewId, f, body);
    return ok ? null : id;
  });
  return results.filter((id): id is string => id !== null);
}

async function postReplyThreads(
  replyFindings: ReplyFinding[],
  reviewId: string,
  inlineBudgetRemaining: number,
): Promise<{ failedIds: string[]; fallbackCount: number }> {
  let fallbackCount = 0;
  const results = await mapBatch(replyFindings, async (f) => {
    const id = findingId(f.path, f.startLine, f.line, f.body);
    const body = embedFindingId(f.renderedBody ?? f.body, id);
    const replied = await withRateLimitRetry(
      async () => replyToThread(f.replyTo, body),
      `reply to ${f.replyTo}`,
    );
    if (replied) return null;
    // Fallback: post as new thread, subject to inline cap
    if (fallbackCount >= inlineBudgetRemaining) {
      console.warn(
        `WARN: Reply to thread ${f.replyTo} failed. Inline cap reached — skipping fallback.`,
      );
      return id;
    }
    console.warn(`WARN: Reply to thread ${f.replyTo} failed. Falling back to new thread.`);
    fallbackCount++;
    const ok = await postWithRetry(reviewId, f, body);
    return ok ? null : id;
  });
  return { failedIds: results.filter((id): id is string => id !== null), fallbackCount };
}

async function ensureReview(
  prNodeId: string,
  headOid: string,
  tier1: ClassifiedFinding[],
  tier2: ClassifiedFinding[],
  tier3: ClassifiedFinding[],
  owner: string,
  name: string,
  summary?: string,
): Promise<{ reviewId: string; updatedFindings: Set<string> }> {
  const existingReview = await findPendingReview(prNodeId);
  if (existingReview) {
    console.log(`Found existing pending review: ${existingReview.id}`);
    await updateReviewBody(
      existingReview.id,
      buildReviewBody(tier3, owner, name, headOid, summary),
    );
    const updated = await updateExistingThreads(existingReview, [...tier1, ...tier2]);
    return { reviewId: existingReview.id, updatedFindings: updated };
  }
  const reviewId = await createPendingReview(
    prNodeId,
    headOid,
    buildReviewBody(tier3, owner, name, headOid, summary),
  );
  console.log(`Created pending review: ${reviewId}`);
  return { reviewId, updatedFindings: new Set() };
}

interface StatusCounts {
  posted: number;
  total: number;
  replies: number;
  upToDate: number;
  skipped: number;
  failed: number;
  truncated: number;
  tier3Count: number;
}

function formatStatusSummary(counts: StatusCounts): string {
  const parts: string[] = [];
  if (counts.replies > 0) parts.push(`${counts.replies} replies`);
  if (counts.upToDate > 0) parts.push(`${counts.upToDate} up-to-date`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.truncated > 0) parts.push(`${counts.truncated} truncated`);
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return (
    `Posted ${counts.posted}/${counts.total} inline threads${detail}. ` +
    `${counts.tier3Count} findings in review body.`
  );
}

// oxlint-disable-next-line max-lines-per-function -- Why: orchestration function that coordinates reply/new posting and computes stats; splitting further would fragment the logic
async function postFindings(
  tier1: ClassifiedFinding[],
  tier2: ClassifiedFinding[],
  tier3: ClassifiedFinding[],
  prInfo: PrInfo,
  skipIds: string[],
  summary?: string,
): Promise<PostReviewResult> {
  const { owner, name, prNodeId, headOid } = prInfo;
  const { reviewId, updatedFindings } = await ensureReview(
    prNodeId,
    headOid,
    tier1,
    tier2,
    tier3,
    owner,
    name,
    summary,
  );

  const skipSet = new Set(skipIds);
  const allInline = [...tier1, ...tier2].filter((f) => {
    const id = findingId(f.path, f.startLine, f.line, f.body);
    return !skipSet.has(id);
  });

  // Split into reply findings and new findings
  const replyFindings = allInline.filter(
    (f): f is ReplyFinding =>
      f.replyTo !== undefined &&
      !updatedFindings.has(findingId(f.path, f.startLine, f.line, f.body)),
  );
  const newFindings = allInline.filter((f) => f.replyTo === undefined);

  // Post replies first (fallbacks count against inline cap)
  const inlineBudget = MAX_INLINE_FINDINGS;
  const { failedIds: replyFailedIds, fallbackCount } = await postReplyThreads(
    replyFindings,
    reviewId,
    inlineBudget,
  );

  // Post new threads with remaining budget after reply fallbacks
  const newFailedIds = await postInlineThreads(
    reviewId,
    newFindings,
    updatedFindings,
    inlineBudget - fallbackCount,
  );

  const failedIds = [...replyFailedIds, ...newFailedIds];
  const skipped = newFindings.filter((f) =>
    updatedFindings.has(findingId(f.path, f.startLine, f.line, f.body)),
  ).length;
  const pendingNew = newFindings.length - skipped;
  const postedNew = Math.min(pendingNew, inlineBudget - fallbackCount) - newFailedIds.length;
  const postedReplies = replyFindings.length - replyFailedIds.length;
  const totalFindings = [...tier1, ...tier2].length;
  const truncated = Math.max(0, pendingNew - (inlineBudget - fallbackCount));

  const statusSummary = formatStatusSummary({
    posted: postedNew + postedReplies,
    total: totalFindings,
    replies: postedReplies,
    upToDate: skipped,
    skipped: totalFindings - allInline.length,
    failed: failedIds.length,
    truncated,
    tier3Count: tier3.length,
  });

  console.log(statusSummary);
  return { summary: statusSummary, failed: failedIds };
}

export async function postReview(opts: PostReviewOptions): Promise<PostReviewResult> {
  const { threadsPath, prNumber, dryRun = false, skipIds = [], expectedSha } = opts;

  const result = await loadAndValidatePr(threadsPath, prNumber, expectedSha, opts.cwd);
  if (!result) return { summary: "No findings to post.", failed: [] };

  const { findings, prInfo, summary: reviewSummary } = result;

  const diff =
    opts.diffText ??
    (
      await execFileAsync("gh", ["pr", "diff", String(prNumber)], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        signal: AbortSignal.timeout(30_000),
        cwd: opts.cwd,
      })
    ).stdout;
  const { tier1, tier2, tier3 } = classifyAndLog(findings, diff);

  if (dryRun) {
    const replyCount = findings.filter((f) => f.replyTo !== undefined).length;
    const parts = [
      `${tier1.length} line-level`,
      `${tier2.length} file-level`,
      `${tier3.length} review-body`,
    ];
    if (replyCount > 0) parts.push(`${replyCount} replies`);
    return {
      summary: `Dry run: ${parts.join(", ")} findings.`,
      failed: [],
    };
  }

  return postFindings(tier1, tier2, tier3, prInfo, skipIds, reviewSummary);
}
