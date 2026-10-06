import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { assertNoReviewSubmit } from "./review-guard.ts";

describe("assertNoReviewSubmit", () => {
  it("allows creating a pending review", () => {
    const query =
      "mutation ($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id } } }";
    assert.doesNotThrow(() => {
      assertNoReviewSubmit(query, { input: { pullRequestId: "PR_1", commitOID: "abc", body: "" } });
    });
  });

  it("blocks submitPullRequestReview", () => {
    const query =
      "mutation ($input: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $input) { clientMutationId } }";
    assert.throws(() => {
      assertNoReviewSubmit(query, { input: { event: "COMMENT" } });
    }, /never submits/u);
  });

  it("blocks an event passed in variables", () => {
    const query =
      "mutation ($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id } } }";
    assert.throws(() => {
      assertNoReviewSubmit(query, { input: { pullRequestId: "PR_1", event: "APPROVE" } });
    }, /never submits/u);
  });

  it("blocks an inline event argument", () => {
    const query =
      'mutation { addPullRequestReview(input: { pullRequestId: "PR_1", event: COMMENT }) { clientMutationId } }';
    assert.throws(() => {
      assertNoReviewSubmit(query, {});
    }, /never submits/u);
  });
});
