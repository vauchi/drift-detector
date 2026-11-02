/**
 * MCP Server for drift-detector
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DriftDatabase } from "./db/database.js";
import { Indexer } from "./indexer.js";
import { OllamaEmbeddingProvider } from "./embeddings.js";
import type {
  Layer,
  DriftSeverity,
  DriftCategory,
  ProjectOverview,
} from "./types.js";
import { matchByName, matchByTags } from "./matching.js";
import { compareTwoStrings } from "string-similarity";
import {
  loadDriftIgnore,
  shouldIgnore,
  type DriftIgnoreRule,
} from "./driftignore.js";
import type { CompiledConfig } from "./config.js";
import { checkParity, checkRepo } from "./cross-repo.js";

const ALL_LAYERS: Layer[] = [
  "problem",
  "feature",
  "e2e_test",
  "unit_test",
  "perf_test",
  "source",
  "dev_doc",
  "user_doc",
];

/**
 * Creates and configures the MCP server with all drift-detector tools.
 */
export function createServer(
  db: DriftDatabase,
  projectRoot: string,
  config: CompiledConfig,
): McpServer {
  const server = new McpServer({
    name: "drift-detector",
    version: "0.1.0",
  });

  const embedder = config.embeddings.enabled
    ? new OllamaEmbeddingProvider(
        config.embeddings.model,
        config.embeddings.baseUrl,
      )
    : undefined;

  const indexer = new Indexer(db, config, embedder);

  // Tool 1: check_concept
  server.tool(
    "check_concept",
    "Look up a concept across all project layers. Returns where it appears " +
      "(features, tests, code, docs), what's missing, and any drift.",
    {
      concept: z.string().describe("The concept name to look up"),
      include_code: z
        .boolean()
        .default(true)
        .describe("Whether to include code snippets in the response"),
    },
    async ({ concept, include_code }) => {
      const conceptRow = db.getConceptByName(concept);
      if (!conceptRow) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Concept "${concept}" not found in the index. Try running reindex first.`,
            },
          ],
        };
      }

      // Find all entities linked to this concept
      const entities = db.getAllEntities();
      const linkedEntities = entities.filter((e) => {
        const metadata = JSON.parse(e.metadata || "{}");
        const tags: string[] = metadata.tags || [];
        // Check if entity has this tag or if it's linked via entity_concepts
        return (
          tags.includes(concept) ||
          e.name.toLowerCase().includes(concept.toLowerCase())
        );
      });

      const byLayer: Record<string, typeof linkedEntities> = {};
      for (const entity of linkedEntities) {
        if (!byLayer[entity.layer]) byLayer[entity.layer] = [];
        byLayer[entity.layer].push(entity);
      }

      const presentLayers = new Set(Object.keys(byLayer));
      const missingLayers = ALL_LAYERS.filter((l) => !presentLayers.has(l));

      let response = `## Concept: ${concept}\n\n`;
      response += `**Found in ${presentLayers.size} layers:**\n\n`;

      for (const [layer, layerEntities] of Object.entries(byLayer)) {
        response += `### ${layer}\n`;
        for (const entity of layerEntities) {
          response += `- ${entity.name} (${entity.entity_type})\n`;
          if (include_code && entity.signature) {
            response += `  \`${entity.signature}\`\n`;
          }
        }
        response += "\n";
      }

      if (missingLayers.length > 0) {
        response += `**Missing from:** ${missingLayers.join(", ")}\n`;
      }

      return {
        content: [{ type: "text" as const, text: response }],
      };
    },
  );

  // Tool 2: audit_drift
  server.tool(
    "audit_drift",
    "Scan for inconsistencies across layers. Returns drift items ranked by severity.",
    {
      scope: z
        .enum(["all", "features", "tests", "docs", "code"])
        .default("all")
        .describe("Scope of the audit"),
      severity: z
        .enum(["all", "high", "medium", "low"])
        .default("all")
        .describe("Filter by severity"),
      limit: z.number().default(20).describe("Maximum items to return"),
      offset: z.number().default(0).describe("Offset for pagination"),
    },
    async ({ scope, severity, limit, offset }) => {
      const ignoreRules = loadDriftIgnore(projectRoot);
      const driftItems = detectDrift(
        db,
        scope,
        severity,
        ignoreRules,
        projectRoot,
      );

      const paginated = driftItems.slice(offset, offset + limit);

      let response = `## Drift Audit Report\n\n`;
      response += `Found ${driftItems.length} drift items.\n\n`;

      if (paginated.length === 0) {
        response += "No drift detected in the specified scope.\n";
      } else {
        for (const item of paginated) {
          const icon =
            item.severity === "high"
              ? "🔴"
              : item.severity === "medium"
                ? "🟡"
                : "🟢";
          response += `${icon} **${item.severity.toUpperCase()}** [${item.category}]: ${item.message}\n`;
          response += `   File: ${item.filePath}:${item.line}\n`;
          response += `   Suggestion: ${item.suggestion}\n\n`;
        }
      }

      if (driftItems.length > offset + limit) {
        response += `\n*Showing ${offset + 1}-${offset + paginated.length} of ${driftItems.length}. Use offset for more.*\n`;
      }

      return {
        content: [{ type: "text" as const, text: response }],
      };
    },
  );

  // Tool 3: get_coverage
  server.tool(
    "get_coverage",
    "Show which concepts are covered at each layer. Returns a matrix with gaps highlighted.",
    {
      filter: z
        .enum(["all", "undocumented", "untested", "unimplemented"])
        .default("all")
        .describe("Filter coverage results"),
      component: z
        .string()
        .optional()
        .describe("Filter to a specific component"),
    },
    async ({ filter, component }) => {
      const coverage = computeCoverage(db, filter, component);

      let response = `## Coverage Matrix\n\n`;
      response += `| Concept | Problem | Features | E2E | Unit | Perf | Code | DevDoc | UserDoc | Score |\n`;
      response += `|---------|---------|----------|-----|------|------|------|--------|---------|-------|\n`;

      for (const entry of coverage) {
        const cells = ALL_LAYERS.map((l) => (entry.layers[l] ? "✅" : "❌"));
        const scorePercent = Math.round(entry.score * 100);
        response += `| ${entry.concept} | ${cells.join(" | ")} | ${scorePercent}% |\n`;
      }

      if (coverage.length === 0) {
        response += "\n*No concepts found. Run reindex first.*\n";
      }

      return {
        content: [{ type: "text" as const, text: response }],
      };
    },
  );

  // Tool 4: search
  server.tool(
    "search",
    "Search across all indexed entities: concepts, functions, scenarios, doc sections.",
    {
      query: z.string().describe("Search query"),
      layer: z
        .enum(["all", "feature", "test", "source", "doc"])
        .default("all")
        .describe("Filter by layer type"),
      limit: z.number().default(20).describe("Maximum results"),
      offset: z.number().default(0).describe("Offset for pagination"),
    },
    async ({ query, layer, limit, offset }) => {
      let results = db.searchEntities(query, limit + offset);

      if (layer !== "all") {
        const layerMap: Record<string, Layer[]> = {
          feature: ["feature"],
          test: ["e2e_test", "unit_test", "perf_test"],
          source: ["source"],
          doc: ["problem", "dev_doc", "user_doc"],
        };
        const allowedLayers = layerMap[layer] || [];
        results = results.filter((r) =>
          allowedLayers.includes(r.layer as Layer),
        );
      }

      results = results.slice(offset, offset + limit);

      let response = `## Search Results for "${query}"\n\n`;

      if (results.length === 0) {
        response += "No results found.\n";
      } else {
        for (const result of results) {
          response += `### ${result.name}\n`;
          response += `- Type: ${result.entity_type}\n`;
          response += `- Layer: ${result.layer}\n`;
          if (result.qualified_name) {
            response += `- Qualified: ${result.qualified_name}\n`;
          }
          response += "\n";
        }
      }

      return {
        content: [{ type: "text" as const, text: response }],
      };
    },
  );

  // Tool 5: get_overview
  server.tool(
    "get_overview",
    "High-level coherence status: total concepts, drift count, coverage percentages.",
    {},
    async () => {
      const overview = computeOverview(db);

      let response = `## Project Coherence Overview\n\n`;
      response += `**Files indexed:** ${overview.totalFiles}\n`;
      response += `**Entities extracted:** ${overview.totalEntities}\n`;
      response += `**Concepts discovered:** ${overview.totalConcepts}\n`;
      response += `**Coherence score:** ${Math.round(overview.coherenceScore * 100)}%\n\n`;

      response += `### Entities by Layer\n\n`;
      for (const [layer, count] of Object.entries(overview.entitiesByLayer)) {
        if (count > 0) {
          response += `- ${layer}: ${count}\n`;
        }
      }

      response += `\n### Drift Summary\n\n`;
      response += `- High: ${overview.driftBySeverity.high}\n`;
      response += `- Medium: ${overview.driftBySeverity.medium}\n`;
      response += `- Low: ${overview.driftBySeverity.low}\n`;
      response += `- **Total:** ${overview.totalDrift}\n`;

      if (overview.lastIndexedAt) {
        response += `\n*Last indexed: ${overview.lastIndexedAt}*\n`;
      }

      return {
        content: [{ type: "text" as const, text: response }],
      };
    },
  );

  // Tool 6: reindex
  server.tool(
    "reindex",
    "Rebuild the project index. Use after major changes or on first setup.",
    {
      full: z
        .boolean()
        .default(false)
        .describe(
          "If true, drops and rebuilds entire index. If false, only indexes changed files.",
        ),
    },
    async ({ full }) => {
      if (config.workspace.repos.length > 0) {
        const result = await indexer.indexWorkspace(
          projectRoot,
          config.workspace.repos,
          { full },
        );

        let response = `## Reindex Complete (workspace mode)\n\n`;
        response += `- Repos indexed: ${result.reposIndexed}\n`;
        response += `- Files indexed: ${result.filesIndexed}\n`;
        response += `- Files skipped (unchanged): ${result.filesSkipped}\n`;
        response += `- Files removed (deleted): ${result.filesRemoved}\n`;
        response += `- Entities extracted: ${result.entitiesExtracted}\n`;
        response += `- Concepts created: ${result.conceptsCreated}\n`;
        response += `- Edges created: ${result.edgesCreated}\n`;

        if (result.errors.length > 0) {
          response += `\n### Errors\n\n`;
          for (const error of result.errors) {
            response += `- ${error.repo}: ${error.message}\n`;
          }
        }

        return {
          content: [{ type: "text" as const, text: response }],
        };
      }

      const result = await indexer.indexDirectory(projectRoot, { full });

      let response = `## Reindex Complete\n\n`;
      response += `- Files indexed: ${result.filesIndexed}\n`;
      response += `- Files skipped (unchanged): ${result.filesSkipped}\n`;
      response += `- Files removed (deleted): ${result.filesRemoved}\n`;
      response += `- Entities extracted: ${result.entitiesExtracted}\n`;
      response += `- Concepts created: ${result.conceptsCreated}\n`;
      response += `- Edges created: ${result.edgesCreated}\n`;

      if (result.errors.length > 0) {
        response += `\n### Errors\n\n`;
        for (const error of result.errors) {
          response += `- ${error.file}: ${error.message}\n`;
        }
      }

      return {
        content: [{ type: "text" as const, text: response }],
      };
    },
  );

  // Tool 7: get_trend
  server.tool(
    "get_trend",
    "Show drift trend over time. Displays historical snapshots of drift counts by category.",
    {
      limit: z.number().default(10).describe("Number of snapshots to show"),
    },
    async ({ limit }) => {
      const snapshots = db.getDriftSnapshots(limit);

      if (snapshots.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No drift snapshots found. Run `get_overview` to create the first snapshot.",
            },
          ],
        };
      }

      // Collect all categories across all snapshots
      const allCategories = new Set<string>();
      for (const snap of snapshots) {
        for (const key of Object.keys(snap.counts)) {
          if (key !== "_total") allCategories.add(key);
        }
      }
      const categories = [...allCategories].sort();

      let response = `## Drift Trend (${snapshots.length} snapshots)\n\n`;
      response += `| Timestamp | ${categories.join(" | ")} | Total | Delta |\n`;
      response += `|-----------|${categories.map(() => "---").join("|")}|-------|-------|\n`;

      // Reverse to show oldest first
      const ordered = [...snapshots].reverse();
      for (let i = 0; i < ordered.length; i++) {
        const snap = ordered[i];
        const total = snap.counts._total ?? 0;
        const cells = categories.map((c) => String(snap.counts[c] ?? 0));

        let delta = "";
        if (i > 0) {
          const prevTotal = ordered[i - 1].counts._total ?? 0;
          const diff = total - prevTotal;
          if (diff > 0) delta = `+${diff}`;
          else if (diff < 0) delta = `${diff}`;
          else delta = "0";
        } else {
          delta = "-";
        }

        const ts = snap.timestamp.replace("T", " ").replace(/\.\d+Z$/, "");
        response += `| ${ts} | ${cells.join(" | ")} | ${total} | ${delta} |\n`;
      }

      return {
        content: [{ type: "text" as const, text: response }],
      };
    },
  );

  // Tool 8: check_repo
  server.tool(
    "check_repo",
    "Show entity summary for a specific repository: file count, entity counts by layer, and concepts.",
    {
      repo: z
        .string()
        .describe("Repository name (e.g. 'core', 'relay', 'cli')"),
    },
    async ({ repo }) => {
      const summary = checkRepo(db, repo);

      let response = `## Repository: ${summary.repo}\n\n`;
      response += `**Files:** ${summary.fileCount}\n`;
      response += `**Entities:** ${summary.entityCount}\n\n`;

      if (summary.entityCount > 0) {
        response += `### Entities by Layer\n\n`;
        for (const [layer, count] of Object.entries(summary.entitiesByLayer)) {
          response += `- ${layer}: ${count}\n`;
        }

        if (summary.concepts.length > 0) {
          response += `\n### Concepts (${summary.concepts.length})\n\n`;
          response += summary.concepts.join(", ") + "\n";
        }
      } else {
        response += `*No entities found for repo "${repo}". Run reindex first.*\n`;
      }

      return {
        content: [{ type: "text" as const, text: response }],
      };
    },
  );

  // Tool 9: check_parity
  server.tool(
    "check_parity",
    "Compare concept coverage across repositories. Finds parity gaps where a concept exists in some repos but not all.",
    {
      repos: z
        .array(z.string())
        .describe(
          "Repository names to compare (e.g. ['core', 'cli', 'tui', 'desktop'])",
        ),
    },
    async ({ repos }) => {
      if (repos.length < 2) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Need at least 2 repos to compare parity.",
            },
          ],
        };
      }

      const gaps = checkParity(db, repos);

      let response = `## Parity Check: ${repos.join(", ")}\n\n`;

      if (gaps.length === 0) {
        response += "All concepts have full parity across the checked repos.\n";
      } else {
        response += `Found ${gaps.length} parity gaps.\n\n`;

        for (const gap of gaps) {
          const icon =
            gap.severity === "high"
              ? "🔴"
              : gap.severity === "medium"
                ? "🟡"
                : "🟢";
          response += `${icon} **${gap.concept}**\n`;
          response += `   Present in: ${gap.presentIn.join(", ")}\n`;
          response += `   Missing from: ${gap.missingFrom.join(", ")}\n\n`;
        }
      }

      return {
        content: [{ type: "text" as const, text: response }],
      };
    },
  );

  return server;
}

