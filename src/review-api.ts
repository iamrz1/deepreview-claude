import { graphql } from "./graphql.ts";
import type { ActualPlacement } from "./thread-placement.ts";

const MAX_PAGES = 50;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string;
}

export interface ReviewComment {
  id: string;
  body: string;
  path: string;
  startLine: number | null;
  line: number;
}

export interface PendingReview {
  id: string;
  body: string;
  comments: {
    totalCount: number;
    nodes: ReviewComment[];
  };
}

interface CommentsPage {
  node: {
    comments: {
      pageInfo: PageInfo;
      nodes: ReviewComment[];
    };
  };
}

interface FindPendingReviewResponse {
  node: {
    viewerLatestReview: {
      nodes: Array<{
        id: string;
        body: string;
        comments: {
          totalCount: number;
          pageInfo: PageInfo;
          nodes: ReviewComment[];
        };
      }>;
    };
  };
}

interface CreateReviewResponse {
  addPullRequestReview: {
    pullRequestReview: {
      id: string;
    };
  };
}

interface AddThreadResponse {
  addPullRequestReviewThread: {
    thread: {
      subjectType: string;
      comments: {
        nodes: Array<{ line: number | null; startLine: number | null }>;
      };
    };
  };
}

async function fetchRemainingComments(
  reviewId: string,
  initialPageInfo: PageInfo,
): Promise<ReviewComment[]> {
  const comments: ReviewComment[] = [];
  let pageInfo = initialPageInfo;
  let pages = 0;
  // 5 minute aggregate timeout for pagination
  const deadline = Date.now() + 5 * 60 * 1000;
  while (pageInfo.hasNextPage && pages++ < MAX_PAGES) {
    if (Date.now() > deadline) {
      console.warn(
        `WARN: Aggregate timeout reached after ${pages} pages. Returning partial results.`,
      );
      break;
    }
    const page = await graphql<CommentsPage>(
      `
        query ($reviewId: ID!, $after: String!) {
          node(id: $reviewId) {
            ... on PullRequestReview {
              comments(first: 100, after: $after) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  body
                  path
                  startLine
                  line
                }
              }
            }
          }
        }
      `,
      { reviewId, after: pageInfo.endCursor },
    );
    const next = page.node.comments;
    comments.push(...next.nodes);
    pageInfo = next.pageInfo;
  }
  if (pages >= MAX_PAGES) {
    console.warn(`WARN: Reached MAX_PAGES (${MAX_PAGES}) — review data may be incomplete.`);
  }
  return comments;
}

export async function findPendingReview(prNodeId: string): Promise<PendingReview | null> {
  const data = await graphql<FindPendingReviewResponse>(
    `
      query ($prId: ID!) {
        node(id: $prId) {
          ... on PullRequest {
            viewerLatestReview: reviews(last: 1, states: PENDING, author: "@me") {
              nodes {
                id
                body
                comments(first: 100) {
                  totalCount
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    id
                    body
                    path
                    startLine
                    line
                  }
                }
              }
            }
          }
        }
      }
    `,
    { prId: prNodeId },
  );
  const reviews = data.node.viewerLatestReview.nodes;
  if (reviews.length === 0) return null;

  const review = reviews[0];
  const comments: ReviewComment[] = [...review.comments.nodes];
  const remaining = await fetchRemainingComments(review.id, review.comments.pageInfo);
  comments.push(...remaining);

  return { ...review, comments: { totalCount: review.comments.totalCount, nodes: comments } };
}

export async function createPendingReview(
  prNodeId: string,
  commitOid: string,
  body: string,
): Promise<string> {
  const data = await graphql<CreateReviewResponse>(
    `
      mutation ($input: AddPullRequestReviewInput!) {
        addPullRequestReview(input: $input) {
          pullRequestReview {
            id
          }
        }
      }
    `,
    {
      input: {
        pullRequestId: prNodeId,
        commitOID: commitOid,
        body,
      },
    },
  );
  return data.addPullRequestReview.pullRequestReview.id;
}

export async function updateReviewBody(reviewId: string, body: string): Promise<void> {
  await graphql(
    `
      mutation ($input: UpdatePullRequestReviewInput!) {
        updatePullRequestReview(input: $input) {
          pullRequestReview {
            id
          }
        }
      }
    `,
    { input: { pullRequestReviewId: reviewId, body } },
  );
}

export async function addLineThread(
  reviewId: string,
  path: string,
  line: number,
  startLine: number | undefined,
  body: string,
): Promise<ActualPlacement> {
  const input: Record<string, unknown> = {
    pullRequestReviewId: reviewId,
    path,
    line,
    side: "RIGHT",
    body,
  };
  if (startLine !== undefined && startLine > 0 && startLine < line) {
    input.startLine = startLine;
    input.startSide = "RIGHT";
  }
  const data = await graphql<AddThreadResponse>(
    `
      mutation ($input: AddPullRequestReviewThreadInput!) {
        addPullRequestReviewThread(input: $input) {
          thread {
            subjectType
            comments(first: 1) {
              nodes {
                line
                startLine
              }
            }
          }
        }
      }
    `,
    { input },
  );
  const thread = data.addPullRequestReviewThread.thread;
  const comment = thread.comments.nodes[0];
  return {
    subjectType: thread.subjectType,
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Why: nodes may be empty at runtime; the array element type omits the undefined case
    line: comment?.line ?? null,
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Why: nodes may be empty at runtime; the array element type omits the undefined case
    startLine: comment?.startLine ?? null,
  };
}

export async function addFileThread(reviewId: string, path: string, body: string): Promise<void> {
  await graphql(
    `
      mutation ($input: AddPullRequestReviewThreadInput!) {
        addPullRequestReviewThread(input: $input) {
          thread {
            id
          }
        }
      }
    `,
    {
      input: {
        pullRequestReviewId: reviewId,
        path,
        body,
        subjectType: "FILE",
      },
    },
  );
}

export async function updateReviewComment(commentId: string, body: string): Promise<void> {
  await graphql(
    `
      mutation ($input: UpdatePullRequestReviewCommentInput!) {
        updatePullRequestReviewComment(input: $input) {
          pullRequestReviewComment {
            id
          }
        }
      }
    `,
    { input: { pullRequestReviewCommentId: commentId, body } },
  );
}

/** Post a reply comment on an existing review thread. */
export async function replyToThread(threadId: string, body: string): Promise<void> {
  await graphql(
    `
      mutation ($input: AddPullRequestReviewThreadReplyInput!) {
        addPullRequestReviewThreadReply(input: $input) {
          comment {
            id
          }
        }
      }
    `,
    { input: { pullRequestReviewThreadId: threadId, body } },
  );
}
