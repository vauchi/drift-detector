/**
 * Tests for CLI audit mode
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DriftDatabase } from "../src/db/database.js";
import {
  parseCliArgs,
  runAudit,
  formatAuditOutput,
  formatCiOutput,
  type CliArgs,
  type AuditResult,
} from "../src/cli.js";
import type { DriftItem } from "../src/server.js";

/** Helper to create a default CliArgs for testing */
function defaultArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    command: "audit",
    ci: false,
    failOn: "high",
    severity: "all",
    scope: "all",
    category: null,
    limit: 0,
    groupBy: null,
    verbose: false,
    ...overrides,
  };
}

/** Helper to create a DriftItem for formatting tests */
function makeDriftItem(overrides: Partial<DriftItem> = {}): DriftItem {
  return {
    severity: "high",
    category: "missing_test",
    message: "Scenario has no test coverage",
    suggestion: "Create a test",
    filePath: "/project/features/auth.feature",
    line: 10,
    ...overrides,
  };
}

describe("CLI audit mode", () => {
  describe("parseCliArgs", () => {
    it("should parse 'audit --ci' with defaults", () => {
      const args = parseCliArgs(["audit", "--ci"]);
      expect(args).toBeDefined();
      expect(args!.command).toBe("audit");
      expect(args!.ci).toBe(true);
      expect(args!.failOn).toBe("high");
    });

    it("should parse 'audit --ci --fail-on=medium'", () => {
      const args = parseCliArgs(["audit", "--ci", "--fail-on=medium"]);
      expect(args!.failOn).toBe("medium");
    });

    it("should parse 'audit --ci --fail-on=low'", () => {
      const args = parseCliArgs(["audit", "--ci", "--fail-on=low"]);
      expect(args!.failOn).toBe("low");
    });

    it("should return null for no arguments (MCP mode)", () => {
      const args = parseCliArgs([]);
      expect(args).toBeNull();
    });

    it("should return null for unknown commands", () => {
      const args = parseCliArgs(["unknown"]);
      expect(args).toBeNull();
    });

    it("should have correct defaults for new fields", () => {
      const args = parseCliArgs(["audit"]);
      expect(args!.severity).toBe("all");
      expect(args!.scope).toBe("all");
      expect(args!.category).toBeNull();
      expect(args!.limit).toBe(0);
      expect(args!.groupBy).toBeNull();
      expect(args!.verbose).toBe(false);
    });

    it("should parse --severity=high", () => {
      const args = parseCliArgs(["audit", "--severity=high"]);
      expect(args!.severity).toBe("high");
    });

    it("should parse --severity=medium", () => {
      const args = parseCliArgs(["audit", "--severity=medium"]);
      expect(args!.severity).toBe("medium");
    });

    it("should parse --severity=low", () => {
      const args = parseCliArgs(["audit", "--severity=low"]);
      expect(args!.severity).toBe("low");
    });

    it("should ignore invalid --severity values", () => {
      const args = parseCliArgs(["audit", "--severity=invalid"]);
      expect(args!.severity).toBe("all");
    });

    it("should parse --scope=features", () => {
      const args = parseCliArgs(["audit", "--scope=features"]);
      expect(args!.scope).toBe("features");
    });

    it("should parse --scope=tests", () => {
      const args = parseCliArgs(["audit", "--scope=tests"]);
      expect(args!.scope).toBe("tests");
    });

    it("should parse --scope=docs", () => {
      const args = parseCliArgs(["audit", "--scope=docs"]);
      expect(args!.scope).toBe("docs");
    });

    it("should parse --scope=code", () => {
      const args = parseCliArgs(["audit", "--scope=code"]);
      expect(args!.scope).toBe("code");
    });

    it("should ignore the retired --scope=design value", () => {
      const args = parseCliArgs(["audit", "--scope=design"]);
      expect(args!.scope).toBe("all");
    });

    it("should ignore invalid --scope values", () => {
      const args = parseCliArgs(["audit", "--scope=invalid"]);
      expect(args!.scope).toBe("all");
    });

    it("should parse --category=missing_test", () => {
      const args = parseCliArgs(["audit", "--category=missing_test"]);
      expect(args!.category).toBe("missing_test");
    });

    it("should parse --limit=50", () => {
      const args = parseCliArgs(["audit", "--limit=50"]);
      expect(args!.limit).toBe(50);
    });

    it("should ignore non-numeric --limit values", () => {
      const args = parseCliArgs(["audit", "--limit=abc"]);
      expect(args!.limit).toBe(0);
    });

    it("should ignore negative --limit values", () => {
      const args = parseCliArgs(["audit", "--limit=-5"]);
      expect(args!.limit).toBe(0);
    });

    it("should parse --group-by=category", () => {
      const args = parseCliArgs(["audit", "--group-by=category"]);
      expect(args!.groupBy).toBe("category");
    });

    it("should parse --group-by=severity", () => {
      const args = parseCliArgs(["audit", "--group-by=severity"]);
      expect(args!.groupBy).toBe("severity");
    });

    it("should parse --group-by=file", () => {
      const args = parseCliArgs(["audit", "--group-by=file"]);
      expect(args!.groupBy).toBe("file");
    });

    it("should ignore invalid --group-by values", () => {
      const args = parseCliArgs(["audit", "--group-by=invalid"]);
      expect(args!.groupBy).toBeNull();
    });

    it("should parse --verbose flag", () => {
      const args = parseCliArgs(["audit", "--verbose"]);
      expect(args!.verbose).toBe(true);
    });

    it("should parse -v flag", () => {
      const args = parseCliArgs(["audit", "-v"]);
      expect(args!.verbose).toBe(true);
    });

    it("should parse multiple flags together", () => {
      const args = parseCliArgs([
        "audit",
        "--severity=high",
        "--scope=features",
        "--category=missing_test",
        "--limit=10",
        "--group-by=category",
        "--verbose",
        "--fail-on=medium",
      ]);
      expect(args!.severity).toBe("high");
      expect(args!.scope).toBe("features");
      expect(args!.category).toBe("missing_test");
      expect(args!.limit).toBe(10);
      expect(args!.groupBy).toBe("category");
      expect(args!.verbose).toBe(true);
      expect(args!.failOn).toBe("medium");
    });
  });

  describe("runAudit", () => {
    let db: DriftDatabase;

    beforeEach(() => {
      db = new DriftDatabase(":memory:");
      db.initialize();
    });

    afterEach(() => {
      db.close();
    });

    it("should return exit code 0 when no drift", () => {
      const result = runAudit(db, defaultArgs());
      expect(result.exitCode).toBe(0);
      expect(result.totalDrift).toBe(0);
      expect(result.items).toEqual([]);
    });

    it("should return exit code 1 when high-severity drift found and failOn=high", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login scenario",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const result = runAudit(db, defaultArgs());
      expect(result.exitCode).toBe(1);
      expect(result.highCount).toBeGreaterThan(0);
      expect(result.items.length).toBeGreaterThan(0);
    });

    it("should return exit code 0 when only medium drift and failOn=high", () => {
      const fileId = db.insertFile("/test/auth_test.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "test_something",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      const result = runAudit(db, defaultArgs());
      expect(result.exitCode).toBe(0);
    });

    it("should return exit code 1 when medium drift and failOn=medium", () => {
      const fileId = db.insertFile("/test/auth_test.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "test_something",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      const result = runAudit(db, defaultArgs({ failOn: "medium" }));
      expect(result.exitCode).toBe(1);
      expect(result.mediumCount).toBeGreaterThan(0);
    });

    it("should include summary counts", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const result = runAudit(db, defaultArgs());
      expect(typeof result.highCount).toBe("number");
      expect(typeof result.mediumCount).toBe("number");
      expect(typeof result.lowCount).toBe("number");
      expect(typeof result.totalDrift).toBe("number");
    });

    it("should return items array in result", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login scenario",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const result = runAudit(db, defaultArgs());
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items[0]).toHaveProperty("severity");
      expect(result.items[0]).toHaveProperty("category");
      expect(result.items[0]).toHaveProperty("message");
    });

    it("should filter items by category", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login scenario",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const result = runAudit(db, defaultArgs({ category: "missing_test" }));
      for (const item of result.items) {
        expect(item.category).toBe("missing_test");
      }
    });

    it("should filter items by category and exclude non-matching", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login scenario",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const result = runAudit(db, defaultArgs({ category: "naming_drift" }));
      expect(result.items.length).toBe(0);
    });

    it("should include filteredCount in result", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login scenario",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const all = runAudit(db, defaultArgs());
      const filtered = runAudit(db, defaultArgs({ severity: "high" }));
      expect(filtered.filteredCount).toBeLessThanOrEqual(all.totalDrift);
    });
  });

  describe("formatAuditOutput", () => {
    it("should show summary header for unfiltered results", () => {
      const result: AuditResult = {
        exitCode: 0,
        items: [],
        totalDrift: 100,
        filteredCount: 100,
        highCount: 10,
        mediumCount: 50,
        lowCount: 40,
      };

      const output = formatAuditOutput(result, defaultArgs());
      expect(output).toContain("Drift Audit: 100 items found");
      expect(output).toContain("High: 10");
      expect(output).toContain("Medium: 50");
      expect(output).toContain("Low: 40");
    });

    it("should show filtered header when counts differ", () => {
      const result: AuditResult = {
        exitCode: 1,
        items: [makeDriftItem()],
        totalDrift: 100,
        filteredCount: 1,
        highCount: 10,
        mediumCount: 50,
        lowCount: 40,
      };

      const output = formatAuditOutput(
        result,
        defaultArgs({ severity: "high" }),
      );
      expect(output).toContain("1 items (filtered from 100 total)");
    });

    it("should show FAIL message when exitCode > 0", () => {
      const result: AuditResult = {
        exitCode: 1,
        items: [],
        totalDrift: 10,
        filteredCount: 10,
        highCount: 10,
        mediumCount: 0,
        lowCount: 0,
      };

      const output = formatAuditOutput(result, defaultArgs());
      expect(output).toContain(
        'FAIL: Drift at or above "high" severity found.',
      );
    });

    it("should show PASS message when exitCode is 0", () => {
      const result: AuditResult = {
        exitCode: 0,
        items: [],
        totalDrift: 0,
        filteredCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
      };

      const output = formatAuditOutput(result, defaultArgs());
      expect(output).toContain("PASS: No drift at or above threshold.");
    });

    it("should strip projectRoot from file paths", () => {
      const item = makeDriftItem({
        filePath: "/project/features/auth.feature",
      });
      const result: AuditResult = {
        exitCode: 1,
        items: [item],
        totalDrift: 1,
        filteredCount: 1,
        highCount: 1,
        mediumCount: 0,
        lowCount: 0,
      };

      const output = formatAuditOutput(result, defaultArgs(), "/project");
      expect(output).toContain("features/auth.feature:10");
      expect(output).not.toContain("/project/features/auth.feature");
    });

    it("should show suggestion in verbose mode", () => {
      const item = makeDriftItem({
        suggestion: "Create a test for this scenario",
      });
      const result: AuditResult = {
        exitCode: 1,
        items: [item],
        totalDrift: 1,
        filteredCount: 1,
        highCount: 1,
        mediumCount: 0,
        lowCount: 0,
      };

      const output = formatAuditOutput(result, defaultArgs({ verbose: true }));
      expect(output).toContain("Suggestion: Create a test for this scenario");
    });

    it("should not show suggestion without verbose mode", () => {
      const item = makeDriftItem({
        suggestion: "Create a test for this scenario",
      });
      const result: AuditResult = {
        exitCode: 1,
        items: [item],
        totalDrift: 1,
        filteredCount: 1,
        highCount: 1,
        mediumCount: 0,
        lowCount: 0,
      };

      const output = formatAuditOutput(result, defaultArgs({ verbose: false }));
      expect(output).not.toContain("Suggestion:");
    });

    it("should group items by category", () => {
      const items = [
        makeDriftItem({ category: "missing_test", message: "msg1" }),
        makeDriftItem({ category: "missing_test", message: "msg2" }),
        makeDriftItem({ category: "missing_doc", message: "msg3" }),
      ];
      const result: AuditResult = {
        exitCode: 1,
        items,
        totalDrift: 3,
        filteredCount: 3,
        highCount: 3,
        mediumCount: 0,
        lowCount: 0,
      };

      const output = formatAuditOutput(
        result,
        defaultArgs({ groupBy: "category" }),
      );
      expect(output).toContain("=== MISSING_TEST (2) ===");
      expect(output).toContain("=== MISSING_DOC (1) ===");
    });

    it("should group items by severity", () => {
      const items = [
        makeDriftItem({ severity: "high", message: "msg1" }),
        makeDriftItem({ severity: "medium", message: "msg2" }),
      ];
      const result: AuditResult = {
        exitCode: 1,
        items,
        totalDrift: 2,
        filteredCount: 2,
        highCount: 1,
        mediumCount: 1,
        lowCount: 0,
      };

      const output = formatAuditOutput(
        result,
        defaultArgs({ groupBy: "severity" }),
      );
      expect(output).toContain("=== HIGH (1) ===");
      expect(output).toContain("=== MEDIUM (1) ===");
    });

    it("should show '... and N more' when group exceeds limit", () => {
      const items = Array.from({ length: 5 }, (_, i) =>
        makeDriftItem({ category: "missing_test", message: `msg${i}` }),
      );
      const result: AuditResult = {
        exitCode: 1,
        items,
        totalDrift: 5,
        filteredCount: 5,
        highCount: 5,
        mediumCount: 0,
        lowCount: 0,
      };

      const output = formatAuditOutput(
        result,
        defaultArgs({ groupBy: "category", limit: 2 }),
      );
      expect(output).toContain("... and 3 more");
    });

    it("should not show items in CI mode", () => {
      const item = makeDriftItem();
      const result: AuditResult = {
        exitCode: 1,
        items: [item],
        totalDrift: 1,
        filteredCount: 1,
        highCount: 1,
        mediumCount: 0,
        lowCount: 0,
      };

      const output = formatAuditOutput(result, defaultArgs({ ci: true }));
      expect(output).not.toContain("auth.feature:10");
    });
  });

  describe("formatCiOutput", () => {
    it("should output valid JSON", () => {
      const result: AuditResult = {
        exitCode: 1,
        items: [makeDriftItem()],
        totalDrift: 100,
        filteredCount: 1,
        highCount: 10,
        mediumCount: 50,
        lowCount: 40,
      };

      const output = formatCiOutput(result);
      const parsed = JSON.parse(output);
      expect(parsed.exitCode).toBe(1);
      expect(parsed.totalDrift).toBe(100);
      expect(parsed.filteredCount).toBe(1);
      expect(parsed.highCount).toBe(10);
      expect(parsed.mediumCount).toBe(50);
      expect(parsed.lowCount).toBe(40);
    });

    it("should include items array in JSON output", () => {
      const item = makeDriftItem({
        severity: "high",
        category: "missing_test",
        message: "No test",
        filePath: "/project/auth.feature",
        line: 20,
        suggestion: "Add test",
      });
      const result: AuditResult = {
        exitCode: 1,
        items: [item],
        totalDrift: 1,
        filteredCount: 1,
        highCount: 1,
        mediumCount: 0,
        lowCount: 0,
      };

      const parsed = JSON.parse(formatCiOutput(result));
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].severity).toBe("high");
      expect(parsed.items[0].category).toBe("missing_test");
      expect(parsed.items[0].message).toBe("No test");
      expect(parsed.items[0].line).toBe(20);
      expect(parsed.items[0].suggestion).toBe("Add test");
    });

    it("should strip projectRoot from file paths in JSON", () => {
      const item = makeDriftItem({
        filePath: "/project/features/auth.feature",
      });
      const result: AuditResult = {
        exitCode: 1,
        items: [item],
        totalDrift: 1,
        filteredCount: 1,
        highCount: 1,
        mediumCount: 0,
        lowCount: 0,
      };

      const parsed = JSON.parse(formatCiOutput(result, "/project"));
      expect(parsed.items[0].filePath).toBe("features/auth.feature");
    });

    it("should output empty items array when no items", () => {
      const result: AuditResult = {
        exitCode: 0,
        items: [],
        totalDrift: 0,
        filteredCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
      };

      const parsed = JSON.parse(formatCiOutput(result));
      expect(parsed.items).toEqual([]);
    });
  });
});
