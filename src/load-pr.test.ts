import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { loadAndValidatePr } from "./load-pr.ts";

const TMP_DIR = "/tmp/opencode/load-pr-test";

describe("loadAndValidatePr — path validation", () => {
  it("rejects paths with null bytes", async () => {
    await assert.rejects(
      loadAndValidatePr("threads\x00.md", 1, undefined, TMP_DIR),
      /Invalid threadsPath/u,
    );
  });

  it("rejects absolute paths", async () => {
    await assert.rejects(
      loadAndValidatePr("/etc/passwd", 1, undefined, TMP_DIR),
      /Invalid threadsPath/u,
    );
  });

  it("rejects paths with directory traversal", async () => {
    await assert.rejects(
      loadAndValidatePr("../../../etc/passwd", 1, undefined, TMP_DIR),
      /Invalid threadsPath/u,
    );
  });

  it("rejects empty path", async () => {
    await assert.rejects(loadAndValidatePr("", 1, undefined, TMP_DIR), /Invalid threadsPath/u);
  });
});

describe("loadAndValidatePr — file system", () => {
  it("throws when file does not exist", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    await assert.rejects(
      loadAndValidatePr("nonexistent.md", 1, undefined, TMP_DIR),
      /Threads file not found/u,
    );
  });

  it("throws when resolved path escapes working directory via symlink", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    const linkPath = join(TMP_DIR, "escape.md");
    try {
      await rm(linkPath);
    } catch {
      // ignore if not present
    }
    try {
      await symlink("/etc/hostname", linkPath);
    } catch {
      // symlink creation may fail on some systems — skip test
      return;
    }
    try {
      await assert.rejects(
        loadAndValidatePr("escape.md", 1, undefined, TMP_DIR),
        /escapes working directory/u,
      );
    } finally {
      await rm(linkPath);
    }
  });

  it("returns null when threads file has no findings", async () => {
    await mkdir(TMP_DIR, { recursive: true });
    await writeFile(join(TMP_DIR, "empty.md"), "");
    const result = await loadAndValidatePr("empty.md", 1, undefined, TMP_DIR);
    assert.equal(result, null);
  });
});
