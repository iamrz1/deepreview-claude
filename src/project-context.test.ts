import { describe, it, expect } from "bun:test";
import { getProjectMetadata, formatProjectContextPreamble } from "./project-context";
import path from "node:path";

describe("project-context: metadata extraction", () => {
  it("should extract metadata from package.json", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const metadata = getProjectMetadata(repoRoot);

    expect(metadata).toBeDefined();
    expect(metadata.version).toBe("0.1.0");
    expect(metadata.name).toBe("deepreview-claude");
    expect(metadata.deploymentModel).toBeDefined();
  });
});

describe("project-context: preamble version handling", () => {
  it("should format project context preamble for v0 projects", () => {
    const metadata = {
      version: "0.1.0",
      name: "test-project",
      isPrivate: true,
      deploymentModel: "internal-network" as const,
      description: "A test project",
    };

    const preamble = formatProjectContextPreamble(metadata);

    expect(preamble).toContain("Project Context");
    expect(preamble).toContain("0.1.0");
    expect(preamble).toContain("pre-1.0");
    expect(preamble).toContain("internal-network");
    expect(preamble).toContain("severity calibration");
  });

  it("should handle v1+ versions without pre-1.0 note", () => {
    const metadata = {
      version: "1.2.3",
      name: "stable-project",
      isPrivate: false,
      deploymentModel: "public-facing" as const,
    };

    const preamble = formatProjectContextPreamble(metadata);

    expect(preamble).toContain("1.2.3");
    expect(preamble).not.toMatch(/1\.2\.3.*pre-1\.0/u);
    expect(preamble).toContain("public-facing");
  });
});

describe("project-context: preamble deployment guidance", () => {
  it("should include deployment guidance for localhost tools", () => {
    const metadata = {
      version: "0.1.0",
      name: "dev-tool",
      isPrivate: true,
      deploymentModel: "localhost-only" as const,
    };

    const preamble = formatProjectContextPreamble(metadata);

    expect(preamble).toContain("localhost-only");
    expect(preamble).toContain("network/auth concerns");
  });

  it("should include guidance for published libraries", () => {
    const metadata = {
      version: "2.0.0",
      name: "published-lib",
      isPrivate: false,
      deploymentModel: "library" as const,
    };

    const preamble = formatProjectContextPreamble(metadata);

    expect(preamble).toContain("library");
    expect(preamble).toContain("API stability");
  });
});
