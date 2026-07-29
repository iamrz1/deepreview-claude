// oxlint-disable max-lines, max-lines-per-function, no-floating-promises -- Why: mock-based integration tests require inline fixture objects for GQL responses; mock.module() returns void in bun:test but is typed as thenable
import { afterEach, beforeEach, describe, it, mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fetchPrReviewThreads (mocked)", () => {
  afterEach(() => {
    mock.restore();
  });

  it("returns PR body and mapped threads from a single-page response", async () => {
    mock.module("./graphql.ts", () => ({
      graphql: async () => ({
        repository: {
          pullRequest: {
            body: "Test PR body",
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "t1",
                  path: "src/foo.ts",
                  startLine: 10,
                  line: 15,
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        author: { login: "octocat", __typename: "User" },
                        body: "Looks good",
                        createdAt: "2026-01-01T00:00:00Z",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
      getPrInfo: async () => ({
        owner: "test-org",
        name: "test-repo",
        prNodeId: "PR_1",
        headOid: "abc123",
        state: "OPEN",
      }),
    }));

    const { fetchPrReviewThreads } = await import("./build-prior-review-fetch.ts");
    const result = await fetchPrReviewThreads("test-org", "test-repo", 1);

    assert.equal(result.prBody, "Test PR body");
    assert.equal(result.threads.length, 1);
    assert.equal(result.threads[0].path, "src/foo.ts");
    assert.equal(result.threads[0].startLine, 10);
    assert.equal(result.threads[0].line, 15);
    assert.equal(result.threads[0].comments[0].authorLogin, "octocat");
    assert.equal(result.threads[0].comments[0].authorType, "human");
  });

  it("follows pagination via hasNextPage/endCursor", async () => {
    let callCount = 0;
    mock.module("./graphql.ts", () => ({
      graphql: async (_query: string, variables: Record<string, unknown>) => {
        // Thread comments query (for thread t1 pagination)
        if ("threadId" in variables) {
          return {
            node: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    author: { login: "extra", __typename: "User" },
                    body: "paginated comment",
                    createdAt: "2026-01-01T02:00:00Z",
                  },
                ],
              },
            },
          };
        }
        // Main review threads query
        callCount++;
        if (callCount === 1) {
          return {
            repository: {
              pullRequest: {
                body: "Paginated PR",
                reviewThreads: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor1" },
                  nodes: [
                    {
                      id: "t1",
                      path: "src/a.ts",
                      startLine: null,
                      line: 1,
                      isResolved: false,
                      isOutdated: false,
                      comments: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [
                          {
                            author: { login: "user1", __typename: "User" },
                            body: "first page",
                            createdAt: "2026-01-01T00:00:00Z",
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          };
        }
        // Second page
        return {
          repository: {
            pullRequest: {
              body: "Paginated PR",
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "t2",
                    path: "src/b.ts",
                    startLine: 5,
                    line: 10,
                    isResolved: true,
                    isOutdated: false,
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          author: { login: "user2", __typename: "User" },
                          body: "second page",
                          createdAt: "2026-01-01T01:00:00Z",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        };
      },
      getPrInfo: async () => ({
        owner: "test-org",
        name: "test-repo",
        prNodeId: "PR_1",
        headOid: "abc123",
        state: "OPEN",
      }),
    }));

    const { fetchPrReviewThreads } = await import("./build-prior-review-fetch.ts");
    const result = await fetchPrReviewThreads("test-org", "test-repo", 42);

    assert.equal(result.prBody, "Paginated PR");
    assert.equal(result.threads.length, 2);
    assert.equal(result.threads[0].path, "src/a.ts");
    assert.equal(result.threads[1].path, "src/b.ts");
    assert.equal(result.threads[1].isResolved, true);
  });

  it("throws when PR is not found", async () => {
    mock.module("./graphql.ts", () => ({
      graphql: async () => ({
        repository: {
          pullRequest: null,
        },
      }),
      getPrInfo: async () => ({
        owner: "org",
        name: "repo",
        prNodeId: "PR_1",
        headOid: "sha",
        state: "OPEN",
      }),
    }));

    const { fetchPrReviewThreads } = await import("./build-prior-review-fetch.ts");
    await assert.rejects(
      async () => fetchPrReviewThreads("org", "repo", 999),
      (err: Error) => {
        assert.ok(err.message.includes("PR #999 not found"));
        assert.ok(err.message.includes("org/repo"));
        return true;
      },
    );
  });
});

describe("buildPriorReview (mocked)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deepreview-test-"));
  });

  afterEach(async () => {
    mock.restore();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes file and returns summary with correct stats", async () => {
    mock.module("./graphql.ts", () => ({
      graphql: async () => ({
        repository: {
          pullRequest: {
            body: "Feature PR description",
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "t1",
                  path: "src/foo.ts",
                  startLine: 1,
                  line: 5,
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        author: { login: "reviewer1", __typename: "User" },
                        body: "Fix this",
                        createdAt: "2026-01-01T00:00:00Z",
                      },
                    ],
                  },
                },
                {
                  id: "t2",
                  path: "src/bar.ts",
                  startLine: null,
                  line: 10,
                  isResolved: false,
                  isOutdated: false,
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        author: { login: "reviewer2", __typename: "User" },
                        body: "Add test",
                        createdAt: "2026-01-01T01:00:00Z",
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
      getPrInfo: async () => ({
        owner: "org",
        name: "repo",
        prNodeId: "PR_1",
        headOid: "abc",
        state: "OPEN",
      }),
    }));

    const { buildPriorReview } = await import("./build-prior-review.ts");
    const outputPath = "prior-review.md";
    const result = await buildPriorReview({
      prNumber: 1,
      outputPath,
      cwd: tmpDir,
    });

    assert.ok(result.includes("PR description"));
    assert.ok(result.includes("2 threads"));
    assert.ok(result.includes("2 reviewers"));
    assert.ok(result.includes(outputPath));

    const written = await readFile(join(tmpDir, outputPath), "utf8");
    assert.ok(written.includes("Feature PR description"));
    assert.ok(written.includes("src/foo.ts"));
    assert.ok(written.includes("src/bar.ts"));
  });

  it("writes empty file and returns 'No prior review content found' message", async () => {
    mock.module("./graphql.ts", () => ({
      graphql: async () => ({
        repository: {
          pullRequest: {
            body: "",
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      }),
      getPrInfo: async () => ({
        owner: "org",
        name: "repo",
        prNodeId: "PR_1",
        headOid: "abc",
        state: "OPEN",
      }),
    }));

    const { buildPriorReview } = await import("./build-prior-review.ts");
    const outputPath = "empty-prior.md";
    const result = await buildPriorReview({
      prNumber: 5,
      outputPath,
      cwd: tmpDir,
    });

    assert.ok(result.includes("No prior review content found"));
    assert.ok(result.includes(outputPath));

    const written = await readFile(join(tmpDir, outputPath), "utf8");
    assert.equal(written, "");
  });

  it("reads manual file and includes it in output", async () => {
    const manualPath = "manual-review.md";
    await writeFile(join(tmpDir, manualPath), "Manually noted: check error handling");

    mock.module("./graphql.ts", () => ({
      graphql: async () => ({
        repository: {
          pullRequest: {
            body: "PR body here",
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      }),
      getPrInfo: async () => ({
        owner: "org",
        name: "repo",
        prNodeId: "PR_1",
        headOid: "abc",
        state: "OPEN",
      }),
    }));

    const { buildPriorReview } = await import("./build-prior-review.ts");
    const outputPath = "merged-prior.md";
    const result = await buildPriorReview({
      prNumber: 3,
      outputPath,
      manualPriorReview: manualPath,
      cwd: tmpDir,
    });

    assert.ok(result.includes("manual prior review"));
    assert.ok(result.includes(outputPath));

    const written = await readFile(join(tmpDir, outputPath), "utf8");
    assert.ok(written.includes("Manually noted: check error handling"));
    assert.ok(written.includes("PR body here"));
  });
});
