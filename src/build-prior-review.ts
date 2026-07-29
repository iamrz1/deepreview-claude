import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getPrInfo } from "./graphql.ts";

import { fetchPrReviewThreads, mapGraphQLThreads } from "./build-prior-review-fetch.ts";
export { fetchPrReviewThreads, mapGraphQLThreads };

/** A single comment within a review thread. */
export interface ThreadComment {
  authorLogin: string;
  authorType: "human" | "bot" | "deepreview";
  body: string;
  createdAt: string;
}

/** A review thread attached to a file path and line range. */
export interface ReviewThread {
  id: string;
  path: string;
  startLine: number | null;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ThreadComment[];
}

const MAX_BYTES = 50 * 1024;

function formatLineRef(startLine: number | null, line: number | null): string {
  if (startLine !== null && line !== null && startLine !== line) {
    return `**L${startLine}-${line}**`;
  }
  if (line !== null) return `**L${line}**`;
  if (startLine !== null) return `**L${startLine}**`;
  return "**file-level**";
}

function formatSourceTag(comment: ThreadComment, thread: ReviewThread): string {
  const parts = [`@${comment.authorLogin}`, comment.authorType];
  if (thread.isResolved) parts.push("resolved");
  if (thread.isOutdated) parts.push("outdated");
  return `[source: ${parts.join(", ")}]`;
}

function formatCommentBody(body: string, indent: string): string {
  if (!body.includes("\n")) return `"${body}"`;
  const lines = body.split("\n").map((line) => `${indent}> ${line}`);
  return "\n" + lines.join("\n");
}

function formatThread(thread: ReviewThread): string {
  if (thread.comments.length === 0) return "";
  const first = thread.comments[0];
  const replies = thread.comments.slice(1);
  const lines: string[] = [];
  const lineRef = formatLineRef(thread.startLine, thread.line);
  const tag = formatSourceTag(first, thread);
  const threadTag = `[thread: ${thread.id}]`;
  lines.push(`- ${lineRef} ${tag} ${threadTag}: ${formatCommentBody(first.body, "  ")}`);
  for (const reply of replies) {
    lines.push(`  - @${reply.authorLogin} replied: ${formatCommentBody(reply.body, "    ")}`);
  }
  return lines.join("\n");
}

function formatFixedSections(prBody: string, manualContent: string | null): string[] {
  const sections: string[] = [];
  if (prBody.trim()) {
    sections.push(`## PR Description\n\n${prBody.trim()}`);
  }
  if (manualContent !== null && manualContent.trim() !== "") {
    sections.push(`## Manual Prior Review\n\n${manualContent.trim()}`);
  }
  return sections;
}

/** Format threads and PR context into a Markdown document grouped by file path. */
export function formatPriorReview(
  prBody: string,
  threads: ReviewThread[],
  manualContent: string | null,
): string {
  const sections: string[] = formatFixedSections(prBody, manualContent);

  if (threads.length > 0) {
    const sorted = [...threads].sort((a, b) => {
      const pathCmp = a.path.localeCompare(b.path);
      if (pathCmp !== 0) return pathCmp;
      return (a.line ?? a.startLine ?? 0) - (b.line ?? b.startLine ?? 0);
    });

    const byFile = new Map<string, ReviewThread[]>();
    for (const t of sorted) {
      const existing = byFile.get(t.path);
      if (existing) existing.push(t);
      else byFile.set(t.path, [t]);
    }

    const fileSections: string[] = [];
    for (const [filePath, fileThreads] of byFile) {
      const threadLines = fileThreads.map(formatThread).filter(Boolean);
      if (threadLines.length > 0) {
        fileSections.push(`### ${filePath}\n\n${threadLines.join("\n")}`);
      }
    }

    if (fileSections.length > 0) {
      // Insert review comments before manual section
      const insertIdx = sections.findIndex((s) => s.startsWith("## Manual Prior Review"));
      if (insertIdx >= 0) {
        sections.splice(insertIdx, 0, `## Prior Review Comments\n\n${fileSections.join("\n\n")}`);
      } else {
        sections.push(`## Prior Review Comments\n\n${fileSections.join("\n\n")}`);
      }
    }
  }

  return sections.join("\n\n");
}

