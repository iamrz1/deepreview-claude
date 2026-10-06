import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { postReview } from "../../src/post-review.ts";
import { buildPriorReview } from "../../src/build-prior-review.ts";
import { routeDiff } from "../../src/route-diff.ts";

function textResult(text: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text }] };
}

function errorResult(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

const server = new McpServer({ name: "deepreview", version: "0.1.0" });

server.registerTool(
  "route_diff",
  {
    description:
      "Route a diff to the abbreviated (quick) or full review pipeline based on " +
      "effective logic size (raw lines discounted by generated/mechanical/data/test " +
      "content) plus a high-stakes override. Reads the diff file and returns a JSON " +
      "RouteResult with the decision, effective size, stakes hits, and a message.",
    inputSchema: {
      input_path: z
        .string()
        .describe("Relative path to the diff file (e.g. the session input.txt)"),
    },
  },
  ({ input_path }) => {
    try {
      const path = resolve(process.cwd(), input_path);
      const diffText = readFileSync(path, "utf-8");
      return textResult(JSON.stringify(routeDiff(diffText)));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "post_review",
  {
    description:
      "Post a GitHub PR review from a threads.md file. Parses findings, classifies " +
      "them into line-level/file-level/review-body tiers based on the PR diff, and " +
      "submits via GitHub GraphQL API. Returns a summary of what was posted.",
    inputSchema: {
      threads_path: z
        .string()
        .describe("Relative path to the threads.md file (from workspace root)"),
      pr_number: z.number().int().positive().describe("Pull request number"),
      dry_run: z.boolean().optional().describe("Print what would be posted without submitting"),
      skip_ids: z
        .array(z.string())
        .optional()
        .describe("Finding IDs to skip (for retrying partial failures)"),
    },
  },
  async ({ threads_path, pr_number, dry_run, skip_ids }) => {
    try {
      const result = await postReview({
        threadsPath: threads_path,
        prNumber: pr_number,
        dryRun: dry_run ?? false,
        skipIds: skip_ids,
        cwd: process.cwd(),
      });
      return textResult(result.summary);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "build_prior_review",
  {
    description:
      "Fetch PR description and existing review threads from GitHub, format them into " +
      "a prior-review Markdown document for deduplication.",
    inputSchema: {
      pr_number: z.number().int().positive().describe("Pull request number"),
      output_path: z.string().describe("Path to write the generated prior-review file"),
    },
  },
  async ({ pr_number, output_path }) => {
    try {
      const summary = await buildPriorReview({
        prNumber: pr_number,
        outputPath: output_path,
        cwd: process.cwd(),
      });
      return textResult(summary);
    } catch (err) {
      return errorResult(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
