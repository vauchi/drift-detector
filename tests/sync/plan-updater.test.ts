/**
 * Tests for plan file task marking and counting
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { markTasksDone, countTasks } from "../../src/sync/plan-updater.js";

describe("markTasksDone", () => {
  const planContent = [
    "## Phase 1: Schema & Format",
    "",
    "1. [x] Design new schema",
    "2. [ ] Migrate all themes",
    "3. [ ] Update validate.py",
    "",
    "## Phase 2: Generator Script",
    "",
    "4. [ ] Write generate.py",
    "5. [ ] Add generated/ to .gitignore",
    "6. [ ] Write tests for generate.py",
  ].join("\n");

  it("should mark specific tasks as done", () => {
    const result = markTasksDone(planContent, [2, 4]);
    const lines = result.split("\n");
    expect(lines[3]).toBe("2. [x] Migrate all themes");
    expect(lines[4]).toBe("3. [ ] Update validate.py");
    expect(lines[8]).toBe("4. [x] Write generate.py");
    expect(lines[9]).toBe("5. [ ] Add generated/ to .gitignore");
  });

  it("should be idempotent — marking already-done task returns same content", () => {
    const result = markTasksDone(planContent, [1]);
    expect(result).toBe(planContent);
  });

  it("should handle unordered list items", () => {
    const unorderedContent = [
      "## Tasks",
      "",
      "- [ ] First task",
      "- [ ] Second task",
      "- [x] Third task",
    ].join("\n");

    const result = markTasksDone(unorderedContent, [2]);
    const lines = result.split("\n");
    expect(lines[3]).toBe("- [x] Second task");
    // Others unchanged
    expect(lines[2]).toBe("- [ ] First task");
    expect(lines[4]).toBe("- [x] Third task");
  });

  it("should handle indented subtasks", () => {
    const indentedContent = [
      "## Tasks",
      "",
      "1. [ ] Parent task",
      "  - [ ] Subtask A",
      "  - [ ] Subtask B",
      "2. [ ] Another task",
    ].join("\n");

    const result = markTasksDone(indentedContent, [2, 4]);
    const lines = result.split("\n");
    expect(lines[3]).toBe("  - [x] Subtask A");
    expect(lines[4]).toBe("  - [ ] Subtask B");
    expect(lines[5]).toBe("2. [x] Another task");
  });

  // CC-11: failure paths
  it("should return empty string for empty content", () => {
    const result = markTasksDone("", [1, 2]);
    expect(result).toBe("");
  });

  it("should return content unchanged for out-of-range task numbers", () => {
    const result = markTasksDone(planContent, [99, 0, -1]);
    expect(result).toBe(planContent);
  });

  it("should return content unchanged for empty task number array", () => {
    const result = markTasksDone(planContent, []);
    expect(result).toBe(planContent);
  });
});

describe("countTasks", () => {
  it("should count total and done tasks correctly", () => {
    const content = [
      "1. [x] Done task",
      "2. [ ] Pending task",
      "- [x] Another done",
      "- [ ] Another pending",
    ].join("\n");

    const result = countTasks(content);
    expect(result).toEqual({ total: 4, done: 2 });
  });

  it("should return zeros for empty content", () => {
    const result = countTasks("");
    expect(result).toEqual({ total: 0, done: 0 });
  });

  it("should count mixed ordered and unordered lists", () => {
    const content = [
      "## Phase 1",
      "1. [x] Design new schema",
      "2. [ ] Migrate all themes",
      "",
      "## Phase 2",
      "- [ ] Write generate.py",
      "- [x] Add generated/ to .gitignore",
      "  - [ ] Subtask",
    ].join("\n");

    const result = countTasks(content);
    expect(result).toEqual({ total: 5, done: 2 });
  });

  it("should not count non-checkbox lines", () => {
    const content = [
      "## Not a task",
      "Some paragraph text",
      "- Regular list item without checkbox",
      "1. Regular ordered item",
      "- [x] Actual task",
    ].join("\n");

    const result = countTasks(content);
    expect(result).toEqual({ total: 1, done: 1 });
  });
});

// CC-04: property-based tests
describe("markTasksDone property tests", () => {
  const checkboxLineArb = fc.oneof(
    fc
      .tuple(fc.boolean(), fc.string({ minLength: 1, maxLength: 30 }))
      .map(
        ([done, desc]) => `- [${done ? "x" : " "}] ${desc.replace(/\n/g, " ")}`,
      ),
    fc
      .tuple(
        fc.boolean(),
        fc.integer({ min: 1, max: 20 }),
        fc.string({ minLength: 1, maxLength: 30 }),
      )
      .map(
        ([done, num, desc]) =>
          `${num}. [${done ? "x" : " "}] ${desc.replace(/\n/g, " ")}`,
      ),
  );

  const planArb = fc
    .array(
      fc.oneof(
        checkboxLineArb,
        fc.constant(""),
        fc.constant("## Section Header"),
        fc.constant("Some paragraph text"),
      ),
      { minLength: 0, maxLength: 20 },
    )
    .map((lines) => lines.join("\n"));

  it("never throws on arbitrary content and task numbers", () => {
    fc.assert(
      fc.property(
        planArb,
        fc.array(fc.integer({ min: -5, max: 50 }), {
          minLength: 0,
          maxLength: 10,
        }),
        (content, taskNumbers) => {
          expect(() => markTasksDone(content, taskNumbers)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("result content length stays reasonable (within 2x original + 1)", () => {
    fc.assert(
      fc.property(
        planArb,
        fc.array(fc.integer({ min: 1, max: 50 }), {
          minLength: 0,
          maxLength: 10,
        }),
        (content, taskNumbers) => {
          const result = markTasksDone(content, taskNumbers);
          // Marking tasks only changes ' ' to 'x', so length should stay the same
          expect(result.length).toBeLessThanOrEqual(content.length + 1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("is idempotent — applying twice gives same result", () => {
    fc.assert(
      fc.property(
        planArb,
        fc.array(fc.integer({ min: 1, max: 50 }), {
          minLength: 0,
          maxLength: 10,
        }),
        (content, taskNumbers) => {
          const first = markTasksDone(content, taskNumbers);
          const second = markTasksDone(first, taskNumbers);
          expect(second).toBe(first);
        },
      ),
      { numRuns: 200 },
    );
  });
});
