/**
 * Git trailer extraction from log output
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  parsePlanTaskTrailer,
  parseProblemTrailer,
  type PlanTaskRef,
  type ProblemRef,
} from "./types.js";

export interface CommitTrailers {
  commitSha: string;
  planTasks: PlanTaskRef[];
  problems: ProblemRef[];
}

export function extractTrailersFromLog(logOutput: string): CommitTrailers[] {
  const results: CommitTrailers[] = [];
  let current: CommitTrailers | null = null;

  for (const line of logOutput.split("\n")) {
    if (line.startsWith("COMMIT_START ")) {
      if (
        current &&
        (current.planTasks.length > 0 || current.problems.length > 0)
      ) {
        results.push(current);
      }
      current = {
        commitSha: line.slice("COMMIT_START ".length).trim(),
        planTasks: [],
        problems: [],
      };
      continue;
    }

    if (!current) continue;

    const planMatch = line.match(/^Plan-Task:\s*(.+)$/);
    if (planMatch) {
      const ref = parsePlanTaskTrailer(planMatch[1].trim());
      if (ref) current.planTasks.push(ref);
      continue;
    }

    const problemMatch = line.match(/^Problem:\s*(.+)$/);
    if (problemMatch) {
      const ref = parseProblemTrailer(problemMatch[1].trim());
      if (ref) current.problems.push(ref);
    }
  }

  if (
    current &&
    (current.planTasks.length > 0 || current.problems.length > 0)
  ) {
    results.push(current);
  }

  return results;
}

export function buildGitLogCommand(sinceRef: string): string[] {
  return [
    "git",
    "log",
    `${sinceRef}..HEAD`,
    "--format=COMMIT_START %h%n%(trailers:key=Plan-Task,key=Problem,valueonly=false)",
  ];
}
