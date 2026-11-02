/**
 * .driftignore file parser and matching
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";

export interface DriftIgnoreRule {
  /** Glob pattern for file path */
  pattern: string;
  /** Drift categories to suppress, or ["*"] for all */
  categories: string[];
}

/**
 * Parse a .driftignore file into rules.
 *
 * Format:
 * - Lines starting with # are comments
 * - Empty lines are skipped
 * - `pattern` alone → suppress all categories for matching files
 * - `pattern category[,category]` → suppress specific categories
 */
export function parseDriftIgnore(content: string): DriftIgnoreRule[] {
  const rules: DriftIgnoreRule[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    const pattern = parts[0];
    const categories =
      parts.length > 1
        ? parts[1]
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : ["*"];

    rules.push({ pattern, categories });
  }

  return rules;
}

/**
 * Load and parse .driftignore from a project root.
 * Returns empty array if no .driftignore file exists.
 */
export function loadDriftIgnore(projectRoot: string): DriftIgnoreRule[] {
  const ignorePath = path.join(projectRoot, ".driftignore");
  try {
    const content = fs.readFileSync(ignorePath, "utf-8");
    return parseDriftIgnore(content);
  } catch {
    return [];
  }
}

/**
 * Check if a file path + category should be ignored based on rules.
 * Matches against both the full path and the project-relative path.
 */
export function shouldIgnore(
  filePath: string,
  category: string,
  rules: DriftIgnoreRule[],
  projectRoot?: string,
): boolean {
  const relativePath =
    projectRoot && filePath.startsWith(projectRoot)
      ? filePath.slice(projectRoot.length).replace(/^\//, "")
      : filePath;

  for (const rule of rules) {
    const opts = { dot: true };
    if (
      minimatch(filePath, rule.pattern, opts) ||
      minimatch(relativePath, rule.pattern, opts)
    ) {
      if (rule.categories.includes("*") || rule.categories.includes(category)) {
        return true;
      }
    }
  }
  return false;
}
