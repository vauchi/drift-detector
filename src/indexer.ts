/**
 * Indexer - Discovers and indexes project files
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import fg from "fast-glob";
import { DriftDatabase } from "./db/database.js";
import { GherkinParser } from "./parsers/gherkin.js";
import { RustParser } from "./parsers/rust.js";
import { TypeScriptParser } from "./parsers/typescript.js";
import { MarkdownParser } from "./parsers/markdown.js";
import type { LayerParser, EdgeType } from "./types.js";
import {
  parseTags,
  matchByTags,
  matchByName,
  matchByPathStem,
  normalizeName,
  extractStem,
} from "./matching.js";
import type { CompiledConfig } from "./config.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { cosineSimilarity, buildEntityText } from "./embeddings.js";

/** Skip tags that appear in >50 entities within a single layer (too generic) */
export const MAX_TAG_FREQUENCY = 50;

/** Max edges per source entity per edge pair */
export const MAX_EDGES_PER_ENTITY = 10;

/** Minimum confidence to create an edge */
export const MIN_EDGE_CONFIDENCE = 0.6;

export interface IndexOptions {
  /** If true, drops and rebuilds the entire index */
  full?: boolean;
  /** Repo name to tag files with (for multi-repo workspaces) */
  repo?: string;
  /** Additional glob patterns to ignore (used to exclude sub-repo paths from root) */
  extraIgnore?: string[];
}

export interface RepoDefinition {
  /** Repository name (e.g. "core", "relay") */
  name: string;
  /** Path relative to workspace root (e.g. "core/") */
  path: string;
}

export interface WorkspaceIndexResult {
  /** Number of repos successfully indexed */
  reposIndexed: number;
  /** Total number of files indexed across all repos */
  filesIndexed: number;
  /** Total number of files skipped (unchanged) across all repos */
  filesSkipped: number;
  /** Total number of files removed (deleted from disk) across all repos */
  filesRemoved: number;
  /** Total number of entities extracted across all repos */
  entitiesExtracted: number;
  /** Total number of concepts created across all repos */
  conceptsCreated: number;
  /** Number of edges created between entities (built once after all repos) */
  edgesCreated: number;
  /** Errors from repos that failed to index */
  errors: Array<{ repo: string; message: string }>;
}

export interface IndexResult {
  /** Number of files indexed */
  filesIndexed: number;
  /** Number of files skipped (unchanged) */
  filesSkipped: number;
  /** Number of files removed (deleted from disk) */
  filesRemoved: number;
  /** Number of entities extracted */
  entitiesExtracted: number;
  /** Number of concepts created */
  conceptsCreated: number;
  /** Number of edges created between entities */
  edgesCreated: number;
  /** Errors encountered during indexing */
  errors: Array<{ file: string; message: string }>;
}

/**
 * Indexes project files by discovering them, parsing with appropriate parsers,
 * and storing entities in the database.
 */
