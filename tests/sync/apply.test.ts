/**
 * Tests for changeset applier — filesystem mutations
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SyncChangeset } from "../../src/sync/types.js";
import { applyChangeset, type ApplyResult } from "../../src/sync/apply.js";

/** Helper to create a minimal problem README with status and artifacts */
function problemReadme(status: string): string {
  return [
    "# Problem: Test",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| **Status** | " + status + " |",
    "| **Last Updated** | 2026-01-01 |",
    "",
    "## Artifacts",
    "",
    "- [x] investigation.md",
  ].join("\n");
}

describe("applyChangeset", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "apply-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("should apply plan task updates — marks tasks [x] and writes back", async () => {
    const planFile = join(tmp, "plan.md");
    await writeFile(
      planFile,
      ["- [ ] Task one", "- [ ] Task two", "- [ ] Task three"].join("\n"),
      "utf-8",
    );

    const changeset: SyncChangeset = {
      planUpdates: [
        {
          file: planFile,
          taskNumber: 1,
          source: "trailer",
          confidence: "explicit",
        },
        {
          file: planFile,
          taskNumber: 3,
          source: "trailer",
          confidence: "explicit",
        },
      ],
      statusTransitions: [],
      fileMoves: [],
      reminders: [],
    };

    const result = await applyChangeset(tmp, changeset);

    expect(result.planFilesUpdated).toEqual([planFile]);
    expect(result.errors).toEqual([]);

    const content = await readFile(planFile, "utf-8");
    const lines = content.split("\n");
    expect(lines[0]).toBe("- [x] Task one");
    expect(lines[1]).toBe("- [ ] Task two");
    expect(lines[2]).toBe("- [x] Task three");
  });

  it("should batch multiple tasks in same file into single write", async () => {
    const planFile = join(tmp, "plan.md");
    await writeFile(
      planFile,
      ["- [ ] A", "- [ ] B", "- [ ] C"].join("\n"),
      "utf-8",
    );

    const changeset: SyncChangeset = {
      planUpdates: [
        {
          file: planFile,
          taskNumber: 1,
          source: "trailer",
          confidence: "explicit",
        },
        {
          file: planFile,
          taskNumber: 2,
          source: "trailer",
          confidence: "explicit",
        },
      ],
      statusTransitions: [],
      fileMoves: [],
      reminders: [],
    };

    const result = await applyChangeset(tmp, changeset);

    // File should appear only once in updated list (batched)
    expect(result.planFilesUpdated).toEqual([planFile]);

    const content = await readFile(planFile, "utf-8");
    expect(content).toBe(["- [x] A", "- [x] B", "- [ ] C"].join("\n"));
  });

  it("should apply status transitions and update last-updated date", async () => {
    const problemDir = join(tmp, "problems", "test-problem");
    await mkdir(problemDir, { recursive: true });
    const readmePath = join(problemDir, "README.md");
    await writeFile(readmePath, problemReadme("implementing"), "utf-8");

    const changeset: SyncChangeset = {
      planUpdates: [],
      statusTransitions: [
        {
          problem: "test-problem",
          problemDir,
          from: "implementing",
          to: "testing",
          reason: "all plan tasks completed",
        },
      ],
      fileMoves: [],
      reminders: [],
    };

    const result = await applyChangeset(tmp, changeset);

    expect(result.problemsUpdated).toEqual(["test-problem"]);
    expect(result.remindersAdded).toEqual([
      "retrospective.md needed before advancing to done",
    ]);
    expect(result.errors).toEqual([]);

    const content = await readFile(readmePath, "utf-8");
    expect(content).toContain("| **Status** | testing |");
    // Last Updated should be today-ish (YYYY-MM-DD format)
    expect(content).toMatch(/\| \*\*Last Updated\*\* \| \d{4}-\d{2}-\d{2} \|/);
    // Should have the gated reminder in Artifacts
    expect(content).toContain(
      "- [ ] retrospective.md needed before advancing to done",
    );
  });

  it("should apply file moves — creates parent dirs and renames", async () => {
    const srcFile = join(tmp, "todo", "plan.md");
    await mkdir(join(tmp, "todo"), { recursive: true });
    await writeFile(srcFile, "# Plan content", "utf-8");

    const destFile = join(tmp, "done", "plan.md");

    const changeset: SyncChangeset = {
      planUpdates: [],
      statusTransitions: [],
      fileMoves: [{ from: srcFile, to: destFile }],
      reminders: [],
    };

    const result = await applyChangeset(tmp, changeset);

    expect(result.filesMoved).toEqual([{ from: srcFile, to: destFile }]);
    expect(result.errors).toEqual([]);

    // Destination should exist
    const content = await readFile(destFile, "utf-8");
    expect(content).toBe("# Plan content");

    // Source should not exist
    await expect(access(srcFile)).rejects.toThrow();
  });

  it("should handle file move idempotency — already-moved source is skipped", async () => {
    const srcFile = join(tmp, "nonexistent.md");
    const destFile = join(tmp, "dest", "nonexistent.md");

    const changeset: SyncChangeset = {
      planUpdates: [],
      statusTransitions: [],
      fileMoves: [{ from: srcFile, to: destFile }],
      reminders: [],
    };

    const result = await applyChangeset(tmp, changeset);

    // Should not error — source doesn't exist, treated as already moved
    expect(result.filesMoved).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("should record error for missing plan file without crashing", async () => {
    const changeset: SyncChangeset = {
      planUpdates: [
        {
          file: join(tmp, "missing-plan.md"),
          taskNumber: 1,
          source: "trailer",
          confidence: "explicit",
        },
      ],
      statusTransitions: [],
      fileMoves: [],
      reminders: [],
    };

    const result = await applyChangeset(tmp, changeset);

    expect(result.planFilesUpdated).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Failed to update plan");
  });

  it("should return empty result for empty changeset", async () => {
    const changeset: SyncChangeset = {
      planUpdates: [],
      statusTransitions: [],
      fileMoves: [],
      reminders: [],
    };

    const result = await applyChangeset(tmp, changeset);

    expect(result).toEqual({
      planFilesUpdated: [],
      problemsUpdated: [],
      filesMoved: [],
      remindersAdded: [],
      errors: [],
    } satisfies ApplyResult);
  });

  it("should be idempotent — applying same changeset twice has no additional effect", async () => {
    const planFile = join(tmp, "plan.md");
    await writeFile(
      planFile,
      ["- [ ] Task one", "- [ ] Task two"].join("\n"),
      "utf-8",
    );

    const problemDir = join(tmp, "problems", "idem");
    await mkdir(problemDir, { recursive: true });
    await writeFile(
      join(problemDir, "README.md"),
      problemReadme("implementing"),
      "utf-8",
    );

    const changeset: SyncChangeset = {
      planUpdates: [
        {
          file: planFile,
          taskNumber: 1,
          source: "trailer",
          confidence: "explicit",
        },
      ],
      statusTransitions: [
        {
          problem: "idem",
          problemDir,
          from: "implementing",
          to: "testing",
          reason: "all tasks done",
        },
      ],
      fileMoves: [],
      reminders: [],
    };

    // First apply
    await applyChangeset(tmp, changeset);
    const planAfterFirst = await readFile(planFile, "utf-8");

    // Second apply
    const result2 = await applyChangeset(tmp, changeset);

    // Plan file should not appear in updated list (no content change)
    expect(result2.planFilesUpdated).toEqual([]);

    // Content should be identical
    const planAfterSecond = await readFile(planFile, "utf-8");
    expect(planAfterSecond).toBe(planAfterFirst);

    // Problem README may still be "updated" because last-updated date changes,
    // but the status and reminder are idempotent
    const readmeAfterSecond = await readFile(
      join(problemDir, "README.md"),
      "utf-8",
    );
    expect(readmeAfterSecond).toContain("| **Status** | testing |");
    // Reminder should appear exactly once
    const reminderCount = (
      readmeAfterSecond.match(
        /retrospective\.md needed before advancing to done/g,
      ) ?? []
    ).length;
    expect(reminderCount).toBe(1);
  });

  it("should record error for missing problem README without crashing", async () => {
    const changeset: SyncChangeset = {
      planUpdates: [],
      statusTransitions: [
        {
          problem: "ghost",
          problemDir: join(tmp, "nonexistent-dir"),
          from: "implementing",
          to: "testing",
          reason: "test",
        },
      ],
      fileMoves: [],
      reminders: [],
    };

    const result = await applyChangeset(tmp, changeset);

    expect(result.problemsUpdated).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Failed to update problem ghost");
  });

  it("should reject paths outside workspace root", async () => {
    const changeset: SyncChangeset = {
      planUpdates: [
        {
          file: "/etc/passwd",
          taskNumber: 1,
          source: "trailer" as const,
          confidence: "explicit" as const,
        },
      ],
      statusTransitions: [],
      fileMoves: [],
      reminders: [],
    };
    await expect(applyChangeset(tmp, changeset)).rejects.toThrow(
      "Path traversal",
    );
  });

  it("should skip problem README write when content is already up-to-date", async () => {
    const problemDir = join(tmp, "problems", "idem-problem");
    await mkdir(problemDir, { recursive: true });
    const readmePath = join(problemDir, "README.md");
    await writeFile(readmePath, problemReadme("implementing"), "utf-8");

    const changeset: SyncChangeset = {
      planUpdates: [],
      statusTransitions: [
        {
          problem: "idem-problem",
          problemDir,
          from: "implementing",
          to: "testing",
          reason: "all tasks done",
        },
      ],
      fileMoves: [],
      reminders: [],
    };

    // First apply
    const result1 = await applyChangeset(tmp, changeset);
    expect(result1.problemsUpdated).toEqual(["idem-problem"]);

    // Second apply — content unchanged, should not re-write
    const result2 = await applyChangeset(tmp, changeset);
    expect(result2.problemsUpdated).toEqual([]);
  });
});
