/**
 * Throw if the request would submit a PR review. deepreview only creates pending
 * reviews; submitting one is always the user's call in the GitHub UI.
 */
export function assertNoReviewSubmit(query: string, variables: Record<string, unknown>): void {
  const input = variables.input;
  const hasEvent = typeof input === "object" && input !== null && "event" in input;
  if (query.includes("submitPullRequestReview") || /\bevent\s*:/u.test(query) || hasEvent) {
    throw new Error("deepreview never submits PR reviews. Reviews must stay pending.");
  }
}
