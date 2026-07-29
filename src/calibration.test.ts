import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  loadCalibration,
  writeCalibration,
  nextId,
  formatCalibrationPreamble,
  type CalibrationEntry,
} from "./calibration";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

const TEST_ROOT = path.join(import.meta.dirname, "..", "tmp-calibration-test");

beforeEach(() => {
  mkdirSync(path.join(TEST_ROOT, ".ai", "deepreview"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// oxlint-disable-next-line max-lines-per-function -- Why: comprehensive test coverage for loadCalibration requires inline YAML fixtures to keep each case self-contained; extracting fixtures would obscure the scenario being tested
describe("calibration: loadCalibration", () => {
  it("returns empty when no calibration file exists", () => {
    const emptyRoot = path.join(TEST_ROOT, "no-files");
    mkdirSync(emptyRoot, { recursive: true });
    const result = loadCalibration(emptyRoot);
    expect(result.active).toEqual([]);
    expect(result.expired).toEqual([]);
  });

  it("loads entries from local calibration file", () => {
    const yaml = `
version: 1
settings:
  expiryDays: 30
entries:
  - id: "cal-001"
    pattern: "missing auth"
    context: "localhost-only server"
    originalSeverity: "warning"
    adjustedSeverity: "suggestion"
    observedCount: 3
    lastConfirmed: "${new Date().toISOString().split("T")[0]}"
    createdAt: "2026-01-01"
`;
    writeFileSync(path.join(TEST_ROOT, ".ai", "deepreview", "calibration.yml"), yaml);
    const result = loadCalibration(TEST_ROOT);
    expect(result.active).toHaveLength(1);
    expect(result.active[0].id).toBe("cal-001");
    expect(result.expired).toHaveLength(0);
  });

  it("filters expired entries based on expiryDays", () => {
    const oldDate = "2020-01-01";
    const yaml = `
version: 1
settings:
  expiryDays: 30
entries:
  - id: "cal-001"
    pattern: "old pattern"
    context: "stale context"
    originalSeverity: "warning"
    adjustedSeverity: "suggestion"
    observedCount: 2
    lastConfirmed: "${oldDate}"
    createdAt: "2020-01-01"
`;
    writeFileSync(path.join(TEST_ROOT, ".ai", "deepreview", "calibration.yml"), yaml);
    const result = loadCalibration(TEST_ROOT);
    expect(result.active).toHaveLength(0);
    expect(result.expired).toHaveLength(1);
    expect(result.expired[0].id).toBe("cal-001");
  });

  it("merges shared and local entries (local wins on conflict)", () => {
    const today = new Date().toISOString().split("T")[0];
    const sharedYaml = `
threatModel: localhost-only
calibration:
  settings:
    expiryDays: 60
  entries:
    - id: "shared-001"
      pattern: "missing auth"
      context: "localhost-only server"
      originalSeverity: "warning"
      adjustedSeverity: "suggestion"
      observedCount: 2
      lastConfirmed: "${today}"
      createdAt: "2026-01-01"
    - id: "shared-002"
      pattern: "stale docs"
      context: "pre-1.0 project"
      originalSeverity: "critical"
      adjustedSeverity: "suggestion"
      observedCount: 5
      lastConfirmed: "${today}"
      createdAt: "2026-01-01"
`;
    const localYaml = `
version: 1
settings:
  expiryDays: 30
entries:
  - id: "cal-001"
    pattern: "missing auth"
    context: "localhost-only server"
    originalSeverity: "warning"
    adjustedSeverity: "suggestion"
    observedCount: 5
    lastConfirmed: "${today}"
    createdAt: "2026-02-01"
`;
    writeFileSync(path.join(TEST_ROOT, ".deepreview.yml"), sharedYaml);
    writeFileSync(path.join(TEST_ROOT, ".ai", "deepreview", "calibration.yml"), localYaml);

    const result = loadCalibration(TEST_ROOT);
    // "missing auth" + "localhost-only server" conflict: local wins (observedCount=5)
    const authEntry = result.active.find((e) => e.pattern === "missing auth");
    expect(authEntry?.observedCount).toBe(5);
    expect(authEntry?.id).toBe("cal-001");
    // "stale docs" comes from shared only
    const docsEntry = result.active.find((e) => e.pattern === "stale docs");
    expect(docsEntry?.id).toBe("shared-002");
  });

  it("handles malformed YAML gracefully", () => {
    writeFileSync(
      path.join(TEST_ROOT, ".ai", "deepreview", "calibration.yml"),
      "not: [valid: yaml: {{{",
    );
    const result = loadCalibration(TEST_ROOT);
    expect(result.active).toEqual([]);
    expect(result.expired).toEqual([]);
  });

  it("uses shared expiryDays when local has no settings", () => {
    // Compute a date 60 days ago — with 90-day expiry this should still be active
    const d = new Date();
    d.setDate(d.getDate() - 60);
    const oldDate = d.toISOString().split("T")[0];
    const sharedYaml = `
threatModel: localhost-only
calibration:
  settings:
    expiryDays: 90
  entries:
    - id: "shared-001"
      pattern: "some pattern"
      context: "some context"
      originalSeverity: "warning"
      adjustedSeverity: "suggestion"
      observedCount: 2
      lastConfirmed: "${oldDate}"
      createdAt: "2026-01-01"
`;
    const localYaml = `
version: 1
entries: []
`;
    writeFileSync(path.join(TEST_ROOT, ".deepreview.yml"), sharedYaml);
    writeFileSync(path.join(TEST_ROOT, ".ai", "deepreview", "calibration.yml"), localYaml);

    const result = loadCalibration(TEST_ROOT);
    // With 90-day expiry, an entry from ~60 days ago should still be active
    expect(result.active).toHaveLength(1);
  });
});

describe("calibration: nextId", () => {
  it("returns cal-001 for empty list", () => {
    expect(nextId([])).toBe("cal-001");
  });

  it("increments from highest existing ID", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Why: test stubs only need id field; full CalibrationEntry would be verbose for this nextId unit test
    const entries = [{ id: "cal-003" } as any, { id: "cal-001" } as any];
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Why: stub array; safe for nextId which only reads .id
    expect(nextId(entries)).toBe("cal-004");
  });

  it("handles non-numeric IDs gracefully", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Why: test stubs only need id field; full CalibrationEntry would be verbose for this nextId unit test
    const entries = [{ id: "shared-001" } as any, { id: "cal-002" } as any];
    // oxlint-disable-next-line typescript/no-unsafe-argument -- Why: stub array; safe for nextId which only reads .id
    expect(nextId(entries)).toBe("cal-003");
  });
});

describe("calibration: formatCalibrationPreamble", () => {
  it("returns empty string for no entries", () => {
    expect(formatCalibrationPreamble([])).toBe("");
  });

  it("formats entries as markdown preamble", () => {
    const entries: CalibrationEntry[] = [
      {
        id: "cal-001",
        pattern: "missing auth",
        context: "localhost-only server",
        originalSeverity: "warning",
        adjustedSeverity: "suggestion",
        observedCount: 4,
        lastConfirmed: "2026-06-28",
        createdAt: "2026-06-01",
      },
    ];
    const preamble = formatCalibrationPreamble(entries);
    expect(preamble).toContain("Learned Calibration");
    expect(preamble).toContain('"missing auth" in localhost-only server');
    expect(preamble).toContain("suggestion (not warning)");
    expect(preamble).toContain("Confirmed 4x");
  });
});

describe("calibration: writeCalibration", () => {
  it("creates directory and writes YAML file", () => {
    const writeRoot = path.join(TEST_ROOT, "write-test");
    mkdirSync(writeRoot, { recursive: true });
    const today = new Date().toISOString().split("T")[0];

    writeCalibration(writeRoot, {
      version: 1,
      settings: { expiryDays: 30 },
      entries: [
        {
          id: "cal-001",
          pattern: "test pattern",
          context: "test context",
          originalSeverity: "warning",
          adjustedSeverity: "suggestion",
          observedCount: 1,
          lastConfirmed: today,
          createdAt: today,
        },
      ],
    });

    const filePath = path.join(writeRoot, ".ai", "deepreview", "calibration.yml");
    expect(existsSync(filePath)).toBe(true);

    // Verify we can read it back
    const result = loadCalibration(writeRoot);
    expect(result.active).toHaveLength(1);
    expect(result.active[0].pattern).toBe("test pattern");
  });
});
