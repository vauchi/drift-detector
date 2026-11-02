/**
 * Sync orchestrator — builds changesets from commit trailers
 *
 * Ties together trailer extraction, slug resolution, plan updating,
 * and problem record status advancement.
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CommitTrailers } from "./trailers.js";
import type { SyncChangeset } from "./types.js";
import { resolvePlanFile, resolveProblemDir } from "./resolver.js";
import { markTasksDone, countTasks } from "./plan-updater.js";
import {
  parseStatus,
  SAFE_TRANSITIONS,
  GATED_REMINDERS,
} from "./problem-updater.js";

export { extractTrailersFromLog, buildGitLogCommand } from "./trailers.js";
export type { CommitTrailers } from "./trailers.js";
export type { SyncChangeset } from "./types.js";

/**
 * Build a changeset from commit trailers, resolving slugs to real files
 * and determining status transitions and file moves.
 */
export async function buildChangeset(
  workspaceRoot: string,
  trailers: CommitTrailers[],
): Promise<SyncChangeset> {
  const changeset: SyncChangeset = {
    planUpdates: [],
    statusTransitions: [],
    fileMoves: [],
    reminders: [],
  };

  if (trailers.length === 0) return changeset;

  // Step 1: Collect task refs by slug, and collect problem slugs
  const tasksBySlug = new Map<string, Set<number>>();
  const problemSlugs = new Set<string>();

  for (const trailer of trailers) {
    for (const task of trailer.planTasks) {
      if (task.taskNumber === undefined) continue;
      let tasks = tasksBySlug.get(task.slug);
      if (!tasks) {
        tasks = new Set();
        tasksBySlug.set(task.slug, tasks);
      }
      tasks.add(task.taskNumber);
    }
    for (const problem of trailer.problems) {
      problemSlugs.add(problem.slug);
    }
  }

  // Step 2: Process each plan slug
  const allTasksDoneSlugs = new Set<string>();

  for (const [slug, taskNumbers] of tasksBySlug) {
    const planFile = await resolvePlanFile(workspaceRoot, slug);
    if (!planFile) continue;

    // Read the plan file to check current state before adding updates
    let content: string;
    try {
      content = await readFile(planFile, "utf-8");
    } catch {
      continue;
    }

    const updatedContent = markTasksDone(content, [...taskNumbers]);

    // Skip if marking produced no change (tasks already done — idempotent)
    if (updatedContent === content) continue;

    // Add PlanUpdate entries only for tasks that would actually change
    for (const taskNumber of taskNumbers) {
      changeset.planUpdates.push({
        file: planFile,
        taskNumber,
        source: "trailer",
        confidence: "explicit",
      });
    }

    const { total, done } = countTasks(updatedContent);

    if (total > 0 && done === total) {
      allTasksDoneSlugs.add(slug);

      // Auto-add as problem ref
      problemSlugs.add(slug);

      // Check for file move (planning/todo/ → planning/done/)
      if (planFile.includes("_private/docs/planning/todo/")) {
        const filename = basename(planFile);
        const doneDir = join(dirname(dirname(planFile)), "done");
        changeset.fileMoves.push({
          from: planFile,
          to: join(doneDir, filename),
        });
      }
    }
  }

  // Step 3: Process problem records
  for (const slug of problemSlugs) {
    const problemDir = await resolveProblemDir(workspaceRoot, slug);
    if (!problemDir) continue;

    const readmePath = join(problemDir, "README.md");
    let content: string;
    try {
      content = await readFile(readmePath, "utf-8");
    } catch {
      continue;
    }

    const currentStatus = parseStatus(content);
    if (!currentStatus) continue;

    // Check if all plan tasks for this problem are done
    if (!allTasksDoneSlugs.has(slug)) continue;

    // Check for safe transition
    const targetStatus = SAFE_TRANSITIONS[currentStatus];
    if (!targetStatus) continue;

    changeset.statusTransitions.push({
      problem: slug,
      problemDir,
      from: currentStatus,
      to: targetStatus,
      reason: "all plan tasks completed",
    });

    // Check for gated reminders on the target status
    const reminder = GATED_REMINDERS[targetStatus];
    if (reminder) {
      changeset.reminders.push(reminder);
    }
  }

  return changeset;
}