// Exported helpers for testing

export interface DriftItem {
  severity: DriftSeverity;
  category: DriftCategory;
  message: string;
  filePath: string;
  line: number;
  suggestion: string;
}

type EntityRow = import("./db/database.js").EntityRow;
type EdgeRow = import("./db/database.js").EdgeRow;
type FileRow = import("./db/database.js").FileRow;

interface DriftContext {
  db: DriftDatabase;
  hasEdges: boolean;
  edgesBySource: Map<number, EdgeRow[]>;
  edgesByTarget: Map<number, EdgeRow[]>;
  filesById: Map<number, FileRow>;
}

export function detectDrift(
  db: DriftDatabase,
  scope: string,
  severityFilter: string,
  ignoreRules: DriftIgnoreRule[] = [],
  projectRoot?: string,
): DriftItem[] {
  let items: DriftItem[] = [];

  const hasEdges = db.getEdgeCount() > 0;
  const ctx: DriftContext = {
    db,
    hasEdges,
    edgesBySource: hasEdges ? db.getAllEdgesBySource() : new Map(),
    edgesByTarget: hasEdges ? db.getAllEdgesByTarget() : new Map(),
    filesById: db.getAllFilesMap(),
  };

  // Scope mapping — use concat instead of push(...spread) to avoid
  // stack overflow with large result arrays
  if (scope === "all" || scope === "features") {
    items = items.concat(detectMissingTest(ctx));
    items = items.concat(detectMissingFeature(ctx));
  }
  if (scope === "all" || scope === "docs") {
    items = items.concat(detectMissingDoc(ctx));
    items = items.concat(detectStaleDoc(ctx));
    items = items.concat(detectStaleApi(ctx));
  }
  if (scope === "all" || scope === "tests") {
    items = items.concat(detectOrphanTest(ctx));
  }
  if (scope === "all" || scope === "code") {
    items = items.concat(detectOrphanCode(ctx));
  }
  if (scope === "all") {
    items = items.concat(detectNamingDrift(ctx));
  }
  if (severityFilter !== "all") {
    items = items.filter((i) => i.severity === severityFilter);
  }

  // Apply .driftignore rules
  if (ignoreRules.length > 0) {
    items = items.filter(
      (item) =>
        !shouldIgnore(item.filePath, item.category, ignoreRules, projectRoot),
    );
  }

  return items;
}

