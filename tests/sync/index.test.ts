/**
 * Tests for sync orchestrator (changeset builder)
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildChangeset } from "../../src/sync/index.js";
import type { CommitTrailers } from "../../src/sync/trailers.js";

let tempRoot: string;

async function makeTempRoot(): Promise<string> {
  const dir = join(
    tmpdir(),
    `sync-orch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createFile(
  base: string,
  relPath: string,
  content = "",
): Promise<void> {
  const full = join(base, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

const PLAN_WITH_2_TASKS = `# Plan

- [ ] Task one
- [ ] Task two
`;

const PLAN_WITH_2_TASKS_1_DONE = `# Plan

- [x] Task one
- [ ] Task two
`;

const PROBLEM_README_IMPLEMENTING = `# Problem: My Feature

| **Status** | implementing |
| **Priority** | high |

## Artifacts

- [x] plan.md
`;

const PROBLEM_README_TESTING = `# Problem: My Feature

| **Status** | testing |
| **Priority** | high |

## Artifacts

- [x] plan.md
`;

beforeEach(async () => {
  tempRoot = await makeTempRoot();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("buildChangeset", () => {
  it("should build changeset from trailer refs (2 tasks referenced → 2 plan updates)", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      PLAN_WITH_2_TASKS,
    );

    const trailers: CommitTrailers[] = [
      {
        commitSha: "abc1234",
        planTasks: [
          { slug: "my-feature", taskNumber: 1 },
          { slug: "my-feature", taskNumber: 2 },
        ],
        problems: [],
      },
    ];

    const changeset = await buildChangeset(tempRoot, trailers);

    expect(changeset.planUpdates).toHaveLength(2);
    expect(changeset.planUpdates[0]).toEqual({
      file: join(
        tempRoot,
        "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      ),
      taskNumber: 1,
      source: "trailer",
      confidence: "explicit",
    });
    expect(changeset.planUpdates[1]).toEqual({
      file: join(
        tempRoot,
        "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      ),
      taskNumber: 2,
      source: "trailer",
      confidence: "explicit",
    });
  });

  it("should trigger status transition when ALL tasks complete (implementing → testing)", async () => {
    // Plan with 2 tasks, 1 already done — marking task 2 will complete it
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      PLAN_WITH_2_TASKS_1_DONE,
    );
    await createFile(
      tempRoot,
      "_private/docs/problems/2026-01-01-my-feature/README.md",
      PROBLEM_README_IMPLEMENTING,
    );

    const trailers: CommitTrailers[] = [
      {
        commitSha: "abc1234",
        planTasks: [{ slug: "my-feature", taskNumber: 2 }],
        problems: [{ slug: "my-feature" }],
      },
    ];

    const changeset = await buildChangeset(tempRoot, trailers);

    expect(changeset.statusTransitions).toHaveLength(1);
    expect(changeset.statusTransitions[0]).toEqual({
      problem: "my-feature",
      problemDir: join(
        tempRoot,
        "_private/docs/problems/2026-01-01-my-feature",
      ),
      from: "implementing",
      to: "testing",
      reason: "all plan tasks completed",
    });
  });

  it("should add reminder for gated transition (retrospective needed)", async () => {
    // All tasks already done, status is implementing → transition to testing triggers gated reminder
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      PLAN_WITH_2_TASKS_1_DONE,
    );
    await createFile(
      tempRoot,
      "_private/docs/problems/2026-01-01-my-feature/README.md",
      PROBLEM_README_IMPLEMENTING,
    );

    const trailers: CommitTrailers[] = [
      {
        commitSha: "abc1234",
        planTasks: [{ slug: "my-feature", taskNumber: 2 }],
        problems: [{ slug: "my-feature" }],
      },
    ];

    const changeset = await buildChangeset(tempRoot, trailers);

    // "testing" status has a gated reminder
    expect(changeset.reminders).toContain(
      "retrospective.md needed before advancing to done",
    );
  });

  it("should return empty changeset for unknown slug", async () => {
    const trailers: CommitTrailers[] = [
      {
        commitSha: "abc1234",
        planTasks: [{ slug: "nonexistent-slug", taskNumber: 1 }],
        problems: [],
      },
    ];

    const changeset = await buildChangeset(tempRoot, trailers);

    expect(changeset.planUpdates).toHaveLength(0);
    expect(changeset.statusTransitions).toHaveLength(0);
    expect(changeset.fileMoves).toHaveLength(0);
    expect(changeset.reminders).toHaveLength(0);
  });

  it("should add file moves for completed plan in planning/todo/", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      PLAN_WITH_2_TASKS_1_DONE,
    );

    const trailers: CommitTrailers[] = [
      {
        commitSha: "abc1234",
        planTasks: [{ slug: "my-feature", taskNumber: 2 }],
        problems: [],
      },
    ];

    const changeset = await buildChangeset(tempRoot, trailers);

    expect(changeset.fileMoves).toContainEqual({
      from: join(
        tempRoot,
        "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      ),
      to: join(
        tempRoot,
        "_private/docs/planning/done/2026-01-01-my-feature.plan.md",
      ),
    });
  });

  it("should consolidate multiple slugs across different commits", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-feature-a.plan.md",
      PLAN_WITH_2_TASKS,
    );
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-feature-b.plan.md",
      PLAN_WITH_2_TASKS,
    );

    const trailers: CommitTrailers[] = [
      {
        commitSha: "abc1234",
        planTasks: [{ slug: "feature-a", taskNumber: 1 }],
        problems: [],
      },
      {
        commitSha: "def5678",
        planTasks: [
          { slug: "feature-a", taskNumber: 2 },
          { slug: "feature-b", taskNumber: 1 },
        ],
        problems: [],
      },
    ];

    const changeset = await buildChangeset(tempRoot, trailers);

    // feature-a has tasks 1 and 2, feature-b has task 1
    expect(changeset.planUpdates).toHaveLength(3);

    const featureAUpdates = changeset.planUpdates.filter((u) =>
      u.file.includes("feature-a"),
    );
    const featureBUpdates = changeset.planUpdates.filter((u) =>
      u.file.includes("feature-b"),
    );

    expect(featureAUpdates).toHaveLength(2);
    expect(featureBUpdates).toHaveLength(1);
  });

  // CC-11: empty trailers array
  it("should return empty changeset for empty trailers array", async () => {
    const changeset = await buildChangeset(tempRoot, []);

    expect(changeset.planUpdates).toHaveLength(0);
    expect(changeset.statusTransitions).toHaveLength(0);
    expect(changeset.fileMoves).toHaveLength(0);
    expect(changeset.reminders).toHaveLength(0);
  });

  // CC-11: trailers with no task numbers
  it("should skip plan tasks without task numbers", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      PLAN_WITH_2_TASKS,
    );

    const trailers: CommitTrailers[] = [
      {
        commitSha: "abc1234",
        planTasks: [{ slug: "my-feature" }], // no taskNumber
        problems: [],
      },
    ];

    const changeset = await buildChangeset(tempRoot, trailers);

    // No task numbers → no plan updates
    expect(changeset.planUpdates).toHaveLength(0);
  });

  it("should not transition status when not all tasks are done", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      PLAN_WITH_2_TASKS,
    );
    await createFile(
      tempRoot,
      "_private/docs/problems/2026-01-01-my-feature/README.md",
      PROBLEM_README_IMPLEMENTING,
    );

    const trailers: CommitTrailers[] = [
      {
        commitSha: "abc1234",
        planTasks: [{ slug: "my-feature", taskNumber: 1 }], // only 1 of 2
        problems: [{ slug: "my-feature" }],
      },
    ];

    const changeset = await buildChangeset(tempRoot, trailers);

    expect(changeset.statusTransitions).toHaveLength(0);
  });

  it("should auto-add problem ref when all plan tasks complete", async () => {
    // Plan in planning/todo with all tasks about to be completed
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      PLAN_WITH_2_TASKS_1_DONE,
    );
    await createFile(
      tempRoot,
      "_private/docs/problems/2026-01-01-my-feature/README.md",
      PROBLEM_README_IMPLEMENTING,
    );

    // Only plan task ref, no explicit problem ref — should auto-add
    const trailers: CommitTrailers[] = [
      {
        commitSha: "abc1234",
        planTasks: [{ slug: "my-feature", taskNumber: 2 }],
        problems: [], // no explicit problem ref
      },
    ];

    const changeset = await buildChangeset(tempRoot, trailers);

    // Should still attempt status transition because all tasks done auto-adds problem
    expect(changeset.statusTransitions).toHaveLength(1);
    expect(changeset.statusTransitions[0].from).toBe("implementing");
    expect(changeset.statusTransitions[0].to).toBe("testing");
  });

  it("should not transition when status has no safe transition", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      PLAN_WITH_2_TASKS_1_DONE,
    );
    await createFile(
      tempRoot,
      "_private/docs/problems/2026-01-01-my-feature/README.md",
      PROBLEM_README_TESTING, // "testing" has no safe transition target
    );

    const trailers: CommitTrailers[] = [
      {
        commitSha: "abc1234",
        planTasks: [{ slug: "my-feature", taskNumber: 2 }],
        problems: [{ slug: "my-feature" }],
      },
    ];

    const changeset = await buildChangeset(tempRoot, trailers);

    expect(changeset.statusTransitions).toHaveLength(0);
  });
});

// CC-04: property-based test — never throws on valid inputs
describe("buildChangeset property tests", () => {
  it("never throws on valid trailers + valid workspace structure", async () => {
    const slugArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,15}[a-z0-9]$/);
    const taskNumArb = fc.integer({ min: 1, max: 20 });

    await fc.assert(
      fc.asyncProperty(slugArb, taskNumArb, async (slug, taskNum) => {
        const dir = await makeTempRoot();
        try {
          // Create a valid plan file
          await createFile(
            dir,
            `_private/docs/planning/todo/2026-01-01-${slug}.plan.md`,
            `# Plan\n- [ ] Task one\n`,
          );

          const trailers: CommitTrailers[] = [
            {
              commitSha: "abc1234",
              planTasks: [{ slug, taskNumber: taskNum }],
              problems: [],
            },
          ];

          const changeset = await buildChangeset(dir, trailers);
          expect(changeset).toBeDefined();
          expect(Array.isArray(changeset.planUpdates)).toBe(true);
          expect(Array.isArray(changeset.statusTransitions)).toBe(true);
          expect(Array.isArray(changeset.fileMoves)).toBe(true);
          expect(Array.isArray(changeset.reminders)).toBe(true);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 20 },
    );
  });
});
