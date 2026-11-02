/**
 * Tests for problem record status parsing and updating
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  parseStatus,
  updateStatus,
  updateLastUpdated,
  addReminder,
  SAFE_TRANSITIONS,
  GATED_REMINDERS,
} from "../../src/sync/problem-updater.js";

const README = [
  "# Problem: Design Token System",
  "",
  "| Field | Value |",
  "|-------|-------|",
  "| **Status** | implementing |",
  "| **Priority** | medium |",
  "| **Owner** | megloff1 |",
  "| **Created** | 2026-03-01 |",
  "| **Last Updated** | 2026-03-05 |",
  "",
  "## Artifacts",
  "- [x] investigation.md",
  "- [x] implementation-plan.md",
  "- [x] plan.md",
  "- [ ] retrospective.md",
].join("\n");

describe("parseStatus", () => {
  it("should extract status from markdown table", () => {
    expect(parseStatus(README)).toBe("implementing");
  });

  it("should return null when no status field exists", () => {
    const noStatus = [
      "# Problem: Something",
      "",
      "| Field | Value |",
      "|-------|-------|",
      "| **Priority** | medium |",
    ].join("\n");
    expect(parseStatus(noStatus)).toBeNull();
  });

  // CC-11: failure path
  it("should return null for empty content", () => {
    expect(parseStatus("")).toBeNull();
  });

  it("should handle extra whitespace around status value", () => {
    const content = "| **Status** |   testing   |";
    expect(parseStatus(content)).toBe("testing");
  });
});

describe("updateStatus", () => {
  it("should replace status field value", () => {
    const result = updateStatus(README, "testing");
    expect(parseStatus(result)).toBe("testing");
    // Other fields unchanged
    expect(result).toContain("| **Priority** | medium |");
    expect(result).toContain("| **Owner** | megloff1 |");
  });

  it("should preserve all other content", () => {
    const result = updateStatus(README, "testing");
    const lines = result.split("\n");
    expect(lines[0]).toBe("# Problem: Design Token System");
    expect(lines[5]).toBe("| **Priority** | medium |");
  });

  // CC-11: failure path — no status field
  it("should return content unchanged when no status field exists", () => {
    const noStatus = "# Problem\n\nSome content without a table.";
    const result = updateStatus(noStatus, "testing");
    expect(result).toBe(noStatus);
  });
});

describe("updateLastUpdated", () => {
  it("should replace the Last Updated date", () => {
    const result = updateLastUpdated(README, "2026-03-12");
    expect(result).toContain("| **Last Updated** | 2026-03-12 |");
    // Original date gone
    expect(result).not.toContain("2026-03-05");
  });

  it("should preserve all other fields", () => {
    const result = updateLastUpdated(README, "2026-03-12");
    expect(result).toContain("| **Status** | implementing |");
    expect(result).toContain("| **Created** | 2026-03-01 |");
  });

  // CC-11: failure path — no Last Updated field
  it("should return content unchanged when no Last Updated field exists", () => {
    const noDate = "# Problem\n\nNo table here.";
    const result = updateLastUpdated(noDate, "2026-03-12");
    expect(result).toBe(noDate);
  });
});

describe("addReminder", () => {
  it("should add an unchecked item to the Artifacts section", () => {
    const result = addReminder(README, "review.md");
    expect(result).toContain("- [ ] review.md");
  });

  it("should be idempotent — does not duplicate existing items", () => {
    const result = addReminder(README, "retrospective.md");
    // retrospective.md already exists as "- [ ] retrospective.md"
    expect(result).toBe(README);
  });

  it("should not duplicate checked items either", () => {
    const result = addReminder(README, "investigation.md");
    // investigation.md already exists as "- [x] investigation.md"
    expect(result).toBe(README);
  });

  // CC-11: failure path — no Artifacts section
  it("should return content unchanged when no Artifacts section exists", () => {
    const noArtifacts = "# Problem\n\nNo artifacts section here.";
    const result = addReminder(noArtifacts, "review.md");
    expect(result).toBe(noArtifacts);
  });

  // CC-11: failure path — empty content
  it("should return empty string for empty content", () => {
    const result = addReminder("", "review.md");
    expect(result).toBe("");
  });
});

describe("SAFE_TRANSITIONS", () => {
  it("should allow implementing to testing", () => {
    expect(SAFE_TRANSITIONS["implementing"]).toBe("testing");
  });

  it("should not auto-advance intake (requires file-existence check)", () => {
    expect(SAFE_TRANSITIONS["intake"]).toBeUndefined();
  });

  it("should not allow testing as a source status", () => {
    expect(SAFE_TRANSITIONS["testing"]).toBeUndefined();
  });
});

describe("GATED_REMINDERS", () => {
  it("should require retrospective for testing status", () => {
    expect(GATED_REMINDERS["testing"]).toBe(
      "retrospective.md needed before advancing to done",
    );
  });
});

// CC-04: property-based tests
describe("updateStatus property tests", () => {
  const statusArb = fc.stringMatching(/^[a-z][a-z-]{0,20}$/);

  it("never corrupts other fields when updating status", () => {
    fc.assert(
      fc.property(statusArb, (newStatus) => {
        const result = updateStatus(README, newStatus);
        // All non-status fields must be preserved
        expect(result).toContain("| **Priority** | medium |");
        expect(result).toContain("| **Owner** | megloff1 |");
        expect(result).toContain("| **Created** | 2026-03-01 |");
        expect(result).toContain("| **Last Updated** | 2026-03-05 |");
        expect(result).toContain("# Problem: Design Token System");
        expect(result).toContain("## Artifacts");
        // Status should be updated
        expect(parseStatus(result)).toBe(newStatus);
      }),
      { numRuns: 200 },
    );
  });

  it("roundtrips — parseStatus returns what updateStatus set", () => {
    fc.assert(
      fc.property(statusArb, (newStatus) => {
        const result = updateStatus(README, newStatus);
        expect(parseStatus(result)).toBe(newStatus);
      }),
      { numRuns: 200 },
    );
  });
});