/** 1. missing_test: Scenarios/outlines with no test coverage */
function detectMissingTest(ctx: DriftContext): DriftItem[] {
  const items: DriftItem[] = [];

  const isPlanned = (e: EntityRow): boolean =>
    (JSON.parse(e.metadata || "{}").tags || []).includes("planned");

  /** Edge types that count as implementation/test evidence */
  const evidenceEdgeTypes = new Set([
    "implements",
    "implemented_by",
    "covers",
    "covered_by",
    "tests",
    "tested_by",
  ]);

  // Only check "feature" layer — skip "problem" layer (draft scenarios)
  // Include @planned scenarios — they may have stale tags
  const features = ctx.db
    .getEntitiesByLayer("feature")
    .filter(
      (e) =>
        e.entity_type === "scenario" || e.entity_type === "scenario_outline",
    );

  if (ctx.hasEdges) {
    for (const feature of features) {
      const incomingEdges = ctx.edgesByTarget.get(feature.id) || [];
      const outgoingEdges = ctx.edgesBySource.get(feature.id) || [];
      const hasCoverage = incomingEdges.some((e) => e.edge_type === "covers");

      if (isPlanned(feature)) {
        // Check for implementation evidence on @planned scenarios
        const allEdges = [...incomingEdges, ...outgoingEdges];
        const bestEdge = allEdges.find((e) =>
          evidenceEdgeTypes.has(e.edge_type),
        );
        if (bestEdge) {
          items.push({
            severity: "low",
            category: "stale_tag",
            message: `Scenario "${feature.name}" is @planned but has implementation evidence (${bestEdge.match_method}, confidence ${bestEdge.confidence.toFixed(2)})`,
            filePath: ctx.filesById.get(feature.file_id)?.path || "unknown",
            line: feature.start_line,
            suggestion: `Update tag from @planned to @implemented — code exists`,
          });
        }
        // No evidence → skip (known to lack tests, not drift)
      } else if (!hasCoverage) {
        items.push({
          severity: "high",
          category: "missing_test",
          message: `Scenario "${feature.name}" has no test coverage`,
          filePath: ctx.filesById.get(feature.file_id)?.path || "unknown",
          line: feature.start_line,
          suggestion: `Create a test that covers this scenario`,
        });
      }
    }
  } else {
    // Fallback: use matching module
    const tests = [
      ...ctx.db.getEntitiesByLayer("unit_test"),
      ...ctx.db.getEntitiesByLayer("e2e_test"),
    ];
    const sources = ctx.db.getEntitiesByLayer("source");
    for (const feature of features) {
      if (isPlanned(feature)) {
        // Check if any source or test entity matches this @planned scenario
        const hasEvidence = [...sources, ...tests].some((s) => {
          const tagMatch = matchByTags(s, feature);
          if (tagMatch) return true;
          const nameMatch = matchByName(s.name, feature.name);
          return nameMatch !== null;
        });
        if (hasEvidence) {
          items.push({
            severity: "low",
            category: "stale_tag",
            message: `Scenario "${feature.name}" is @planned but has implementation evidence (fallback matching)`,
            filePath: ctx.filesById.get(feature.file_id)?.path || "unknown",
            line: feature.start_line,
            suggestion: `Update tag from @planned to @implemented — code exists`,
          });
        }
        // No match → skip (truly planned, not drift)
      } else {
        const hasMatch = tests.some((t) => {
          const tagMatch = matchByTags(t, feature);
          if (tagMatch) return true;
          const nameMatch = matchByName(t.name, feature.name);
          return nameMatch !== null;
        });
        if (!hasMatch) {
          items.push({
            severity: "high",
            category: "missing_test",
            message: `Scenario "${feature.name}" has no test coverage`,
            filePath: ctx.filesById.get(feature.file_id)?.path || "unknown",
            line: feature.start_line,
            suggestion: `Create a test that covers this scenario`,
          });
        }
      }
    }
  }

  return items;
}

