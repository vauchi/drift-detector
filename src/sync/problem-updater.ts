/**
 * Problem record README.md parsing and updating
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const SAFE_TRANSITIONS: Record<string, string> = {
  implementing: "testing",
  // intake → investigating requires file-existence check (investigation.md),
  // not plan-task completion. Left manual until inference layer (Phase 2).
};

export const GATED_REMINDERS: Record<string, string> = {
  testing: "retrospective.md needed before advancing to done",
};

/** Regex matching a Status row in a markdown table: | **Status** | <value> | */
const STATUS_RE = /^\|\s*\*\*Status\*\*\s*\|\s*(.+?)\s*\|$/;

/** Regex matching a Last Updated row: | **Last Updated** | <date> | */
const LAST_UPDATED_RE = /^\|\s*\*\*Last Updated\*\*\s*\|\s*(.+?)\s*\|$/;

/** Regex matching an Artifacts section heading */
const ARTIFACTS_HEADING_RE = /^##\s+Artifacts\s*$/;

/** Regex matching a checkbox line with an artifact name */
const ARTIFACT_ITEM_RE = /^-\s+\[[ x]\]\s+(.+)$/;

/**
 * Extract status from a problem record markdown table.
 * Returns null if no status field is found.
 */
export function parseStatus(content: string): string | null {
  for (const line of content.split("\n")) {
    const match = line.match(STATUS_RE);
    if (match) return match[1];
  }
  return null;
}

/**
 * Replace the status value in a problem record markdown table.
 * Returns content unchanged if no status field exists.
 */
export function updateStatus(content: string, newStatus: string): string {
  return content
    .split("\n")
    .map((line) => {
      if (STATUS_RE.test(line)) {
        return `| **Status** | ${newStatus} |`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Replace the Last Updated date in a problem record markdown table.
 * Returns content unchanged if no Last Updated field exists.
 */
export function updateLastUpdated(content: string, date: string): string {
  return content
    .split("\n")
    .map((line) => {
      if (LAST_UPDATED_RE.test(line)) {
        return `| **Last Updated** | ${date} |`;
      }
      return line;
    })
    .join("\n");
}

/**
 * Add an unchecked item to the Artifacts section.
 * Idempotent: does not add if the reminder already exists (checked or unchecked).
 * Returns content unchanged if no Artifacts section exists.
 */
export function addReminder(content: string, reminder: string): string {
  if (content === "") return "";

  const lines = content.split("\n");

  // Find the Artifacts section
  let artifactsIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ARTIFACTS_HEADING_RE.test(lines[i])) {
      artifactsIndex = i;
      break;
    }
  }

  if (artifactsIndex === -1) return content;

  // Check if reminder already exists (checked or unchecked)
  for (let i = artifactsIndex + 1; i < lines.length; i++) {
    const match = lines[i].match(ARTIFACT_ITEM_RE);
    if (match && match[1] === reminder) return content;
    // Stop at next heading
    if (lines[i].startsWith("## ") && i > artifactsIndex) break;
  }

  // Find the last artifact item to insert after it
  let insertIndex = artifactsIndex;
  for (let i = artifactsIndex + 1; i < lines.length; i++) {
    if (ARTIFACT_ITEM_RE.test(lines[i])) {
      insertIndex = i;
    } else if (lines[i].startsWith("## ")) {
      break;
    }
  }

  lines.splice(insertIndex + 1, 0, `- [ ] ${reminder}`);
  return lines.join("\n");
}
