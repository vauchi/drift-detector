/**
 * Tests for MCP server
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createServer,
  detectDrift,
  computeOverview,
  computeCoverage,
  getAllConcepts,
} from "../src/server.js";
import { DriftDatabase } from "../src/db/database.js";
import { parseDriftIgnore } from "../src/driftignore.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { testConfig } from "./test-config.js";

describe("MCP Server", () => {
  let db: DriftDatabase;
  let tempDir: string;

  beforeEach(async () => {
    db = new DriftDatabase(":memory:");
    db.initialize();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "drift-server-test-"));
  });

  afterEach(async () => {
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("createServer", () => {
    it("should create a server with correct name and version", () => {
      const server = createServer(db, tempDir, testConfig());
      expect(server).toBeDefined();
    });
  });

  describe("reindex tool", () => {
    it("should index feature files and return results", async () => {
      await fs.writeFile(
        path.join(tempDir, "test.feature"),
        `@auth
Feature: Test Feature
  Scenario: Test Scenario
    Given something`,
      );

      const { Indexer } = await import("../src/indexer.js");
      const indexer = new Indexer(db, testConfig());
      const result = await indexer.indexDirectory(tempDir);

      expect(result.filesIndexed).toBe(1);
      expect(result.entitiesExtracted).toBeGreaterThan(0);
      expect(result).toHaveProperty("edgesCreated");
    });
  });

  describe("concept lookup", () => {
    it("should find concepts after indexing", async () => {
      await fs.writeFile(
        path.join(tempDir, "auth.feature"),
        `@auth @security
Feature: Authentication
  Scenario: Login
    Given I am on login page`,
      );

      const { Indexer } = await import("../src/indexer.js");
      const indexer = new Indexer(db, testConfig());
      await indexer.indexDirectory(tempDir);

      // @security tag creates the "security" concept
      const securityConcept = db.getConceptByName("security");
      expect(securityConcept).toBeDefined();
      expect(securityConcept!.source).toBe("tag");
    });
  });

  describe("search functionality", () => {
    it("should find entities by name via FTS", async () => {
      await fs.writeFile(
        path.join(tempDir, "contacts.feature"),
        `Feature: Contact Exchange
  Scenario: Share Contact
    Given I have a contact`,
      );

      const { Indexer } = await import("../src/indexer.js");
      const indexer = new Indexer(db, testConfig());
      await indexer.indexDirectory(tempDir);

      const results = db.searchEntities("Contact");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toContain("Contact");
    });
  });

  describe("coverage computation", () => {
    it("should compute layer coverage for concepts", async () => {
      await fs.writeFile(
        path.join(tempDir, "auth.feature"),
        `@auth
Feature: Auth Feature
  Scenario: Login
    Given credentials`,
      );

      const { Indexer } = await import("../src/indexer.js");
      const indexer = new Indexer(db, testConfig());
      await indexer.indexDirectory(tempDir);

      const featureEntities = db.getEntitiesByLayer("feature");
      expect(featureEntities.length).toBeGreaterThan(0);
    });
  });

  describe("detectDrift", () => {
    it("does not require design files for retired boundary models", async () => {
      const screenPath = path.join(tempDir, "core", "app_screen.rs");
      const componentPath = path.join(tempDir, "core", "component.rs");
      await fs.mkdir(path.dirname(screenPath), { recursive: true });
      await fs.mkdir(
        path.join(tempDir, "_private", "designs", "screens"),
        { recursive: true },
      );
      await fs.mkdir(
        path.join(tempDir, "_private", "designs", "components"),
        { recursive: true },
      );
      await fs.writeFile(screenPath, "pub enum AppScreen { Home }");
      await fs.writeFile(componentPath, "pub enum Component { Text }");

      const screenFileId = db.insertFile(
        "core/app_screen.rs",
        "screen-hash",
        "rust",
      );
      db.insertEntity(screenFileId, {
        name: "AppScreen",
        entityType: "enum",
        layer: "source",
        startLine: 1,
        endLine: 1,
        tags: [],
        metadata: {},
      });
      const componentFileId = db.insertFile(
        "core/component.rs",
        "component-hash",
        "rust",
      );
      db.insertEntity(componentFileId, {
        name: "Component",
        entityType: "enum",
        layer: "source",
        startLine: 1,
        endLine: 1,
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "design", "all", [], tempDir);

      expect(items).toEqual([]);
    });

    it("should detect missing_test for scenarios without test coverage", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "User logs in",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 8,
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "all", "all");
      const missingTests = items.filter((i) => i.category === "missing_test");
      expect(missingTests.length).toBeGreaterThan(0);
      expect(missingTests[0].severity).toBe("high");
      expect(missingTests[0].filePath).toBe("/test/auth.feature");
      expect(missingTests[0].line).toBe(3);
    });

    it("should not report missing_test when test matches by tags", () => {
      const fileId1 = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId1, {
        name: "User logs in",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 8,
        tags: ["auth"],
        metadata: {},
      });

      const fileId2 = db.insertFile("/test/auth_test.rs", "def", "rust");
      db.insertEntity(fileId2, {
        name: "test_login",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: ["auth"],
        metadata: {},
      });

      const items = detectDrift(db, "features", "all");
      const missingTests = items.filter(
        (i) =>
          i.category === "missing_test" && i.message.includes("User logs in"),
      );
      expect(missingTests).toHaveLength(0);
    });

    it("should detect missing_test for scenario_outline too", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login with various credentials",
        entityType: "scenario_outline",
        layer: "feature",
        startLine: 3,
        endLine: 15,
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "features", "all");
      const missingTests = items.filter((i) => i.category === "missing_test");
      expect(missingTests.length).toBeGreaterThan(0);
    });

    it("should detect missing_doc for public source entities", () => {
      const fileId = db.insertFile("/src/lib.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "create_contact",
        entityType: "function",
        layer: "source",
        startLine: 10,
        endLine: 30,
        visibility: "public",
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "docs", "all");
      const missingDocs = items.filter((i) => i.category === "missing_doc");
      expect(missingDocs.length).toBeGreaterThan(0);
      expect(missingDocs[0].severity).toBe("medium");
      expect(missingDocs[0].filePath).toBe("/src/lib.rs");
    });

    it("should not report missing_doc for private entities", () => {
      const fileId = db.insertFile("/src/lib.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "internal_helper",
        entityType: "function",
        layer: "source",
        startLine: 10,
        endLine: 20,
        visibility: "private",
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "docs", "all");
      const missingDocs = items.filter((i) => i.category === "missing_doc");
      expect(missingDocs).toHaveLength(0);
    });

    it("should detect missing_feature for tests without scenarios", () => {
      const fileId = db.insertFile("/test/auth_test.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "test_user_registration",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "features", "all");
      const missingFeatures = items.filter(
        (i) => i.category === "missing_feature",
      );
      expect(missingFeatures.length).toBeGreaterThan(0);
      expect(missingFeatures[0].severity).toBe("medium");
    });

    it("should detect orphan_test for tests without source (fallback)", () => {
      const fileId = db.insertFile("/test/orphan_test.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "test_nonexistent_module",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "tests", "all");
      const orphanTests = items.filter((i) => i.category === "orphan_test");
      expect(orphanTests.length).toBeGreaterThan(0);
      expect(orphanTests[0].severity).toBe("medium");
    });

    it("should detect orphan_code with edges present", () => {
      const fileId1 = db.insertFile("/src/orphan.rs", "abc", "rust");
      db.insertEntity(fileId1, {
        name: "orphan_function",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // Create an edge on a different entity so hasEdges = true
      const fileId2 = db.insertFile("/test/other.rs", "def", "rust");
      const entityId2 = db.insertEntity(fileId2, {
        name: "test_other",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });
      db.insertEdge(entityId2, entityId2, "tests", 1.0, "explicit");

      const items = detectDrift(db, "code", "all");
      const orphanCode = items.filter((i) => i.category === "orphan_code");
      expect(orphanCode.length).toBeGreaterThan(0);
      expect(orphanCode[0].severity).toBe("low");
    });

    it("should not detect orphan_code when no edges exist", () => {
      const fileId = db.insertFile("/src/lib.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "some_function",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // No edges at all → orphan_code is edge-only, should return empty
      const items = detectDrift(db, "code", "all");
      const orphanCode = items.filter((i) => i.category === "orphan_code");
      expect(orphanCode).toHaveLength(0);
    });

    it("should detect stale_api for API docs without source (no edges)", () => {
      const fileId = db.insertFile("/docs/api.md", "abc", "markdown");
      db.insertEntity(fileId, {
        name: "POST /api/contacts",
        entityType: "api_endpoint",
        layer: "user_doc",
        startLine: 5,
        endLine: 20,
        tags: [],
        metadata: {},
      });

      // No edges → falls back to name matching
      const items = detectDrift(db, "docs", "all");
      const staleApis = items.filter((i) => i.category === "stale_api");
      expect(staleApis.length).toBeGreaterThan(0);
      expect(staleApis[0].severity).toBe("high");
    });

    it("should detect stale_api with edges present", () => {
      const fileId = db.insertFile("/docs/api.md", "abc", "markdown");
      db.insertEntity(fileId, {
        name: "POST /api/contacts",
        entityType: "api_endpoint",
        layer: "user_doc",
        startLine: 5,
        endLine: 20,
        tags: [],
        metadata: {},
      });

      // Create an edge on a different entity so hasEdges = true
      const fileId2 = db.insertFile("/src/lib.rs", "def", "rust");
      const entityId2 = db.insertEntity(fileId2, {
        name: "handler",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });
      db.insertEdge(entityId2, entityId2, "references", 1.0, "explicit");

      const items = detectDrift(db, "docs", "all");
      const staleApis = items.filter((i) => i.category === "stale_api");
      expect(staleApis.length).toBeGreaterThan(0);
    });

    it("should detect naming_drift between entities of same concept", () => {
      const fileId1 = db.insertFile("/test/feature.feature", "abc", "gherkin");
      const entityId1 = db.insertEntity(fileId1, {
        name: "user authentication handler",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const fileId2 = db.insertFile("/test/auth_test.rs", "def", "rust");
      const entityId2 = db.insertEntity(fileId2, {
        name: "auth validate check",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      const conceptId = db.insertConcept("auth", "tag");
      db.linkEntityToConcept(entityId1, conceptId, 1.0);
      db.linkEntityToConcept(entityId2, conceptId, 1.0);

      const items = detectDrift(db, "all", "all");
      const namingDrift = items.filter((i) => i.category === "naming_drift");
      expect(namingDrift.length).toBeGreaterThan(0);
      expect(namingDrift[0].severity).toBe("low");
    });

    it("should filter by severity", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Scenario with no test",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const allItems = detectDrift(db, "all", "all");
      const highOnly = detectDrift(db, "all", "high");
      const lowOnly = detectDrift(db, "all", "low");

      expect(highOnly.every((i) => i.severity === "high")).toBe(true);
      expect(lowOnly.every((i) => i.severity === "low")).toBe(true);
      expect(allItems.length).toBeGreaterThanOrEqual(highOnly.length);
    });

    it("should scope drift to features", () => {
      const fileId1 = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId1, {
        name: "Login scenario",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const fileId2 = db.insertFile("/src/lib.rs", "def", "rust");
      db.insertEntity(fileId2, {
        name: "public_fn",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        visibility: "public",
        tags: [],
        metadata: {},
      });

      const featureItems = detectDrift(db, "features", "all");
      const docItems = detectDrift(db, "docs", "all");

      // Features scope should have missing_test and missing_feature, no missing_doc
      const categories = new Set(featureItems.map((i) => i.category));
      expect(categories.has("missing_doc")).toBe(false);

      // Docs scope should have missing_doc, no missing_test
      const docCategories = new Set(docItems.map((i) => i.category));
      expect(docCategories.has("missing_test")).toBe(false);
    });

    it("should resolve file paths correctly (regression for file_id bug)", () => {
      const fileId = db.insertFile("/project/test.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Some scenario",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 8,
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "features", "all");
      const missingTests = items.filter((i) => i.category === "missing_test");
      expect(missingTests.length).toBeGreaterThan(0);
      // Should resolve to actual path, not "unknown"
      expect(missingTests[0].filePath).toBe("/project/test.feature");
    });

    it("should not detect stale_doc when no edges exist", () => {
      const fileId = db.insertFile("/docs/api.md", "abc", "markdown");
      db.insertEntity(fileId, {
        name: "API Reference",
        entityType: "doc_section",
        layer: "dev_doc",
        startLine: 1,
        endLine: 50,
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "docs", "all");
      const staleDocs = items.filter((i) => i.category === "stale_doc");
      expect(staleDocs).toHaveLength(0);
    });

    it("should not report missing_test for problem-layer scenarios", () => {
      // Scenarios in _private/features/ get layer="problem" instead of "feature"
      const fileId = db.insertFile(
        "/_private/features/draft.feature",
        "abc",
        "gherkin",
      );
      db.insertEntity(fileId, {
        name: "Draft scenario",
        entityType: "scenario",
        layer: "problem",
        startLine: 3,
        endLine: 8,
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "features", "all");
      const missingTests = items.filter(
        (i) =>
          i.category === "missing_test" && i.message.includes("Draft scenario"),
      );
      expect(missingTests).toHaveLength(0);
    });

    it("should not report missing_doc for pub mod re-exports", () => {
      const fileId = db.insertFile("/src/lib.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "contacts",
        entityType: "module",
        layer: "source",
        startLine: 5,
        endLine: 5,
        visibility: "public",
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "docs", "all");
      const missingDocs = items.filter(
        (i) => i.category === "missing_doc" && i.message.includes("contacts"),
      );
      expect(missingDocs).toHaveLength(0);
    });

    it("should still report missing_doc for non-module public entities", () => {
      const fileId = db.insertFile("/src/lib.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "contacts",
        entityType: "module",
        layer: "source",
        startLine: 5,
        endLine: 5,
        visibility: "public",
        tags: [],
        metadata: {},
      });
      // Also add a real function that should still be flagged
      db.insertEntity(fileId, {
        name: "undocumented_helper",
        entityType: "function",
        layer: "source",
        startLine: 10,
        endLine: 20,
        visibility: "public",
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "docs", "all");
      const moduleDocs = items.filter(
        (i) => i.category === "missing_doc" && i.message.includes("contacts"),
      );
      const fnDocs = items.filter(
        (i) =>
          i.category === "missing_doc" &&
          i.message.includes("undocumented_helper"),
      );
      expect(moduleDocs).toHaveLength(0);
      expect(fnDocs).toHaveLength(1);
    });

    it("should not report missing_doc for entities with doc comments", () => {
      const fileId = db.insertFile("/src/lib.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "documented_fn",
        entityType: "function",
        layer: "source",
        startLine: 3,
        endLine: 10,
        visibility: "public",
        tags: [],
        metadata: { hasDocComment: true, docCommentLines: 2 },
      });

      const items = detectDrift(db, "docs", "all");
      const missingDocs = items.filter(
        (i) =>
          i.category === "missing_doc" && i.message.includes("documented_fn"),
      );
      expect(missingDocs).toHaveLength(0);
    });

    it("should still report missing_doc for entities without doc comments", () => {
      const fileId = db.insertFile("/src/lib.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "undocumented_fn",
        entityType: "function",
        layer: "source",
        startLine: 3,
        endLine: 10,
        visibility: "public",
        tags: [],
        metadata: {},
      });

      const items = detectDrift(db, "docs", "all");
      const missingDocs = items.filter(
        (i) =>
          i.category === "missing_doc" && i.message.includes("undocumented_fn"),
      );
      expect(missingDocs.length).toBeGreaterThan(0);
    });

    it("should filter items matching .driftignore rules", () => {
      const fileId = db.insertFile("/src/internal/helper.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "internal_helper",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        visibility: "public",
        tags: [],
        metadata: {},
      });

      const rules = parseDriftIgnore("**/internal/** missing_doc");
      const items = detectDrift(db, "docs", "all", rules);
      const missingDocs = items.filter(
        (i) =>
          i.category === "missing_doc" && i.message.includes("internal_helper"),
      );
      expect(missingDocs).toHaveLength(0);
    });

    it("should not filter items when driftignore category doesn't match", () => {
      const fileId = db.insertFile("/src/internal/helper.rs", "abc", "rust");
      db.insertEntity(fileId, {
        name: "internal_helper2",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        visibility: "public",
        tags: [],
        metadata: {},
      });

      const rules = parseDriftIgnore("**/internal/** missing_test");
      const items = detectDrift(db, "docs", "all", rules);
      const missingDocs = items.filter(
        (i) =>
          i.category === "missing_doc" &&
          i.message.includes("internal_helper2"),
      );
      expect(missingDocs.length).toBeGreaterThan(0);
    });

    it("should not detect stale_doc when doc has valid documents edge", () => {
      const fileId1 = db.insertFile("/docs/api.md", "abc", "markdown");
      const docId = db.insertEntity(fileId1, {
        name: "API Reference",
        entityType: "doc_section",
        layer: "dev_doc",
        startLine: 1,
        endLine: 50,
        tags: [],
        metadata: {},
      });

      const fileId2 = db.insertFile("/src/lib.rs", "def", "rust");
      const srcId = db.insertEntity(fileId2, {
        name: "handler",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // Valid documents edge → not stale
      db.insertEdge(docId, srcId, "documents", 0.8, "name_convention");

      const items = detectDrift(db, "docs", "all");
      const staleDocs = items.filter((i) => i.category === "stale_doc");
      expect(staleDocs).toHaveLength(0);
    });

    it("should detect orphan_test with edge-based detection", () => {
      const fileId1 = db.insertFile("/test/auth_test.rs", "abc", "rust");
      db.insertEntity(fileId1, {
        name: "test_login",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // Create edges so hasEdges = true, but this test has no "tests" edge
      const fileId2 = db.insertFile("/src/lib.rs", "def", "rust");
      const srcId = db.insertEntity(fileId2, {
        name: "create_contact",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });
      db.insertEdge(srcId, srcId, "references", 1.0, "explicit");

      const items = detectDrift(db, "tests", "all");
      const orphanTests = items.filter((i) => i.category === "orphan_test");
      expect(orphanTests.length).toBeGreaterThan(0);
    });

    it("should not report missing_test when scenario has covers edge", () => {
      const fileId1 = db.insertFile("/test/auth.feature", "abc", "gherkin");
      const scenarioId = db.insertEntity(fileId1, {
        name: "User logs in",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 8,
        tags: [],
        metadata: {},
      });

      const fileId2 = db.insertFile("/test/auth_test.rs", "def", "rust");
      const testId = db.insertEntity(fileId2, {
        name: "test_user_login",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // "covers" edge from test → scenario
      db.insertEdge(testId, scenarioId, "covers", 0.9, "name_convention");

      const items = detectDrift(db, "features", "all");
      const missingTests = items.filter(
        (i) =>
          i.category === "missing_test" && i.message.includes("User logs in"),
      );
      expect(missingTests).toHaveLength(0);
    });

    it("should not report missing_feature when test has covers edge", () => {
      const fileId1 = db.insertFile("/test/auth.feature", "abc", "gherkin");
      const scenarioId = db.insertEntity(fileId1, {
        name: "User logs in",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 8,
        tags: [],
        metadata: {},
      });

      const fileId2 = db.insertFile("/test/auth_test.rs", "def", "rust");
      const testId = db.insertEntity(fileId2, {
        name: "test_user_login",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // "covers" edge from test → scenario
      db.insertEdge(testId, scenarioId, "covers", 0.9, "name_convention");

      const items = detectDrift(db, "features", "all");
      const missingFeatures = items.filter(
        (i) =>
          i.category === "missing_feature" &&
          i.message.includes("test_user_login"),
      );
      expect(missingFeatures).toHaveLength(0);
    });

    it("should not report orphan_test when test has tests edge", () => {
      const fileId1 = db.insertFile("/src/contact.rs", "abc", "rust");
      const srcId = db.insertEntity(fileId1, {
        name: "create_contact",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 20,
        tags: [],
        metadata: {},
      });

      const fileId2 = db.insertFile("/test/contact_test.rs", "def", "rust");
      const testId = db.insertEntity(fileId2, {
        name: "test_create_contact",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // "tests" edge from test → source
      db.insertEdge(testId, srcId, "tests", 0.85, "name_convention");

      const items = detectDrift(db, "tests", "all");
      const orphanTests = items.filter(
        (i) =>
          i.category === "orphan_test" &&
          i.message.includes("test_create_contact"),
      );
      expect(orphanTests).toHaveLength(0);
    });

    it("should not report orphan_code when source has edges", () => {
      const fileId1 = db.insertFile("/src/contact.rs", "abc", "rust");
      const srcId = db.insertEntity(fileId1, {
        name: "create_contact",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 20,
        tags: [],
        metadata: {},
      });

      const fileId2 = db.insertFile("/test/contact_test.rs", "def", "rust");
      const testId = db.insertEntity(fileId2, {
        name: "test_create_contact",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // Both in and out edges on source
      db.insertEdge(testId, srcId, "tests", 0.85, "name_convention");

      const items = detectDrift(db, "code", "all");
      const orphanCode = items.filter(
        (i) =>
          i.category === "orphan_code" && i.message.includes("create_contact"),
      );
      expect(orphanCode).toHaveLength(0);
    });

    it("should detect stale_doc when documents edge targets deleted entity", () => {
      const fileId1 = db.insertFile("/docs/api.md", "abc", "markdown");
      const docId = db.insertEntity(fileId1, {
        name: "Contact API",
        entityType: "doc_section",
        layer: "dev_doc",
        startLine: 1,
        endLine: 30,
        tags: [],
        metadata: {},
      });

      // Create a target entity then delete it via raw SQL to leave a dangling edge.
      // FK constraints prevent inserting an edge to a non-existent entity, so we
      // temporarily disable them to simulate DB inconsistency.
      const rawDb = (db as any).db;
      rawDb.pragma("foreign_keys = OFF");
      db.insertEdge(docId, 9999, "documents", 0.8, "name_convention");
      rawDb.pragma("foreign_keys = ON");

      const items = detectDrift(db, "docs", "all");
      const staleDocs = items.filter(
        (i) => i.category === "stale_doc" && i.message.includes("Contact API"),
      );
      expect(staleDocs).toHaveLength(1);
      expect(staleDocs[0].severity).toBe("medium");
    });

    it("should not report naming_drift when entities have high similarity", () => {
      const fileId1 = db.insertFile("/test/feature.feature", "abc", "gherkin");
      const entityId1 = db.insertEntity(fileId1, {
        name: "create contact",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const fileId2 = db.insertFile("/test/contact_test.rs", "def", "rust");
      const entityId2 = db.insertEntity(fileId2, {
        name: "create_contact",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      const conceptId = db.insertConcept("contact", "tag");
      db.linkEntityToConcept(entityId1, conceptId, 1.0);
      db.linkEntityToConcept(entityId2, conceptId, 1.0);

      const items = detectDrift(db, "all", "all");
      const namingDrift = items.filter(
        (i) =>
          i.category === "naming_drift" &&
          i.message.includes("create contact") &&
          i.message.includes("create_contact"),
      );
      expect(namingDrift).toHaveLength(0);
    });

    it("should not crash on naming_drift with empty concept list", () => {
      // No concepts at all
      const items = detectDrift(db, "all", "all");
      const namingDrift = items.filter((i) => i.category === "naming_drift");
      expect(namingDrift).toHaveLength(0);
    });
  });

  describe("computeCoverage", () => {
    it("should return coverage matrix for concepts", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: ["auth"],
        metadata: {},
      });

      const coverage = computeCoverage(db, "all");
      expect(coverage.length).toBeGreaterThan(0);
      const authEntry = coverage.find((c) => c.concept === "auth");
      expect(authEntry).toBeDefined();
      expect(authEntry!.layers.feature).toBe(true);
      expect(authEntry!.score).toBeGreaterThan(0);
    });

    it("should filter untested concepts", () => {
      const fileId1 = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId1, {
        name: "Login",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: ["auth"],
        metadata: {},
      });

      // "auth" has no unit_test or e2e_test → should appear in untested filter
      const untested = computeCoverage(db, "untested");
      const authEntry = untested.find((c) => c.concept === "auth");
      expect(authEntry).toBeDefined();
    });

    it("should filter undocumented concepts", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: ["auth"],
        metadata: {},
      });

      const undocumented = computeCoverage(db, "undocumented");
      const authEntry = undocumented.find((c) => c.concept === "auth");
      expect(authEntry).toBeDefined();
    });

    it("should filter unimplemented concepts", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: ["auth"],
        metadata: {},
      });

      const unimplemented = computeCoverage(db, "unimplemented");
      const authEntry = unimplemented.find((c) => c.concept === "auth");
      expect(authEntry).toBeDefined();
    });

    it("should filter by component name", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: ["auth", "crypto"],
        metadata: {},
      });

      const authOnly = computeCoverage(db, "all", "auth");
      expect(authOnly.every((c) => c.concept.includes("auth"))).toBe(true);
    });
  });

  describe("getAllConcepts", () => {
    it("should return concept names from entity tags", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Login",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: ["auth", "security"],
        metadata: {},
      });

      const concepts = getAllConcepts(db);
      expect(concepts).toContain("auth");
      expect(concepts).toContain("security");
    });

    it("should return empty array for no entities", () => {
      const concepts = getAllConcepts(db);
      expect(concepts).toEqual([]);
    });
  });

  describe("computeOverview", () => {
    it("should return correct overview statistics", () => {
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

      const overview = computeOverview(db);
      expect(overview.totalFiles).toBe(1);
      expect(overview.totalEntities).toBe(1);
      expect(overview.entitiesByLayer.feature).toBe(1);
      expect(overview.totalDrift).toBeGreaterThan(0);
      expect(overview.driftBySeverity.high).toBeGreaterThan(0);
      expect(overview.coherenceScore).toBeLessThan(1);
    });

    it("should return coherence score of 1 when no drift", () => {
      // Empty DB → no drift
      const overview = computeOverview(db);
      expect(overview.totalFiles).toBe(0);
      expect(overview.totalEntities).toBe(0);
      expect(overview.coherenceScore).toBe(1);
      expect(overview.totalDrift).toBe(0);
    });

    it("should count concepts from concepts table", () => {
      db.insertConcept("auth", "tag");
      db.insertConcept("crypto", "tag");

      const overview = computeOverview(db);
      expect(overview.totalConcepts).toBe(2);
    });

    it("should auto-save a drift snapshot", () => {
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

      computeOverview(db);

      const snapshots = db.getDriftSnapshots(10);
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0].counts._total).toBeGreaterThan(0);
    });
  });

  describe("detectDrift - self-healing tag override", () => {
    it("reports @planned scenario with implements edge as stale_tag LOW", () => {
      const featureFileId = db.insertFile(
        "/test/exchange.feature",
        "abc",
        "gherkin",
      );
      const scenarioId = db.insertEntity(featureFileId, {
        name: "Exchange contact via QR",
        entityType: "scenario",
        layer: "feature",
        startLine: 5,
        endLine: 12,
        tags: ["planned"],
        metadata: {},
      });

      const srcFileId = db.insertFile("/src/exchange.rs", "def", "rust");
      const implId = db.insertEntity(srcFileId, {
        name: "exchange_via_qr",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 20,
        tags: [],
        metadata: {},
      });

      // Create an "implements" edge: code → feature
      db.insertEdge(implId, scenarioId, "implements", 0.85, "name_convention");

      const items = detectDrift(db, "features", "all");
      const staleTags = items.filter((i) => i.category === "stale_tag");
      expect(staleTags).toHaveLength(1);
      expect(staleTags[0].severity).toBe("low");
      expect(staleTags[0].message).toContain("Exchange contact via QR");
      expect(staleTags[0].message).toContain("@planned");
      expect(staleTags[0].message).toContain("implementation evidence");
      expect(staleTags[0].suggestion).toContain("@planned");
      expect(staleTags[0].suggestion).toContain("@implemented");
      expect(staleTags[0].filePath).toBe("/test/exchange.feature");
      expect(staleTags[0].line).toBe(5);

      // Should NOT also report as missing_test
      const missingTests = items.filter(
        (i) =>
          i.category === "missing_test" &&
          i.message.includes("Exchange contact via QR"),
      );
      expect(missingTests).toHaveLength(0);
    });

    it("skips @planned scenario with no edge evidence", () => {
      const featureFileId = db.insertFile(
        "/test/future.feature",
        "abc",
        "gherkin",
      );
      db.insertEntity(featureFileId, {
        name: "Future feature not yet built",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 8,
        tags: ["planned"],
        metadata: {},
      });

      // Insert an unrelated edge to ensure hasEdges is true
      const otherFileId = db.insertFile("/src/other.rs", "xyz", "rust");
      const otherId = db.insertEntity(otherFileId, {
        name: "other_fn",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });
      db.insertEdge(otherId, otherId, "references", 1.0, "explicit");

      const items = detectDrift(db, "features", "all");
      const related = items.filter(
        (i) => i.message.includes("Future feature not yet built"),
      );
      expect(related).toHaveLength(0);
    });

    it("reports non-@planned scenario without coverage as missing_test HIGH", () => {
      const featureFileId = db.insertFile(
        "/test/auth.feature",
        "abc",
        "gherkin",
      );
      db.insertEntity(featureFileId, {
        name: "User logs in with password",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // Insert an unrelated edge to ensure hasEdges is true
      const otherFileId = db.insertFile("/src/other.rs", "xyz", "rust");
      const otherId = db.insertEntity(otherFileId, {
        name: "other_fn",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });
      db.insertEdge(otherId, otherId, "references", 1.0, "explicit");

      const items = detectDrift(db, "features", "all");
      const missingTests = items.filter(
        (i) =>
          i.category === "missing_test" &&
          i.message.includes("User logs in with password"),
      );
      expect(missingTests).toHaveLength(1);
      expect(missingTests[0].severity).toBe("high");
    });
  });
});