/** Check if an entity has inline doc comments (/// or //!) */
function hasInlineDocComment(entity: EntityRow): boolean {
  const metadata = JSON.parse(entity.metadata || "{}");
  return metadata.hasDocComment === true;
}

/** 2. missing_doc: Public source entities with no documentation edge
 *
 * Severity: MEDIUM — undocumented public types are a quality gap,
 * not an architectural violation. Keeps HIGH reserved for contract
 * breaks (missing tests, stale APIs).
 */
function detectMissingDoc(ctx: DriftContext): DriftItem[] {
  const items: DriftItem[] = [];
  const sources = ctx.db
    .getEntitiesByLayer("source")
    .filter(
      (e) =>
        e.visibility === "public" &&
        e.entity_type !== "module" &&
        !hasInlineDocComment(e),
    );

  if (ctx.hasEdges) {
    for (const source of sources) {
      const edges = ctx.edgesByTarget.get(source.id) || [];
      const hasDoc = edges.some((e) => e.edge_type === "documents");
      if (!hasDoc) {
        items.push({
          severity: "medium",
          category: "missing_doc",
          message: `Public entity "${source.name}" has no documentation`,
          filePath: ctx.filesById.get(source.file_id)?.path || "unknown",
          line: source.start_line,
          suggestion: `Add documentation for this public entity`,
        });
      }
    }
  } else {
    const docs = [
      ...ctx.db.getEntitiesByLayer("dev_doc"),
      ...ctx.db.getEntitiesByLayer("user_doc"),
    ];
    for (const source of sources) {
      const hasMatch = docs.some((d) => {
        const tagMatch = matchByTags(d, source);
        if (tagMatch) return true;
        const nameMatch = matchByName(d.name, source.name);
        return nameMatch !== null;
      });
      if (!hasMatch) {
        items.push({
          severity: "medium",
          category: "missing_doc",
          message: `Public entity "${source.name}" has no documentation`,
          filePath: ctx.filesById.get(source.file_id)?.path || "unknown",
          line: source.start_line,
          suggestion: `Add documentation for this public entity`,
        });
      }
    }
  }

  return items;
}

