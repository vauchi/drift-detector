/**
 * Plan file task marking and counting
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Regex matching both ordered and unordered checkbox lines (with optional indentation) */
const CHECKBOX_RE = /^(\s*(?:[-*]|\d+\.)\s+)\[([ x])\](\s.*)$/;

/**
 * Marks the specified tasks (1-based, by order of appearance) as done.
 * Idempotent: already-done tasks are left unchanged.
 */
export function markTasksDone(content: string, taskNumbers: number[]): string {
  if (content === "" || taskNumbers.length === 0) return content;

  const targetSet = new Set(taskNumbers);
  let taskIndex = 0;

  return content
    .split("\n")
    .map((line) => {
      const match = line.match(CHECKBOX_RE);
      if (!match) return line;

      taskIndex++;
      if (targetSet.has(taskIndex)) {
        // Replace [ ] with [x]; already [x] stays [x]
        return `${match[1]}[x]${match[3]}`;
      }
      return line;
    })
    .join("\n");
}

/** Counts all checkbox items and how many are marked done. */
export function countTasks(content: string): { total: number; done: number } {
  let total = 0;
  let done = 0;

  for (const line of content.split("\n")) {
    const match = line.match(CHECKBOX_RE);
    if (match) {
      total++;
      if (match[2] === "x") done++;
    }
  }

  return { total, done };
}
