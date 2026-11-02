/**
 * Configuration loading for drift-detector
 *
 * Loads project-specific configuration from driftconfig.toml,
 * making the tool generic and reusable across projects.
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseTOML } from "smol-toml";
import { z } from "zod";

// ─── Interfaces ──────────────────────────────────────────

export interface WorkspaceRepo {
  name: string;
  path: string;
}

export interface DriftConfig {
  workspace: { repos: WorkspaceRepo[] };
  indexing: { ignore: string[] };
  concepts: { aliases: Record<string, string | string[]> };
  tags: {
    path: Record<string, Record<string, string | string[]>>;
    namePatterns: Record<string, Array<{ pattern: string; tag: string }>>;
    headingKeywords: Array<{ keyword: string; tag: string }>;
  };
  layers: {
    markdown: {
      devDocFilenames: string[];
      devDocPaths: string[];
      userDocPaths: string[];
      userDocFilenames: string[];
    };
    gherkin: {
      problemPaths: string[];
    };
  };
  embeddings: {
    model: string;
    baseUrl: string;
    enabled: boolean;
  };
}

export interface CompiledConfig extends DriftConfig {
  _compiled: {
    namePatterns: Record<string, Array<{ regex: RegExp; tag: string }>>;
  };
}

// ─── Default Config (generic — no project-specific values) ───

export const DEFAULT_CONFIG: DriftConfig = {
  workspace: { repos: [] },
  indexing: { ignore: [] },
  concepts: { aliases: {} },
  tags: { path: {}, namePatterns: {}, headingKeywords: [] },
  layers: {
    markdown: {
      devDocFilenames: ["ARCHITECTURE.md", "CONTRIBUTING.md", "CHANGELOG.md"],
      devDocPaths: [],
      userDocPaths: ["/docs/"],
      userDocFilenames: ["README.md"],
    },
    gherkin: { problemPaths: [] },
  },
  embeddings: {
    model: "qwen3-embedding:0.6B",
    baseUrl: "http://localhost:11434",
    enabled: true,
  },
};

// ─── Zod Schema ──────────────────────────────────────────

const stringOrStringArray = z.union([z.string(), z.array(z.string())]);

const configSchema = z.object({
  workspace: z
    .object({
      repos: z
        .array(
          z.object({
            name: z.string(),
            path: z.string(),
          }),
        )
        .default([]),
    })
    .default({}),

  indexing: z
    .object({
      ignore: z.array(z.string()).default([]),
    })
    .default({}),

  concepts: z
    .object({
      aliases: z.record(z.string(), stringOrStringArray).default({}),
    })
    .default({}),

  tags: z
    .object({
      path: z
        .record(z.string(), z.record(z.string(), stringOrStringArray))
        .default({}),
      name_patterns: z
        .record(
          z.string(),
          z.array(
            z.object({
              pattern: z.string(),
              tag: z.string(),
            }),
          ),
        )
        .default({}),
      heading_keywords: z
        .array(
          z.object({
            keyword: z.string(),
            tag: z.string(),
          }),
        )
        .default([]),
    })
    .default({}),

  layers: z
    .object({
      markdown: z
        .object({
          dev_doc_filenames: z
            .array(z.string())
            .default(DEFAULT_CONFIG.layers.markdown.devDocFilenames),
          dev_doc_paths: z
            .array(z.string())
            .default(DEFAULT_CONFIG.layers.markdown.devDocPaths),
          user_doc_paths: z
            .array(z.string())
            .default(DEFAULT_CONFIG.layers.markdown.userDocPaths),
          user_doc_filenames: z
            .array(z.string())
            .default(DEFAULT_CONFIG.layers.markdown.userDocFilenames),
        })
        .default({}),
      gherkin: z
        .object({
          problem_paths: z
            .array(z.string())
            .default(DEFAULT_CONFIG.layers.gherkin.problemPaths),
        })
        .default({}),
    })
    .default({}),

  embeddings: z
    .object({
      model: z.string().default(DEFAULT_CONFIG.embeddings.model),
      base_url: z.string().default(DEFAULT_CONFIG.embeddings.baseUrl),
      enabled: z.boolean().default(DEFAULT_CONFIG.embeddings.enabled),
    })
    .default({}),
});

// ─── Config Loading ──────────────────────────────────────

export const CONFIG_FILENAME = "driftconfig.toml";

/**
 * Load project configuration from driftconfig.toml.
 * Returns DEFAULT_CONFIG if the file does not exist.
 */
export function loadConfig(projectRoot: string): CompiledConfig {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    return compileConfig(DEFAULT_CONFIG);
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = parseTOML(raw);
  const validated = configSchema.parse(parsed);

  const config: DriftConfig = {
    workspace: { repos: validated.workspace.repos },
    indexing: { ignore: validated.indexing.ignore },
    concepts: { aliases: validated.concepts.aliases },
    tags: {
      path: validated.tags.path,
      namePatterns: validated.tags.name_patterns,
      headingKeywords: validated.tags.heading_keywords,
    },
    layers: {
      markdown: {
        devDocFilenames: validated.layers.markdown.dev_doc_filenames,
        devDocPaths: validated.layers.markdown.dev_doc_paths,
        userDocPaths: validated.layers.markdown.user_doc_paths,
        userDocFilenames: validated.layers.markdown.user_doc_filenames,
      },
      gherkin: {
        problemPaths: validated.layers.gherkin.problem_paths,
      },
    },
    embeddings: {
      model: validated.embeddings.model,
      baseUrl: validated.embeddings.base_url,
      enabled: validated.embeddings.enabled,
    },
  };

  return compileConfig(config);
}

/**
 * Compile a DriftConfig by pre-building RegExp objects for name patterns.
 */
export function compileConfig(config: DriftConfig): CompiledConfig {
  const compiled: Record<string, Array<{ regex: RegExp; tag: string }>> = {};

  for (const [lang, patterns] of Object.entries(config.tags.namePatterns)) {
    compiled[lang] = patterns.map((p) => ({
      regex: new RegExp(p.pattern, "i"),
      tag: p.tag,
    }));
  }

  return {
    ...config,
    _compiled: { namePatterns: compiled },
  };
}
