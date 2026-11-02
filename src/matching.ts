/**
 * Multi-strategy entity matching for drift detection and edge building
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { compareTwoStrings } from "string-similarity";
import type { EntityRow } from "./db/database.js";

export interface MatchResult {
  confidence: number;
  method:
    | "exact_tag"
    | "name_convention"
    | "fuzzy"
    | "path_stem"
    | "containment"
    | "semantic";
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "should",
  "can",
  "with",
  "for",
  "and",
  "or",
  "to",
  "in",
  "on",
  "at",
  "it",
]);

const tagCache = new WeakMap<EntityRow, string[]>();

/**
 * Parse tags from an entity's metadata JSON.
 * Results are cached per entity object via WeakMap.
 */
export function parseTags(entity: EntityRow): string[] {
  const cached = tagCache.get(entity);
  if (cached) return cached;
  try {
    const metadata = JSON.parse(entity.metadata || "{}");
    const result = Array.isArray(metadata.tags) ? metadata.tags : [];
    tagCache.set(entity, result);
    return result;
  } catch {
    const empty: string[] = [];
    tagCache.set(entity, empty);
    return empty;
  }
}

/**
 * Normalize a name for comparison: strip test prefixes, split camelCase,
 * remove stop words, lowercase, sort tokens.
 */
export function normalizeName(name: string): string[] {
  // Strip test prefixes (case-insensitive)
  let cleaned = name.replace(
    /^(test_|should_|it_|describe_|spec_|given_|when_|then_)/i,
    "",
  );

  // Split camelCase BEFORE lowercasing so we detect case boundaries
  cleaned = cleaned.replace(/([a-z])([A-Z])/g, "$1 $2");

  const tokens = cleaned
    .toLowerCase()
    .split(/[_\-\s/:.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

  return tokens.sort();
}

/**
 * Match two entities by shared tags from metadata JSON.
 * Confidence scales with overlap ratio (0.85–1.0).
 */
export function matchByTags(a: EntityRow, b: EntityRow): MatchResult | null {
  const tagsA = new Set(parseTags(a));
  const tagsB = new Set(parseTags(b));

  if (tagsA.size === 0 || tagsB.size === 0) return null;

  const intersection = new Set([...tagsA].filter((t) => tagsB.has(t)));
  if (intersection.size === 0) return null;

  const union = new Set([...tagsA, ...tagsB]);
  const overlapRatio = intersection.size / union.size;
  const confidence = 0.85 + overlapRatio * 0.15;

  return { confidence, method: "exact_tag" };
}

/**
 * Match two entities by normalized name similarity using Dice coefficient.
 * Returns name_convention (≥0.7) or fuzzy (≥0.5) match.
 */
export function matchByName(nameA: string, nameB: string): MatchResult | null {
  const tokensA = normalizeName(nameA);
  const tokensB = normalizeName(nameB);

  if (tokensA.length === 0 || tokensB.length === 0) return null;

  // Token overlap
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = [...setA].filter((t) => setB.has(t));
  const tokenOverlap = (2 * intersection.length) / (setA.size + setB.size);

  // String similarity on joined tokens
  const strA = tokensA.join(" ");
  const strB = tokensB.join(" ");
  const dice = compareTwoStrings(strA, strB);

  const combined = (tokenOverlap + dice) / 2;

  if (combined >= 0.7) {
    return {
      confidence: Math.min(0.9, 0.7 + combined * 0.2),
      method: "name_convention",
    };
  }

  // Containment check: if ALL tokens of the shorter name appear in the longer name,
  // the shorter entity is likely being tested by the longer-named test.
  // E.g., test_get_recovery_readiness_returns_not_ready → get_recovery_readiness
  // Checked before fuzzy because containment is a stronger signal for test→source matching.
  const [shorter, longer] =
    setA.size <= setB.size ? [setA, setB] : [setB, setA];
  if (shorter.size >= 2) {
    const contained = [...shorter].filter((t) => longer.has(t));
    if (contained.length === shorter.size) {
      const ratio = shorter.size / longer.size;
      return {
        confidence: Math.min(0.75, 0.6 + ratio * 0.15),
        method: "containment",
      };
    }
  }

  if (combined >= 0.5) {
    return { confidence: Math.min(0.8, 0.4 + combined * 0.3), method: "fuzzy" };
  }

  return null;
}

/**
 * Match two entities by file path stem overlap.
 * Confidence 0.6–0.8 based on stem similarity.
 */
export function matchByPathStem(
  pathA: string,
  pathB: string,
): MatchResult | null {
  const stemA = extractStem(pathA);
  const stemB = extractStem(pathB);

  if (!stemA || !stemB) return null;

  const dice = compareTwoStrings(stemA, stemB);

  if (dice >= 0.5) {
    const confidence = 0.6 + dice * 0.2;
    return { confidence: Math.min(0.8, confidence), method: "path_stem" };
  }

  return null;
}

/**
 * Extract a file's stem — basename without extension and test/spec suffixes.
 */
export function extractStem(filePath: string): string {
  const basename = filePath.split("/").pop() || "";
  return basename
    .replace(/\.\w+$/, "")
    .replace(/[._-](test|spec|tests|e2e)$/i, "")
    .toLowerCase();
}

/**
 * Try all matching strategies in priority order: tags → name → path stem.
 * Returns the best match or null.
 */
export function bestMatch(
  a: EntityRow,
  b: EntityRow,
  filePathA?: string,
  filePathB?: string,
): MatchResult | null {
  const tagMatch = matchByTags(a, b);
  if (tagMatch) return tagMatch;

  const nameMatch = matchByName(a.name, b.name);
  if (nameMatch) return nameMatch;

  if (filePathA && filePathB) {
    return matchByPathStem(filePathA, filePathB);
  }

  return null;
}
