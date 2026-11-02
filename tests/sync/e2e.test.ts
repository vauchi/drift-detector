/**
 * End-to-end integration test for the plan-sync pipeline
 *
 * Exercises the full flow: trailer extraction -> changeset building ->
 * filesystem apply -> idempotency verification.
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
import { extractTrailersFromLog } from "../../src/sync/trailers.js";
import { buildChangeset } from "../../src/sync/index.js";
import { applyChangeset } from "../../src/sync/apply.js";

/** Build a fake git log with COMMIT_START format and Plan-Task trailers */
function fakeGitLog(
  entries: Array<{ sha: string; planTasks?: string[]; problems?: string[] }>,
): string {
  return entries
    .map((e) => {
      const lines = [`COMMIT_START ${e.sha}`];
      for (const t of e.planTasks ?? []) lines.push(`Plan-Task: ${t}`);
      for (const p of e.problems ?? []) lines.push(`Problem: ${p}`);
      return lines.join("\n");
    })
    .join("\n");
}

/** Minimal plan file with numbered checkbox tasks */
function planFile(tasks: string[]): string {
  return tasks.map((t) => `- [ ] ${t}`).join("\n") + "\n";
}

/** Problem README with status, last-updated, and artifacts section */
function problemReadme(status: string, date = "2026-01-01"): string {
  return [
    "# Problem: Test Feature",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| **Status** | ${status} |`,
    `| **Last Updated** | ${date} |`,
    "",
    "## Artifacts",
    "",
    "- [x] investigation.md",
    "",
  ].join("\n");
}

describe("plan-sync e2e pipeline", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "sync-e2e-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("Scenario 1: complete flow — task marking + status advance + file move", () => {
    it("should mark all tasks, advance status, move plan file, and add reminder", async () => {
      // Set up workspace structure
      const todoDir = join(tmp, "_private/docs/planning/todo");
      const problemDir = join(
        tmp,
        "_private/docs/problems/2026-01-01-test-feature",
      );
      await mkdir(todoDir, { recursive: true });
      await mkdir(problemDir, { recursive: true });

      const planPath = join(todoDir, "2026-01-01-test-feature.plan.md");
      await writeFile(
        planPath,
        planFile(["Implement API", "Write tests", "Update docs"]),
        "utf-8",
      );
      await writeFile(
        join(problemDir, "README.md"),
        problemReadme("implementing"),
        "utf-8",
      );

      // Fake git log referencing all 3 tasks
      const logOutput = fakeGitLog([
        { sha: "aaa1111", planTasks: ["test-feature#1", "test-feature#2"] },
        { sha: "bbb2222", planTasks: ["test-feature#3"] },
      ]);

      // Pipeline: extract -> build -> apply
      const trailers = extractTrailersFromLog(logOutput);
      expect(trailers).toHaveLength(2);

      const changeset = await buildChangeset(tmp, trailers);

      // Verify changeset shape before apply
      expect(changeset.planUpdates).toHaveLength(3);
      expect(changeset.statusTransitions).toHaveLength(1);
      expect(changeset.statusTransitions[0].from).toBe("implementing");
      expect(changeset.statusTransitions[0].to).toBe("testing");
      expect(changeset.fileMoves).toHaveLength(1);
      expect(changeset.fileMoves[0].from).toBe(planPath);
      expect(changeset.reminders).toContain(
        "retrospective.md needed before advancing to done",
      );

      const result = await applyChangeset(tmp, changeset);

      expect(result.errors).toEqual([]);

      // Plan file should have all tasks marked [x]
      // After move, read from the done directory
      const donePath = join(
        tmp,
        "_private/docs/planning/done/2026-01-01-test-feature.plan.md",
      );
      const movedContent = await readFile(donePath, "utf-8");
      expect(movedContent).toContain("- [x] Implement API");
      expect(movedContent).toContain("- [x] Write tests");
      expect(movedContent).toContain("- [x] Update docs");
      expect(movedContent).not.toContain("- [ ]");

      // Verify file was actually moved (source gone)
      await expect(access(planPath)).rejects.toThrow();
      expect(result.filesMoved).toEqual([{ from: planPath, to: donePath }]);

      // Problem README should have updated status and date
      const readmeContent = await readFile(
        join(problemDir, "README.md"),
        "utf-8",
      );
      expect(readmeContent).toContain("| **Status** | testing |");
      // Last Updated should be today's date (YYYY-MM-DD)
      const today = new Date().toISOString().slice(0, 10);
      expect(readmeContent).toContain(`| **Last Updated** | ${today} |`);

      // Retrospective reminder should exist in artifacts
      expect(readmeContent).toContain(
        "- [ ] retrospective.md needed before advancing to done",
      );
      expect(result.remindersAdded).toContain(
        "retrospective.md needed before advancing to done",
      );
    });
  });

  describe("Scenario 2: partial completion — no status advance", () => {
    it("should mark only referenced tasks, leave status unchanged, no file move", async () => {
      const todoDir = join(tmp, "_private/docs/planning/todo");
      const problemDir = join(
        tmp,
        "_private/docs/problems/2026-01-01-test-feature",
      );
      await mkdir(todoDir, { recursive: true });
      await mkdir(problemDir, { recursive: true });

      const planPath = join(todoDir, "2026-01-01-test-feature.plan.md");
      await writeFile(
        planPath,
        planFile(["Task A", "Task B", "Task C"]),
        "utf-8",
      );
      await writeFile(
        join(problemDir, "README.md"),
        problemReadme("implementing"),
        "utf-8",
      );

      // Only reference tasks 1 and 2 — task 3 remains unchecked
      const logOutput = fakeGitLog([
        { sha: "ccc3333", planTasks: ["test-feature#1", "test-feature#2"] },
      ]);

      const trailers = extractTrailersFromLog(logOutput);
      const changeset = await buildChangeset(tmp, trailers);

      // No status transition since not all tasks are done
      expect(changeset.statusTransitions).toEqual([]);
      expect(changeset.fileMoves).toEqual([]);
      expect(changeset.reminders).toEqual([]);

      const result = await applyChangeset(tmp, changeset);

      expect(result.errors).toEqual([]);
      expect(result.filesMoved).toEqual([]);
      expect(result.problemsUpdated).toEqual([]);

      // Tasks 1 and 2 marked, task 3 still unchecked
      const content = await readFile(planPath, "utf-8");
      expect(content).toContain("- [x] Task A");
      expect(content).toContain("- [x] Task B");
      expect(content).toContain("- [ ] Task C");

      // Problem status unchanged
      const readmeContent = await readFile(
        join(problemDir, "README.md"),
        "utf-8",
      );
      expect(readmeContent).toContain("| **Status** | implementing |");
    });
  });

  describe("Scenario 3: idempotency", () => {
    it("should produce no changes on second run of the same pipeline", async () => {
      const todoDir = join(tmp, "_private/docs/planning/todo");
      const problemDir = join(
        tmp,
        "_private/docs/problems/2026-01-01-test-feature",
      );
      await mkdir(todoDir, { recursive: true });
      await mkdir(problemDir, { recursive: true });

      const planPath = join(todoDir, "2026-01-01-test-feature.plan.md");
      await writeFile(planPath, planFile(["Only task"]), "utf-8");
      await writeFile(
        join(problemDir, "README.md"),
        problemReadme("implementing"),
        "utf-8",
      );

      const logOutput = fakeGitLog([
        { sha: "ddd4444", planTasks: ["test-feature#1"] },
      ]);

      // First run
      const trailers = extractTrailersFromLog(logOutput);
      const changeset1 = await buildChangeset(tmp, trailers);
      const result1 = await applyChangeset(tmp, changeset1);

      expect(result1.errors).toEqual([]);
      expect(result1.planFilesUpdated).toHaveLength(1);
      expect(result1.problemsUpdated).toHaveLength(1);
      expect(result1.filesMoved).toHaveLength(1);

      // Second run — re-build changeset from the same workspace state
      // The plan file has moved to done/, and tasks are already [x]
      const changeset2 = await buildChangeset(tmp, trailers);

      // Plan file is in done/ (resolver finds it), but all tasks are already
      // [x], so buildChangeset skips it — no updates to apply
      expect(changeset2.planUpdates).toEqual([]);
      expect(changeset2.statusTransitions).toEqual([]);
      expect(changeset2.fileMoves).toEqual([]);

      const result2 = await applyChangeset(tmp, changeset2);

      expect(result2.planFilesUpdated).toEqual([]);
      expect(result2.problemsUpdated).toEqual([]);
      expect(result2.filesMoved).toEqual([]);
      expect(result2.errors).toEqual([]);
    });
  });

  describe("Scenario 4: multiple plans in one changeset", () => {
    it("should process two independent slugs from the same git log", async () => {
      const todoDir = join(tmp, "_private/docs/planning/todo");
      const problemDirA = join(
        tmp,
        "_private/docs/problems/2026-01-01-feature-alpha",
      );
      const problemDirB = join(
        tmp,
        "_private/docs/problems/2026-02-01-feature-beta",
      );
      await mkdir(todoDir, { recursive: true });
      await mkdir(problemDirA, { recursive: true });
      await mkdir(problemDirB, { recursive: true });

      const planA = join(todoDir, "2026-01-01-feature-alpha.plan.md");
      const planB = join(todoDir, "2026-02-01-feature-beta.plan.md");
      await writeFile(
        planA,
        planFile(["Alpha task 1", "Alpha task 2"]),
        "utf-8",
      );
      await writeFile(planB, planFile(["Beta task 1"]), "utf-8");
      await writeFile(
        join(problemDirA, "README.md"),
        problemReadme("implementing"),
        "utf-8",
      );
      await writeFile(
        join(problemDirB, "README.md"),
        problemReadme("implementing"),
        "utf-8",
      );

      // Single git log references both slugs — alpha fully done, beta fully done
      const logOutput = fakeGitLog([
        { sha: "eee5555", planTasks: ["feature-alpha#1", "feature-beta#1"] },
        { sha: "fff6666", planTasks: ["feature-alpha#2"] },
      ]);

      const trailers = extractTrailersFromLog(logOutput);
      const changeset = await buildChangeset(tmp, trailers);

      // Both slugs should have plan updates
      const alphaPlanUpdates = changeset.planUpdates.filter(
        (u) => u.file === planA,
      );
      const betaPlanUpdates = changeset.planUpdates.filter(
        (u) => u.file === planB,
      );
      expect(alphaPlanUpdates).toHaveLength(2);
      expect(betaPlanUpdates).toHaveLength(1);

      // Both should have status transitions (all tasks done for both)
      expect(changeset.statusTransitions).toHaveLength(2);
      const slugs = changeset.statusTransitions.map((t) => t.problem).sort();
      expect(slugs).toEqual(["feature-alpha", "feature-beta"]);

      // Both should have file moves
      expect(changeset.fileMoves).toHaveLength(2);

      const result = await applyChangeset(tmp, changeset);

      expect(result.errors).toEqual([]);

      // Verify alpha moved and tasks done
      const doneDir = join(tmp, "_private/docs/planning/done");
      const alphaContent = await readFile(
        join(doneDir, "2026-01-01-feature-alpha.plan.md"),
        "utf-8",
      );
      expect(alphaContent).toContain("- [x] Alpha task 1");
      expect(alphaContent).toContain("- [x] Alpha task 2");
      expect(alphaContent).not.toContain("- [ ]");

      // Verify beta moved and tasks done
      const betaContent = await readFile(
        join(doneDir, "2026-02-01-feature-beta.plan.md"),
        "utf-8",
      );
      expect(betaContent).toContain("- [x] Beta task 1");
      expect(betaContent).not.toContain("- [ ]");

      // Both problem READMEs should be updated
      expect(result.problemsUpdated.sort()).toEqual([
        "feature-alpha",
        "feature-beta",
      ]);

      const readmeA = await readFile(join(problemDirA, "README.md"), "utf-8");
      const readmeB = await readFile(join(problemDirB, "README.md"), "utf-8");
      expect(readmeA).toContain("| **Status** | testing |");
      expect(readmeB).toContain("| **Status** | testing |");
      expect(readmeA).toContain(
        "- [ ] retrospective.md needed before advancing to done",
      );
      expect(readmeB).toContain(
        "- [ ] retrospective.md needed before advancing to done",
      );
    });
  });
});
