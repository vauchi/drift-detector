/**
 * CLI audit mode for CI pipeline integration
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DriftDatabase } from "./db/database.js";
import { detectDrift, type DriftItem } from "./server.js";
import { loadDriftIgnore } from "./driftignore.js";
import type { DriftSeverity } from "./types.js";

export interface CliArgs {
  command: "audit";
  ci: boolean;
  failOn: DriftSeverity;
  severity: string;
  scope: string;
  category: string | null;
  limit: number;
  groupBy: "category" | "severity" | "file" | null;
  verbose: boolean;
}

export interface AuditResult {
  exitCode: number;
  items: DriftItem[];
  totalDrift: number;
  filteredCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

export interface SyncArgs {
  command: "sync";
  since: string;
  output: string | null;
  dryRun: boolean;
  apply: boolean;
}

/**
 * Parse sync subcommand arguments. Returns null if not a sync command
 * or if required --since flag is missing.
 */
export function parseSyncArgs(argv: string[]): SyncArgs | null {
  if (argv.length === 0 || argv[0] !== "sync") return null;

  let since: string | null = null;
  let output: string | null = null;
  let dryRun = false;
  let apply = false;

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--since" && i + 1 < argv.length) {
      since = argv[++i];
    } else if (argv[i] === "--output" && i + 1 < argv.length) {
      output = argv[++i];
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--apply") {
      apply = true;
    }
  }

  if (!since) return null;

  return { command: "sync", since, output, dryRun, apply };
}

const VALID_SEVERITIES = ["all", "high", "medium", "low"];
const VALID_SCOPES = ["all", "features", "tests", "docs", "code"];
const VALID_GROUP_BY = ["category", "severity", "file"];

/**
 * Parse CLI arguments. Returns null if no CLI command is found (MCP mode).
 */
export function parseCliArgs(argv: string[]): CliArgs | null {
  if (argv.length === 0 || argv[0] !== "audit") return null;

  let ci = false;
  let failOn: DriftSeverity = "high";
  let severity = "all";
  let scope = "all";
  let category: string | null = null;
  let limit = 0;
  let groupBy: CliArgs["groupBy"] = null;
  let verbose = false;

  for (const arg of argv) {
    if (arg === "--ci") ci = true;
    if (arg === "--verbose" || arg === "-v") verbose = true;

    if (arg.startsWith("--fail-on=")) {
      const value = arg.split("=")[1];
      if (value === "high" || value === "medium" || value === "low") {
        failOn = value;
      }
    }
    if (arg.startsWith("--severity=")) {
      const value = arg.split("=")[1];
      if (VALID_SEVERITIES.includes(value)) {
        severity = value;
      }
    }
    if (arg.startsWith("--scope=")) {
      const value = arg.split("=")[1];
      if (VALID_SCOPES.includes(value)) {
        scope = value;
      }
    }
    if (arg.startsWith("--category=")) {
      category = arg.split("=")[1];
    }
    if (arg.startsWith("--limit=")) {
      const value = parseInt(arg.split("=")[1], 10);
      if (!isNaN(value) && value >= 0) {
        limit = value;
      }
    }
    if (arg.startsWith("--group-by=")) {
      const value = arg.split("=")[1];
      if (VALID_GROUP_BY.includes(value)) {
        groupBy = value as CliArgs["groupBy"];
      }
    }
  }

  return {
    command: "audit",
    ci,
    failOn,
    severity,
    scope,
    category,
    limit,
    groupBy,
    verbose,
  };
}

/**
 * Run drift audit and return result with exit code.
 *
 * Exit codes:
 * - 0: No drift at or above failOn severity
 * - 1: Drift found at or above failOn severity
 */
