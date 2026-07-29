/**
 * Per-project calibration persistence for deepreview severity adjustments.
 *
 * Reads/writes .ai/deepreview/calibration.yml (local) and the calibration
 * section of .deepreview.yml (shared). Handles merge logic, expiry, and
 * preamble formatting for reviewer injection.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";

/** Severity levels used by deepreview findings. */
export type Severity = "critical" | "warning" | "suggestion";

/** A single calibration entry recording a systematic severity adjustment. */
export interface CalibrationEntry {
  /** Unique identifier (e.g., "cal-001") */
  id: string;
  /** Short description of the finding category */
  pattern: string;
  /** Project-specific context that makes this adjustment valid */
  context: string;
  /** Severity the reviewer originally assigned */
  originalSeverity: Severity;
  /** Severity the validator adjusted to */
  adjustedSeverity: Severity;
  /** How many times this adjustment has been observed */
  observedCount: number;
  /** When a validator last made this same adjustment (ISO date) */
  lastConfirmed: string;
  /** When the entry was first created (ISO date) */
  createdAt: string;
}

/** Configurable settings for calibration behavior. */
export interface CalibrationSettings {
  /** Days before an unconfirmed entry expires (default: 30) */
  expiryDays: number;
}

/** Top-level calibration file structure. */
export interface CalibrationData {
  version: 1;
  settings?: CalibrationSettings;
  entries: CalibrationEntry[];
}

interface SharedConfig {
  threatModel?: string;
  calibration?: {
    settings?: Partial<CalibrationSettings>;
    entries?: CalibrationEntry[];
  };
}

const DEFAULT_EXPIRY_DAYS = 30;
const LOCAL_PATH = ".ai/deepreview/calibration.yml";
const SHARED_PATH = ".deepreview.yml";

function isExpired(entry: CalibrationEntry, expiryDays: number): boolean {
  const lastConfirmed = new Date(entry.lastConfirmed);
  const now = new Date();
  const diffMs = now.getTime() - lastConfirmed.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays > expiryDays;
}

function parseLocalFile(filePath: string): CalibrationData | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Why: loadYaml returns unknown; validated by field access below
    const data = loadYaml(content) as CalibrationData | null;
    if (data === null || typeof data !== "object") {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function parseSharedFile(filePath: string): {
  settings?: Partial<CalibrationSettings>;
  entries: CalibrationEntry[];
} {
  if (!existsSync(filePath)) {
    return { entries: [] };
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Why: loadYaml returns unknown; validated by field access below
    const data = loadYaml(content) as SharedConfig | null;
    if (data?.calibration === undefined) {
      return { entries: [] };
    }
    return {
      settings: data.calibration.settings,
      entries: data.calibration.entries ?? [],
    };
  } catch {
    return { entries: [] };
  }
}

function entryKey(entry: CalibrationEntry): string {
  return `${entry.pattern}|||${entry.context}`;
}

/**
 * Load and merge calibration from local + shared sources, filtering expired entries.
 *
 * Merge precedence: local entries override shared entries when both match on
 * pattern + context. Settings precedence: local > shared > default (30 days).
 */
export function loadCalibration(repoRoot: string): {
  active: CalibrationEntry[];
  expired: CalibrationEntry[];
} {
  const localPath = path.join(repoRoot, LOCAL_PATH);
  const sharedPath = path.join(repoRoot, SHARED_PATH);

  const local = parseLocalFile(localPath);
  const shared = parseSharedFile(sharedPath);

  // Settings precedence: local > shared > default
  const expiryDays =
    local?.settings?.expiryDays ?? shared.settings?.expiryDays ?? DEFAULT_EXPIRY_DAYS;

  // Merge: start with shared entries, then overlay local entries by key
  const merged = new Map<string, CalibrationEntry>();
  for (const entry of shared.entries) {
    merged.set(entryKey(entry), entry);
  }
  for (const entry of local?.entries ?? []) {
    merged.set(entryKey(entry), entry);
  }

  const active: CalibrationEntry[] = [];
  const expired: CalibrationEntry[] = [];

  for (const entry of merged.values()) {
    if (isExpired(entry, expiryDays)) {
      expired.push(entry);
    } else {
      active.push(entry);
    }
  }

  return { active, expired };
}

/**
 * Format active calibration entries as a markdown preamble for reviewer injection.
 * Returns empty string if no entries.
 */
export function formatCalibrationPreamble(entries: CalibrationEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines: string[] = [
    "## Learned Calibration (from prior review sessions)",
    "",
    "The following patterns have been consistently downgraded by validators in this",
    "project. Adjust your severity accordingly — do not inflate these categories:",
    "",
  ];

  for (const entry of entries) {
    lines.push(
      `- "${entry.pattern}" in ${entry.context} → ${entry.adjustedSeverity} (not ${entry.originalSeverity}). Confirmed ${entry.observedCount}x.`,
    );
  }

  return lines.join("\n") + "\n";
}

/**
 * Write calibration data to .ai/deepreview/calibration.yml.
 * Creates the .ai/deepreview/ directory if it doesn't exist.
 */
export function writeCalibration(repoRoot: string, data: CalibrationData): void {
  const dirPath = path.join(repoRoot, ".ai", "deepreview");
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
  const filePath = path.join(dirPath, "calibration.yml");
  const yaml = dumpYaml(data, { lineWidth: 120, noRefs: true });
  writeFileSync(filePath, `# Auto-maintained by deepreview. User-editable.\n${yaml}`);
}

/**
 * Generate the next sequential calibration entry ID.
 * Parses existing "cal-NNN" IDs and returns "cal-(max+1)".
 */
export function nextId(existing: CalibrationEntry[]): string {
  let max = 0;
  for (const entry of existing) {
    const match = /^cal-(\d+)$/u.exec(entry.id);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > max) {
        max = num;
      }
    }
  }
  return `cal-${String(max + 1).padStart(3, "0")}`;
}
