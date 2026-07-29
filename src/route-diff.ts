import parseDiff from "parse-diff";

export type Category = "generated" | "test" | "mechanical" | "data-config" | "logic";

export interface FileBreakdown {
  path: string;
  category: Category;
  changedLines: number;
  weightedLines: number;
}

export const CATEGORY_WEIGHTS: Record<Category, number> = {
  generated: 0,
  mechanical: 0,
  "data-config": 0.25,
  test: 0.5,
  logic: 1.0,
};

const GENERATED_MARKER = /@generated|Code generated .* DO NOT EDIT/u;

const GENERATED_FILENAME =
  /(\.pb\.(go|ts|js)|_grpc\.pb\.go|\.connect\.go|_pb2\.py|_pb2_grpc\.py|\.twirp\.go)$/u;

const GENERATED_SNAPSHOT = /((^|\/)__snapshots__\/|\.snap$|\.golden$|(^|\/)testdata\/)/u;

const LOCKFILE =
  /(^|\/)(go\.sum|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|stencil\.lock|jsonnetfile\.lock\.json)$|\.lock$/u;

const TEST_PATH =
  /(_test\.go$|\.spec\.[^/]+$|\.test\.[^/]+$|(^|\/)__tests__\/|(^|\/)test\/|(^|\/)spec\/)/u;

const DATA_CONFIG = /\.(json|ya?ml|toml|tf|jsonnet)$/u;

const IMPORT_LINE = /^\s*(import|from|use|require|#include)\b/u;

/** True only if every non-blank changed line is an import/use/require line. */
function isImportOnly(added: string[], removed: string[]): boolean {
  const changed = [...added, ...removed].filter((l) => l.trim() !== "");
  if (changed.length === 0) return false;
  return changed.every((l) => IMPORT_LINE.test(l));
}

export function categorizeFile(
  path: string,
  addedLines: string[],
  removedLines: string[],
  contextLines: string[],
): Category {
  const allText = [...addedLines, ...contextLines];
  if (GENERATED_FILENAME.test(path) || LOCKFILE.test(path) || GENERATED_SNAPSHOT.test(path))
    return "generated";
  if (allText.some((l) => GENERATED_MARKER.test(l))) return "generated";
  if (TEST_PATH.test(path)) return "test";
  if (isImportOnly(addedLines, removedLines)) return "mechanical";
  if (DATA_CONFIG.test(path)) return "data-config";
  return "logic";
}

export function computeBreakdown(diffText: string): FileBreakdown[] {
  const parsed = parseDiff(diffText);
  const result: FileBreakdown[] = [];
  for (const file of parsed) {
    const path = file.to === "/dev/null" ? file.from : file.to;
    if (path === undefined || path === "") continue;

    const added: string[] = [];
    const removed: string[] = [];
    const context: string[] = [];
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === "add") added.push(change.content.slice(1));
        else if (change.type === "del") removed.push(change.content.slice(1));
        else context.push(change.content.slice(1));
      }
    }
    const category = categorizeFile(path, added, removed, context);
    const changedLines = added.length + removed.length;
    result.push({
      path,
      category,
      changedLines,
      weightedLines: changedLines * CATEGORY_WEIGHTS[category],
    });
  }
  return result;
}

export interface StakesHit {
  path: string;
  reasons: string[];
}

const STAKES_SIGNALS: { reason: string; path?: RegExp; line?: RegExp }[] = [
  {
    reason: "auth",
    path: /(auth|credential|token|secret|password|oauth|crypto|signing)/iu,
    line: /(auth|credential|token|secret|password|oauth|scram|\bTLS\b|\bIAM\b|crypto|encrypt|decrypt|signing)/u,
  },
  {
    reason: "migration",
    path: /((^|\/)migrations\/|\.sql$)/u,
    line: /(CREATE INDEX|ALTER TABLE|DROP\b|invalidateCache|cache\.Invalidate)/u,
  },
  {
    reason: "concurrency",
    line: /(go func|sync\.|<-|Mutex|WaitGroup|atomic\.)/u,
  },
  {
    reason: "public-contract",
    path: /\.proto$/u,
  },
];

