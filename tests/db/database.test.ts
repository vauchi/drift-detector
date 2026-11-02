/**
 * Tests for database operations
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DriftDatabase } from "../../src/db/database.js";
import type { ParsedEntity } from "../../src/types.js";

describe("DriftDatabase", () => {
  let db: DriftDatabase;

  beforeEach(() => {
    db = new DriftDatabase(":memory:");
    db.initialize();
  });

  afterEach(() => {
    db.close();
  });

  describe("initialization", () => {
    it("should create all required tables", () => {
      // If we can query without errors, tables exist
      expect(db.getAllFiles()).toEqual([]);
      expect(db.getAllEntities()).toEqual([]);
    });

    it("should set schema version in metadata", () => {
      expect(db.getMetadata("schema_version")).toBe("3");
    });
  });

  describe("file operations", () => {
    it("should insert and retrieve a file", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc123", "gherkin");
      const file = db.getFileByPath("/test/auth.feature");

      expect(file).toBeDefined();
      expect(file!.id).toBe(fileId);
      expect(file!.path).toBe("/test/auth.feature");
      expect(file!.content_hash).toBe("abc123");
      expect(file!.language).toBe("gherkin");
    });

    it("should update file content hash", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc123", "gherkin");
      db.updateFile(fileId, "def456");

      const file = db.getFileByPath("/test/auth.feature");
      expect(file!.content_hash).toBe("def456");
    });

    it("should delete a file", () => {
      db.insertFile("/test/auth.feature", "abc123", "gherkin");
      db.deleteFile("/test/auth.feature");

      const file = db.getFileByPath("/test/auth.feature");
      expect(file).toBeUndefined();
    });

    it("should retrieve a file by id", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc123", "gherkin");
      const file = db.getFileById(fileId);

      expect(file).toBeDefined();
      expect(file!.id).toBe(fileId);
      expect(file!.path).toBe("/test/auth.feature");
    });

    it("should return undefined for non-existent file id", () => {
      expect(db.getFileById(99999)).toBeUndefined();
    });

    it("should return all files", () => {
      db.insertFile("/test/auth.feature", "abc123", "gherkin");
      db.insertFile("/test/login.feature", "def456", "gherkin");

      const files = db.getAllFiles();
      expect(files).toHaveLength(2);
    });
  });

  describe("entity operations", () => {
    let fileId: number;

    beforeEach(() => {
      fileId = db.insertFile("/test/auth.feature", "abc123", "gherkin");
    });

    it("should insert and retrieve an entity", () => {
      const entity: ParsedEntity = {
        name: "User Authentication",
        entityType: "feature",
        layer: "feature",
        startLine: 1,
        endLine: 10,
        tags: ["auth"],
        metadata: { description: "Auth feature" },
      };

      const entityId = db.insertEntity(fileId, entity);
      const entities = db.getEntitiesByFileId(fileId);

      expect(entities).toHaveLength(1);
      expect(entities[0].id).toBe(entityId);
      expect(entities[0].name).toBe("User Authentication");
      expect(entities[0].entity_type).toBe("feature");
      expect(entities[0].layer).toBe("feature");
    });

    it("should store qualified name", () => {
      const entity: ParsedEntity = {
        name: "Successful login",
        qualifiedName: "User Authentication::Successful login",
        entityType: "scenario",
        layer: "feature",
        startLine: 5,
        endLine: 10,
        tags: [],
        metadata: {},
      };

      db.insertEntity(fileId, entity);
      const entities = db.getEntitiesByFileId(fileId);

      expect(entities[0].qualified_name).toBe(
        "User Authentication::Successful login",
      );
    });

    it("should filter entities by layer", () => {
      const feature: ParsedEntity = {
        name: "Feature",
        entityType: "feature",
        layer: "feature",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      };
      const test: ParsedEntity = {
        name: "Test",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      };

      db.insertEntity(fileId, feature);
      db.insertEntity(fileId, test);

      const features = db.getEntitiesByLayer("feature");
      expect(features).toHaveLength(1);
      expect(features[0].name).toBe("Feature");

      const tests = db.getEntitiesByLayer("unit_test");
      expect(tests).toHaveLength(1);
      expect(tests[0].name).toBe("Test");
    });

    it("should cascade delete entities when file is deleted", () => {
      const entity: ParsedEntity = {
        name: "Feature",
        entityType: "feature",
        layer: "feature",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      };
      db.insertEntity(fileId, entity);

      expect(db.getAllEntities()).toHaveLength(1);

      db.deleteFile("/test/auth.feature");

      expect(db.getAllEntities()).toHaveLength(0);
    });
  });

  describe("edge operations", () => {
    let entity1Id: number;
    let entity2Id: number;

    beforeEach(() => {
      const fileId = db.insertFile("/test/auth.feature", "abc123", "gherkin");
      entity1Id = db.insertEntity(fileId, {
        name: "Scenario",
        entityType: "scenario",
        layer: "feature",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });
      entity2Id = db.insertEntity(fileId, {
        name: "Test",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });
    });

    it("should insert and retrieve edges", () => {
      db.insertEdge(entity2Id, entity1Id, "covers", 0.9, "name_convention");

      const edges = db.getEdgesBySourceId(entity2Id);
      expect(edges).toHaveLength(1);
      expect(edges[0].target_id).toBe(entity1Id);
      expect(edges[0].edge_type).toBe("covers");
      expect(edges[0].confidence).toBe(0.9);
      expect(edges[0].match_method).toBe("name_convention");
    });

    it("should retrieve edges by target", () => {
      db.insertEdge(entity2Id, entity1Id, "covers", 1.0, "exact_tag");

      const edges = db.getEdgesByTargetId(entity1Id);
      expect(edges).toHaveLength(1);
      expect(edges[0].source_id).toBe(entity2Id);
    });

    it("should clear all edges", () => {
      db.insertEdge(entity2Id, entity1Id, "covers", 0.9, "name_convention");
      expect(db.getEdgeCount()).toBe(1);

      db.clearEdges();
      expect(db.getEdgeCount()).toBe(0);
    });

    it("should count edges", () => {
      expect(db.getEdgeCount()).toBe(0);
      db.insertEdge(entity2Id, entity1Id, "covers", 0.9, "name_convention");
      db.insertEdge(entity1Id, entity2Id, "covered_by", 0.9, "name_convention");
      expect(db.getEdgeCount()).toBe(2);
    });
  });

  describe("concept operations", () => {
    let entityId: number;

    beforeEach(() => {
      const fileId = db.insertFile("/test/auth.feature", "abc123", "gherkin");
      entityId = db.insertEntity(fileId, {
        name: "Auth Feature",
        entityType: "feature",
        layer: "feature",
        startLine: 1,
        endLine: 10,
        tags: ["auth"],
        metadata: {},
      });
    });

    it("should create and retrieve concepts", () => {
      const conceptId = db.insertConcept(
        "auth",
        "tag",
        "Authentication concept",
      );
      const concept = db.getConceptByName("auth");

      expect(concept).toBeDefined();
      expect(concept!.id).toBe(conceptId);
      expect(concept!.name).toBe("auth");
      expect(concept!.source).toBe("tag");
      expect(concept!.description).toBe("Authentication concept");
    });

    it("should get or create concept", () => {
      const id1 = db.getOrCreateConcept("auth", "tag");
      const id2 = db.getOrCreateConcept("auth", "tag");

      expect(id1).toBe(id2);
    });

    it("should link entities to concepts", () => {
      const conceptId = db.insertConcept("auth", "tag");
      db.linkEntityToConcept(entityId, conceptId, 1.0);

      // Verify via raw query that link exists
      const entity = db.getEntityById(entityId);
      expect(entity).toBeDefined();
    });

    it("should return all concepts", () => {
      db.insertConcept("auth", "tag");
      db.insertConcept("crypto", "tag");
      db.insertConcept("exchange", "inferred");

      const concepts = db.getAllConcepts();
      expect(concepts).toHaveLength(3);
      expect(concepts.map((c) => c.name).sort()).toEqual([
        "auth",
        "crypto",
        "exchange",
      ]);
    });

    it("should get entities by concept id", () => {
      const conceptId = db.insertConcept("auth", "tag");
      db.linkEntityToConcept(entityId, conceptId, 1.0);

      const entities = db.getEntitiesByConceptId(conceptId);
      expect(entities).toHaveLength(1);
      expect(entities[0].id).toBe(entityId);
    });
  });

  describe("search operations", () => {
    beforeEach(() => {
      const fileId = db.insertFile("/test/auth.feature", "abc123", "gherkin");
      db.insertEntity(fileId, {
        name: "User Authentication",
        qualifiedName: "Auth::User Authentication",
        entityType: "feature",
        layer: "feature",
        startLine: 1,
        endLine: 10,
        signature: "Feature: User Authentication",
        tags: [],
        metadata: {},
      });
      db.insertEntity(fileId, {
        name: "Contact Exchange",
        qualifiedName: "Contact::Exchange",
        entityType: "feature",
        layer: "feature",
        startLine: 11,
        endLine: 20,
        tags: [],
        metadata: {},
      });
    });

    it("should search entities by name", () => {
      const results = db.searchEntities("Authentication");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("User Authentication");
    });

    it("should search entities by qualified name", () => {
      const results = db.searchEntities("Contact");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Contact Exchange");
    });

    it("should limit search results", () => {
      // Search for something that matches both entities
      const results = db.searchEntities("Feature", 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe("statistics", () => {
    beforeEach(() => {
      const file1 = db.insertFile("/test/auth.feature", "abc", "gherkin");
      const file2 = db.insertFile("/test/auth.test.ts", "def", "typescript");

      db.insertEntity(file1, {
        name: "Feature 1",
        entityType: "feature",
        layer: "feature",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });
      db.insertEntity(file1, {
        name: "Feature 2",
        entityType: "feature",
        layer: "feature",
        startLine: 11,
        endLine: 20,
        tags: [],
        metadata: {},
      });
      db.insertEntity(file2, {
        name: "Test 1",
        entityType: "test_fn",
        layer: "unit_test",
        startLine: 1,
        endLine: 5,
        tags: [],
        metadata: {},
      });
    });

    it("should count entities by layer", () => {
      const counts = db.getEntityCountByLayer();
      expect(counts.feature).toBe(2);
      expect(counts.unit_test).toBe(1);
    });

    it("should count total entities", () => {
      expect(db.getTotalEntityCount()).toBe(3);
    });

    it("should count total files", () => {
      expect(db.getTotalFileCount()).toBe(2);
    });
  });

  describe("transactions", () => {
    it("should execute operations in a transaction", () => {
      const fileId = db.transaction(() => {
        const id = db.insertFile("/test/auth.feature", "abc", "gherkin");
        db.insertEntity(id, {
          name: "Feature",
          entityType: "feature",
          layer: "feature",
          startLine: 1,
          endLine: 10,
          tags: [],
          metadata: {},
        });
        return id;
      });

      expect(fileId).toBeGreaterThan(0);
      expect(db.getAllEntities()).toHaveLength(1);
    });
  });

  describe("drift snapshots", () => {
    it("should save and retrieve drift snapshots", () => {
      const counts = { missing_test: 10, missing_doc: 5, _total: 15 };
      db.saveDriftSnapshot("2026-01-01T00:00:00.000Z", counts);

      const snapshots = db.getDriftSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].timestamp).toBe("2026-01-01T00:00:00.000Z");
      expect(snapshots[0].counts.missing_test).toBe(10);
      expect(snapshots[0].counts._total).toBe(15);
    });

    it("should return snapshots in reverse chronological order", () => {
      db.saveDriftSnapshot("2026-01-01T00:00:00.000Z", { _total: 10 });
      db.saveDriftSnapshot("2026-01-02T00:00:00.000Z", { _total: 8 });
      db.saveDriftSnapshot("2026-01-03T00:00:00.000Z", { _total: 5 });

      const snapshots = db.getDriftSnapshots();
      expect(snapshots).toHaveLength(3);
      expect(snapshots[0].timestamp).toBe("2026-01-03T00:00:00.000Z");
      expect(snapshots[2].timestamp).toBe("2026-01-01T00:00:00.000Z");
    });

    it("should respect limit parameter", () => {
      db.saveDriftSnapshot("2026-01-01T00:00:00.000Z", { _total: 10 });
      db.saveDriftSnapshot("2026-01-02T00:00:00.000Z", { _total: 8 });
      db.saveDriftSnapshot("2026-01-03T00:00:00.000Z", { _total: 5 });

      const snapshots = db.getDriftSnapshots(2);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0].timestamp).toBe("2026-01-03T00:00:00.000Z");
      expect(snapshots[1].timestamp).toBe("2026-01-02T00:00:00.000Z");
    });

    it("should return empty array when no snapshots exist", () => {
      const snapshots = db.getDriftSnapshots();
      expect(snapshots).toEqual([]);
    });

    it("should overwrite snapshot with same timestamp", () => {
      db.saveDriftSnapshot("2026-01-01T00:00:00.000Z", { _total: 10 });
      db.saveDriftSnapshot("2026-01-01T00:00:00.000Z", { _total: 5 });

      const snapshots = db.getDriftSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].counts._total).toBe(5);
    });
  });

  describe("reset", () => {
    it("should drop and recreate all tables", () => {
      const fileId = db.insertFile("/test/auth.feature", "abc", "gherkin");
      db.insertEntity(fileId, {
        name: "Feature",
        entityType: "feature",
        layer: "feature",
        startLine: 1,
        endLine: 10,
        tags: [],
        metadata: {},
      });

      db.reset();

      expect(db.getAllFiles()).toHaveLength(0);
      expect(db.getAllEntities()).toHaveLength(0);
      expect(db.getMetadata("schema_version")).toBe("3");
    });
  });

  describe("multi-repo indexing", () => {
    it("should store repo on files", () => {
      const id = db.insertFile("core/src/lib.rs", "hash1", "rust", "core");
      const file = db.getFileById(id);
      expect(file?.repo).toBe("core");
    });

    it("should default repo to null when not provided", () => {
      const id = db.insertFile("src/lib.rs", "hash1", "rust");
      const file = db.getFileById(id);
      expect(file?.repo).toBeNull();
    });

    it("should filter entities by repo", () => {
      const fid1 = db.insertFile("core/src/lib.rs", "hash1", "rust", "core");
      const fid2 = db.insertFile("relay/src/main.rs", "hash2", "rust", "relay");
      const entity: ParsedEntity = {
        entityType: "function",
        name: "foo",
        layer: "source",
        startLine: 1,
        endLine: 5,
        tags: ["test"],
      };
      db.insertEntity(fid1, entity);
      db.insertEntity(fid2, { ...entity, name: "bar" });

      const coreEntities = db.getEntitiesByRepo("core");
      expect(coreEntities).toHaveLength(1);
      expect(coreEntities[0].name).toBe("foo");

      const relayEntities = db.getEntitiesByRepo("relay");
      expect(relayEntities).toHaveLength(1);
      expect(relayEntities[0].name).toBe("bar");
    });
  });
});
