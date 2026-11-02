/**
 * Tests for .driftignore parser and matching
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseDriftIgnore,
  loadDriftIgnore,
  shouldIgnore,
} from "../src/driftignore.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

describe("driftignore", () => {
  describe("parseDriftIgnore", () => {
    it("should parse a pattern with all categories", () => {
      const rules = parseDriftIgnore("target/**");
      expect(rules).toHaveLength(1);
      expect(rules[0].pattern).toBe("target/**");
      expect(rules[0].categories).toEqual(["*"]);
    });

    it("should parse a pattern with specific category", () => {
      const rules = parseDriftIgnore("src/internal/** missing_doc");
      expect(rules).toHaveLength(1);
      expect(rules[0].pattern).toBe("src/internal/**");
      expect(rules[0].categories).toEqual(["missing_doc"]);
    });

    it("should parse a pattern with multiple categories", () => {
      const rules = parseDriftIgnore("src/gen/** missing_doc,missing_test");
      expect(rules).toHaveLength(1);
      expect(rules[0].categories).toEqual(["missing_doc", "missing_test"]);
    });

    it("should skip comments", () => {
      const rules = parseDriftIgnore("# This is a comment\ntarget/**");
      expect(rules).toHaveLength(1);
      expect(rules[0].pattern).toBe("target/**");
    });

    it("should skip empty lines", () => {
      const rules = parseDriftIgnore("\n\ntarget/**\n\nsrc/**\n");
      expect(rules).toHaveLength(2);
    });

    it("should parse multiple rules", () => {
      const content = `# Generated files
target/**

# Internal modules
src/internal/** missing_doc

# Draft features
_private/features/** missing_test`;
      const rules = parseDriftIgnore(content);
      expect(rules).toHaveLength(3);
      expect(rules[0].pattern).toBe("target/**");
      expect(rules[0].categories).toEqual(["*"]);
      expect(rules[1].pattern).toBe("src/internal/**");
      expect(rules[1].categories).toEqual(["missing_doc"]);
      expect(rules[2].pattern).toBe("_private/features/**");
      expect(rules[2].categories).toEqual(["missing_test"]);
    });

    it("should return empty array for empty content", () => {
      expect(parseDriftIgnore("")).toEqual([]);
    });

    it("should return empty array for comment-only content", () => {
      expect(parseDriftIgnore("# Just a comment")).toEqual([]);
    });
  });

  describe("shouldIgnore", () => {
    it("should match files with wildcard category", () => {
      const rules = parseDriftIgnore("target/**");
      expect(shouldIgnore("target/debug/main.rs", "missing_test", rules)).toBe(
        true,
      );
      expect(shouldIgnore("target/debug/main.rs", "missing_doc", rules)).toBe(
        true,
      );
    });

    it("should match files with specific category", () => {
      const rules = parseDriftIgnore("src/internal/** missing_doc");
      expect(shouldIgnore("src/internal/helper.rs", "missing_doc", rules)).toBe(
        true,
      );
      expect(
        shouldIgnore("src/internal/helper.rs", "missing_test", rules),
      ).toBe(false);
    });

    it("should not match non-matching paths", () => {
      const rules = parseDriftIgnore("target/**");
      expect(shouldIgnore("src/lib.rs", "missing_test", rules)).toBe(false);
    });

    it("should work with multiple rules", () => {
      const rules = parseDriftIgnore("target/**\nsrc/gen/** missing_doc");
      expect(shouldIgnore("target/main.rs", "missing_test", rules)).toBe(true);
      expect(shouldIgnore("src/gen/bindings.rs", "missing_doc", rules)).toBe(
        true,
      );
      expect(shouldIgnore("src/gen/bindings.rs", "missing_test", rules)).toBe(
        false,
      );
      expect(shouldIgnore("src/lib.rs", "missing_doc", rules)).toBe(false);
    });

    it("should handle empty rules", () => {
      expect(shouldIgnore("any/file.rs", "missing_test", [])).toBe(false);
    });
  });

  describe("loadDriftIgnore", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "drift-ignore-test-"));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("should load rules from .driftignore file", async () => {
      await fs.writeFile(
        path.join(tempDir, ".driftignore"),
        "target/**\nsrc/gen/** missing_doc",
      );

      const rules = loadDriftIgnore(tempDir);
      expect(rules).toHaveLength(2);
    });

    it("should return empty array when no .driftignore exists", () => {
      const rules = loadDriftIgnore(tempDir);
      expect(rules).toEqual([]);
    });
  });
});
