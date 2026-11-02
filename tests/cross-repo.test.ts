/**
 * Tests for cross-repo drift detection
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DriftDatabase } from "../src/db/database.js";
import { checkParity, checkRepo } from "../src/cross-repo.js";

describe("Cross-repo drift detection", () => {
  let db: DriftDatabase;

  beforeEach(() => {
    db = new DriftDatabase(":memory:");
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  describe("checkParity", () => {
    it("should detect parity gap when concept exists in one repo but not another", () => {
      // "exchange" concept in core but not cli
      const coreFile = db.insertFile(
        "/core/src/exchange.rs",
        "hash1",
        "rust",
        "core",
      );
      db.insertEntity(coreFile, {
        name: "exchange_cards",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: ["exchange"],
        metadata: {},
      });

      const cliFile = db.insertFile("/cli/src/main.rs", "hash2", "rust", "cli");
      db.insertEntity(cliFile, {
        name: "run_cli",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: ["startup"],
        metadata: {},
      });

      const gaps = checkParity(db, ["core", "cli"]);
      const exchangeGap = gaps.find((g) => g.concept === "exchange");
      expect(exchangeGap).toBeDefined();
      expect(exchangeGap!.presentIn).toContain("core");
      expect(exchangeGap!.missingFrom).toContain("cli");
    });

    it("should not report gap when concept exists in all repos", () => {
      const coreFile = db.insertFile(
        "/core/src/exchange.rs",
        "hash1",
        "rust",
        "core",
      );
      db.insertEntity(coreFile, {
        name: "exchange_cards",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: ["exchange"],
        metadata: {},
      });

      const cliFile = db.insertFile(
        "/cli/src/exchange.rs",
        "hash2",
        "rust",
        "cli",
      );
      db.insertEntity(cliFile, {
        name: "cli_exchange",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: ["exchange"],
        metadata: {},
      });

      const gaps = checkParity(db, ["core", "cli"]);
      const exchangeGap = gaps.find((g) => g.concept === "exchange");
      expect(exchangeGap).toBeUndefined();
    });

    it("should return empty for no concepts", () => {
      const gaps = checkParity(db, ["core", "cli"]);
      expect(gaps).toEqual([]);
    });

    it("should ignore concepts that exist in no checked repos", () => {
      // Concept in "relay" but we only check core and cli
      const relayFile = db.insertFile(
        "/relay/src/lib.rs",
        "hash1",
        "rust",
        "relay",
      );
      db.insertEntity(relayFile, {
        name: "relay_handler",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: ["relay-only"],
        metadata: {},
      });

      const gaps = checkParity(db, ["core", "cli"]);
      expect(gaps.find((g) => g.concept === "relay-only")).toBeUndefined();
    });

    it("should report severity based on gap ratio", () => {
      // Concept in 1 out of 4 repos → high severity
      const coreFile = db.insertFile(
        "/core/src/lib.rs",
        "hash1",
        "rust",
        "core",
      );
      db.insertEntity(coreFile, {
        name: "sync_fn",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: ["sync"],
        metadata: {},
      });

      // 3 repos with no "sync" concept
      db.insertFile("/cli/src/main.rs", "hash2", "rust", "cli");
      db.insertFile("/tui/src/main.rs", "hash3", "rust", "tui");
      db.insertFile("/desktop/src/main.rs", "hash4", "rust", "desktop");

      const gaps = checkParity(db, ["core", "cli", "tui", "desktop"]);
      const syncGap = gaps.find((g) => g.concept === "sync");
      expect(syncGap).toBeDefined();
      expect(syncGap!.severity).toBe("high");
    });
  });

  describe("checkRepo", () => {
    it("should return repo summary with entity counts by layer", () => {
      const file1 = db.insertFile("/core/src/lib.rs", "hash1", "rust", "core");
      db.insertEntity(file1, {
        name: "create_contact",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: ["exchange"],
        metadata: {},
      });

      const file2 = db.insertFile(
        "/core/tests/test.rs",
        "hash2",
        "rust",
        "core",
      );
      db.insertEntity(file2, {
        name: "test_create_contact",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: ["exchange"],
        metadata: {},
      });

      const summary = checkRepo(db, "core");
      expect(summary.repo).toBe("core");
      expect(summary.fileCount).toBe(2);
      expect(summary.entityCount).toBe(2);
      expect(summary.entitiesByLayer.source).toBe(1);
      expect(summary.entitiesByLayer.unit_test).toBe(1);
      expect(summary.concepts).toContain("exchange");
    });

    it("should return empty summary for unknown repo", () => {
      const summary = checkRepo(db, "nonexistent");
      expect(summary.repo).toBe("nonexistent");
      expect(summary.fileCount).toBe(0);
      expect(summary.entityCount).toBe(0);
      expect(summary.concepts).toEqual([]);
    });
  });
});
