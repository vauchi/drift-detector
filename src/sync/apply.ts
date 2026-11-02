/**
 * Changeset applier — writes plan updates, status transitions, and file moves
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SyncChangeset } from "./types.js";
import { markTasksDone } from "./plan-updater.js";
import {
  updateStatus,
  updateLastUpdated,
  addReminder,
  GATED_REMINDERS,
} from "./problem-updater.js";

export interface ApplyResult {
  planFilesUpdated: string[];
  problemsUpdated: string[];
  filesMoved: Array<{ from: string; to: string }>;
  remindersAdded: string[];
  errors: string[];
}

function assertPathUnderRoot(filePath: string, root: string): void {
  const resolved = resolve(filePath);
  const resolvedRoot = resolve(root);
  if (!resolved.startsWith(resolvedRoot + "/") && resolved !== resolvedRoot) {
    throw new Error(
      `Path traversal detected: ${filePath} is outside workspace root ${root}`,
    );
  }
}

/**
 * Apply a changeset to the filesystem.
 * Modifies plan files, problem READMEs, and moves files/directories.
 */
export async function applyChangeset(
  workspaceRoot: string,
  changeset: SyncChangeset,
): Promise<ApplyResult> {
  // Validate all paths before any mutations
  for (const update of changeset.planUpdates) {
    assertPathUnderRoot(update.file, workspaceRoot);
  }
  for (const transition of changeset.statusTransitions) {
    assertPathUnderRoot(
      join(transition.problemDir, "README.md"),
      workspaceRoot,
    );
  }
  for (const move of changeset.fileMoves) {
    assertPathUnderRoot(move.from, workspaceRoot);
    assertPathUnderRoot(move.to, workspaceRoot);
  }

  const result: ApplyResult = {
    planFilesUpdated: [],
    problemsUpdated: [],
    filesMoved: [],
    remindersAdded: [],
    errors: [],
  };

  // Step 1: Apply plan task updates (group by file to batch writes)
  const tasksByFile = new Map<string, number[]>();
  for (const update of changeset.planUpdates) {
    const tasks = tasksByFile.get(update.file) ?? [];
    tasks.push(update.taskNumber);
    tasksByFile.set(update.file, tasks);
  }

  for (const [file, taskNumbers] of tasksByFile) {
    try {
      const content = await readFile(file, "utf-8");
      const updated = markTasksDone(content, taskNumbers);
      if (updated !== content) {
        await writeFile(file, updated, "utf-8");
        result.planFilesUpdated.push(file);
      }
    } catch (err) {
      result.errors.push(`Failed to update plan ${file}: ${err}`);
    }
  }

  // Step 2: Apply problem record updates
  for (const transition of changeset.statusTransitions) {
    const readmePath = join(transition.problemDir, "README.md");
    try {
      const originalContent = await readFile(readmePath, "utf-8");
      let content = originalContent;
      content = updateStatus(content, transition.to);
      content = updateLastUpdated(
        content,
        new Date().toISOString().slice(0, 10),
      );

      // Add gated reminder if applicable
      const reminder = GATED_REMINDERS[transition.to];
      if (reminder) {
        content = addReminder(content, reminder);
        result.remindersAdded.push(reminder);
      }

      if (content !== originalContent) {
        await writeFile(readmePath, content, "utf-8");
        result.problemsUpdated.push(transition.problem);
      }
    } catch (err) {
      result.errors.push(
        `Failed to update problem ${transition.problem}: ${err}`,
      );
    }
  }

  // Step 3: Apply file moves
  for (const move of changeset.fileMoves) {
    try {
      await access(move.from);
    } catch {
      // Source gone — already moved, skip
      continue;
    }
    try {
      await mkdir(dirname(move.to), { recursive: true });
      await rename(move.from, move.to);
      result.filesMoved.push({ from: move.from, to: move.to });
    } catch (err) {
      result.errors.push(`Failed to move ${move.from} → ${move.to}: ${err}`);
    }
  }

  return result;
}
