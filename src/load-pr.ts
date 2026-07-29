import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseThreads } from "./parse-threads.ts";
import { type Finding } from "./diff-classifier.ts";
import { type PrInfo, getPrInfo } from "./graphql.ts";
import { isValidPath } from "./review-helpers.ts";

/** Load and parse a threads file, validate the PR is open, and verify the head SHA matches. */
export async function loadAndValidatePr(
  threadsPath: string,
  prNumber: number,
  expectedSha: string | undefined,
  cwd: string | undefined,
): Promise<{ findings: Finding[]; prInfo: PrInfo; summary?: string } | null> {
  if (!isValidPath(threadsPath)) {
    throw new Error(`Invalid threadsPath: ${threadsPath}`);
  }
  const base = await realpath(resolve(cwd ?? process.cwd()));
  const candidatePath = resolve(base, threadsPath);
  let resolved: string;
  try {
    resolved = await realpath(candidatePath);
  } catch {
    throw new Error(`Threads file not found: ${candidatePath}`);
  }
  if (!resolved.startsWith(base + "/") && resolved !== base) {
    throw new Error(`threadsPath escapes working directory: ${threadsPath}`);
  }
  const content = await readFile(resolved, "utf8");
  const { findings, summary } = parseThreads(content);
  if (findings.length === 0 && (summary === undefined || summary === "")) return null;

  const prInfo = await getPrInfo(prNumber, { cwd });
  if (prInfo.state !== "OPEN") {
    throw new Error(`PR is ${prInfo.state}. Aborting.`);
  }

  const resolvedSha = expectedSha ?? process.env.PR_HEAD_SHA;
  if (resolvedSha !== undefined && resolvedSha !== "" && resolvedSha !== prInfo.headOid) {
    throw new Error(`ABORT: PR head moved (expected ${resolvedSha}, got ${prInfo.headOid}).`);
  }

  return { findings, prInfo, summary };
}