/** Truncate content to fit within a byte-length budget using binary search. */
export function truncateToFit(content: string, maxBytes: number = MAX_BYTES): string {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength <= maxBytes) return content;

  // Binary search for the right character count
  let lo = 0;
  let hi = content.length;
  const suffix = "\n\n[truncated — content exceeds size limit]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const target = maxBytes - suffixBytes;

  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(content.slice(0, mid), "utf8") <= target) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return content.slice(0, lo) + suffix;
}

function newestCommentTimestamp(thread: ReviewThread): string {
  if (thread.comments.length === 0) return "1970-01-01T00:00:00Z";
  return thread.comments[thread.comments.length - 1].createdAt;
}

/**
 * Assemble a prior-review document with priority-aware truncation.
 * PR description and manual content are always kept; oldest threads are dropped first.
 */
export function buildPriorReviewContent(
  prBody: string,
  threads: ReviewThread[],
  manualContent: string | null,
): string {
  if (
    !prBody.trim() &&
    threads.length === 0 &&
    (manualContent === null || manualContent.trim() === "")
  ) {
    return "";
  }

  const fixedSections = formatFixedSections(prBody, manualContent);
  const fixedContent = fixedSections.join("\n\n");

  if (threads.length === 0) {
    return truncateToFit(fixedContent, MAX_BYTES);
  }

  // Newest threads are retained first; oldest dropped when over budget
  const sortedByRecency = [...threads].sort((a, b) =>
    newestCommentTimestamp(b).localeCompare(newestCommentTimestamp(a)),
  );

  // Estimate bytes per thread (formatThread + file header overhead).
  // truncateToFit is the safety net if our estimate is slightly off.
  const fixedBytes = Buffer.byteLength(fixedContent, "utf8");
  const separator = "\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const sectionHeaderBytes = Buffer.byteLength("## Prior Review Comments\n\n", "utf8");
  let budgetRemaining =
    MAX_BYTES - fixedBytes - (fixedContent ? separatorBytes : 0) - sectionHeaderBytes;

  const keptThreads: ReviewThread[] = [];
  const seenPaths = new Set<string>();
  for (const thread of sortedByRecency) {
    const threadText = formatThread(thread);
    const fileHeaderBytes = seenPaths.has(thread.path)
      ? 0
      : Buffer.byteLength(`### ${thread.path}\n\n`, "utf8");
    const threadBytes = Buffer.byteLength(threadText, "utf8") + fileHeaderBytes + separatorBytes;
    if (threadBytes <= budgetRemaining) {
      keptThreads.push(thread);
      seenPaths.add(thread.path);
      budgetRemaining -= threadBytes;
    }
  }

  const result = formatPriorReview(prBody, keptThreads, manualContent);
  return truncateToFit(result, MAX_BYTES);
}

export interface BuildPriorReviewOptions {
  /** PR number to fetch context from. */
  prNumber: number;
  /** Path to write the generated prior-review file. */
  outputPath: string;
  /** Path to a user-provided prior-review file to merge in. */
  manualPriorReview?: string;
  /** Working directory for path resolution and `gh` commands. */
  cwd?: string;
}

/** Fetch PR context from GitHub, format it, and write the prior-review file. */
export async function buildPriorReview(opts: BuildPriorReviewOptions): Promise<string> {
  const { prNumber, outputPath, manualPriorReview } = opts;
  const cwd = opts.cwd ?? process.cwd();

  const prInfo = await getPrInfo(prNumber, { cwd });
  const { prBody, threads } = await fetchPrReviewThreads(prInfo.owner, prInfo.name, prNumber);

  let manualContent: string | null = null;
  if (manualPriorReview !== undefined) {
    manualContent = await readFile(resolve(cwd, manualPriorReview), "utf8");
  }

  const content = buildPriorReviewContent(prBody, threads, manualContent);
  await writeFile(resolve(cwd, outputPath), content, "utf8");

  if (content === "") {
    return `No prior review content found. Written empty file to ${outputPath}.`;
  }

  const bytes = Buffer.byteLength(content, "utf8");
  const kb = (bytes / 1024).toFixed(1);
  const uniqueAuthors = new Set(threads.flatMap((t) => t.comments.map((c) => c.authorLogin)));
  const parts: string[] = [];
  if (prBody.trim()) parts.push("PR description");
  if (threads.length > 0)
    parts.push(`${threads.length} threads from ${uniqueAuthors.size} reviewers`);
  if (manualContent !== null) parts.push("manual prior review");

  return `Built prior review: ${kb}KB (${parts.join(" + ")}). Written to ${outputPath}.`;
}
