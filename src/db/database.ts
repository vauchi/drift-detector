/**
 * Database connection and operations for drift-detector
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import Database from "better-sqlite3";
import { SCHEMA_SQL, DROP_SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import type { ParsedEntity, Layer, EdgeType, MatchMethod } from "../types.js";

/**
 * Database wrapper for drift-detector.
 */
export class DriftDatabase {
  private db: Database.Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  /**
   * Initialize the database schema.
   */
  initialize(): void {
    this.db.exec(SCHEMA_SQL);
    this.setMetadata("schema_version", String(SCHEMA_VERSION));
  }

  /**
   * Drop all tables and reinitialize (for full reindex).
   */
  reset(): void {
    this.db.exec(DROP_SCHEMA_SQL);
    this.initialize();
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get or set metadata values.
   */
  getMetadata(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMetadata(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  /**
   * File operations
   */
  getFileByPath(path: string): FileRow | undefined {
    return this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as
      | FileRow
      | undefined;
  }

  getFileById(id: number): FileRow | undefined {
    return this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as
      | FileRow
      | undefined;
  }

  insertFile(
    path: string,
    contentHash: string,
    language: string | null,
    repo: string | null = null,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO files (path, content_hash, language, repo, last_indexed_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run(path, contentHash, language, repo);
    return result.lastInsertRowid as number;
  }

  updateFile(id: number, contentHash: string): void {
    this.db
      .prepare(
        `UPDATE files SET content_hash = ?, last_indexed_at = datetime('now')
         WHERE id = ?`,
      )
      .run(contentHash, id);
  }

  deleteFile(path: string): void {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  }

  getAllFiles(): FileRow[] {
    return this.db.prepare("SELECT * FROM files").all() as FileRow[];
  }

  /**
   * Entity operations
   */
  insertEntity(fileId: number, entity: ParsedEntity): number {
    // Include tags in metadata for querying
    const metadataWithTags = {
      ...entity.metadata,
      tags: entity.tags,
    };

    const result = this.db
      .prepare(
        `INSERT INTO entities
         (file_id, entity_type, name, qualified_name, layer, start_line, end_line,
          visibility, signature, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        entity.entityType,
        entity.name,
        entity.qualifiedName ?? null,
        entity.layer,
        entity.startLine,
        entity.endLine,
        entity.visibility ?? null,
        entity.signature ?? null,
        JSON.stringify(metadataWithTags),
      );
    return result.lastInsertRowid as number;
  }

  getEntitiesByFileId(fileId: number): EntityRow[] {
    return this.db
      .prepare("SELECT * FROM entities WHERE file_id = ?")
      .all(fileId) as EntityRow[];
  }

  getEntitiesByLayer(layer: Layer): EntityRow[] {
    return this.db
      .prepare("SELECT * FROM entities WHERE layer = ?")
      .all(layer) as EntityRow[];
  }

  getEntityById(id: number): EntityRow | undefined {
    return this.db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as
      | EntityRow
      | undefined;
  }

  getAllEntities(): EntityRow[] {
    return this.db.prepare("SELECT * FROM entities").all() as EntityRow[];
  }

  getEntitiesByRepo(repo: string): EntityRow[] {
    return this.db
      .prepare(
        `SELECT e.* FROM entities e
         JOIN files f ON e.file_id = f.id
         WHERE f.repo = ?`,
      )
      .all(repo) as EntityRow[];
  }

  /**
   * Edge operations
   */
  insertEdge(
    sourceId: number,
    targetId: number,
    edgeType: EdgeType,
    confidence: number = 1.0,
    matchMethod: MatchMethod | null = null,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO edges (source_id, target_id, edge_type, confidence, match_method)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sourceId, targetId, edgeType, confidence, matchMethod);
    return result.lastInsertRowid as number;
  }

  getEdgesBySourceId(sourceId: number): EdgeRow[] {
    return this.db
      .prepare("SELECT * FROM edges WHERE source_id = ?")
      .all(sourceId) as EdgeRow[];
  }

  getEdgesByTargetId(targetId: number): EdgeRow[] {
    return this.db
      .prepare("SELECT * FROM edges WHERE target_id = ?")
      .all(targetId) as EdgeRow[];
  }

  clearEdges(): void {
    this.db.prepare("DELETE FROM edges").run();
  }

  getEdgeCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM edges")
      .get() as { count: number };
    return row.count;
  }

  getAllEdgesBySource(): Map<number, EdgeRow[]> {
    const rows = this.db.prepare("SELECT * FROM edges").all() as EdgeRow[];
    const map = new Map<number, EdgeRow[]>();
    for (const row of rows) {
      const arr = map.get(row.source_id);
      if (arr) arr.push(row);
      else map.set(row.source_id, [row]);
    }
    return map;
  }

  getAllEdgesByTarget(): Map<number, EdgeRow[]> {
    const rows = this.db.prepare("SELECT * FROM edges").all() as EdgeRow[];
    const map = new Map<number, EdgeRow[]>();
    for (const row of rows) {
      const arr = map.get(row.target_id);
      if (arr) arr.push(row);
      else map.set(row.target_id, [row]);
    }
    return map;
  }

  getAllFilesMap(): Map<number, FileRow> {
    const rows = this.db.prepare("SELECT * FROM files").all() as FileRow[];
    const map = new Map<number, FileRow>();
    for (const row of rows) {
      map.set(row.id, row);
    }
    return map;
  }

  /**
   * Concept operations
   */
  insertConcept(
    name: string,
    source: "tag" | "inferred" | "manual",
    description?: string,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO concepts (name, source, description) VALUES (?, ?, ?)`,
      )
      .run(name, source, description ?? null);
    return result.lastInsertRowid as number;
  }

  getConceptByName(name: string): ConceptRow | undefined {
    return this.db
      .prepare("SELECT * FROM concepts WHERE name = ?")
      .get(name) as ConceptRow | undefined;
  }

  getOrCreateConcept(
    name: string,
    source: "tag" | "inferred" | "manual",
  ): number {
    const existing = this.getConceptByName(name);
    if (existing) return existing.id;
    return this.insertConcept(name, source);
  }

  getAllConcepts(): ConceptRow[] {
    return this.db.prepare("SELECT * FROM concepts").all() as ConceptRow[];
  }

  getEntitiesByConceptId(conceptId: number): EntityRow[] {
    return this.db
      .prepare(
        `SELECT e.* FROM entities e
         JOIN entity_concepts ec ON e.id = ec.entity_id
         WHERE ec.concept_id = ?`,
      )
      .all(conceptId) as EntityRow[];
  }

  linkEntityToConcept(
    entityId: number,
    conceptId: number,
    confidence: number = 1.0,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO entity_concepts (entity_id, concept_id, confidence)
         VALUES (?, ?, ?)`,
      )
      .run(entityId, conceptId, confidence);
  }

  /**
   * Search operations
   */
  searchEntities(query: string, limit: number = 20): EntityRow[] {
    return this.db
      .prepare(
        `SELECT e.* FROM entities e
         JOIN entities_fts fts ON e.id = fts.rowid
         WHERE entities_fts MATCH ?
         LIMIT ?`,
      )
      .all(query, limit) as EntityRow[];
  }

  /**
   * Statistics
   */
  getEntityCountByLayer(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT layer, COUNT(*) as count FROM entities GROUP BY layer")
      .all() as { layer: string; count: number }[];
    return Object.fromEntries(rows.map((r) => [r.layer, r.count]));
  }

  getTotalEntityCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM entities")
      .get() as { count: number };
    return row.count;
  }

  getTotalFileCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM files")
      .get() as { count: number };
    return row.count;
  }

  /**
   * Save a drift snapshot with counts per category.
   */
  saveDriftSnapshot(timestamp: string, counts: Record<string, number>): void {
    this.setMetadata(`drift_snapshot:${timestamp}`, JSON.stringify(counts));
  }

  /**
   * Get drift snapshots ordered by timestamp (most recent first).
   */
  getDriftSnapshots(
    limit: number = 10,
  ): Array<{ timestamp: string; counts: Record<string, number> }> {
    const rows = this.db
      .prepare(
        `SELECT key, value FROM metadata
         WHERE key LIKE 'drift_snapshot:%'
         ORDER BY key DESC
         LIMIT ?`,
      )
      .all(limit) as { key: string; value: string }[];

    return rows.map((row) => ({
      timestamp: row.key.replace("drift_snapshot:", ""),
      counts: JSON.parse(row.value),
    }));
  }

  /**
   * Transaction helper
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

/**
 * Row types for database queries
 */
export interface FileRow {
  id: number;
  path: string;
  content_hash: string;
  language: string | null;
  repo: string | null;
  last_indexed_at: string;
}

export interface EntityRow {
  id: number;
  file_id: number;
  entity_type: string;
  name: string;
  qualified_name: string | null;
  layer: string;
  start_line: number;
  end_line: number;
  visibility: string | null;
  signature: string | null;
  metadata: string;
}

export interface EdgeRow {
  id: number;
  source_id: number;
  target_id: number;
  edge_type: string;
  confidence: number;
  match_method: string | null;
}

export interface ConceptRow {
  id: number;
  name: string;
  description: string | null;
  source: string;
}
