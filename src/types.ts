/**
 * Core types for drift-detector
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The 8 layers of a software project that drift-detector tracks.
 * Ordered from most abstract (problem) to most concrete (user_doc).
 */
export type Layer =
  | "problem" // Problem statements, ADRs, requirements
  | "feature" // Gherkin feature files
  | "e2e_test" // End-to-end / integration tests
  | "unit_test" // Unit tests
  | "perf_test" // Performance tests / benchmarks
  | "source" // Production source code
  | "dev_doc" // Developer documentation (CLAUDE.md, ARCHITECTURE.md)
  | "user_doc"; // User-facing documentation (README, guides)

/**
 * Types of entities that can be extracted from project files.
 */
export type EntityType =
  // Gherkin
  | "feature"
  | "scenario"
  | "scenario_outline"
  | "background"
  | "step"
  // Source code
  | "function"
  | "method"
  | "class"
  | "struct"
  | "enum"
  | "trait"
  | "interface"
  | "type_alias"
  | "constant"
  | "module"
  // Tests
  | "test_fn"
  | "test_suite"
  | "benchmark"
  // Documentation
  | "doc_section"
  | "api_endpoint"
  // Problem tracking
  | "problem_statement"
  | "decision";

/**
 * Types of edges (relationships) between entities.
 */
export type EdgeType =
  | "tests" // test → code: this test exercises this code
  | "tested_by" // code → test: this code is tested by
  | "implements" // code → feature: this code implements this feature
  | "implemented_by" // feature → code: this feature is implemented by
  | "documents" // doc → code: this doc describes this code
  | "documented_by" // code → doc: this code is documented by
  | "covers" // test → feature: this test covers this scenario
  | "covered_by" // feature → test: this scenario is covered by
  | "calls" // code → code: function call relationship
  | "references" // any → any: generic reference
  | "parent_of" // structural: feature → scenario, class → method
  | "child_of"; // structural: scenario → feature, method → class

/**
 * Methods used to establish cross-references between entities.
 */
export type MatchMethod =
  | "exact_tag" // Shared tag (e.g., @auth)
  | "name_convention" // Normalized name match
  | "path_stem" // File path stem match
  | "fuzzy" // String similarity match
  | "containment" // All tokens of shorter name found in longer name
  | "semantic" // Embedding-based match
  | "explicit"; // Explicit annotation in code

/**
 * Visibility of a code entity.
 */
export type Visibility = "public" | "private" | "protected" | "internal";

/**
 * A parsed entity extracted from a file.
 * This is the intermediate representation produced by parsers.
 */
export interface ParsedEntity {
  /** Display name of the entity */
  name: string;

  /** Fully qualified name (e.g., module::Class::method) */
  qualifiedName?: string;

  /** Type of entity */
  entityType: EntityType;

  /** Which layer this entity belongs to */
  layer: Layer;

  /** Starting line number (1-indexed) */
  startLine: number;

  /** Ending line number (1-indexed) */
  endLine: number;

  /** Visibility modifier for code entities */
  visibility?: Visibility;

  /** Function signature or type definition text */
  signature?: string;

  /** Tags extracted from the entity (Gherkin tags, doc tags, etc.) */
  tags: string[];

  /** Additional metadata specific to entity type */
  metadata: Record<string, unknown>;
}

/**
 * A reference hint extracted during parsing.
 * Used to suggest cross-references before full graph analysis.
 */
export interface ReferenceHint {
  /** Type of reference */
  type: "tag" | "import" | "call" | "doc_link" | "annotation";

  /** The reference target (tag name, import path, function name, etc.) */
  target: string;

  /** Line where the reference appears */
  line: number;

  /** Optional: qualified target for imports */
  qualifiedTarget?: string;
}

/**
 * Result of parsing a single file.
 */
export interface ParseResult {
  /** Entities extracted from the file */
  entities: ParsedEntity[];

  /** Reference hints for cross-referencing */
  references: ReferenceHint[];

  /** Any parse errors or warnings */
  errors: ParseError[];
}

/**
 * A parse error or warning.
 */
export interface ParseError {
  /** Error severity */
  severity: "error" | "warning";

  /** Error message */
  message: string;

  /** Line number where error occurred */
  line?: number;

  /** Column number where error occurred */
  column?: number;
}

/**
 * Interface that all layer parsers must implement.
 */
export interface LayerParser {
  /** Unique identifier for the language/format this parser handles */
  readonly languageId: string;

  /** Glob patterns for files this parser can handle */
  readonly filePatterns: string[];

  /**
   * Parse a file and extract entities.
   * @param path - Absolute path to the file
   * @param content - File content as string
   * @returns Parse result with entities, references, and errors
   */
  parseFile(path: string, content: string): ParseResult;
}

/**
 * Drift severity levels.
 */
export type DriftSeverity = "high" | "medium" | "low";

/**
 * Categories of drift that can be detected.
 */
export type DriftCategory =
  | "missing_test" // Feature/code with no test coverage
  | "missing_doc" // Code/feature with no documentation
  | "missing_feature" // Test/code with no feature spec
  | "orphan_test" // Test with no corresponding feature/code
  | "orphan_code" // Code with no tests or docs
  | "stale_doc" // Doc referencing non-existent code
  | "stale_api" // API doc for removed endpoint
  | "naming_drift" // Inconsistent naming across layers
  | "parity_gap" // Concept exists in some repos but not all expected ones
  | "stale_tag"; // @planned tag on scenario that has implementation evidence

/**
 * A detected drift item.
 */
export interface DriftItem {
  /** Unique identifier */
  id: string;

  /** Severity level */
  severity: DriftSeverity;

  /** Category of drift */
  category: DriftCategory;

  /** The entity where drift was detected */
  sourceEntityId: number;

  /** The layer where coverage is expected but missing */
  expectedLayer: Layer;

  /** Human-readable description of the drift */
  message: string;

  /** Suggested action to fix the drift */
  suggestion: string;

  /** File path where drift was detected */
  filePath: string;

  /** Line number in the file */
  line: number;
}

/**
 * A concept that spans multiple layers.
 */
export interface Concept {
  /** Unique identifier */
  id: number;

  /** Primary name of the concept */
  name: string;

  /** Optional description */
  description?: string;

  /** How the concept was discovered */
  source: "tag" | "inferred" | "manual";

  /** Layers where this concept appears */
  layers: Layer[];

  /** Entity IDs linked to this concept */
  entityIds: number[];
}

/**
 * Coverage matrix entry for a concept.
 */
export interface CoverageEntry {
  /** Concept being measured */
  concept: string;

  /** Coverage per layer (true = covered, false = missing) */
  layers: Record<Layer, boolean>;

  /** Overall coverage score (0-1) */
  score: number;
}

/**
 * Project overview statistics.
 */
export interface ProjectOverview {
  /** Total number of indexed files */
  totalFiles: number;

  /** Total number of entities */
  totalEntities: number;

  /** Entity count per layer */
  entitiesByLayer: Record<Layer, number>;

  /** Total number of concepts */
  totalConcepts: number;

  /** Total number of drift items */
  totalDrift: number;

  /** Drift count by severity */
  driftBySeverity: Record<DriftSeverity, number>;

  /** Overall coherence score (0-1, higher is better) */
  coherenceScore: number;

  /** Last index timestamp */
  lastIndexedAt: string;
}