/** 3. missing_feature: Test functions with no coverage edge to any scenario */
function detectMissingFeature(ctx: DriftContext): DriftItem[] {
  const items: DriftItem[] = [];
  const tests = [
    ...ctx.db.getEntitiesByLayer("unit_test"),
    ...ctx.db.getEntitiesByLayer("e2e_test"),
  ].filter((e) => e.entity_type === "test_fn");

  if (ctx.hasEdges) {
    for (const test of tests) {
      const edges = ctx.edgesBySource.get(test.id) || [];
      const hasFeature = edges.some((e) => e.edge_type === "covers");
      if (!hasFeature) {
        items.push({
          severity: "medium",
          category: "missing_feature",
          message: `Test "${test.name}" has no corresponding feature scenario`,
          filePath: ctx.filesById.get(test.file_id)?.path || "unknown",
          line: test.start_line,
          suggestion: `Add a Gherkin scenario that this test covers`,
        });
      }
    }
  } else {
    const features = ctx.db
      .getEntitiesByLayer("feature")
      .filter(
        (e) =>
          e.entity_type === "scenario" || e.entity_type === "scenario_outline",
      );
    for (const test of tests) {
      const hasMatch = features.some((f) => {
        const tagMatch = matchByTags(test, f);
        if (tagMatch) return true;
        const nameMatch = matchByName(test.name, f.name);
        return nameMatch !== null;
      });
      if (!hasMatch) {
        items.push({
          severity: "medium",
          category: "missing_feature",
          message: `Test "${test.name}" has no corresponding feature scenario`,
          filePath: ctx.filesById.get(test.file_id)?.path || "unknown",
          line: test.start_line,
          suggestion: `Add a Gherkin scenario that this test covers`,
        });
      }
    }
  }

  return items;
}

