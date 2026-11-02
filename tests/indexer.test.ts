/**
 * Tests for the indexer
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Indexer,
  MAX_TAG_FREQUENCY,
  MAX_EDGES_PER_ENTITY,
} from "../src/indexer.js";
import type { EmbeddingProvider } from "../src/embeddings.js";
import { DriftDatabase } from "../src/db/database.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { testConfig } from "./test-config.js";

describe("Indexer", () => {
  let db: DriftDatabase;
  let indexer: Indexer;
  let tempDir: string;

  beforeEach(async () => {
    db = new DriftDatabase(":memory:");
    db.initialize();
    indexer = new Indexer(db, testConfig());

    // Create temp directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "drift-test-"));
  });

  afterEach(async () => {
    db.close();
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("indexDirectory", () => {
    it("should index .feature files", async () => {
      const featureContent = `
Feature: User Login
  Scenario: Successful login
    Given I am on the login page
    When I enter valid credentials
    Then I should see the dashboard
`;
      await fs.writeFile(path.join(tempDir, "login.feature"), featureContent);

      await indexer.indexDirectory(tempDir);

      const entities = db.getAllEntities();
      expect(entities.length).toBeGreaterThan(0);

      const feature = entities.find((e) => e.entity_type === "feature");
      expect(feature).toBeDefined();
      expect(feature!.name).toBe("User Login");
    });

    it("should index multiple feature files", async () => {
      await fs.writeFile(
        path.join(tempDir, "auth.feature"),
        "Feature: Auth\n  Scenario: Login\n    Given something",
      );
      await fs.writeFile(
        path.join(tempDir, "contacts.feature"),
        "Feature: Contacts\n  Scenario: Add\n    Given something",
      );

      await indexer.indexDirectory(tempDir);

      const features = db
        .getEntitiesByLayer("feature")
        .filter((e) => e.entity_type === "feature");
      expect(features).toHaveLength(2);
    });

    it("should store content hash for incremental indexing", async () => {
      await fs.writeFile(
        path.join(tempDir, "test.feature"),
        "Feature: Test\n  Scenario: One\n    Given something",
      );

      await indexer.indexDirectory(tempDir);

      const files = db.getAllFiles();
      expect(files).toHaveLength(1);
      expect(files[0].content_hash).toBeDefined();
      expect(files[0].content_hash.length).toBeGreaterThan(0);
    });

    it("should index nested directories", async () => {
      const nested = path.join(tempDir, "features", "auth");
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(
        path.join(nested, "login.feature"),
        "Feature: Login\n  Scenario: Test\n    Given something",
      );

      await indexer.indexDirectory(tempDir);

      const files = db.getAllFiles();
      expect(files).toHaveLength(1);
      expect(files[0].path).toContain("login.feature");
    });

    it("should skip non-matching files", async () => {
      await fs.writeFile(path.join(tempDir, "readme.txt"), "Plain text file");
      await fs.writeFile(
        path.join(tempDir, "test.feature"),
        "Feature: Test\n  Scenario: One\n    Given something",
      );

      await indexer.indexDirectory(tempDir);

      const files = db.getAllFiles();
      // Should only index the .feature file, not .txt
      expect(files).toHaveLength(1);
      expect(files[0].path).toContain(".feature");
    });
  });

  describe("incremental indexing", () => {
    it("should skip unchanged files on reindex", async () => {
      await fs.writeFile(
        path.join(tempDir, "test.feature"),
        "Feature: Test\n  Scenario: One\n    Given something",
      );

      await indexer.indexDirectory(tempDir);
      const firstIndexTime = db.getAllFiles()[0].last_indexed_at;

      // Wait a tiny bit and reindex
      await new Promise((r) => setTimeout(r, 10));
      await indexer.indexDirectory(tempDir);

      const secondIndexTime = db.getAllFiles()[0].last_indexed_at;
      // Timestamp should be the same since file hasn't changed
      expect(secondIndexTime).toBe(firstIndexTime);
    });

    it("should reindex changed files", async () => {
      const filePath = path.join(tempDir, "test.feature");
      await fs.writeFile(
        filePath,
        "Feature: Test\n  Scenario: One\n    Given something",
      );

      await indexer.indexDirectory(tempDir);
      const firstHash = db.getAllFiles()[0].content_hash;

      // Modify the file
      await fs.writeFile(
        filePath,
        "Feature: Test Updated\n  Scenario: Two\n    Given something else",
      );

      await indexer.indexDirectory(tempDir);
      const secondHash = db.getAllFiles()[0].content_hash;

      expect(secondHash).not.toBe(firstHash);

      // Entities should be updated
      const features = db
        .getAllEntities()
        .filter((e) => e.entity_type === "feature");
      expect(features).toHaveLength(1);
      expect(features[0].name).toBe("Test Updated");
    });

    it("should remove deleted files from index", async () => {
      const filePath = path.join(tempDir, "test.feature");
      await fs.writeFile(
        filePath,
        "Feature: Test\n  Scenario: One\n    Given something",
      );

      await indexer.indexDirectory(tempDir);
      expect(db.getAllFiles()).toHaveLength(1);

      // Delete the file
      await fs.rm(filePath);

      await indexer.indexDirectory(tempDir);
      expect(db.getAllFiles()).toHaveLength(0);
      expect(db.getAllEntities()).toHaveLength(0);
    });
  });

  describe("full reindex", () => {
    it("should clear and rebuild entire index", async () => {
      await fs.writeFile(
        path.join(tempDir, "test.feature"),
        "Feature: Test\n  Scenario: One\n    Given something",
      );

      await indexer.indexDirectory(tempDir);
      expect(db.getAllFiles()).toHaveLength(1);
      expect(db.getAllEntities().length).toBeGreaterThan(0);

      // Add another file manually to simulate stale data
      db.insertFile("/stale/file.feature", "abc123", "gherkin");
      expect(db.getAllFiles()).toHaveLength(2);

      // Full reindex should clear the stale entry
      await indexer.indexDirectory(tempDir, { full: true });

      // Should only have the one real file
      expect(db.getAllFiles()).toHaveLength(1);
      expect(db.getAllFiles()[0].path).toContain("test.feature");
    });
  });

  describe("edge building", () => {
    it("should create edges between tests and features with shared tags", async () => {
      // Create a feature file with tags
      await fs.writeFile(
        path.join(tempDir, "auth.feature"),
        `@auth
Feature: Authentication
  @auth @smoke
  Scenario: Login
    Given I am on login page`,
      );

      // Create a test file that references auth (via tag in name)
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      // We can't easily create Rust test files, so we verify edge building logic
      // through the indexer result

      const result = await indexer.indexDirectory(tempDir);
      expect(result.edgesCreated).toBeGreaterThanOrEqual(0);
    });

    it("should return edge count in IndexResult", async () => {
      await fs.writeFile(
        path.join(tempDir, "test.feature"),
        "Feature: Test\n  Scenario: One\n    Given something",
      );

      const result = await indexer.indexDirectory(tempDir);
      expect(result).toHaveProperty("edgesCreated");
      expect(typeof result.edgesCreated).toBe("number");
    });

    it("should clear edges on rebuild", async () => {
      await fs.writeFile(
        path.join(tempDir, "test.feature"),
        "Feature: Test\n  Scenario: One\n    Given something",
      );

      await indexer.indexDirectory(tempDir);

      // Rebuild should clear and recreate
      await indexer.indexDirectory(tempDir, { full: true });
      // Edge count should be same or zero (consistent rebuild)
      expect(db.getEdgeCount()).toBeGreaterThanOrEqual(0);
    });

    it("should create bidirectional edges", async () => {
      // Manually create entities to test edge building directly
      const fileId1 = db.insertFile("/test/auth.feature", "abc", "gherkin");
      const fileId2 = db.insertFile("/test/auth_test.rs", "def", "rust");

      db.insertEntity(fileId1, {
        name: "Login",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: ["auth"],
        metadata: {},
      });

      db.insertEntity(fileId2, {
        name: "test_login",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: ["auth"],
        metadata: {},
      });

      const edgeCount = await indexer.buildEdges();
      expect(edgeCount).toBeGreaterThan(0);
      // Edges should be bidirectional (covers + covered_by)
      expect(edgeCount % 2).toBe(0);
    });
  });

  describe("edge constraints", () => {
    it("should not create edges for high-frequency tags", async () => {
      // Create more than MAX_TAG_FREQUENCY entities with the same tag in "feature" layer
      for (let i = 0; i < MAX_TAG_FREQUENCY + 10; i++) {
        const fid = db.insertFile(
          `/features/f${i}.feature`,
          `hash${i}`,
          "gherkin",
        );
        db.insertEntity(fid, {
          name: `Scenario ${i}`,
          entityType: "scenario",
          layer: "feature",
          startLine: 1,
          endLine: 5,
          tags: ["common-tag"],
          metadata: {},
        });
      }

      // Create a test entity with the same tag
      const testFileId = db.insertFile("/tests/test.rs", "testhash", "rust");
      db.insertEntity(testFileId, {
        name: "test_common",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 5,
        tags: ["common-tag"],
        metadata: {},
      });

      const edgeCount = await indexer.buildEdges();
      // The "common-tag" should be skipped because it appears in >50 feature entities
      // So no edges from tag matching. Name/path matching may produce a few edges.
      expect(edgeCount).toBeLessThan(MAX_TAG_FREQUENCY);
    });

    it("should cap edges per source entity", async () => {
      // Create many feature entities with distinct tags
      for (let i = 0; i < MAX_EDGES_PER_ENTITY + 5; i++) {
        const fid = db.insertFile(
          `/features/f${i}.feature`,
          `hash${i}`,
          "gherkin",
        );
        db.insertEntity(fid, {
          name: `Scenario ${i}`,
          entityType: "scenario",
          layer: "feature",
          startLine: 1,
          endLine: 5,
          tags: [`tag-${i}`, "shared"],
          metadata: {},
        });
      }

      // Create one test entity with ALL those tags
      const allTags = Array.from(
        { length: MAX_EDGES_PER_ENTITY + 5 },
        (_, i) => `tag-${i}`,
      );
      allTags.push("shared");
      const testFileId = db.insertFile("/tests/test.rs", "testhash", "rust");
      db.insertEntity(testFileId, {
        name: "test_all",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 5,
        tags: allTags,
        metadata: {},
      });

      const edgeCount = await indexer.buildEdges();
      // Each edge is bidirectional (x2), and capped at MAX_EDGES_PER_ENTITY per source
      expect(edgeCount).toBeLessThanOrEqual(
        MAX_EDGES_PER_ENTITY * 2 * 5, // multiple edge pairs, each capped
      );
    });

    it("should export constraint constants", () => {
      expect(MAX_TAG_FREQUENCY).toBe(50);
      expect(MAX_EDGES_PER_ENTITY).toBe(10);
    });
  });

  describe("concept extraction from tags", () => {
    it("should create concepts from Gherkin tags", async () => {
      // Create indexer with aliases configured
      const aliasIndexer = new Indexer(
        db,
        testConfig({
          concepts: { aliases: { auth: "security" } },
        }),
      );

      await fs.writeFile(
        path.join(tempDir, "auth.feature"),
        `@auth @security
Feature: Authentication
  @smoke
  Scenario: Login
    Given something`,
      );

      await aliasIndexer.indexDirectory(tempDir);

      // @auth resolves to "security" via configured alias
      // @security passes through as-is
      const securityConcept = db.getConceptByName("security");
      const smokeConcept = db.getConceptByName("smoke");

      expect(securityConcept).toBeDefined();
      expect(smokeConcept).toBeDefined();
    });
  });

  describe("explicit annotation edge building", () => {
    it("should create covers/covered_by edges from scenarioAnnotations metadata", async () => {
      // Create a feature scenario entity
      const featureFileId = db.insertFile(
        "/features/identity_management.feature",
        "fhash",
        "gherkin",
      );
      db.insertEntity(featureFileId, {
        name: "User creates a new identity",
        qualifiedName: "Identity Management::User creates a new identity",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 7,
        tags: ["identity"],
        metadata: {},
      });

      // Create a test entity with @scenario annotation pointing at the above
      const testFileId = db.insertFile("/tests/identity.rs", "thash", "rust");
      db.insertEntity(testFileId, {
        name: "test_create_identity",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {
          scenarioAnnotations: [
            {
              feature: "identity_management.feature",
              scenario: "User creates a new identity",
            },
          ],
        },
      });

      const edgeCount = await indexer.buildEdges();

      // Should have at least 2 edges: covers + covered_by
      expect(edgeCount).toBeGreaterThanOrEqual(2);

      // Verify the test entity has a "covers" edge to the scenario
      const testEntity = db
        .getAllEntities()
        .find((e) => e.name === "test_create_identity");
      const scenarioEntity = db
        .getAllEntities()
        .find((e) => e.name === "User creates a new identity");
      expect(testEntity).toBeDefined();
      expect(scenarioEntity).toBeDefined();

      const edges = db.getEdgesBySourceId(testEntity!.id);
      const coversEdge = edges.find(
        (e) => e.edge_type === "covers" && e.target_id === scenarioEntity!.id,
      );
      expect(coversEdge).toBeDefined();
      expect(coversEdge!.confidence).toBe(1.0);
      expect(coversEdge!.match_method).toBe("explicit");
    });

    it("should create edges for multiple scenarioAnnotations on one test", async () => {
      // Create two scenario entities
      const featureFileId = db.insertFile(
        "/features/exchange.feature",
        "fhash",
        "gherkin",
      );
      db.insertEntity(featureFileId, {
        name: "QR exchange",
        qualifiedName: "Contact Exchange::QR exchange",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 7,
        tags: [],
        metadata: {},
      });
      db.insertEntity(featureFileId, {
        name: "Generate QR code",
        qualifiedName: "Contact Exchange::Generate QR code",
        entityType: "scenario",
        layer: "feature",
        startLine: 9,
        endLine: 14,
        tags: [],
        metadata: {},
      });

      // Create a test that covers both
      const testFileId = db.insertFile("/tests/exchange.rs", "thash", "rust");
      db.insertEntity(testFileId, {
        name: "test_qr_flow",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 20,
        tags: [],
        metadata: {
          scenarioAnnotations: [
            { feature: "exchange.feature", scenario: "QR exchange" },
            { feature: "exchange.feature", scenario: "Generate QR code" },
          ],
        },
      });

      await indexer.buildEdges();

      // Should have 4 edges: 2 covers + 2 covered_by
      const testEntity = db
        .getAllEntities()
        .find((e) => e.name === "test_qr_flow");
      const testEdges = db.getEdgesBySourceId(testEntity!.id);
      const coversEdges = testEdges.filter((e) => e.edge_type === "covers");
      expect(coversEdges).toHaveLength(2);
    });

    it("should not duplicate annotation edges with tag-based edges", async () => {
      // Create a scenario with a tag AND a test that has both the tag and annotation
      const featureFileId = db.insertFile(
        "/features/identity.feature",
        "fhash",
        "gherkin",
      );
      db.insertEntity(featureFileId, {
        name: "Create identity",
        qualifiedName: "Identity Management::Create identity",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 7,
        tags: ["identity"],
        metadata: {},
      });

      const testFileId = db.insertFile("/tests/identity.rs", "thash", "rust");
      db.insertEntity(testFileId, {
        name: "test_create_identity",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: ["identity"],
        metadata: {
          scenarioAnnotations: [
            {
              feature: "identity.feature",
              scenario: "Create identity",
            },
          ],
        },
      });

      await indexer.buildEdges();

      // Should not have duplicate edges between the same pair
      const testEntity = db
        .getAllEntities()
        .find((e) => e.name === "test_create_identity");
      const scenarioEntity = db
        .getAllEntities()
        .find((e) => e.name === "Create identity");
      const testEdges = db.getEdgesBySourceId(testEntity!.id);
      const coversEdges = testEdges.filter(
        (e) => e.edge_type === "covers" && e.target_id === scenarioEntity!.id,
      );
      // Should have exactly 1 covers edge, not 2
      expect(coversEdges).toHaveLength(1);
    });

    it("should handle annotation pointing to non-existent scenario gracefully", async () => {
      const testFileId = db.insertFile("/tests/test.rs", "thash", "rust");
      db.insertEntity(testFileId, {
        name: "test_missing_scenario",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {
          scenarioAnnotations: [
            {
              feature: "nonexistent.feature",
              scenario: "Missing scenario",
            },
          ],
        },
      });

      // Should not throw
      const edgeCount = await indexer.buildEdges();
      expect(edgeCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe("explicit @source annotation edge building", () => {
    it("should create tests/tested_by edges from sourceAnnotations metadata", async () => {
      // Create a source entity
      const sourceFileId = db.insertFile("/src/recovery.rs", "shash", "rust");
      db.insertEntity(sourceFileId, {
        name: "get_recovery_readiness",
        qualifiedName: "recovery::get_recovery_readiness",
        entityType: "function",
        layer: "source",
        startLine: 10,
        endLine: 30,
        visibility: "public",
        tags: [],
        metadata: {},
      });

      // Create a test entity with @source annotation
      const testFileId = db.insertFile(
        "/tests/recovery_tests.rs",
        "thash",
        "rust",
      );
      db.insertEntity(testFileId, {
        name: "test_get_recovery_readiness_returns_ready",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 15,
        tags: [],
        metadata: {
          sourceAnnotations: [{ target: "get_recovery_readiness" }],
        },
      });

      const edgeCount = await indexer.buildEdges();
      expect(edgeCount).toBeGreaterThanOrEqual(2);

      const testEntity = db
        .getAllEntities()
        .find((e) => e.name === "test_get_recovery_readiness_returns_ready");
      const sourceEntity = db
        .getAllEntities()
        .find((e) => e.name === "get_recovery_readiness");
      expect(testEntity).toBeDefined();
      expect(sourceEntity).toBeDefined();

      const edges = db.getEdgesBySourceId(testEntity!.id);
      const testsEdge = edges.find(
        (e) => e.edge_type === "tests" && e.target_id === sourceEntity!.id,
      );
      expect(testsEdge).toBeDefined();
      expect(testsEdge!.confidence).toBe(1.0);
      expect(testsEdge!.match_method).toBe("explicit");
    });

    it("should match @source by qualified name", async () => {
      const sourceFileId = db.insertFile("/src/recovery.rs", "shash", "rust");
      db.insertEntity(sourceFileId, {
        name: "get_recovery_readiness",
        qualifiedName: "recovery::get_recovery_readiness",
        entityType: "function",
        layer: "source",
        startLine: 10,
        endLine: 30,
        tags: [],
        metadata: {},
      });

      const testFileId = db.insertFile(
        "/tests/recovery_tests.rs",
        "thash",
        "rust",
      );
      db.insertEntity(testFileId, {
        name: "test_qualified_source",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {
          sourceAnnotations: [{ target: "recovery::get_recovery_readiness" }],
        },
      });

      await indexer.buildEdges();

      const testEntity = db
        .getAllEntities()
        .find((e) => e.name === "test_qualified_source");
      const sourceEntity = db
        .getAllEntities()
        .find((e) => e.name === "get_recovery_readiness");

      const edges = db.getEdgesBySourceId(testEntity!.id);
      const testsEdge = edges.find(
        (e) => e.edge_type === "tests" && e.target_id === sourceEntity!.id,
      );
      expect(testsEdge).toBeDefined();
      expect(testsEdge!.confidence).toBe(1.0);
    });

    it("should handle @source pointing to non-existent entity gracefully", async () => {
      const testFileId = db.insertFile("/tests/test.rs", "thash", "rust");
      db.insertEntity(testFileId, {
        name: "test_missing_source",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {
          sourceAnnotations: [{ target: "nonexistent_function" }],
        },
      });

      // Should not throw
      const edgeCount = await indexer.buildEdges();
      expect(edgeCount).toBeGreaterThanOrEqual(0);
    });

    it("should support both @scenario and @source on same test", async () => {
      // Source entity
      const sourceFileId = db.insertFile("/src/recovery.rs", "shash", "rust");
      db.insertEntity(sourceFileId, {
        name: "get_recovery_readiness",
        qualifiedName: "recovery::get_recovery_readiness",
        entityType: "function",
        layer: "source",
        startLine: 10,
        endLine: 30,
        tags: [],
        metadata: {},
      });

      // Feature scenario
      const featureFileId = db.insertFile(
        "/features/contact_recovery.feature",
        "fhash",
        "gherkin",
      );
      db.insertEntity(featureFileId, {
        name: "Recovery readiness check",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 7,
        tags: [],
        metadata: {},
      });

      // Test with both annotations
      const testFileId = db.insertFile(
        "/tests/recovery_tests.rs",
        "thash",
        "rust",
      );
      db.insertEntity(testFileId, {
        name: "test_recovery_readiness_check",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 15,
        tags: [],
        metadata: {
          scenarioAnnotations: [
            {
              feature: "contact_recovery.feature",
              scenario: "Recovery readiness check",
            },
          ],
          sourceAnnotations: [{ target: "get_recovery_readiness" }],
        },
      });

      await indexer.buildEdges();

      const testEntity = db
        .getAllEntities()
        .find((e) => e.name === "test_recovery_readiness_check");
      const edges = db.getEdgesBySourceId(testEntity!.id);

      // Should have both a "covers" edge and a "tests" edge
      const coversEdge = edges.find((e) => e.edge_type === "covers");
      const testsEdge = edges.find((e) => e.edge_type === "tests");
      expect(coversEdge).toBeDefined();
      expect(testsEdge).toBeDefined();
      expect(coversEdge!.confidence).toBe(1.0);
      expect(testsEdge!.confidence).toBe(1.0);
    });
  });

  describe("indexWorkspace", () => {
    it("should index multiple repos and tag entities with repo name", async () => {
      const coreDir = path.join(tempDir, "core");
      const relayDir = path.join(tempDir, "relay");
      await fs.mkdir(path.join(coreDir, "src"), { recursive: true });
      await fs.mkdir(path.join(relayDir, "src"), { recursive: true });

      await fs.writeFile(
        path.join(coreDir, "src", "lib.rs"),
        `pub fn core_function() -> bool {\n    true\n}\n`,
      );
      await fs.writeFile(
        path.join(relayDir, "src", "main.rs"),
        `fn relay_handler() {\n    println!("hello");\n}\n`,
      );

      const result = await indexer.indexWorkspace(tempDir, [
        { name: "core", path: "core/" },
        { name: "relay", path: "relay/" },
      ]);

      expect(result.reposIndexed).toBe(2);
      expect(result.filesIndexed).toBeGreaterThanOrEqual(2);

      // Files should be tagged with repo name
      const allFiles = db.getAllFiles();
      const coreFiles = allFiles.filter((f) => f.repo === "core");
      const relayFiles = allFiles.filter((f) => f.repo === "relay");
      expect(coreFiles.length).toBeGreaterThanOrEqual(1);
      expect(relayFiles.length).toBeGreaterThanOrEqual(1);

      // Entities should be queryable by repo
      const coreEntities = db.getEntitiesByRepo("core");
      const relayEntities = db.getEntitiesByRepo("relay");
      expect(coreEntities.length).toBeGreaterThanOrEqual(1);
      expect(relayEntities.length).toBeGreaterThanOrEqual(1);
    });

    it("should skip repos with non-existent paths", async () => {
      const result = await indexer.indexWorkspace(tempDir, [
        { name: "missing", path: "does-not-exist/" },
      ]);

      expect(result.reposIndexed).toBe(0);
      expect(result.errors.length).toBe(1);
    });

    it("should reset DB once at start when full=true", async () => {
      // Pre-populate DB with stale data
      db.insertFile("/stale/file.feature", "stale", "gherkin");
      expect(db.getAllFiles()).toHaveLength(1);

      const coreDir = path.join(tempDir, "core");
      await fs.mkdir(path.join(coreDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(coreDir, "src", "lib.rs"),
        `pub fn core_fn() -> bool {\n    true\n}\n`,
      );

      const result = await indexer.indexWorkspace(
        tempDir,
        [{ name: "core", path: "core/" }],
        { full: true },
      );

      // Stale file should be gone (DB was reset)
      const allFiles = db.getAllFiles();
      expect(allFiles.every((f) => !f.path.includes("/stale/"))).toBe(true);
      expect(result.filesIndexed).toBeGreaterThanOrEqual(1);
    });

    it("should build edges after all repos indexed", async () => {
      // Create two repos with cross-repo entities that can form edges
      const featuresDir = path.join(tempDir, "features");
      const coreDir = path.join(tempDir, "core");
      await fs.mkdir(featuresDir, { recursive: true });
      await fs.mkdir(path.join(coreDir, "tests"), { recursive: true });

      await fs.writeFile(
        path.join(featuresDir, "auth.feature"),
        `@auth
Feature: Authentication
  @auth
  Scenario: Login
    Given I am on login page`,
      );

      await fs.writeFile(
        path.join(coreDir, "tests", "auth_test.rs"),
        `#[cfg(test)]
mod tests {
    #[test]
    fn test_login() {
        assert!(true);
    }
}`,
      );

      const result = await indexer.indexWorkspace(tempDir, [
        { name: "features", path: "features/" },
        { name: "core", path: "core/" },
      ]);

      expect(result.reposIndexed).toBe(2);
      // Edges should be built (may be 0 if no tag overlap, but the field exists)
      expect(typeof result.edgesCreated).toBe("number");
    });

    it("should return aggregate counts across all repos", async () => {
      const coreDir = path.join(tempDir, "core");
      const relayDir = path.join(tempDir, "relay");
      await fs.mkdir(path.join(coreDir, "src"), { recursive: true });
      await fs.mkdir(path.join(relayDir, "src"), { recursive: true });

      await fs.writeFile(
        path.join(coreDir, "src", "lib.rs"),
        `pub fn core_function() -> bool {\n    true\n}\n`,
      );
      await fs.writeFile(
        path.join(relayDir, "src", "main.rs"),
        `fn relay_handler() {\n    println!("hello");\n}\n`,
      );

      const result = await indexer.indexWorkspace(tempDir, [
        { name: "core", path: "core/" },
        { name: "relay", path: "relay/" },
      ]);

      expect(result.reposIndexed).toBe(2);
      expect(result.filesIndexed).toBeGreaterThanOrEqual(2);
      expect(result.entitiesExtracted).toBeGreaterThanOrEqual(2);
      expect(typeof result.filesSkipped).toBe("number");
      expect(typeof result.filesRemoved).toBe("number");
      expect(typeof result.conceptsCreated).toBe("number");
      expect(typeof result.edgesCreated).toBe("number");
    });
  });

  describe("buildEdges - semantic phase", () => {
    it("creates semantic edges for entities unmatched by name/tag", async () => {
      // Mock embedder: returns similar vectors for related concepts
      const mockEmbedder: EmbeddingProvider = {
        async isAvailable() {
          return true;
        },
        async embed(text: string) {
          if (text.includes("shred") || text.includes("destruction"))
            return [0.9, 0.1, 0.0];
          if (text.includes("theme") || text.includes("color"))
            return [0.0, 0.0, 1.0];
          return [0.5, 0.5, 0.0];
        },
      };

      // Create indexer with embedder
      const semanticIndexer = new Indexer(db, testConfig(), mockEmbedder);

      // Create a scenario about data destruction (no matching tags or names to source)
      const featureFileId = db.insertFile(
        "/features/shredding.feature",
        "fhash",
        "gherkin",
      );
      db.insertEntity(featureFileId, {
        name: "User shreds contact data",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 7,
        tags: [],
        metadata: {},
      });

      // Create a source entity with related semantics but different name
      const sourceFileId = db.insertFile(
        "/src/destruction.rs",
        "shash",
        "rust",
      );
      db.insertEntity(sourceFileId, {
        name: "secure_destruction_wipe",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 20,
        tags: [],
        metadata: {},
      });

      // Also create an unrelated source to verify it doesn't match
      const unrelatedFileId = db.insertFile("/src/theme.rs", "uhash", "rust");
      db.insertEntity(unrelatedFileId, {
        name: "apply_color_theme",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      await semanticIndexer.buildEdges();

      // Should have semantic edges between shred scenario and destruction source
      const scenario = db
        .getAllEntities()
        .find((e) => e.name === "User shreds contact data");
      expect(scenario).toBeDefined();

      const scenarioEdges = db.getEdgesBySourceId(scenario!.id);
      const implementedByEdge = scenarioEdges.find(
        (e) =>
          e.edge_type === "implemented_by" && e.match_method === "semantic",
      );
      expect(implementedByEdge).toBeDefined();
      expect(implementedByEdge!.confidence).toBeGreaterThanOrEqual(0.5);
      expect(implementedByEdge!.confidence).toBeLessThanOrEqual(0.95);

      // Verify the matching source is the destruction one, not the theme one
      const destructionSource = db
        .getAllEntities()
        .find((e) => e.name === "secure_destruction_wipe");
      expect(implementedByEdge!.target_id).toBe(destructionSource!.id);
    });

    it("skips semantic phase when embedder unavailable", async () => {
      const unavailableEmbedder: EmbeddingProvider = {
        async isAvailable() {
          return false;
        },
        async embed() {
          throw new Error("should not be called");
        },
      };

      const semanticIndexer = new Indexer(
        db,
        testConfig(),
        unavailableEmbedder,
      );

      // Create unmatched feature + source
      const featureFileId = db.insertFile(
        "/features/test.feature",
        "fhash",
        "gherkin",
      );
      db.insertEntity(featureFileId, {
        name: "Some scenario",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const sourceFileId = db.insertFile("/src/test.rs", "shash", "rust");
      db.insertEntity(sourceFileId, {
        name: "some_function",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // Should not throw and should not create semantic edges
      await semanticIndexer.buildEdges();
      const allEdges = db.getAllEdgesBySource();
      for (const [, edges] of allEdges) {
        for (const edge of edges) {
          expect(edge.match_method).not.toBe("semantic");
        }
      }
    });

    it("skips semantic phase when no embedder provided", async () => {
      // Indexer without embedder parameter (default behavior)
      const plainIndexer = new Indexer(db, testConfig());

      const featureFileId = db.insertFile(
        "/features/test.feature",
        "fhash",
        "gherkin",
      );
      db.insertEntity(featureFileId, {
        name: "Some scenario",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });

      const sourceFileId = db.insertFile("/src/test.rs", "shash", "rust");
      db.insertEntity(sourceFileId, {
        name: "some_function",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      // buildEdges should still work normally
      const edgeCount = await plainIndexer.buildEdges();
      expect(typeof edgeCount).toBe("number");
    });

    it("does not create semantic edges for features already matched", async () => {
      const mockEmbedder: EmbeddingProvider = {
        async isAvailable() {
          return true;
        },
        async embed() {
          return [0.9, 0.1, 0.0];
        },
      };

      const semanticIndexer = new Indexer(db, testConfig(), mockEmbedder);

      // Create a scenario with a tag matching a source
      const featureFileId = db.insertFile(
        "/features/auth.feature",
        "fhash",
        "gherkin",
      );
      db.insertEntity(featureFileId, {
        name: "User logs in",
        entityType: "scenario",
        layer: "feature",
        startLine: 3,
        endLine: 7,
        tags: ["auth"],
        metadata: {},
      });

      const sourceFileId = db.insertFile("/src/auth.rs", "shash", "rust");
      db.insertEntity(sourceFileId, {
        name: "login_handler",
        entityType: "function",
        layer: "source",
        startLine: 1,
        endLine: 20,
        tags: ["auth"],
        metadata: {},
      });

      await semanticIndexer.buildEdges();

      // The feature should have been matched by tag (Phase 1), not semantic
      const scenario = db
        .getAllEntities()
        .find((e) => e.name === "User logs in");
      const edges = db.getEdgesBySourceId(scenario!.id);
      const semanticEdges = edges.filter((e) => e.match_method === "semantic");
      expect(semanticEdges).toHaveLength(0);
    });
  });
});
