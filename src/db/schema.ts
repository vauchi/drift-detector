/**
 * SQLite database schema for drift-detector
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * SQL statements to create the drift-detector schema.
 * Uses SQLite with FTS5 for full-text search.
 */
export const SCHEMA_SQL = `
-- Indexed files
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    language TEXT,
    repo TEXT,
    last_indexed_at TEXT NOT NULL
);

-- Entities extracted from files
CREATE TABLE IF NOT EXISTS entities (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT,
    layer TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    visibility TEXT,
    signature TEXT,
    metadata TEXT
);

-- Relationships between entities
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    edge_type TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    match_method TEXT
);

-- Concepts that span layers
CREATE TABLE IF NOT EXISTS concepts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    source TEXT NOT NULL DEFAULT 'inferred'
);

-- Many-to-many: entities <-> concepts
CREATE TABLE IF NOT EXISTS entity_concepts (
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
    confidence REAL DEFAULT 1.0,
    PRIMARY KEY (entity_id, concept_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_files_repo ON files(repo);
CREATE INDEX IF NOT EXISTS idx_entities_file ON entities(file_id);
CREATE INDEX IF NOT EXISTS idx_entities_layer ON entities(layer);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
CREATE INDEX IF NOT EXISTS idx_entity_concepts_entity ON entity_concepts(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_concepts_concept ON entity_concepts(concept_id);

-- Composite indexes for drift detection queries
CREATE INDEX IF NOT EXISTS idx_entities_layer_type ON entities(layer, entity_type);
CREATE INDEX IF NOT EXISTS idx_edges_source_type ON edges(source_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_target_type ON edges(target_id, edge_type);

-- Full-text search on entities
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    name,
    qualified_name,
    signature,
    content='entities',
    content_rowid='id'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, name, qualified_name, signature)
    VALUES (new.id, new.name, new.qualified_name, new.signature);
END;

CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, name, qualified_name, signature)
    VALUES ('delete', old.id, old.name, old.qualified_name, old.signature);
END;

CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, name, qualified_name, signature)
    VALUES ('delete', old.id, old.name, old.qualified_name, old.signature);
    INSERT INTO entities_fts(rowid, name, qualified_name, signature)
    VALUES (new.id, new.name, new.qualified_name, new.signature);
END;

-- Metadata table for tracking index state
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

/**
 * SQL to drop all tables (for full reindex).
 */
export const DROP_SCHEMA_SQL = `
DROP TABLE IF EXISTS entity_concepts;
DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS entities_fts;
DROP TABLE IF EXISTS entities;
DROP TABLE IF EXISTS concepts;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS metadata;
`;

/**
 * Schema version for migrations.
 */
export const SCHEMA_VERSION = 3;
