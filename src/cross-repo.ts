/**
 * Cross-repo drift detection
 *
 * Compares concept coverage across repositories to find parity gaps
 * where a concept exists in some repos but is missing from others.
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { DriftDatabase } from "./db/database.js";
import type { DriftSeverity } from "./types.js";

export interface ParityGap {
  /** The concept name */
  concept: string;
  /** Repos where the concept exists */
  presentIn: string[];
  /** Repos where the concept is missing */
  missingFrom: string[];
  /** Severity based on how many repos are missing */
  severity: DriftSeverity;
}

export interface RepoSummary {
  /** Repo name */
  repo: string;
  /** Number of indexed files */
  fileCount: number;
  /** Total entity count */
  entityCount: number;
  /** Entities grouped by layer */
  entitiesByLayer: Record<string, number>;
  /** Concepts present in this repo */
  concepts: string[];
}

/**
 * Check concept parity across a set of repos.
 * Returns gaps where a concept exists in some repos but not all.
 */
export function checkParity(db: DriftDatabase, repos: string[]): ParityGap[] {
  if (repos.length < 2) return [];

  // Build concept → repo set mapping
  const conceptRepos = new Map<string, Set<string>>();

  for (const repo of repos) {
    const entities = db.getEntitiesByRepo(repo);
    for (const entity of entities) {
      const metadata = JSON.parse(entity.metadata || "{}");
      const tags: string[] = metadata.tags || [];
      for (const tag of tags) {
        let repoSet = conceptRepos.get(tag);
        if (!repoSet) {
          repoSet = new Set();
          conceptRepos.set(tag, repoSet);
        }
        repoSet.add(repo);
      }
    }
  }

  // Find gaps: concepts present in at least one but not all repos
  const gaps: ParityGap[] = [];

  for (const [concept, repoSet] of conceptRepos) {
    if (repoSet.size < repos.length && repoSet.size > 0) {
      const presentIn = [...repoSet];
      const missingFrom = repos.filter((r) => !repoSet.has(r));
      const missingRatio = missingFrom.length / repos.length;

      let severity: DriftSeverity;
      if (missingRatio >= 0.5) {
        severity = "high";
      } else if (missingRatio >= 0.25) {
        severity = "medium";
      } else {
        severity = "low";
      }

      gaps.push({ concept, presentIn, missingFrom, severity });
    }
  }

  // Sort by severity (high first), then by concept name
  const severityOrder: Record<DriftSeverity, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  gaps.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.concept.localeCompare(b.concept),
  );

  return gaps;
}

/**
 * Get a summary of a specific repo's indexed content.
 */
export function checkRepo(db: DriftDatabase, repo: string): RepoSummary {
  const files = db.getAllFiles().filter((f) => f.repo === repo);
  const entities = db.getEntitiesByRepo(repo);

  // Count by layer
  const entitiesByLayer: Record<string, number> = {};
  for (const entity of entities) {
    entitiesByLayer[entity.layer] = (entitiesByLayer[entity.layer] || 0) + 1;
  }

  // Collect concepts from tags
  const concepts = new Set<string>();
  for (const entity of entities) {
    const metadata = JSON.parse(entity.metadata || "{}");
    const tags: string[] = metadata.tags || [];
    for (const tag of tags) {
      concepts.add(tag);
    }
  }

  return {
    repo,
    fileCount: files.length,
    entityCount: entities.length,
    entitiesByLayer,
    concepts: [...concepts].sort(),
  };
}
