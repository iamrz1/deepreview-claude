import { graphql } from "./graphql.ts";
import type { ReviewThread } from "./build-prior-review.ts";

// --- GraphQL types ---

interface GQLPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GQLCommentAuthor {
  login: string;
  __typename: string;
}

interface GQLComment {
  author: GQLCommentAuthor | null;
  body: string;
  createdAt: string;
}

interface GQLCommentsConnection {
  pageInfo: GQLPageInfo;
  nodes: GQLComment[];
}

interface GQLThreadNode {
  id: string;
  path: string;
  startLine: number | null;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: GQLCommentsConnection;
}

interface GQLReviewThreadsConnection {
  pageInfo: GQLPageInfo;
  nodes: GQLThreadNode[];
}

interface GQLPullRequest {
  body: string;
  reviewThreads: GQLReviewThreadsConnection;
}

interface GQLFetchResponse {
  repository: {
    pullRequest: GQLPullRequest | null;
  };
}

interface GQLThreadCommentsResponse {
  node: {
    comments: GQLCommentsConnection;
  };
}

// --- Constants ---

const MAX_THREAD_PAGES = 20;
const MAX_COMMENT_PAGES = 10;
const AGGREGATE_TIMEOUT_MS = 5 * 60 * 1000;

// --- Mapping ---

const FINDING_ID_RE = /<!-- finding:[a-f0-9]+ -->/u;

function classifyAuthorType(
  author: GQLCommentAuthor | null,
  body: string,
): "human" | "bot" | "deepreview" {
  // deepreview embeds finding IDs as HTML comments; detect regardless of posting account
  if (FINDING_ID_RE.test(body)) return "deepreview";
  // ghost/deleted users treated as bot
  if (!author) return "bot";
  if (author.__typename === "Bot" || author.__typename === "Mannequin") return "bot";
  if (author.login.endsWith("[bot]")) return "bot";
  return "human";
}

/** Map raw GraphQL thread nodes to domain ReviewThread objects with author classification. */
export function mapGraphQLThreads(nodes: GQLThreadNode[]): ReviewThread[] {
  return nodes.map((node) => ({
    id: node.id,
    path: node.path,
    startLine: node.startLine,
    line: node.line,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    comments: node.comments.nodes.map((c) => ({
      authorLogin: c.author?.login ?? "ghost",
      authorType: classifyAuthorType(c.author, c.body),
      body: c.body,
      createdAt: c.createdAt,
    })),
  }));
}

// --- Fetching ---

const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        body
        reviewThreads(first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            path
            startLine
            line
            isResolved
            isOutdated
            comments(first: 100) {
              pageInfo { hasNextPage endCursor }
              nodes {
                author { login __typename }
                body
                createdAt
              }
            }
          }
        }
      }
    }
  }
`;

const THREAD_COMMENTS_QUERY = `
  query ($threadId: ID!, $after: String!) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            author { login __typename }
            body
            createdAt
          }
        }
      }
    }
  }
`;

async function paginateThreads(
  owner: string,
  name: string,
  prNumber: number,
  deadline: number,
): Promise<{ prBody: string; nodes: GQLThreadNode[] }> {
  const nodes: GQLThreadNode[] = [];
  let prBody = "";
  let after: string | null = null;
  let pages = 0;

  while (pages < MAX_THREAD_PAGES) {
    if (Date.now() > deadline) {
      console.warn(
        "WARN: Aggregate timeout reached fetching review threads. Returning partial results.",
      );
      break;
    }
    pages++;

    const data: GQLFetchResponse = await graphql<GQLFetchResponse>(REVIEW_THREADS_QUERY, {
      owner,
      name,
      number: prNumber,
      after,
    });

    const pr: GQLPullRequest | null = data.repository.pullRequest;
    if (!pr) throw new Error(`PR #${prNumber} not found in ${owner}/${name}`);

    if (pages === 1) prBody = pr.body;

    nodes.push(...pr.reviewThreads.nodes);

    if (!pr.reviewThreads.pageInfo.hasNextPage) break;
    after = pr.reviewThreads.pageInfo.endCursor;
  }

  if (pages >= MAX_THREAD_PAGES) {
    console.warn(
      `WARN: Reached MAX_THREAD_PAGES (${MAX_THREAD_PAGES}) — thread data may be incomplete.`,
    );
  }

  return { prBody, nodes };
}

async function paginateThreadComments(nodes: GQLThreadNode[], deadline: number): Promise<void> {
  for (const thread of nodes) {
    if (!thread.comments.pageInfo.hasNextPage) continue;
    if (Date.now() > deadline) {
      console.warn(
        "WARN: Aggregate timeout reached fetching thread comments. Returning partial results.",
      );
      break;
    }

    let commentAfter: string | null = thread.comments.pageInfo.endCursor;
    let commentPages = 0;
    while (commentAfter !== null && commentPages < MAX_COMMENT_PAGES) {
      if (Date.now() > deadline) break;
      commentPages++;

      const data = await graphql<GQLThreadCommentsResponse>(THREAD_COMMENTS_QUERY, {
        threadId: thread.id,
        after: commentAfter,
      });

      thread.comments.nodes.push(...data.node.comments.nodes);
      if (!data.node.comments.pageInfo.hasNextPage) break;
      commentAfter = data.node.comments.pageInfo.endCursor;
    }
  }
}

/** Fetch PR body and all review threads via paginated GraphQL queries. */
export async function fetchPrReviewThreads(
  owner: string,
  name: string,
  prNumber: number,
): Promise<{ prBody: string; threads: ReviewThread[] }> {
  const deadline = Date.now() + AGGREGATE_TIMEOUT_MS;

  const { prBody, nodes } = await paginateThreads(owner, name, prNumber, deadline);
  await paginateThreadComments(nodes, deadline);

  return { prBody, threads: mapGraphQLThreads(nodes) };
}
