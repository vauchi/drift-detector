/**
 * Markdown (.md) parser
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as path from "node:path";
import type {
  LayerParser,
  ParseResult,
  ParsedEntity,
  ReferenceHint,
  Layer,
} from "../types.js";
import type { CompiledConfig } from "../config.js";

/**
 * Parser for Markdown documentation files.
 * Extracts heading sections as doc_section entities.
 */
export class MarkdownParser implements LayerParser {
  readonly languageId = "markdown";
  readonly filePatterns = ["**/*.md"];
  private config: CompiledConfig;

  constructor(config: CompiledConfig) {
    this.config = config;
  }

  parseFile(filePath: string, content: string): ParseResult {
    const entities: ParsedEntity[] = [];
    const references: ReferenceHint[] = [];
    const lines = content.split("\n");

    const layer = this.detectLayer(filePath);
    const fileName = path.basename(filePath, ".md");

    // Track heading positions for calculating end lines
    const headings: Array<{
      name: string;
      level: number;
      line: number;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // ATX headings: # Heading
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        headings.push({
          name: headingMatch[2].trim(),
          level: headingMatch[1].length,
          line: lineNum,
        });
        continue;
      }

      // Extract references to other docs or code
      const linkMatches = line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
      for (const match of linkMatches) {
        references.push({
          type: "doc_link",
          target: match[2],
          line: lineNum,
        });
      }
    }

    // Convert headings to entities with computed end lines
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i];

      // End line is the line before the next heading at same or higher level, or EOF
      let endLine = lines.length;
      for (let j = i + 1; j < headings.length; j++) {
        if (headings[j].level <= heading.level) {
          endLine = headings[j].line - 1;
          break;
        }
      }

      const qualifiedName = `${fileName}::${heading.name}`;

      entities.push({
        name: heading.name,
        qualifiedName,
        entityType: "doc_section",
        layer,
        startLine: heading.line,
        endLine,
        tags: this.extractTags(filePath, heading.name),
        metadata: {
          level: heading.level,
        },
      });
    }

    return { entities, references, errors: [] };
  }

  /**
   * Determine doc layer based on file path.
   */
  private detectLayer(filePath: string): Layer {
    const name = path.basename(filePath);
    const mdConfig = this.config.layers.markdown;

    // Developer-facing docs by filename
    if (mdConfig.devDocFilenames.includes(name)) return "dev_doc";

    // Developer-facing docs by path
    for (const devPath of mdConfig.devDocPaths) {
      if (filePath.includes(devPath)) return "dev_doc";
    }

    // User-facing docs by path
    for (const userPath of mdConfig.userDocPaths) {
      if (filePath.includes(userPath)) return "user_doc";
    }

    // User-facing docs by filename
    if (mdConfig.userDocFilenames.includes(name)) return "user_doc";

    return "dev_doc";
  }

  /**
   * Extract concept tags from file path and heading.
   */
  private extractTags(filePath: string, headingName: string): string[] {
    const tags: string[] = [];
    const lower = headingName.toLowerCase();

    // Heading keyword tags from config
    for (const { keyword, tag } of this.config.tags.headingKeywords) {
      if (lower.includes(keyword)) {
        tags.push(tag);
      }
    }

    // Path-based tags from config
    const pathRules = this.config.tags.path.markdown ?? {};
    for (const [substring, tagOrTags] of Object.entries(pathRules)) {
      if (filePath.includes(substring)) {
        if (Array.isArray(tagOrTags)) {
          tags.push(...tagOrTags);
        } else {
          tags.push(tagOrTags);
        }
      }
    }

    return [...new Set(tags)];
  }
}