/** 4. orphan_test: Test functions with no edge to any source entity */
function detectOrphanTest(ctx: DriftContext): DriftItem[] {
  const items: DriftItem[] = [];
  const tests = [
    ...ctx.db.getEntitiesByLayer("unit_test"),
    ...ctx.db.getEntitiesByLayer("e2e_test"),
  ].filter((e) => e.entity_type === "test_fn");

  if (ctx.hasEdges) {
    for (const test of tests) {
      const edges = ctx.edgesBySource.get(test.id) || [];
      const hasSource = edges.some((e) => e.edge_type === "tests");
      if (!hasSource) {
        items.push({
          severity: "medium",
          category: "orphan_test",
          message: `Test "${test.name}" has no corresponding source code`,
          filePath: ctx.filesById.get(test.file_id)?.path || "unknown",
          line: test.start_line,
          suggestion: `Link this test to source code or remove if obsolete`,
        });
      }
    }
  } else {
    const sources = ctx.db.getEntitiesByLayer("source");
    for (const test of tests) {
      const hasMatch = sources.some((s) => {
        const tagMatch = matchByTags(test, s);
        if (tagMatch) return true;
        const nameMatch = matchByName(test.name, s.name);
        return nameMatch !== null;
      });
      if (!hasMatch) {
        items.push({
          severity: "medium",
          category: "orphan_test",
          message: `Test "${test.name}" has no corresponding source code`,
          filePath: ctx.filesById.get(test.file_id)?.path || "unknown",
          line: test.start_line,
          suggestion: `Link this test to source code or remove if obsolete`,
        });
      }
    }
  }

  return items;
}