export function runAudit(
  db: DriftDatabase,
  args: CliArgs,
  projectRoot?: string,
): AuditResult {
  // Load .driftignore rules if project root is available
  const ignoreRules = projectRoot ? loadDriftIgnore(projectRoot) : [];

  // Always detect all items first for accurate exit code computation
  const allItems = detectDrift(db, "all", "all", ignoreRules, projectRoot);

  const highCount = allItems.filter((i) => i.severity === "high").length;
  const mediumCount = allItems.filter((i) => i.severity === "medium").length;
  const lowCount = allItems.filter((i) => i.severity === "low").length;
  const totalDrift = allItems.length;

  let exitCode = 0;
  const severityRank: Record<DriftSeverity, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  const threshold = severityRank[args.failOn];

  if (highCount > 0 && severityRank.high >= threshold) exitCode = 1;
  else if (mediumCount > 0 && severityRank.medium >= threshold) exitCode = 1;
  else if (lowCount > 0 && severityRank.low >= threshold) exitCode = 1;

  // Apply display filters — reuse allItems when no scope/severity filter
  const hasDisplayFilters = args.scope !== "all" || args.severity !== "all";
  let filtered = hasDisplayFilters
    ? detectDrift(db, args.scope, args.severity, ignoreRules, projectRoot)
    : allItems;

  if (args.category) {
    filtered = filtered.filter((i) => i.category === args.category);
  }

  if (args.limit > 0) {
    filtered = filtered.slice(0, args.limit);
  }

  return {
    exitCode,
    items: filtered,
    totalDrift,
    filteredCount: filtered.length,
    highCount,
    mediumCount,
    lowCount,
  };
}

/**
 * Format audit result for human-readable output.
 */
export function formatAuditOutput(
  result: AuditResult,
  args: CliArgs,
  projectRoot?: string,
): string {
  const lines: string[] = [];
  const isFiltered = result.filteredCount !== result.totalDrift;

  if (isFiltered) {
    lines.push(
      `Drift Audit: ${result.filteredCount} items (filtered from ${result.totalDrift} total)`,
    );
  } else {
    lines.push(`Drift Audit: ${result.totalDrift} items found`);
  }
  lines.push(`  High: ${result.highCount}`);
  lines.push(`  Medium: ${result.mediumCount}`);
  lines.push(`  Low: ${result.lowCount}`);

  if (result.items.length > 0 && !args.ci) {
    lines.push("");

    const stripRoot = (p: string): string => {
      if (projectRoot && p.startsWith(projectRoot)) {
        return p.slice(projectRoot.length).replace(/^\//, "");
      }
      return p;
    };

    const formatItem = (item: DriftItem): string[] => {
      const path = stripRoot(item.filePath);
      const itemLines: string[] = [];
      itemLines.push(`  ${path}:${item.line} — ${item.message}`);
      if (args.verbose && item.suggestion) {
        itemLines.push(`    Suggestion: ${item.suggestion}`);
      }
      return itemLines;
    };

    if (args.groupBy) {
      const groups = groupItems(result.items, args.groupBy);
      for (const [groupKey, groupItems] of groups) {
        lines.push(`=== ${groupKey.toUpperCase()} (${groupItems.length}) ===`);
        const limited =
          args.limit > 0 ? groupItems.slice(0, args.limit) : groupItems;
        for (const item of limited) {
          lines.push(...formatItem(item));
        }
        const remaining = groupItems.length - limited.length;
        if (remaining > 0) {
          lines.push(`  ... and ${remaining} more`);
        }
        lines.push("");
      }
    } else {
      for (const item of result.items) {
        lines.push(...formatItem(item));
      }
    }
  }

  if (result.exitCode > 0) {
    lines.push(`FAIL: Drift at or above "${args.failOn}" severity found.`);
  } else {
    lines.push("PASS: No drift at or above threshold.");
  }

  return lines.join("\n");
}

/**
 * Format audit result as JSON for CI output.
 */
export function formatCiOutput(
  result: AuditResult,
  projectRoot?: string,
): string {
  const stripRoot = (p: string): string => {
    if (projectRoot && p.startsWith(projectRoot)) {
      return p.slice(projectRoot.length).replace(/^\//, "");
    }
    return p;
  };

  const output = {
    exitCode: result.exitCode,
    totalDrift: result.totalDrift,
    filteredCount: result.filteredCount,
    highCount: result.highCount,
    mediumCount: result.mediumCount,
    lowCount: result.lowCount,
    items: result.items.map((item) => ({
      severity: item.severity,
      category: item.category,
      message: item.message,
      filePath: stripRoot(item.filePath),
      line: item.line,
      suggestion: item.suggestion,
    })),
  };

  return JSON.stringify(output);
}

function groupItems(
  items: DriftItem[],
  groupBy: "category" | "severity" | "file",
): Map<string, DriftItem[]> {
  const groups = new Map<string, DriftItem[]>();

  for (const item of items) {
    let key: string;
    switch (groupBy) {
      case "category":
        key = item.category;
        break;
      case "severity":
        key = item.severity;
        break;
      case "file":
        key = item.filePath;
        break;
    }
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }

  return groups;
}
