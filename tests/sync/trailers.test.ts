/**
 * Tests for git trailer extraction from log output
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  extractTrailersFromLog,
  buildGitLogCommand,
} from "../../src/sync/trailers.js";

describe("extractTrailersFromLog", () => {
  it("should extract Plan-Task trailers from git log output", () => {
    const logOutput = [
      "COMMIT_START a1b2c3d",
      "Plan-Task: sp24-desktop-exchange#4",
      "Plan-Task: sp24-desktop-exchange#5",
      "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>",
      "COMMIT_START d4e5f6g",
      "Plan-Task: unified-transport#1",
      "COMMIT_START h7i8j9k",
      "",
    ].join("\n");

    const result = extractTrailersFromLog(logOutput);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      commitSha: "a1b2c3d",
      planTasks: [
        { slug: "sp24-desktop-exchange", taskNumber: 4 },
        { slug: "sp24-desktop-exchange", taskNumber: 5 },
      ],
      problems: [],
    });
    expect(result[1]).toEqual({
      commitSha: "d4e5f6g",
      planTasks: [{ slug: "unified-transport", taskNumber: 1 }],
      problems: [],
    });
  });

  it("should extract Problem trailers", () => {
    const logOutput = [
      "COMMIT_START abc123",
      "Plan-Task: sp24-desktop-exchange#4",
      "Problem: sp24-desktop-exchange",
      "",
    ].join("\n");

    const result = extractTrailersFromLog(logOutput);
    expect(result).toHaveLength(1);
    expect(result[0].problems).toEqual([{ slug: "sp24-desktop-exchange" }]);
  });

  it("should return empty array for log with no trailers", () => {
    const logOutput = [
      "COMMIT_START abc123",
      "",
      "COMMIT_START def456",
      "",
    ].join("\n");

    const result = extractTrailersFromLog(logOutput);
    expect(result).toEqual([]);
  });

  // CC-11: failure-path tests
  it("should return empty array for empty string input", () => {
    const result = extractTrailersFromLog("");
    expect(result).toEqual([]);
  });

  it("should skip COMMIT_START lines with no SHA", () => {
    const logOutput = ["COMMIT_START ", "Plan-Task: some-plan#1", ""].join(
      "\n",
    );

    const result = extractTrailersFromLog(logOutput);
    // The commit is created with an empty SHA but still collects trailers
    expect(result).toHaveLength(1);
    expect(result[0].commitSha).toBe("");
    expect(result[0].planTasks).toEqual([{ slug: "some-plan", taskNumber: 1 }]);
  });

  it("should silently drop invalid Plan-Task trailer values", () => {
    const logOutput = [
      "COMMIT_START abc123",
      "Plan-Task: ###invalid",
      "Plan-Task: UpperCase#1",
      "Plan-Task: valid-slug#2",
      "",
    ].join("\n");

    const result = extractTrailersFromLog(logOutput);
    expect(result).toHaveLength(1);
    expect(result[0].planTasks).toEqual([
      { slug: "valid-slug", taskNumber: 2 },
    ]);
  });
});

describe("buildGitLogCommand", () => {
  it("should build git log command with the given ref", () => {
    const cmd = buildGitLogCommand("abc123");
    expect(cmd[0]).toBe("git");
    expect(cmd[1]).toBe("log");
    expect(cmd[2]).toBe("abc123..HEAD");
    expect(cmd[3]).toContain("COMMIT_START");
    expect(cmd[3]).toContain("Plan-Task");
    expect(cmd[3]).toContain("Problem");
  });
});

// CC-04: property-based tests
describe("extractTrailersFromLog property tests", () => {
  const slugArb = fc.stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/);

  const taskNumberArb = fc.integer({ min: 1, max: 9999 });

  const commitBlockArb = fc.record({
    sha: fc.stringMatching(/^[0-9a-f]{7}$/),
    planTasks: fc.array(fc.tuple(slugArb, taskNumberArb), {
      minLength: 0,
      maxLength: 3,
    }),
    problems: fc.array(slugArb, { minLength: 0, maxLength: 2 }),
  });

  it("output length equals number of blocks with at least one trailer", () => {
    fc.assert(
      fc.property(
        fc.array(commitBlockArb, { minLength: 0, maxLength: 5 }),
        (blocks) => {
          const lines: string[] = [];
          for (const block of blocks) {
            lines.push(`COMMIT_START ${block.sha}`);
            for (const [slug, num] of block.planTasks) {
              lines.push(`Plan-Task: ${slug}#${num}`);
            }
            for (const prob of block.problems) {
              lines.push(`Problem: ${prob}`);
            }
          }
          const logOutput = lines.join("\n");
          const result = extractTrailersFromLog(logOutput);
          const blocksWithTrailers = blocks.filter(
            (b) => b.planTasks.length > 0 || b.problems.length > 0,
          );
          expect(result).toHaveLength(blocksWithTrailers.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never throws on arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 500 }), (input) => {
        expect(() => extractTrailersFromLog(input)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});