/** 5. orphan_code: Source entities with zero edges in any direction (edge-only) */
function detectOrphanCode(ctx: DriftContext): DriftItem[] {
  if (!ctx.hasEdges) return [];

  const items: DriftItem[] = [];
  const sources = ctx.db.getEntitiesByLayer("source");

  for (const source of sources) {
    const outEdges = ctx.edgesBySource.get(source.id) || [];
    const inEdges = ctx.edgesByTarget.get(source.id) || [];
    if (outEdges.length === 0 && inEdges.length === 0) {
      items.push({
        severity: "low",
        category: "orphan_code",
        message: `Source entity "${source.name}" has no connections to tests, docs, or features`,
        filePath: ctx.filesById.get(source.file_id)?.path || "unknown",
        line: source.start_line,
        suggestion: `Add tests, documentation, or a feature spec for this entity`,
      });
    }
  }

  return items;
}

/** 6. stale_doc: Doc entities with documents edge to non-existent target (edge-only) */
function detectStaleDoc(ctx: DriftContext): DriftItem[] {
  if (!ctx.hasEdges) return [];

  const items: DriftItem[] = [];
  const docs = [
    ...ctx.db.getEntitiesByLayer("dev_doc"),
    ...ctx.db.getEntitiesByLayer("user_doc"),
  ];

  for (const doc of docs) {
    const edges = ctx.edgesBySource.get(doc.id) || [];
    for (const edge of edges) {
      if (edge.edge_type === "documents") {
        const target = ctx.db.getEntityById(edge.target_id);
        if (!target) {
          items.push({
            severity: "medium",
            category: "stale_doc",
            message: `Documentation "${doc.name}" references a non-existent entity`,
            filePath: ctx.filesById.get(doc.file_id)?.path || "unknown",
            line: doc.start_line,
            suggestion: `Update or remove this documentation section`,
          });
        }
      }
    }
  }

  return items;
}

/** 7. stale_api: api_endpoint doc entities with no matching source */
function detectStaleApi(ctx: DriftContext): DriftItem[] {
  const items: DriftItem[] = [];
  const apiDocs = [
    ...ctx.db.getEntitiesByLayer("dev_doc"),
    ...ctx.db.getEntitiesByLayer("user_doc"),
  ].filter((e) => e.entity_type === "api_endpoint");

  if (ctx.hasEdges) {
    for (const apiDoc of apiDocs) {
      const edges = ctx.edgesBySource.get(apiDoc.id) || [];
      const hasSource = edges.some((e) => e.edge_type === "documents");
      if (!hasSource) {
        items.push({
          severity: "high",
          category: "stale_api",
          message: `API endpoint "${apiDoc.name}" has no matching source implementation`,
          filePath: ctx.filesById.get(apiDoc.file_id)?.path || "unknown",
          line: apiDoc.start_line,
          suggestion: `Implement this API endpoint or remove stale documentation`,
        });
      }
    }
  } else {
    const sources = ctx.db.getEntitiesByLayer("source");
    for (const apiDoc of apiDocs) {
      const hasMatch = sources.some((s) => {
        const nameMatch = matchByName(apiDoc.name, s.name);
        return nameMatch !== null;
      });
      if (!hasMatch) {
        items.push({
          severity: "high",
          category: "stale_api",
          message: `API endpoint "${apiDoc.name}" has no matching source implementation`,
          filePath: ctx.filesById.get(apiDoc.file_id)?.path || "unknown",
          line: apiDoc.start_line,
          suggestion: `Implement this API endpoint or remove stale documentation`,
        });
      }
    }
  }

  return items;
}

/** 8. naming_drift: Entities linked to same concept with low name similarity */
function detectNamingDrift(ctx: DriftContext): DriftItem[] {
  const items: DriftItem[] = [];
  const concepts = ctx.db.getAllConcepts();
  const MAX_ITEMS = 100;

  for (const concept of concepts) {
    if (items.length >= MAX_ITEMS) break;

    const entities = ctx.db.getEntitiesByConceptId(concept.id);
    if (entities.length < 2 || entities.length > 200) continue;

    // Group by layer to only compare cross-layer pairs
    const byLayer = new Map<string, typeof entities>();
    for (const e of entities) {
      const arr = byLayer.get(e.layer) || [];
      arr.push(e);
      byLayer.set(e.layer, arr);
    }
    const layers = [...byLayer.keys()];
    if (layers.length < 2) continue;

    // Compare one representative per layer pair (cap O(n^2))
    for (let li = 0; li < layers.length && items.length < MAX_ITEMS; li++) {
      for (
        let lj = li + 1;
        lj < layers.length && items.length < MAX_ITEMS;
        lj++
      ) {
        const layerA = byLayer.get(layers[li])!;
        const layerB = byLayer.get(layers[lj])!;

        // Sample up to 10 entities per layer to avoid explosion
        const sampleA = layerA.slice(0, 10);
        const sampleB = layerB.slice(0, 10);

        for (const a of sampleA) {
          for (const b of sampleB) {
            const similarity = compareTwoStrings(
              a.name.toLowerCase(),
              b.name.toLowerCase(),
            );

            if (similarity >= 0.2 && similarity <= 0.5) {
              items.push({
                severity: "low",
                category: "naming_drift",
                message: `"${a.name}" (${a.layer}) and "${b.name}" (${b.layer}) are linked to concept "${concept.name}" but have low name similarity (${Math.round(similarity * 100)}%)`,
                filePath: ctx.filesById.get(a.file_id)?.path || "unknown",
                line: a.start_line,
                suggestion: `Consider aligning naming conventions across layers`,
              });
            }
          }
        }
      }
    }
  }

  return items;
}

