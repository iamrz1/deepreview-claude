/**
 * Project context detection and formatting for severity calibration in reviewers.
 *
 * Extracts metadata from package.json, Cargo.toml, and .deepreview.yml to build
 * a preamble that helps reviewers calibrate finding severity appropriately.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import type { Severity } from "./calibration";

export interface ProjectMetadata {
  /** Semantic version (e.g., "0.1.0", "3.2.1") */
  version?: string;
  /** Whether the project is marked as private/internal */
  isPrivate?: boolean;
  /** Deployment model: "localhost-only" | "internal-network" | "public-facing" | "library" | "unknown" */
  deploymentModel?: string;
  /** True if project has publish = false in Cargo.toml */
  isUnpublished?: boolean;
  /** Description of the project */
  description?: string;
  /** Name of the project */
  name?: string;
}

export interface DeepReviewConfig {
  threatModel?: "localhost-only" | "internal-network" | "public-facing" | "library";
  /** Additional context hints for reviewers */
  context?: string;
  /** Shared calibration entries and settings (opt-in team calibration) */
  calibration?: {
    settings?: { expiryDays?: number };
    entries?: Array<{
      id: string;
      pattern: string;
      context: string;
      originalSeverity: Severity;
      adjustedSeverity: Severity;
      observedCount: number;
      lastConfirmed: string;
      createdAt: string;
    }>;
  };
}

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
}

function parsePackageJson(filePath: string): Partial<ProjectMetadata> {
  try {
    const content = readFileSync(filePath, "utf-8");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Why: JSON.parse returns any; fields are all optional strings/booleans
    const pkg = JSON.parse(content) as PackageJson;
    return {
      version: pkg.version,
      isPrivate: pkg.private === true,
      name: pkg.name,
      description: pkg.description,
    };
  } catch {
    return {};
  }
}

function parseCargoToml(filePath: string): Partial<ProjectMetadata> {
  try {
    const content = readFileSync(filePath, "utf-8");
    const versionMatch = /^version\s*=\s*["']([^"']+)["']/u.exec(content);
    const nameMatch = /^name\s*=\s*["']([^"']+)["']/u.exec(content);
    const publishMatch = /^\[publish\]/u.exec(content);
    const descMatch = /^description\s*=\s*["']([^"']+)["']/u.exec(content);

    return {
      version: versionMatch?.[1],
      name: nameMatch?.[1],
      description: descMatch?.[1],
      isUnpublished: publishMatch !== null,
    };
  } catch {
    return {};
  }
}

/**
 * Parse .deepreview.yml and extract deployment model.
 */
function parseDeepReviewConfig(filePath: string): DeepReviewConfig {
  try {
    const content = readFileSync(filePath, "utf-8");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Why: loadYaml returns unknown; fields are all optional with safe defaults
    const result = loadYaml(content) as DeepReviewConfig | null;
    return result ?? {};
  } catch {
    return {};
  }
}

/**
 * Detect deployment model from project structure and metadata.
 */
function detectDeploymentModel(metadata: ProjectMetadata, config: DeepReviewConfig): string {
  // Explicit config wins
  if (config.threatModel) {
    return config.threatModel;
  }

  // Infer from metadata
  if (metadata.isPrivate === false || metadata.isUnpublished === false) {
    return "public-facing";
  }
  if (metadata.isPrivate === true) {
    return "internal-network";
  }

  return "unknown";
}

/**
 * Extract all project metadata from the repository root.
 */
export function getProjectMetadata(
  repoRoot: string,
): ProjectMetadata & { deploymentModel: string } {
  // Try package.json first (Node.js projects)
  const packageJsonPath = path.join(repoRoot, "package.json");
  let metadata: Partial<ProjectMetadata> = existsSync(packageJsonPath)
    ? parsePackageJson(packageJsonPath)
    : {};

  // Try Cargo.toml (Rust projects) — takes precedence for version/name if both exist
  const cargoTomlPath = path.join(repoRoot, "Cargo.toml");
  if (existsSync(cargoTomlPath)) {
    metadata = { ...metadata, ...parseCargoToml(cargoTomlPath) };
  }

  // Try .deepreview.yml for explicit configuration
  const deepReviewConfigPath = path.join(repoRoot, ".deepreview.yml");
  const config: DeepReviewConfig = existsSync(deepReviewConfigPath)
    ? parseDeepReviewConfig(deepReviewConfigPath)
    : {};

  const deploymentModel = detectDeploymentModel(metadata as ProjectMetadata, config);

  return {
    ...(metadata as ProjectMetadata),
    deploymentModel,
  };
}

/**
 * Get deployment context description for severity calibration.
 */
function getDeploymentContext(deploymentModel: string): string {
  switch (deploymentModel) {
    case "localhost-only":
      return "(localhost-only dev tools — network/auth concerns are lower priority)";
    case "internal-network":
      return "(internal tool — auth is important but threat model is limited to internal users)";
    case "public-facing":
      return "(public-facing service — threat model includes untrusted users)";
    case "library":
      return "(published library — API stability and backwards compatibility are critical)";
    default:
      return "";
  }
}

/**
 * Build calibration guidelines for severity assessment.
 */
function getCalibrationGuidelines(): string[] {
  return [
    "- Pre-1.0 projects: breaking API changes are expected — flag as suggestion, not warning",
    "- Localhost-only tools: network/auth concerns are lower priority — downgrade to suggestion",
    "- Published libraries (v1+): API stability and auth are critical — flag violations as warning/critical",
    "- Stale docs in pre-1.0 projects: flag as suggestion, not critical",
  ];
}

/**
 * Format project metadata as a context preamble for reviewers.
 * This is prepended to PRIOR_CONTEXT and helps reviewers calibrate severity.
 */
export function formatProjectContextPreamble(
  metadata: ProjectMetadata & { deploymentModel: string },
): string {
  const lines: string[] = ["## Project Context (for severity calibration)"];

  if (metadata.name !== undefined && metadata.name !== "") {
    lines.push(`**Name:** ${metadata.name}`);
  }

  if (metadata.version !== undefined && metadata.version !== "") {
    const versionParts = metadata.version.split(".");
    const majorVersion = Number.parseInt(versionParts[0] ?? "0", 10);
    if (majorVersion === 0) {
      lines.push(
        `**Version:** ${metadata.version} (pre-1.0 — relaxed API stability expectations; breaking changes are expected)`,
      );
    } else {
      lines.push(`**Version:** ${metadata.version}`);
    }
  }

  if (metadata.deploymentModel !== "") {
    const deploymentContext = getDeploymentContext(metadata.deploymentModel);
    lines.push(`**Deployment:** ${metadata.deploymentModel} ${deploymentContext}`);
  }

  if (metadata.isPrivate === true) {
    lines.push("**Status:** Private/internal project (no external consumers)");
  } else if (metadata.isUnpublished === false) {
    lines.push("**Status:** Published (breaking changes require major version bump)");
  }

  if (metadata.description !== undefined && metadata.description !== "") {
    lines.push(`**Purpose:** ${metadata.description}`);
  }

  lines.push("\nUse this context to calibrate finding severity. Calibration guidelines:");
  lines.push(...getCalibrationGuidelines());

  return lines.join("\n") + "\n";
}