/** Built-in ignore patterns that always apply */
const BUILTIN_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/target/**",
  "**/.cargo/**",
  "**/build/**",
];

export class Indexer {
  private db: DriftDatabase;
  private parsers: LayerParser[];
  private config: CompiledConfig;
  private embedder?: EmbeddingProvider;

  constructor(
    db: DriftDatabase,
    config: CompiledConfig,
    embedder?: EmbeddingProvider,
  ) {
    this.db = db;
    this.config = config;
    this.embedder = embedder;
    this.parsers = [
      new GherkinParser(config),
      new RustParser(config),
      new TypeScriptParser(config),
      new MarkdownParser(config),
    ];
  }

  /**
   * Index all matching files in a directory.
   */
  async indexDirectory(
    rootDir: string,
    options: IndexOptions = {},
  ): Promise<IndexResult> {
    const result: IndexResult = {
      filesIndexed: 0,
      filesSkipped: 0,
      filesRemoved: 0,
      entitiesExtracted: 0,
      conceptsCreated: 0,
      edgesCreated: 0,
      errors: [],
    };

    // Full reindex: clear everything first
    if (options.full) {
      this.db.reset();
    }

    // Get all file patterns from parsers
    const patterns = this.parsers.flatMap((p) => p.filePatterns);

    const files = await fg(patterns, {
      cwd: rootDir,
      absolute: true,
      ignore: [
        ...BUILTIN_IGNORE,
        ...this.config.indexing.ignore,
        ...(options.extraIgnore ?? []),
      ],
    });

    // Build map of current files for deletion detection
    const currentFilePaths = new Set(files);

    // Check for deleted files (incremental only)
    if (!options.full) {
      const indexedFiles = this.db.getAllFiles();
      for (const indexedFile of indexedFiles) {
        // Only consider files under the current rootDir for deletion
        // (avoids cross-repo deletions in multi-repo workspaces)
        if (
          indexedFile.path.startsWith(rootDir) &&
          !currentFilePaths.has(indexedFile.path)
        ) {
          this.db.deleteFile(indexedFile.path);
          result.filesRemoved++;
        }
      }
    }

    for (const filePath of files) {
      try {
        const indexed = await this.indexFile(filePath, options);
        if (indexed.skipped) {
          result.filesSkipped++;
        } else {
          result.filesIndexed++;
          result.entitiesExtracted += indexed.entityCount;
          result.conceptsCreated += indexed.conceptCount;
        }
      } catch (error) {
        result.errors.push({
          file: filePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Build cross-layer edges after all files are indexed
    result.edgesCreated = await this.buildEdges();

    return result;
  }

  /**
   * Build cross-layer edges between entities using multi-strategy matching.
   * Returns the number of edges created.
   */
  async buildEdges(): Promise<number> {
    this.db.clearEdges();
    let edgeCount = 0;

    const allEntities = this.db.getAllEntities();
    const allFiles = this.db.getAllFiles();
    const filePathById = new Map(allFiles.map((f) => [f.id, f.path]));

    // Group entities by layer
    const byLayer = new Map<string, typeof allEntities>();
    for (const entity of allEntities) {
      const arr = byLayer.get(entity.layer) || [];
      arr.push(entity);
      byLayer.set(entity.layer, arr);
    }

    // Build tag index per layer for fast lookup
    const tagIndex = this.buildTagIndex(allEntities);

    // Phase 0: Build explicit edges from @scenario and @source annotations
    // These are high-confidence (1.0) edges that take priority over heuristic matching
    const explicitlyMatched = new Set<string>();

    this.db.transaction(() => {
      edgeCount += this.buildAnnotationEdges(
        allEntities,
        filePathById,
        explicitlyMatched,
      );
      edgeCount += this.buildSourceAnnotationEdges(
        allEntities,
        filePathById,
        explicitlyMatched,
      );
    });

    // Define cross-layer edge pairs to build
    const edgePairs: Array<{
      sourceLayer: string[];
      targetLayer: string[];
      forwardType: EdgeType;
      reverseType: EdgeType;
    }> = [
      {
        sourceLayer: ["unit_test", "e2e_test"],
        targetLayer: ["feature"],
        forwardType: "covers",
        reverseType: "covered_by",
      },
      {
        sourceLayer: ["unit_test", "e2e_test"],
        targetLayer: ["source"],
        forwardType: "tests",
        reverseType: "tested_by",
      },
      {
        sourceLayer: ["dev_doc", "user_doc"],
        targetLayer: ["source"],
        forwardType: "documents",
        reverseType: "documented_by",
      },
      {
        sourceLayer: ["source"],
        targetLayer: ["feature"],
        forwardType: "implements",
        reverseType: "implemented_by",
      },
    ];

    this.db.transaction(() => {
      for (const pair of edgePairs) {
        edgeCount += this.buildCrossLayerEdges(
          byLayer,
          filePathById,
          tagIndex,
          pair.sourceLayer,
          pair.targetLayer,
          pair.forwardType,
          pair.reverseType,
          explicitlyMatched,
        );
      }
    });

    // Phase 2.5: Semantic matching via embeddings (optional)
    if (this.embedder && (await this.embedder.isAvailable())) {
      edgeCount += await this.buildSemanticEdges(
        byLayer,
        filePathById,
        explicitlyMatched,
      );
    }

    return edgeCount;
  }

  /**
   * Build explicit edges from @scenario annotations in entity metadata.
   * These are high-confidence (1.0) edges with match_method "explicit".
   */
  private buildAnnotationEdges(
    allEntities: import("./db/database.js").EntityRow[],
    filePathById: Map<number, string>,
    matched: Set<string>,
  ): number {
    let count = 0;

    // Build a lookup of scenario entities by name for efficient matching
    const scenariosByName = new Map<
      string,
      import("./db/database.js").EntityRow[]
    >();
    for (const entity of allEntities) {
      if (
        entity.layer === "feature" &&
        (entity.entity_type === "scenario" ||
          entity.entity_type === "scenario_outline")
      ) {
        const arr = scenariosByName.get(entity.name) || [];
        arr.push(entity);
        scenariosByName.set(entity.name, arr);
      }
    }

    // Find entities with scenarioAnnotations in their metadata
    for (const entity of allEntities) {
      if (entity.layer !== "unit_test" && entity.layer !== "e2e_test") continue;

      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(entity.metadata || "{}");
      } catch {
        continue;
      }

      const annotations = metadata.scenarioAnnotations as
        | Array<{ feature: string; scenario: string }>
        | undefined;
      if (!annotations || !Array.isArray(annotations)) continue;

      for (const annotation of annotations) {
        // Look up the scenario by name
        const candidates = scenariosByName.get(annotation.scenario);
        if (!candidates || candidates.length === 0) continue;

        // If there are multiple scenarios with the same name, prefer one
        // whose file path matches the annotation's feature name
        let target = candidates[0];
        if (candidates.length > 1) {
          const featureMatch = candidates.find((c) => {
            const filePath = filePathById.get(c.file_id) || "";
            return filePath.includes(annotation.feature);
          });
          if (featureMatch) target = featureMatch;
        }

        const key = `${entity.id}-${target.id}`;
        if (matched.has(key)) continue;
        matched.add(key);

        this.db.insertEdge(entity.id, target.id, "covers", 1.0, "explicit");
        this.db.insertEdge(target.id, entity.id, "covered_by", 1.0, "explicit");
        count += 2;
      }
    }

    return count;
  }

  /**
   * Build explicit edges from @source annotations in entity metadata.
   * These create "tests"/"tested_by" edges with confidence 1.0 and method "explicit".
   */
  private buildSourceAnnotationEdges(
    allEntities: import("./db/database.js").EntityRow[],
    filePathById: Map<number, string>,
    matched: Set<string>,
  ): number {
    let count = 0;

    // Build lookup of source entities by name and qualified_name
    const sourcesByName = new Map<
      string,
      import("./db/database.js").EntityRow[]
    >();
    const sourcesByQualifiedName = new Map<
      string,
      import("./db/database.js").EntityRow
    >();
    for (const entity of allEntities) {
      if (entity.layer !== "source") continue;
      const arr = sourcesByName.get(entity.name) || [];
      arr.push(entity);
      sourcesByName.set(entity.name, arr);
      if (entity.qualified_name) {
        sourcesByQualifiedName.set(entity.qualified_name, entity);
      }
    }

    // Find test entities with sourceAnnotations in their metadata
    for (const entity of allEntities) {
      if (entity.layer !== "unit_test" && entity.layer !== "e2e_test") continue;

      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(entity.metadata || "{}");
      } catch {
        continue;
      }

      const annotations = metadata.sourceAnnotations as
        | Array<{ target: string }>
        | undefined;
      if (!annotations || !Array.isArray(annotations)) continue;

      for (const annotation of annotations) {
        // Try qualified name first (e.g., "recovery::get_recovery_readiness")
        let target = sourcesByQualifiedName.get(annotation.target);

        // Fall back to simple name lookup
        if (!target) {
          const candidates = sourcesByName.get(annotation.target);
          if (candidates && candidates.length > 0) {
            target = candidates[0];
            // If multiple candidates, prefer one in same repo
            if (candidates.length > 1) {
              const testFilePath = filePathById.get(entity.file_id) || "";
              const repoMatch = candidates.find((c) => {
                const sourcePath = filePathById.get(c.file_id) || "";
                // Same repo prefix (e.g., both under /core/)
                const parts = testFilePath.split("/");
                if (parts.length <= 2) return false;
                const testRepo = parts.slice(0, -2).join("/");
                return sourcePath.startsWith(testRepo);
              });
              if (repoMatch) target = repoMatch;
            }
          }
        }

        if (!target) continue;

        const key = `${entity.id}-${target.id}`;
        if (matched.has(key)) continue;
        matched.add(key);

        this.db.insertEdge(entity.id, target.id, "tests", 1.0, "explicit");
        this.db.insertEdge(target.id, entity.id, "tested_by", 1.0, "explicit");
        count += 2;
      }
    }

    return count;
  }

  /**
   * Build edges between two sets of layers.
   */
  private buildCrossLayerEdges(
    byLayer: Map<string, import("./db/database.js").EntityRow[]>,
    filePathById: Map<number, string>,
    tagIndex: Map<string, Map<string, import("./db/database.js").EntityRow[]>>,
    sourceLayers: string[],
    targetLayers: string[],
    forwardType: EdgeType,
    reverseType: EdgeType,
    explicitlyMatched: Set<string> = new Set(),
  ): number {
    let count = 0;

    const sources = sourceLayers.flatMap((l) => byLayer.get(l) || []);
    const targets = targetLayers.flatMap((l) => byLayer.get(l) || []);

    if (sources.length === 0 || targets.length === 0) return 0;

    // Track which sources have been matched (to avoid duplicate edges)
    // Include pairs that were already matched by explicit annotations
    const matched = new Set<string>(explicitlyMatched);

    // Phase 1: Tag-based matching using pre-built index
    // Track per-entity edge count for cap
    const edgesPerSource = new Map<number, number>();
    // Track sources matched in Phase 1 only (not from explicit annotations)
    const phase1MatchedSources = new Set<number>();

    for (const source of sources) {
      const sourceTags = parseTags(source);
      for (const tag of sourceTags) {
        for (const targetLayer of targetLayers) {
          const layerTagMap = tagIndex.get(targetLayer);
          if (!layerTagMap) continue;
          const tagTargets = layerTagMap.get(tag);
          if (!tagTargets) continue;

          // Tag frequency cap: skip tags that are too common in this layer
          if (tagTargets.length > MAX_TAG_FREQUENCY) continue;

          for (const target of tagTargets) {
            // Per-entity edge cap
            const sourceEdgeCount = edgesPerSource.get(source.id) || 0;
            if (sourceEdgeCount >= MAX_EDGES_PER_ENTITY) break;

            const key = `${source.id}-${target.id}`;
            if (matched.has(key)) continue;
            matched.add(key);

            const tagMatch = matchByTags(source, target);
            if (tagMatch && tagMatch.confidence >= MIN_EDGE_CONFIDENCE) {
              this.db.insertEdge(
                source.id,
                target.id,
                forwardType,
                tagMatch.confidence,
                tagMatch.method,
              );
              this.db.insertEdge(
                target.id,
                source.id,
                reverseType,
                tagMatch.confidence,
                tagMatch.method,
              );
              count += 2;
              edgesPerSource.set(source.id, sourceEdgeCount + 1);
              phase1MatchedSources.add(source.id);
            }
          }
        }
      }
    }

    // Phase 2: Name + path matching for sources not matched in Phase 1
    // Use phase1MatchedSources (not the full matched set) to avoid blocking
    // tests that only have explicit annotation edges (covers) from getting
    // name/path-based edges (tests) to source code entities.
    const matchedSources = phase1MatchedSources;

    // Pre-index targets by normalized name tokens for O(1) candidate lookup
    // instead of O(sources × targets) brute-force comparison
    const targetsByToken = new Map<string, Array<(typeof targets)[number]>>();
    for (const target of targets) {
      const tokens = normalizeName(target.name);
      for (const token of tokens) {
        const arr = targetsByToken.get(token) || [];
        arr.push(target);
        targetsByToken.set(token, arr);
      }
    }

    // Pre-index targets by path stem for path-based matching
    const targetsByStem = new Map<string, Array<(typeof targets)[number]>>();
    for (const target of targets) {
      const p = filePathById.get(target.file_id);
      if (p) {
        const stem = extractStem(p);
        if (stem) {
          const arr = targetsByStem.get(stem) || [];
          arr.push(target);
          targetsByStem.set(stem, arr);
        }
      }
    }

    for (const source of sources) {
      if (matchedSources.has(source.id)) continue;

      // Gather candidate targets that share at least one token with source
      const sourceTokens = normalizeName(source.name);
      const candidateIds = new Set<number>();
      const candidateMap = new Map<number, (typeof targets)[number]>();
      for (const token of sourceTokens) {
        const hits = targetsByToken.get(token);
        if (hits) {
          for (const t of hits) {
            if (!candidateIds.has(t.id)) {
              candidateIds.add(t.id);
              candidateMap.set(t.id, t);
            }
          }
        }
      }

      let sourceMatched = false;
      for (const target of candidateMap.values()) {
        const key = `${source.id}-${target.id}`;
        if (matched.has(key)) continue;

        const nameMatch = matchByName(source.name, target.name);
        if (nameMatch && nameMatch.confidence >= MIN_EDGE_CONFIDENCE) {
          matched.add(key);
          this.db.insertEdge(
            source.id,
            target.id,
            forwardType,
            nameMatch.confidence,
            nameMatch.method,
          );
          this.db.insertEdge(
            target.id,
            source.id,
            reverseType,
            nameMatch.confidence,
            nameMatch.method,
          );
          count += 2;
          sourceMatched = true;
          break; // One match per source for name/path
        }
      }

      if (!sourceMatched) {
        // Try path stem matching
        const pathA = filePathById.get(source.file_id);
        if (pathA) {
          const stem = extractStem(pathA);
          if (stem) {
            const stemCandidates = targetsByStem.get(stem);
            if (stemCandidates) {
              for (const target of stemCandidates) {
                const key = `${source.id}-${target.id}`;
                if (matched.has(key)) continue;
                const pathB = filePathById.get(target.file_id);
                if (pathB) {
                  const pathMatch = matchByPathStem(pathA, pathB);
                  if (
                    pathMatch &&
                    pathMatch.confidence >= MIN_EDGE_CONFIDENCE
                  ) {
                    matched.add(key);
                    this.db.insertEdge(
                      source.id,
                      target.id,
                      forwardType,
                      pathMatch.confidence,
                      pathMatch.method,
                    );
                    this.db.insertEdge(
                      target.id,
                      source.id,
                      reverseType,
                      pathMatch.confidence,
                      pathMatch.method,
                    );
                    count += 2;
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }

    return count;
  }

  /**
   * Phase 2.5: Semantic matching via embeddings.
   * Only matches source → feature (the pair that suffers most from stale tags).
   * Finds unmatched features and embeds them alongside a sample of sources.
   */
  private async buildSemanticEdges(
    byLayer: Map<string, import("./db/database.js").EntityRow[]>,
    filePathById: Map<number, string>,
    explicitlyMatched: Set<string>,
  ): Promise<number> {
    const MAX_SOURCES_TO_EMBED = 500;
    const SEMANTIC_THRESHOLD = 0.6;

    const features = byLayer.get("feature") || [];
    const sources = byLayer.get("source") || [];

    if (features.length === 0 || sources.length === 0) return 0;

    // Find features that have no "implemented_by" edges from Phase 0-2
    // implemented_by edges have the feature as source_id
    const edgesBySource = this.db.getAllEdgesBySource();
    const featuresWithImplements = new Set<number>();
    for (const [sourceId, edges] of edgesBySource) {
      if (edges.some((e) => e.edge_type === "implemented_by")) {
        featuresWithImplements.add(sourceId);
      }
    }

    const unmatchedFeatures = features.filter(
      (f) =>
        (f.entity_type === "scenario" ||
          f.entity_type === "scenario_outline") &&
        !featuresWithImplements.has(f.id),
    );

    if (unmatchedFeatures.length === 0) return 0;

    // Sample sources to bound runtime
    const sourceSample = sources.slice(0, MAX_SOURCES_TO_EMBED);

    // Embed all unmatched features
    const featureEmbeddings = new Map<number, number[]>();
    for (const feature of unmatchedFeatures) {
      const text = buildEntityText(feature);
      const embedding = await this.embedder!.embed(text);
      if (embedding) {
        featureEmbeddings.set(feature.id, embedding);
      }
    }

    if (featureEmbeddings.size === 0) return 0;

    // Embed source sample
    const sourceEmbeddings = new Map<number, number[]>();
    for (const source of sourceSample) {
      const text = buildEntityText(source);
      const embedding = await this.embedder!.embed(text);
      if (embedding) {
        sourceEmbeddings.set(source.id, embedding);
      }
    }

    if (sourceEmbeddings.size === 0) return 0;

    // For each unmatched feature, find the best matching source
    let count = 0;
    const edgesToInsert: Array<{
      sourceId: number;
      targetId: number;
      confidence: number;
    }> = [];

    for (const [featureId, featureVec] of featureEmbeddings) {
      let bestSourceId: number | null = null;
      let bestSim = 0;

      for (const [sourceId, sourceVec] of sourceEmbeddings) {
        const key = `${sourceId}-${featureId}`;
        if (explicitlyMatched.has(key)) continue;

        const sim = cosineSimilarity(featureVec, sourceVec);
        if (sim >= SEMANTIC_THRESHOLD && sim > bestSim) {
          bestSim = sim;
          bestSourceId = sourceId;
        }
      }

      if (bestSourceId !== null) {
        // Map similarity [0.6, 1.0] → confidence [0.5, 0.95]
        const confidence = 0.5 + bestSim * 0.45;
        edgesToInsert.push({
          sourceId: bestSourceId,
          targetId: featureId,
          confidence,
        });
      }
    }

    if (edgesToInsert.length > 0) {
      this.db.transaction(() => {
        for (const edge of edgesToInsert) {
          this.db.insertEdge(
            edge.sourceId,
            edge.targetId,
            "implements",
            edge.confidence,
            "semantic",
          );
          this.db.insertEdge(
            edge.targetId,
            edge.sourceId,
            "implemented_by",
            edge.confidence,
            "semantic",
          );
          count += 2;
        }
      });
    }

    return count;
  }

  /**
   * Build a tag index: layer → tag → entities with that tag.
   */
  private buildTagIndex(
    entities: import("./db/database.js").EntityRow[],
  ): Map<string, Map<string, import("./db/database.js").EntityRow[]>> {
    const index = new Map<
      string,
      Map<string, import("./db/database.js").EntityRow[]>
    >();

    for (const entity of entities) {
      const tags = parseTags(entity);
      for (const tag of tags) {
        let layerMap = index.get(entity.layer);
        if (!layerMap) {
          layerMap = new Map();
          index.set(entity.layer, layerMap);
        }
        let arr = layerMap.get(tag);
        if (!arr) {
          arr = [];
          layerMap.set(tag, arr);
        }
        arr.push(entity);
      }
    }

    return index;
  }

  /**
   * Index a single file.
   */
  private async indexFile(
    filePath: string,
    options: IndexOptions = {},
  ): Promise<{ skipped: boolean; entityCount: number; conceptCount: number }> {
    // Find appropriate parser
    const parser = this.findParser(filePath);
    if (!parser) {
      return { skipped: true, entityCount: 0, conceptCount: 0 };
    }

    const content = await fs.readFile(filePath, "utf-8");
    const contentHash = this.hashContent(content);

    // Check if file has changed (incremental indexing)
    if (!options.full) {
      const existingFile = this.db.getFileByPath(filePath);
      if (existingFile && existingFile.content_hash === contentHash) {
        return { skipped: true, entityCount: 0, conceptCount: 0 };
      }

      // Remove old data if file exists but changed
      if (existingFile) {
        this.db.deleteFile(filePath);
      }
    }

    const parseResult = parser.parseFile(filePath, content);

    // Store in database within a transaction
    let entityCount = 0;
    let conceptCount = 0;

    this.db.transaction(() => {
      const fileId = this.db.insertFile(
        filePath,
        contentHash,
        parser.languageId,
        options.repo ?? null,
      );

      for (const entity of parseResult.entities) {
        const entityId = this.db.insertEntity(fileId, entity);
        entityCount++;

        // Create concepts from tags, applying alias normalization
        for (const rawTag of entity.tags) {
          const tags = this.resolveAliases(rawTag);
          for (const tag of tags) {
            const existingConcept = this.db.getConceptByName(tag);
            if (!existingConcept) {
              const conceptId = this.db.insertConcept(tag, "tag");
              this.db.linkEntityToConcept(entityId, conceptId, 1.0);
              conceptCount++;
            } else {
              this.db.linkEntityToConcept(entityId, existingConcept.id, 1.0);
            }
          }
        }
      }
    });

    return { skipped: false, entityCount, conceptCount };
  }

  /**
   * Find a parser that can handle the given file.
   */
  private findParser(filePath: string): LayerParser | undefined {
    for (const parser of this.parsers) {
      for (const pattern of parser.filePatterns) {
        // Extract extension from glob pattern like "**/*.rs"
        const extMatch = pattern.match(/\*(\.\w+)$/);
        if (extMatch && filePath.endsWith(extMatch[1])) {
          return parser;
        }
      }
    }
    return undefined;
  }

  /**
   * Resolve a tag to its canonical concept name(s).
   * An alias maps to the canonical form; unrecognized tags pass through as-is.
   * A tag can also expand to multiple concepts (e.g., "ble" → ["exchange", "ble"]).
   */
  private resolveAliases(tag: string): string[] {
    const mapped = this.config.concepts.aliases[tag];
    if (mapped) return Array.isArray(mapped) ? mapped : [mapped];
    return [tag];
  }

  /**
   * Index a multi-repo workspace by iterating repo definitions.
   * Each repo's files are tagged with the repo name.
   *
   * When `options.full` is true, the DB is reset once at the start (not per-repo).
   * Edges are built once after all repos are indexed (not per-repo).
   */
  async indexWorkspace(
    workspaceRoot: string,
    repos: RepoDefinition[],
    options: IndexOptions = {},
  ): Promise<WorkspaceIndexResult> {
    const result: WorkspaceIndexResult = {
      reposIndexed: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      filesRemoved: 0,
      entitiesExtracted: 0,
      conceptsCreated: 0,
      edgesCreated: 0,
      errors: [],
    };

    // Reset DB once at start for full reindex (not per-repo)
    if (options.full) {
      this.db.reset();
    }

    // Collect all repo paths for excluding sub-repos from root entry
    const allRepoPaths = repos.map((r) => r.path);

    for (const repo of repos) {
      const repoPath = path.join(workspaceRoot, repo.path);
      try {
        await fs.access(repoPath);
      } catch {
        result.errors.push({
          repo: repo.name,
          message: `Repo path does not exist: ${repoPath}`,
        });
        continue;
      }

      // For root entry (path "."), exclude all other repo directories
      // so each sub-repo is only indexed under its own name
      const extraIgnore =
        repo.path === "."
          ? allRepoPaths.filter((p) => p !== ".").map((p) => `${p}**`)
          : [];

      // Don't pass full to per-repo indexDirectory — DB already reset above.
      // Don't let per-repo calls build edges — we do that once after all repos.
      const repoResult = await this.indexDirectoryNoEdges(repoPath, {
        repo: repo.name,
        extraIgnore,
      });
      result.reposIndexed++;
      result.filesIndexed += repoResult.filesIndexed;
      result.filesSkipped += repoResult.filesSkipped;
      result.filesRemoved += repoResult.filesRemoved;
      result.entitiesExtracted += repoResult.entitiesExtracted;
      result.conceptsCreated += repoResult.conceptsCreated;
    }

    // Build edges once after ALL repos are indexed
    result.edgesCreated = await this.buildEdges();

    return result;
  }

  /**
   * Index a directory without building edges (used by indexWorkspace).
   * Same as indexDirectory but skips the buildEdges() call at the end.
   */
  private async indexDirectoryNoEdges(
    rootDir: string,
    options: IndexOptions = {},
  ): Promise<Omit<IndexResult, "edgesCreated">> {
    const result = {
      filesIndexed: 0,
      filesSkipped: 0,
      filesRemoved: 0,
      entitiesExtracted: 0,
      conceptsCreated: 0,
      errors: [] as Array<{ file: string; message: string }>,
    };

    const patterns = this.parsers.flatMap((p) => p.filePatterns);

    const files = await fg(patterns, {
      cwd: rootDir,
      absolute: true,
      ignore: [
        ...BUILTIN_IGNORE,
        ...this.config.indexing.ignore,
        ...(options.extraIgnore ?? []),
      ],
    });

    const currentFilePaths = new Set(files);

    // Check for deleted files (only under this rootDir)
    const indexedFiles = this.db.getAllFiles();
    for (const indexedFile of indexedFiles) {
      if (
        indexedFile.path.startsWith(rootDir) &&
        !currentFilePaths.has(indexedFile.path)
      ) {
        this.db.deleteFile(indexedFile.path);
        result.filesRemoved++;
      }
    }

    for (const filePath of files) {
      try {
        const indexed = await this.indexFile(filePath, options);
        if (indexed.skipped) {
          result.filesSkipped++;
        } else {
          result.filesIndexed++;
          result.entitiesExtracted += indexed.entityCount;
          result.conceptsCreated += indexed.conceptCount;
        }
      } catch (error) {
        result.errors.push({
          file: filePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }

  /**
   * Compute SHA-256 hash of content.
   */
  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }
}
