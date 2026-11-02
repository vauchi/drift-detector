/**
 * Plan file and problem directory slug resolution
 *
 * Maps slugs from Plan-Task: and Problem: trailers to actual files on disk.
 * Slugs are matched as substrings of filenames after stripping the YYYY-MM-DD- date prefix.
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fg from "fast-glob";
import { basename, join } from "node:path";

const PLAN_SEARCH_DIRS = ["_private/docs/planning/todo", "_private/docs/planning/done"];

const PROBLEM_SEARCH_DIR = "_private/docs/problems";

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/;

/**
 * Strip the YYYY-MM-DD- date prefix from a filename stem.
 * Returns the remainder (e.g. "sp24-desktop-phone-exchange" from
 * "2026-02-26-sp24-desktop-phone-exchange.plan.md").
 */
function stripDatePrefix(name: string): string {
  return name.replace(DATE_PREFIX_RE, "");
}

/**
 * Check if all hyphen-separated parts of `slug` appear in order
 * within the hyphen-separated parts of `stem` (subsequence match).
 *
 * Example: "sp24-desktop-exchange" matches "sp24-desktop-phone-exchange"
 * because [sp24, desktop, exchange] is a subsequence of [sp24, desktop, phone, exchange].
 */
function slugMatchesStem(slug: string, stem: string): boolean {
  if (stem.includes(slug)) return true;

  const slugParts = slug.split("-");
  const stemParts = stem.split("-");

  let si = 0;
  for (const part of stemParts) {
    if (si < slugParts.length && part === slugParts[si]) {
      si++;
    }
  }
  return si === slugParts.length;
}

/**
 * Resolve a slug to a plan file path by substring match.
 *
 * Searches `_private/docs/planning/todo/` and `_private/docs/planning/done/` for
 * `*.plan.md` files whose date-stripped stem contains the slug.
 * Prefers an exact match over a substring match.
 *
 * Returns the absolute path or null if not found.
 */
export async function resolvePlanFile(
  workspaceRoot: string,
  slug: string,
): Promise<string | null> {
  if (!slug) return null;

  const patterns = PLAN_SEARCH_DIRS.map((dir) =>
    join(workspaceRoot, dir, "*.plan.md"),
  );

  let entries: string[];
  try {
    entries = await fg(patterns, { onlyFiles: true, absolute: true });
  } catch {
    return null;
  }

  const exactMatches: string[] = [];
  const subsequenceMatches: string[] = [];

  for (const entry of entries) {
    const stem = stripDatePrefix(basename(entry, ".plan.md"));
    if (stem === slug) {
      exactMatches.push(entry);
    } else if (slugMatchesStem(slug, stem)) {
      subsequenceMatches.push(entry);
    }
  }

  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    console.warn(
      `[resolver] ambiguous: ${exactMatches.length} exact matches for slug "${slug}"`,
    );
    return null;
  }
  if (subsequenceMatches.length === 1) return subsequenceMatches[0];
  if (subsequenceMatches.length > 1) {
    console.warn(
      `[resolver] ambiguous: ${subsequenceMatches.length} subsequence matches for slug "${slug}"`,
    );
    return null;
  }

  return null;
}

/**
 * Resolve a slug to a problem directory path by substring match.
 *
 * Searches `_private/docs/problems/` for directories whose date-stripped
 * name contains the slug.
 *
 * Returns the absolute path or null if not found.
 */
export async function resolveProblemDir(
  workspaceRoot: string,
  slug: string,
): Promise<string | null> {
  if (!slug) return null;

  const pattern = join(workspaceRoot, PROBLEM_SEARCH_DIR, "*");

  let entries: string[];
  try {
    entries = await fg(pattern, { onlyDirectories: true, absolute: true });
  } catch {
    return null;
  }

  const exactMatches: string[] = [];
  const subsequenceMatches: string[] = [];

  for (const entry of entries) {
    const stem = stripDatePrefix(basename(entry));
    if (stem === slug) {
      exactMatches.push(entry);
    } else if (slugMatchesStem(slug, stem)) {
      subsequenceMatches.push(entry);
    }
  }

  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    console.warn(
      `[resolver] ambiguous: ${exactMatches.length} exact matches for slug "${slug}"`,
    );
    return null;
  }
  if (subsequenceMatches.length === 1) return subsequenceMatches[0];
  if (subsequenceMatches.length > 1) {
    console.warn(
      `[resolver] ambiguous: ${subsequenceMatches.length} subsequence matches for slug "${slug}"`,
    );
    return null;
  }

  return null;
}