interface CoverageEntry {
  concept: string;
  layers: Record<Layer, boolean>;
  score: number;
}

export function computeCoverage(
  db: DriftDatabase,
  filter: string,
  component?: string,
): CoverageEntry[] {
  const concepts = getAllConcepts(db);
  const entries: CoverageEntry[] = [];

  for (const conceptName of concepts) {
    const layers: Record<Layer, boolean> = {} as Record<Layer, boolean>;
    let presentCount = 0;

    for (const layer of ALL_LAYERS) {
      const entities = db.getEntitiesByLayer(layer);
      const hasLayer = entities.some((e) => {
        const metadata = JSON.parse(e.metadata || "{}");
        const tags: string[] = metadata.tags || [];
        return (
          tags.includes(conceptName) ||
          e.name.toLowerCase().includes(conceptName.toLowerCase())
        );
      });
      layers[layer] = hasLayer;
      if (hasLayer) presentCount++;
    }

    const score = presentCount / ALL_LAYERS.length;

    // Apply filters
    if (filter === "untested" && (layers["unit_test"] || layers["e2e_test"]))
      continue;
    if (filter === "undocumented" && (layers["dev_doc"] || layers["user_doc"]))
      continue;
    if (filter === "unimplemented" && layers["source"]) continue;

    if (
      component &&
      !conceptName.toLowerCase().includes(component.toLowerCase())
    )
      continue;

    entries.push({ concept: conceptName, layers, score });
  }

  return entries.sort((a, b) => a.score - b.score);
}

export function getAllConcepts(db: DriftDatabase): string[] {
  // Get concepts from the concepts table and from entity tags
  const concepts = new Set<string>();

  // From concepts table
  const entities = db.getAllEntities();
  for (const entity of entities) {
    const metadata = JSON.parse(entity.metadata || "{}");
    const tags: string[] = metadata.tags || [];
    for (const tag of tags) {
      concepts.add(tag);
    }
  }

  return Array.from(concepts);
}

export function computeOverview(db: DriftDatabase): ProjectOverview {
  const entitiesByLayer = db.getEntityCountByLayer() as Record<Layer, number>;

  // Fill in missing layers with 0
  for (const layer of ALL_LAYERS) {
    if (!(layer in entitiesByLayer)) {
      entitiesByLayer[layer] = 0;
    }
  }

  const driftItems = detectDrift(db, "all", "all");
  const driftBySeverity: Record<DriftSeverity, number> = {
    high: driftItems.filter((i) => i.severity === "high").length,
    medium: driftItems.filter((i) => i.severity === "medium").length,
    low: driftItems.filter((i) => i.severity === "low").length,
  };

  // Coherence score: inverse of drift percentage
  const totalEntities = db.getTotalEntityCount();
  const coherenceScore =
    totalEntities > 0 ? Math.max(0, 1 - driftItems.length / totalEntities) : 1;

  const lastIndexed = db.getMetadata("last_indexed_at");

  // Auto-snapshot: save drift counts if last snapshot is >1 hour old
  const driftByCategory: Record<string, number> = {};
  for (const item of driftItems) {
    driftByCategory[item.category] = (driftByCategory[item.category] || 0) + 1;
  }
  driftByCategory._total = driftItems.length;

  const snapshots = db.getDriftSnapshots(1);
  const lastSnapshotTime =
    snapshots.length > 0 ? new Date(snapshots[0].timestamp).getTime() : 0;
  const now = new Date();
  if (now.getTime() - lastSnapshotTime > 3600_000) {
    db.saveDriftSnapshot(now.toISOString(), driftByCategory);
  }

  return {
    totalFiles: db.getTotalFileCount(),
    totalEntities,
    entitiesByLayer,
    totalConcepts: db.getAllConcepts().length,
    totalDrift: driftItems.length,
    driftBySeverity,
    coherenceScore,
    lastIndexedAt: lastIndexed || "",
  };
}
