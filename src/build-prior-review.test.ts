// oxlint-disable max-lines -- Why: comprehensive test coverage for mapGraphQLThreads and buildPriorReviewContent requires many inline fixture objects; extracting them would obscure intent
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
  buildPriorReview,
  buildPriorReviewContent,
  formatPriorReview,
  mapGraphQLThreads,
  truncateToFit,
} from "./build-prior-review.ts";
import type { ReviewThread, ThreadComment } from "./build-prior-review.ts";

function makeThread(
  path: string,
  line: number,
  comments: { login: string; body: string }[],
  opts?: { id?: string; startLine?: number; isResolved?: boolean; isOutdated?: boolean },
): ReviewThread {
  return {
    id: opts?.id ?? `PRT_${path}_${line}`,
    path,
    startLine: opts?.startLine ?? null,
    line,
    isResolved: opts?.isResolved ?? false,
    isOutdated: opts?.isOutdated ?? false,
    comments: comments.map(
      (c): ThreadComment => ({
        authorLogin: c.login,
        authorType: "human",
        body: c.body,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    ),
  };
}

describe("formatPriorReview: sections", () => {
  it("formats PR description only", () => {
    const result = formatPriorReview("This PR adds feature X.", [], null);
    assert.ok(result.includes("## PR Description"));
    assert.ok(result.includes("This PR adds feature X."));
    assert.ok(!result.includes("## Prior Review Comments"));
    assert.ok(!result.includes("## Manual Prior Review"));
  });

  it("includes manual prior review section", () => {
    const result = formatPriorReview("body", [], "Manual findings here.");
    assert.ok(result.includes("## Manual Prior Review"));
    assert.ok(result.includes("Manual findings here."));
  });

  it("returns empty string when all inputs are empty", () => {
    const result = formatPriorReview("", [], null);
    assert.equal(result, "");
  });
});

// oxlint-disable-next-line max-lines-per-function -- Why: two inline thread fixtures with full comment arrays are required to test multi-thread grouping and line-range formatting; extracting them would obscure the test intent
describe("formatPriorReview: thread formatting", () => {
  it("formats threads grouped by file with line numbers", () => {
    const threads: ReviewThread[] = [
      {
        id: "PRT_1",
        path: "src/foo.ts",
        startLine: 10,
        line: 15,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            authorLogin: "octocat",
            authorType: "human",
            body: "Should this be async?",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            authorLogin: "author",
            authorType: "human",
            body: "Good point, fixed.",
            createdAt: "2026-01-01T01:00:00Z",
          },
        ],
      },
      {
        id: "PRT_2",
        path: "src/foo.ts",
        startLine: null,
        line: 42,
        isResolved: true,
        isOutdated: false,
        comments: [
          {
            authorLogin: "bot-reviewer[bot]",
            authorType: "bot",
            body: "Unused import.",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ];
    const result = formatPriorReview("PR body.", threads, null);
    assert.ok(result.includes("### src/foo.ts"));
    assert.ok(result.includes("**L10-15**"));
    assert.ok(result.includes("[source: @octocat, human]"));
    assert.ok(result.includes("**L42**"));
    assert.ok(result.includes("[source: @bot-reviewer[bot], bot, resolved]"));
    assert.ok(result.includes("@author replied:"));
  });
});

describe("formatPriorReview: thread ordering and flags", () => {
  it("sorts threads by file path then line number", () => {
    const threads = [
      makeThread("src/z.ts", 1, [{ login: "a", body: "z" }]),
      makeThread("src/a.ts", 5, [{ login: "a", body: "a5" }]),
      makeThread("src/a.ts", 1, [{ login: "a", body: "a1" }]),
    ];
    const result = formatPriorReview("", threads, null);
    const aPos = result.indexOf("### src/a.ts");
    const zPos = result.indexOf("### src/z.ts");
    assert.ok(aPos < zPos, "src/a.ts should come before src/z.ts");
    const a1Pos = result.indexOf("a1");
    const a5Pos = result.indexOf("a5");
    assert.ok(a1Pos < a5Pos, "line 1 should come before line 5");
  });

  it("marks outdated threads", () => {
    const threads = [
      makeThread("src/x.ts", 1, [{ login: "a", body: "old" }], { isOutdated: true }),
    ];
    const result = formatPriorReview("", threads, null);
    assert.ok(result.includes("outdated"));
  });
});

describe("truncateToFit", () => {
  it("returns content unchanged when under budget", () => {
    const content = "short content";
    assert.equal(truncateToFit(content, 50_000), content);
  });

  it("truncates to fit within byte limit", () => {
    const content = "x".repeat(60_000);
    const result = truncateToFit(content, 50_000);
    assert.ok(Buffer.byteLength(result, "utf8") <= 50_000);
  });
});

describe("fetchPrReviewThreads", () => {
  it("is exported as a function", async () => {
    const { fetchPrReviewThreads } = await import("./build-prior-review.ts");
    assert.equal(typeof fetchPrReviewThreads, "function");
  });
});

// oxlint-disable-next-line max-lines-per-function -- Why: covers five author-type classification cases; each requires a full GQL node fixture and an assertion; splitting into separate describes would not reduce total lines
describe("mapGraphQLThreads", () => {
  it("maps GraphQL response nodes to ReviewThread[]", () => {
    const nodes = [
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
        line: 5,
        isResolved: true,
        isOutdated: false,
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { login: "ci-bot[bot]", __typename: "Bot" },
              body: "Lint error",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
    ];
    const result = mapGraphQLThreads(nodes);
    assert.equal(result.length, 2);
    assert.equal(result[0].path, "src/foo.ts");
    assert.equal(result[0].comments[0].authorType, "human");
    assert.equal(result[1].comments[0].authorType, "bot");
    assert.equal(result[1].isResolved, true);
  });

  it("detects bot by __typename Bot", () => {
    const nodes = [
      {
        id: "t1",
        path: "a.ts",
        startLine: null,
        line: 1,
        isResolved: false,
        isOutdated: false,
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { login: "dependabot", __typename: "Bot" },
              body: "bump",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
    ];
    const result = mapGraphQLThreads(nodes);
    assert.equal(result[0].comments[0].authorType, "bot");
  });

  it("detects bot by [bot] suffix when __typename is missing", () => {
    const nodes = [
      {
        id: "t1",
        path: "a.ts",
        startLine: null,
        line: 1,
        isResolved: false,
        isOutdated: false,
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { login: "some-bot[bot]", __typename: "User" },
              body: "x",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
    ];
    const result = mapGraphQLThreads(nodes);
    assert.equal(result[0].comments[0].authorType, "bot");
  });

  it("preserves thread id from GraphQL node", () => {
    const nodes = [
      {
        id: "PRT_kwDOABC123",
        path: "src/foo.ts",
        startLine: null,
        line: 10,
        isResolved: false,
        isOutdated: false,
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { login: "alice", __typename: "User" },
              body: "Fix this",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
    ];
    const result = mapGraphQLThreads(nodes);
    assert.equal(result[0].id, "PRT_kwDOABC123");
  });

  it("detects deepreview by finding ID HTML comment in body", () => {
    const nodes = [
      {
        id: "t1",
        path: "src/foo.ts",
        startLine: null,
        line: 10,
        isResolved: false,
        isOutdated: false,
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { login: "reviewer-human", __typename: "User" },
              body: "Missing error handling.\n<!-- finding:abc123 -->",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
        },
      },
    ];
    const result = mapGraphQLThreads(nodes);
    assert.equal(result[0].comments[0].authorType, "deepreview");
    assert.equal(result[0].comments[0].authorLogin, "reviewer-human");
  });
});

describe("buildPriorReviewContent: basic behavior", () => {
  it("keeps all content when under budget", () => {
    const threads: ReviewThread[] = [
      {
        id: "PRT_basic",
        path: "a.ts",
        startLine: null,
        line: 1,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            authorLogin: "a",
            authorType: "human",
            body: "small",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ];
    const result = buildPriorReviewContent("PR body", threads, "manual");
    assert.ok(result.includes("PR body"));
    assert.ok(result.includes("small"));
    assert.ok(result.includes("manual"));
  });

  it("returns empty string when all inputs empty", () => {
    const result = buildPriorReviewContent("", [], null);
    assert.equal(result, "");
  });
});

describe("buildPriorReview (integration shape)", () => {
  it("exports buildPriorReview as a function", () => {
    assert.equal(typeof buildPriorReview, "function");
  });
});

// oxlint-disable-next-line max-lines-per-function -- Why: two test cases require large inline thread fixtures (20K body strings) to exercise byte-budget truncation; extracting fixtures would obscure the budget arithmetic being tested
describe("buildPriorReviewContent: truncation", () => {
  it("drops oldest threads first when over budget", () => {
    const oldThread: ReviewThread = {
      id: "PRT_old",
      path: "old.ts",
      startLine: null,
      line: 1,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          authorLogin: "a",
          authorType: "human",
          body: "x".repeat(30_000),
          createdAt: "2020-01-01T00:00:00Z",
        },
      ],
    };
    const newThread: ReviewThread = {
      id: "PRT_new",
      path: "new.ts",
      startLine: null,
      line: 1,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          authorLogin: "b",
          authorType: "human",
          body: "y".repeat(30_000),
          createdAt: "2026-06-01T00:00:00Z",
        },
      ],
    };
    const result = buildPriorReviewContent("PR body", [oldThread, newThread], null);
    const bytes = Buffer.byteLength(result, "utf8");
    assert.ok(bytes <= 50 * 1024, `Expected <= 50KB, got ${bytes}`);
    assert.ok(result.includes("new.ts"));
    assert.ok(!result.includes("old.ts"), "old thread should have been dropped");
  });

  it("preserves PR description and manual content even when threads are large", () => {
    const bigThread: ReviewThread = {
      id: "PRT_big",
      path: "big.ts",
      startLine: null,
      line: 1,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          authorLogin: "a",
          authorType: "human",
          body: "z".repeat(45_000),
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const result = buildPriorReviewContent(
      "Important PR description",
      [bigThread],
      "Critical manual notes",
    );
    assert.ok(result.includes("Important PR description"));
    assert.ok(result.includes("Critical manual notes"));
    assert.ok(Buffer.byteLength(result, "utf8") <= 50 * 1024);
  });
});

describe("formatPriorReview: formatCommentBody paths", () => {
  it("renders multi-line body as indented blockquote", () => {
    const threads: ReviewThread[] = [
      {
        id: "PRT_multi",
        path: "src/multi.ts",
        startLine: null,
        line: 1,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            authorLogin: "reviewer",
            authorType: "human",
            body: "line one\nline two\nline three",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ];
    const result = formatPriorReview("", threads, null);
    assert.ok(result.includes("  > line one"));
    assert.ok(result.includes("  > line two"));
    assert.ok(result.includes("  > line three"));
    // Multi-line bodies should NOT be wrapped in quotes
    assert.ok(!result.includes('"line one'));
  });

  it("renders single-line body in quotes", () => {
    const threads: ReviewThread[] = [
      {
        id: "PRT_single",
        path: "src/single.ts",
        startLine: null,
        line: 1,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            authorLogin: "reviewer",
            authorType: "human",
            body: "a single line comment",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ];
    const result = formatPriorReview("", threads, null);
    assert.ok(result.includes('"a single line comment"'));
  });
});

describe("formatPriorReview: formatLineRef paths", () => {
  it("renders startLine only when line is null", () => {
    const threads: ReviewThread[] = [
      {
        id: "PRT_start_only",
        path: "src/start-only.ts",
        startLine: 42,
        line: null,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            authorLogin: "a",
            authorType: "human",
            body: "note",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ];
    const result = formatPriorReview("", threads, null);
    assert.ok(result.includes("**L42**"));
    // Should NOT include a range
    assert.ok(!result.includes("**L42-"));
  });

  it("renders file-level when both startLine and line are null", () => {
    const threads: ReviewThread[] = [
      {
        id: "PRT_file_level",
        path: "src/file-level.ts",
        startLine: null,
        line: null,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            authorLogin: "a",
            authorType: "human",
            body: "general comment",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ];
    const result = formatPriorReview("", threads, null);
    assert.ok(result.includes("**file-level**"));
  });
});

describe("formatPriorReview: formatSourceTag paths", () => {
  it("renders deepreview author type in source tag", () => {
    const threads: ReviewThread[] = [
      {
        id: "PRT_dr",
        path: "src/dr.ts",
        startLine: null,
        line: 5,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            authorLogin: "review-bot",
            authorType: "deepreview",
            body: "finding",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ];
    const result = formatPriorReview("", threads, null);
    assert.ok(result.includes("[source: @review-bot, deepreview]"));
  });

  it("renders both resolved and outdated simultaneously", () => {
    const threads: ReviewThread[] = [
      {
        id: "PRT_both",
        path: "src/both.ts",
        startLine: null,
        line: 10,
        isResolved: true,
        isOutdated: true,
        comments: [
          {
            authorLogin: "user",
            authorType: "human",
            body: "old resolved",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ];
    const result = formatPriorReview("", threads, null);
    assert.ok(result.includes("[source: @user, human, resolved, outdated]"));
  });
});

describe("formatPriorReview: thread ID tags", () => {
  it("includes thread ID tag in formatted output", () => {
    const thread = makeThread("src/foo.ts", 10, [{ login: "alice", body: "Fix this" }], {
      id: "PRT_kwDOABC123",
    });
    const result = formatPriorReview("", [thread], null);
    assert.ok(result.includes("[thread: PRT_kwDOABC123]"));
  });

  it("places thread ID after source tag", () => {
    const thread = makeThread("src/foo.ts", 10, [{ login: "alice", body: "Fix this" }], {
      id: "PRT_kwDOXYZ789",
    });
    const result = formatPriorReview("", [thread], null);
    assert.match(result, /\[source: [^\]]+\] \[thread: PRT_kwDOXYZ789\]/u);
  });
});

describe("formatPriorReview: formatThread empty comments", () => {
  it("returns empty output for thread with no comments", () => {
    const threads: ReviewThread[] = [
      {
        id: "PRT_empty",
        path: "src/empty.ts",
        startLine: null,
        line: 1,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    ];
    const result = formatPriorReview("", threads, null);
    // Empty thread produces no output; no file heading should appear
    assert.ok(!result.includes("### src/empty.ts"));
  });
});

describe("truncateToFit: edge cases", () => {
  it("handles multi-byte UTF-8 content within byte limit", () => {
    // Each emoji (😀) is 4 bytes in UTF-8; 15000 repeats ≈ 60KB
    const emoji = "\u{1F600}";
    const content = emoji.repeat(15_000);
    const result = truncateToFit(content, 50_000);
    const resultBytes = Buffer.byteLength(result, "utf8");
    assert.ok(resultBytes <= 50_000, `Expected <= 50000 bytes, got ${resultBytes}`);
    assert.ok(result.includes("[truncated"));
  });

  it("handles CJK characters within byte limit", () => {
    // CJK characters are 3 bytes in UTF-8; 20000 repeats ≈ 60KB
    const content = "\u4e00".repeat(20_000);
    const result = truncateToFit(content, 50_000);
    const resultBytes = Buffer.byteLength(result, "utf8");
    assert.ok(resultBytes <= 50_000, `Expected <= 50000 bytes, got ${resultBytes}`);
  });

  it("returns content unchanged at exact byte boundary", () => {
    // Build content whose byte length is exactly maxBytes
    const maxBytes = 1000;
    // ASCII: 1 byte per char
    const content = "a".repeat(maxBytes);
    assert.equal(Buffer.byteLength(content, "utf8"), maxBytes);
    const result = truncateToFit(content, maxBytes);
    assert.equal(result, content);
  });

  it("includes truncation suffix when truncated", () => {
    const content = "x".repeat(60_000);
    const result = truncateToFit(content, 50_000);
    assert.ok(result.endsWith("[truncated — content exceeds size limit]"));
  });
});

// oxlint-disable-next-line max-lines-per-function -- Why: edge case tests require large inline fixtures to exercise byte-budget boundaries
describe("buildPriorReviewContent: edge cases", () => {
  it("returns only fixed sections when all threads are too large for budget", () => {
    // Use a large PR body so the remaining budget is too small for any thread
    const largePrBody = "P".repeat(20_000);
    const hugeThreadBody = "z".repeat(40_000);
    const threads: ReviewThread[] = [
      {
        id: "PRT_big1",
        path: "big1.ts",
        startLine: null,
        line: 1,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            authorLogin: "a",
            authorType: "human",
            body: hugeThreadBody,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
      {
        id: "PRT_big2",
        path: "big2.ts",
        startLine: null,
        line: 1,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            authorLogin: "b",
            authorType: "human",
            body: hugeThreadBody,
            createdAt: "2026-02-01T00:00:00Z",
          },
        ],
      },
    ];
    const result = buildPriorReviewContent(largePrBody, threads, null);
    assert.ok(result.includes(largePrBody.slice(0, 100)));
    assert.ok(!result.includes("## Prior Review Comments"));
  });

  it("counts file header only once for multiple threads sharing same path", () => {
    const threads: ReviewThread[] = [
      makeThread("shared/file.ts", 1, [{ login: "a", body: "comment 1" }]),
      makeThread("shared/file.ts", 5, [{ login: "b", body: "comment 2" }]),
      makeThread("shared/file.ts", 10, [{ login: "c", body: "comment 3" }]),
    ];
    const result = buildPriorReviewContent("", threads, null);
    // All threads should be present since they share a file header
    assert.ok(result.includes("comment 1"));
    assert.ok(result.includes("comment 2"));
    assert.ok(result.includes("comment 3"));
    // File header appears exactly once in the output
    const headerCount = result.split("### shared/file.ts").length - 1;
    assert.equal(headerCount, 1);
  });

  it("treats whitespace-only manualContent as empty", () => {
    const result = buildPriorReviewContent("body", [], "   \n\t  \n  ");
    assert.ok(!result.includes("## Manual Prior Review"));
    assert.ok(result.includes("## PR Description"));
  });

  it("treats whitespace-only prBody as empty", () => {
    const result = buildPriorReviewContent("  \n  \t  ", [], null);
    assert.equal(result, "");
  });

  it("orders sections: PR Description → Prior Review Comments → Manual Prior Review", () => {
    const threads = [makeThread("src/x.ts", 1, [{ login: "r", body: "finding" }])];
    const result = buildPriorReviewContent("description", threads, "manual notes");
    const prDescIdx = result.indexOf("## PR Description");
    const priorCommentsIdx = result.indexOf("## Prior Review Comments");
    const manualIdx = result.indexOf("## Manual Prior Review");
    assert.ok(prDescIdx >= 0, "PR Description section missing");
    assert.ok(priorCommentsIdx >= 0, "Prior Review Comments section missing");
    assert.ok(manualIdx >= 0, "Manual Prior Review section missing");
    assert.ok(
      prDescIdx < priorCommentsIdx,
      "PR Description should come before Prior Review Comments",
    );
    assert.ok(
      priorCommentsIdx < manualIdx,
      "Prior Review Comments should come before Manual Prior Review",
    );
  });
});
