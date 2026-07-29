import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { detectLinePromotion } from "./thread-placement.ts";

describe("detectLinePromotion", () => {
  it("returns null when GitHub kept the requested line-level placement", () => {
    const reason = detectLinePromotion(
      { line: 42, startLine: undefined },
      { subjectType: "LINE", line: 42, startLine: null },
    );
    assert.equal(reason, null);
  });

  it("returns null when a multi-line placement is preserved", () => {
    const reason = detectLinePromotion(
      { line: 42, startLine: 40 },
      { subjectType: "LINE", line: 42, startLine: 40 },
    );
    assert.equal(reason, null);
  });

  it("flags silent promotion to a FILE-level thread", () => {
    const reason = detectLinePromotion(
      { line: 999, startLine: undefined },
      { subjectType: "FILE", line: null, startLine: null },
    );
    assert.notEqual(reason, null);
    assert.match(String(reason), /file-level/iu);
    assert.match(String(reason), /999/u);
  });

  it("flags a repositioned line (GitHub moved the anchor)", () => {
    const reason = detectLinePromotion(
      { line: 42, startLine: undefined },
      { subjectType: "LINE", line: 40, startLine: null },
    );
    assert.notEqual(reason, null);
    assert.match(String(reason), /requested line 42/iu);
    assert.match(String(reason), /40/u);
  });

  it("does not flag when readback line is unavailable but subject stayed LINE", () => {
    // Defensive: if GitHub omits the comment line but keeps LINE subject, trust it.
    const reason = detectLinePromotion(
      { line: 42, startLine: undefined },
      { subjectType: "LINE", line: null, startLine: null },
    );
    assert.equal(reason, null);
  });
});