export function detectStakes(diffText: string): StakesHit[] {
  const breakdown = computeBreakdown(diffText);
  const eligible = new Set(
    breakdown
      .filter((f) => f.category === "logic" || f.category === "data-config")
      .map((f) => f.path),
  );
  const parsed = parseDiff(diffText);
  const hits: StakesHit[] = [];

  for (const file of parsed) {
    const path = file.to === "/dev/null" ? file.from : file.to;
    if (path === undefined || path === "" || !eligible.has(path)) continue;

    const changedText = file.chunks
      .flatMap((c) => c.changes)
      .filter((ch) => ch.type === "add" || ch.type === "del")
      .map((ch) => ch.content.slice(1))
      .join("\n");

    const reasons: string[] = [];
    for (const sig of STAKES_SIGNALS) {
      const pathHit = sig.path?.test(path) ?? false;
      const lineHit = sig.line?.test(changedText) ?? false;
      if (pathHit || lineHit) reasons.push(sig.reason);
    }
    if (reasons.length > 0) hits.push({ path, reasons });
  }
  return hits;
}

export const EFFECTIVE_SIZE_THRESHOLD = 150;
export const MAX_LOGIC_FILES = 10;

export interface RouteResult {
  decision: "quick" | "full";
  reason: "stakes" | "effective-size" | "logic-file-count" | "small";
  effectiveLogicLines: number;
  logicFileCount: number;
  stakes: { hit: boolean; hits: StakesHit[] };
  breakdown: FileBreakdown[];
  message: string;
}

export function routeDiff(diffText: string): RouteResult {
  const breakdown = computeBreakdown(diffText);
  const stakesHits = detectStakes(diffText);
  const effectiveLogicLines = breakdown.reduce((sum, f) => sum + f.weightedLines, 0);
  const logicFileCount = breakdown.filter((f) => f.category === "logic").length;
  const stakes = { hit: stakesHits.length > 0, hits: stakesHits };

  let decision: RouteResult["decision"];
  let reason: RouteResult["reason"];
  if (stakes.hit) {
    decision = "full";
    reason = "stakes";
  } else if (effectiveLogicLines <= EFFECTIVE_SIZE_THRESHOLD && logicFileCount <= MAX_LOGIC_FILES) {
    decision = "quick";
    reason = "small";
  } else if (logicFileCount > MAX_LOGIC_FILES) {
    decision = "full";
    reason = "logic-file-count";
  } else {
    decision = "full";
    reason = "effective-size";
  }

  return {
    decision,
    reason,
    effectiveLogicLines,
    logicFileCount,
    stakes,
    breakdown,
    message: buildMessage(decision, reason, effectiveLogicLines, breakdown, stakesHits),
  };
}

function buildMessage(
  decision: RouteResult["decision"],
  reason: RouteResult["reason"],
  effectiveLogicLines: number,
  breakdown: FileBreakdown[],
  stakesHits: StakesHit[],
): string {
  const discounted = breakdown
    .filter((f) => f.category === "generated" || f.category === "mechanical")
    .reduce((sum, f) => sum + f.changedLines, 0);
  const roundedLogic = Math.round(effectiveLogicLines);

  if (decision === "quick") {
    const discountNote =
      discounted > 0 ? `; ${discounted} lines generated/mechanical discounted` : "";
    return `Small effective change detected (${roundedLogic} effective logic lines${discountNote}). Using abbreviated review. Use \`--full\` to force the full pipeline.`;
  }
  if (reason === "stakes") {
    const surfaces = [...new Set(stakesHits.flatMap((h) => h.reasons))].join(", ");
    return `High-stakes change detected (${surfaces}). Using the full review pipeline.`;
  }
  if (reason === "logic-file-count") {
    return `Many hand-written files changed (more than ${MAX_LOGIC_FILES}). Using the full review pipeline.`;
  }
  return `Effective change size (${roundedLogic} logic lines) exceeds the abbreviated-review threshold (${EFFECTIVE_SIZE_THRESHOLD}). Using the full review pipeline.`;
}
