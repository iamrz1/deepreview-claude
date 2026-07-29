import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { classifyFindings } from "./diff-classifier.ts";

const SAMPLE_DIFF = [
  "diff --git a/pkg/server/handler.go b/pkg/server/handler.go",
  "index abc1234..def5678 100644",
  "--- a/pkg/server/handler.go",
  "+++ b/pkg/server/handler.go",
  "@@ -40,6 +40,10 @@ func Handle() {",
  "     existing()",
  "+    newLine1()",
  "+    newLine2()",
  "+    newLine3()",
  "+    newLine4()",
  "     more()",
  "diff --git a/README.md b/README.md",
  "index 111..222 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,3 +1,4 @@",
  " # Title",
  "+New line",
  " Rest",
].join("\n");

describe("classifyFindings", () => {
  it("tier 1: line within a diff hunk", () => {
    const findings = [{ path: "pkg/server/handler.go", line: 42, body: "issue" }];
    const result = classifyFindings(findings, SAMPLE_DIFF);
    assert.equal(result[0].tier, 1);
  });

  it("tier 2: file in diff but line not in any hunk", () => {
    const findings = [{ path: "pkg/server/handler.go", line: 200, body: "issue" }];
    const result = classifyFindings(findings, SAMPLE_DIFF);
    assert.equal(result[0].tier, 2);
  });

  it("tier 3: file not in diff at all", () => {
    const findings = [{ path: "internal/other.go", line: 10, body: "issue" }];
    const result = classifyFindings(findings, SAMPLE_DIFF);
    assert.equal(result[0].tier, 3);
  });
});
