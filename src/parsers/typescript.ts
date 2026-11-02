/**
 * TypeScript/JavaScript (.ts/.tsx/.js/.jsx) parser
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
  LayerParser,
  ParseResult,
  ParsedEntity,
  ReferenceHint,
  Layer,
} from "../types.js";
import type { CompiledConfig } from "../config.js";

/**
 * Parsed scenario annotation from a `// @scenario:` comment.
 */
interface ScenarioAnnotation {
  feature: string;
  scenario: string;
}

/**
 * Parsed source annotation from a `// @source:` comment.
 */
interface SourceAnnotation {
  target: string;
}

/**
 * Regex patterns for TypeScript entity extraction.
 */
const PATTERNS = {
  exportFunction: /^(\s*)export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/,
  exportClass: /^(\s*)export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/,
  exportInterface: /^(\s*)export\s+(?:default\s+)?interface\s+(\w+)/,
  exportType: /^(\s*)export\s+(?:default\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/,
  exportConst: /^(\s*)export\s+(?:default\s+)?const\s+(\w+)/,
  describe: /^(\s*)describe\s*\(\s*["'`](.+?)["'`]/,
  it: /^(\s*)(?:it|test)\s*\(\s*["'`](.+?)["'`]/,
  importStmt: /^\s*import\s+.*from\s+["'`](.+?)["'`]/,
  scenarioAnnotation: /^\s*\/\/\s*@scenario:\s*(.+)/,
  sourceAnnotation: /^\s*\/\/\s*@source:\s*(.+)/,
};

/**
 * Parser for TypeScript and JavaScript files.
 * Extracts exported functions, classes, interfaces, types, constants, and test suites.
 */
export class TypeScriptParser implements LayerParser {
  readonly languageId = "typescript";
  readonly filePatterns = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
  private config: CompiledConfig;

  constructor(config: CompiledConfig) {
    this.config = config;
  }

  parseFile(path: string, content: string): ParseResult {
    const entities: ParsedEntity[] = [];
    const references: ReferenceHint[] = [];
    const lines = content.split("\n");

    const baseLayer = this.detectLayer(path);
    const isTestFile = baseLayer === "unit_test" || baseLayer === "e2e_test";
    let hasJsDoc = false;
    let inJsDocBlock = false;
    let scenarioAnnotations: Array<{
      annotation: ScenarioAnnotation;
      line: number;
    }> = [];
    let sourceAnnotations: Array<{
      annotation: SourceAnnotation;
      line: number;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Track JSDoc comments (/** ... */)
      const trimmed = line.trim();
      if (inJsDocBlock) {
        if (trimmed.includes("*/")) {
          inJsDocBlock = false;
        }
        continue;
      }
      if (trimmed.startsWith("/**")) {
        hasJsDoc = true;
        if (!trimmed.includes("*/")) {
          inJsDocBlock = true;
        }
        continue;
      }

      // Import references
      const importMatch = line.match(PATTERNS.importStmt);
      if (importMatch) {
        references.push({
          type: "import",
          target: importMatch[1],
          line: lineNum,
        });
        continue;
      }

      // Accumulate // @scenario: annotations
      const scenarioMatch = line.match(PATTERNS.scenarioAnnotation);
      if (scenarioMatch) {
        const parsed = this.parseScenarioAnnotation(scenarioMatch[1].trim());
        if (parsed) {
          scenarioAnnotations.push({ annotation: parsed, line: lineNum });
          references.push({
            type: "annotation",
            target: scenarioMatch[1].trim(),
            line: lineNum,
          });
        }
        continue;
      }

      // Accumulate // @source: annotations
      const sourceMatch = line.match(PATTERNS.sourceAnnotation);
      if (sourceMatch) {
        const target = sourceMatch[1].trim();
        if (target) {
          sourceAnnotations.push({
            annotation: { target },
            line: lineNum,
          });
          references.push({
            type: "annotation",
            target: `@source:${target}`,
            line: lineNum,
          });
        }
        continue;
      }

      // Test suites (describe blocks)
      const describeMatch = line.match(PATTERNS.describe);
      if (describeMatch) {
        const endLine = this.findBlockEnd(lines, i);
        entities.push({
          name: describeMatch[2],
          entityType: "test_suite",
          layer: baseLayer,
          startLine: lineNum,
          endLine,
          tags: this.extractTags(path, describeMatch[2]),
          metadata: this.buildMetadata(
            scenarioAnnotations,
            sourceAnnotations,
            hasJsDoc,
          ),
        });
        hasJsDoc = false;
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Test cases (it/test blocks)
      const itMatch = line.match(PATTERNS.it);
      if (itMatch) {
        const endLine = this.findBlockEnd(lines, i);
        entities.push({
          name: itMatch[2],
          entityType: "test_fn",
          layer: baseLayer,
          startLine: lineNum,
          endLine,
          tags: this.extractTags(path, itMatch[2]),
          metadata: this.buildMetadata(
            scenarioAnnotations,
            sourceAnnotations,
            hasJsDoc,
          ),
        });
        hasJsDoc = false;
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Exported function
      const fnMatch = line.match(PATTERNS.exportFunction);
      if (fnMatch) {
        const endLine = this.findBlockEnd(lines, i);
        entities.push({
          name: fnMatch[2],
          qualifiedName: this.qualifiedName(path, fnMatch[2]),
          entityType: isTestFile ? "test_fn" : "function",
          layer: baseLayer,
          startLine: lineNum,
          endLine,
          visibility: "public",
          signature: line.trim(),
          tags: this.extractTags(path, fnMatch[2]),
          metadata: this.buildMetadata(
            scenarioAnnotations,
            sourceAnnotations,
            hasJsDoc,
          ),
        });
        hasJsDoc = false;
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Exported class
      const classMatch = line.match(PATTERNS.exportClass);
      if (classMatch) {
        const endLine = this.findBlockEnd(lines, i);
        entities.push({
          name: classMatch[2],
          qualifiedName: this.qualifiedName(path, classMatch[2]),
          entityType: "class",
          layer: baseLayer,
          startLine: lineNum,
          endLine,
          visibility: "public",
          signature: line.trim(),
          tags: this.extractTags(path, classMatch[2]),
          metadata: this.buildMetadata(
            scenarioAnnotations,
            sourceAnnotations,
            hasJsDoc,
          ),
        });
        hasJsDoc = false;
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Exported interface
      const ifaceMatch = line.match(PATTERNS.exportInterface);
      if (ifaceMatch) {
        const endLine = this.findBlockEnd(lines, i);
        entities.push({
          name: ifaceMatch[2],
          qualifiedName: this.qualifiedName(path, ifaceMatch[2]),
          entityType: "interface",
          layer: baseLayer,
          startLine: lineNum,
          endLine,
          visibility: "public",
          signature: line.trim(),
          tags: this.extractTags(path, ifaceMatch[2]),
          metadata: this.buildMetadata(
            scenarioAnnotations,
            sourceAnnotations,
            hasJsDoc,
          ),
        });
        hasJsDoc = false;
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Exported type alias
      const typeMatch = line.match(PATTERNS.exportType);
      if (typeMatch) {
        entities.push({
          name: typeMatch[2],
          qualifiedName: this.qualifiedName(path, typeMatch[2]),
          entityType: "type_alias",
          layer: baseLayer,
          startLine: lineNum,
          endLine: lineNum,
          visibility: "public",
          signature: line.trim(),
          tags: this.extractTags(path, typeMatch[2]),
          metadata: this.buildMetadata(
            scenarioAnnotations,
            sourceAnnotations,
            hasJsDoc,
          ),
        });
        hasJsDoc = false;
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Exported constant
      const constMatch = line.match(PATTERNS.exportConst);
      if (constMatch) {
        entities.push({
          name: constMatch[2],
          qualifiedName: this.qualifiedName(path, constMatch[2]),
          entityType: "constant",
          layer: baseLayer,
          startLine: lineNum,
          endLine: lineNum,
          visibility: "public",
          signature: line.trim(),
          tags: this.extractTags(path, constMatch[2]),
          metadata: this.buildMetadata(
            scenarioAnnotations,
            sourceAnnotations,
            hasJsDoc,
          ),
        });
        hasJsDoc = false;
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Reset annotations on non-comment, non-entity lines
      if (line.trim() && !line.trim().startsWith("//")) {
        hasJsDoc = false;
        scenarioAnnotations = [];
        sourceAnnotations = [];
      }
    }

    return { entities, references, errors: [] };
  }

  /**
   * Determine the layer based on file path.
   */
  private detectLayer(path: string): Layer {
    if (path.includes("/e2e/")) return "e2e_test";
    if (
      path.endsWith(".test.ts") ||
      path.endsWith(".test.tsx") ||
      path.endsWith(".test.js") ||
      path.endsWith(".spec.ts") ||
      path.endsWith(".spec.tsx") ||
      path.endsWith(".spec.js") ||
      path.includes("/__tests__/")
    ) {
      return "unit_test";
    }
    return "source";
  }

  /**
   * Build qualified name from path and entity name.
   */
  private qualifiedName(path: string, name: string): string {
    const match = path.match(/\/src\/(.+)\.[jt]sx?$/);
    if (match) {
      const modulePath = match[1].replace(/\/index$/, "").replace(/\//g, "/");
      return `${modulePath}::${name}`;
    }
    return name;
  }

  /**
   * Extract concept tags from file path.
   */
  private extractTags(path: string, _name: string): string[] {
    const tags: string[] = [];

    // Path-based tags from config
    const pathRules = this.config.tags.path.typescript ?? {};
    for (const [substring, tagOrTags] of Object.entries(pathRules)) {
      if (path.includes(substring)) {
        if (Array.isArray(tagOrTags)) {
          tags.push(...tagOrTags);
        } else {
          tags.push(tagOrTags);
        }
      }
    }

    return [...new Set(tags)];
  }

  /**
   * Build metadata object with scenario and source annotation info if present.
   */
  private buildMetadata(
    scenarioAnnotations: Array<{
      annotation: ScenarioAnnotation;
      line: number;
    }>,
    sourceAnnotations: Array<{
      annotation: SourceAnnotation;
      line: number;
    }> = [],
    hasJsDoc = false,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    if (hasJsDoc) {
      metadata.hasDocComment = true;
    }
    if (scenarioAnnotations.length > 0) {
      metadata.scenarioAnnotations = scenarioAnnotations.map(
        (a) => a.annotation,
      );
    }
    if (sourceAnnotations.length > 0) {
      metadata.sourceAnnotations = sourceAnnotations.map((a) => a.annotation);
    }
    return metadata;
  }

  /**
   * Parse a scenario annotation value like "feature_name :: Scenario Name"
   * or "feature_name:Scenario Name" into its components.
   */
  private parseScenarioAnnotation(value: string): ScenarioAnnotation | null {
    // Try " :: " separator first (used by majority of annotations),
    // fall back to single ":" for legacy format
    const doubleIdx = value.indexOf(" :: ");
    if (doubleIdx > 0) {
      const feature = value.substring(0, doubleIdx).trim();
      const scenario = value.substring(doubleIdx + 4).trim();
      if (feature && scenario) return { feature, scenario };
    }

    const colonIdx = value.indexOf(":");
    if (colonIdx <= 0 || colonIdx >= value.length - 1) return null;
    const feature = value.substring(0, colonIdx).trim();
    const scenario = value.substring(colonIdx + 1).trim();
    if (!feature || !scenario) return null;
    return { feature, scenario };
  }

  /**
   * Find the end of a block by counting braces.
   */
  private findBlockEnd(lines: string[], startIdx: number): number {
    let depth = 0;
    let started = false;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === "{") {
          depth++;
          started = true;
        }
        if (ch === "}") {
          depth--;
        }
      }
      if (started && depth <= 0) {
        return i + 1;
      }
    }

    return startIdx + 1;
  }
}
