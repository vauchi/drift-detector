/**
 * Rust (.rs file) parser
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
  Visibility,
} from "../types.js";
import type { CompiledConfig } from "../config.js";

/**
 * Regex patterns for Rust entity extraction.
 */
/**
 * Parsed scenario annotation from a `// @scenario:` comment.
 */
interface ScenarioAnnotation {
  feature: string;
  scenario: string;
}

/**
 * Parsed source annotation from a `// @source:` comment.
 * Links a test to specific source entity by name or qualified name.
 */
interface SourceAnnotation {
  target: string;
}

const PATTERNS = {
  fn: /^(\s*)(pub(?:\(crate\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/,
  struct: /^(\s*)(pub(?:\(crate\))?\s+)?struct\s+(\w+)/,
  enum: /^(\s*)(pub(?:\(crate\))?\s+)?enum\s+(\w+)/,
  trait: /^(\s*)(pub(?:\(crate\))?\s+)?trait\s+(\w+)/,
  impl: /^(\s*)impl(?:<[^>]*>)?\s+(?:(\w+)\s+for\s+)?(\w+)/,
  typeAlias: /^(\s*)(pub(?:\(crate\))?\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/,
  const: /^(\s*)(pub(?:\(crate\))?\s+)?const\s+(\w+)\s*:/,
  mod: /^(\s*)(pub(?:\(crate\))?\s+)?mod\s+(\w+)/,
  testAttr: /^\s*#\[(?:tokio::)?test/,
  cfgTest: /^\s*#\[cfg\(test\)\]/,
  benchAttr: /^\s*#\[bench\]/,
  useStmt: /^\s*use\s+([\w:]+)/,
  docComment: /^\s*\/\/\/\s?(.*)/,
  moduleDocComment: /^\s*\/\/!\s?(.*)/,
  scenarioAnnotation: /^\s*\/\/\s*@scenario:\s*(.+)/,
  sourceAnnotation: /^\s*\/\/\s*@source:\s*(.+)/,
};

/**
 * Parser for Rust .rs files.
 * Extracts functions, structs, enums, traits, type aliases, constants, modules, and tests.
 */
export class RustParser implements LayerParser {
  readonly languageId = "rust";
  readonly filePatterns = ["**/*.rs"];
  private config: CompiledConfig;

  constructor(config: CompiledConfig) {
    this.config = config;
  }

  parseFile(path: string, content: string): ParseResult {
    const entities: ParsedEntity[] = [];
    const references: ReferenceHint[] = [];
    const lines = content.split("\n");

    const baseLayer = this.detectLayer(path);
    let nextIsTest = false;
    let nextIsBench = false;
    let inCfgTest = false;
    let docCommentLines: string[] = [];
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

      // Accumulate /// doc comments
      const docMatch = line.match(PATTERNS.docComment);
      if (docMatch) {
        docCommentLines.push(docMatch[1]);
        continue;
      }

      // Accumulate //! module-level doc comments (treated same as ///)
      const moduleDocMatch = line.match(PATTERNS.moduleDocComment);
      if (moduleDocMatch) {
        docCommentLines.push(moduleDocMatch[1]);
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

      // Track test/bench attributes
      if (PATTERNS.testAttr.test(line)) {
        nextIsTest = true;
        continue;
      }
      if (PATTERNS.benchAttr.test(line)) {
        nextIsBench = true;
        continue;
      }
      if (PATTERNS.cfgTest.test(line)) {
        inCfgTest = true;
        continue;
      }

      // Track use statements as references
      const useMatch = line.match(PATTERNS.useStmt);
      if (useMatch) {
        references.push({
          type: "import",
          target: useMatch[1],
          line: lineNum,
        });
        continue;
      }

      // Function
      const fnMatch = line.match(PATTERNS.fn);
      if (fnMatch) {
        const [, , visMod, name, _params] = fnMatch;
        const layer = nextIsTest
          ? "unit_test"
          : nextIsBench
            ? "perf_test"
            : inCfgTest
              ? "unit_test"
              : baseLayer;
        const entityType =
          nextIsTest || (inCfgTest && name.startsWith("test"))
            ? "test_fn"
            : nextIsBench
              ? "benchmark"
              : "function";
        const endLine = this.findBlockEnd(lines, i);

        entities.push({
          name,
          qualifiedName: this.qualifiedName(path, name),
          entityType,
          layer,
          startLine: lineNum,
          endLine,
          visibility: this.parseVisibility(visMod),
          signature: line.trim(),
          tags: this.extractTags(path, name),
          metadata: this.buildMetadata(
            docCommentLines,
            scenarioAnnotations,
            sourceAnnotations,
          ),
        });
        docCommentLines = [];
        scenarioAnnotations = [];
        sourceAnnotations = [];

        nextIsTest = false;
        nextIsBench = false;
        continue;
      }

      // Struct
      const structMatch = line.match(PATTERNS.struct);
      if (structMatch) {
        const [, , visMod, name] = structMatch;
        const endLine = this.findBlockEnd(lines, i);
        entities.push({
          name,
          qualifiedName: this.qualifiedName(path, name),
          entityType: "struct",
          layer: baseLayer,
          startLine: lineNum,
          endLine,
          visibility: this.parseVisibility(visMod),
          signature: line.trim(),
          tags: this.extractTags(path, name),
          metadata: this.buildMetadata(
            docCommentLines,
            scenarioAnnotations,
            sourceAnnotations,
          ),
        });
        docCommentLines = [];
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Enum
      const enumMatch = line.match(PATTERNS.enum);
      if (enumMatch) {
        const [, , visMod, name] = enumMatch;
        const endLine = this.findBlockEnd(lines, i);
        entities.push({
          name,
          qualifiedName: this.qualifiedName(path, name),
          entityType: "enum",
          layer: baseLayer,
          startLine: lineNum,
          endLine,
          visibility: this.parseVisibility(visMod),
          signature: line.trim(),
          tags: this.extractTags(path, name),
          metadata: this.buildMetadata(
            docCommentLines,
            scenarioAnnotations,
            sourceAnnotations,
          ),
        });
        docCommentLines = [];
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Trait
      const traitMatch = line.match(PATTERNS.trait);
      if (traitMatch) {
        const [, , visMod, name] = traitMatch;
        const endLine = this.findBlockEnd(lines, i);
        entities.push({
          name,
          qualifiedName: this.qualifiedName(path, name),
          entityType: "trait",
          layer: baseLayer,
          startLine: lineNum,
          endLine,
          visibility: this.parseVisibility(visMod),
          signature: line.trim(),
          tags: this.extractTags(path, name),
          metadata: this.buildMetadata(
            docCommentLines,
            scenarioAnnotations,
            sourceAnnotations,
          ),
        });
        docCommentLines = [];
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Type alias
      const typeMatch = line.match(PATTERNS.typeAlias);
      if (typeMatch) {
        const [, , visMod, name] = typeMatch;
        entities.push({
          name,
          qualifiedName: this.qualifiedName(path, name),
          entityType: "type_alias",
          layer: baseLayer,
          startLine: lineNum,
          endLine: lineNum,
          visibility: this.parseVisibility(visMod),
          signature: line.trim(),
          tags: this.extractTags(path, name),
          metadata: this.buildMetadata(
            docCommentLines,
            scenarioAnnotations,
            sourceAnnotations,
          ),
        });
        docCommentLines = [];
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Constant
      const constMatch = line.match(PATTERNS.const);
      if (constMatch) {
        const [, , visMod, name] = constMatch;
        entities.push({
          name,
          qualifiedName: this.qualifiedName(path, name),
          entityType: "constant",
          layer: baseLayer,
          startLine: lineNum,
          endLine: lineNum,
          visibility: this.parseVisibility(visMod),
          signature: line.trim(),
          tags: this.extractTags(path, name),
          metadata: this.buildMetadata(
            docCommentLines,
            scenarioAnnotations,
            sourceAnnotations,
          ),
        });
        docCommentLines = [];
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Module
      const modMatch = line.match(PATTERNS.mod);
      if (modMatch) {
        const [, , visMod, name] = modMatch;
        // cfg(test) module
        if (inCfgTest || name === "tests") {
          inCfgTest = true;
        }
        const endLine = line.includes("{")
          ? this.findBlockEnd(lines, i)
          : lineNum;
        entities.push({
          name,
          qualifiedName: this.qualifiedName(path, name),
          entityType: "module",
          layer: baseLayer,
          startLine: lineNum,
          endLine,
          visibility: this.parseVisibility(visMod),
          tags: this.extractTags(path, name),
          metadata: this.buildMetadata(
            docCommentLines,
            scenarioAnnotations,
            sourceAnnotations,
          ),
        });
        docCommentLines = [];
        scenarioAnnotations = [];
        sourceAnnotations = [];
        continue;
      }

      // Skip other attribute lines and comments — preserve accumulated state
      const trimmed = line.trim();
      if (trimmed.startsWith("#[") || trimmed.startsWith("//") || trimmed === "") {
        continue;
      }

      // Reset test flag, doc comments, and annotations if we hit a non-attribute,
      // non-comment, non-empty, non-entity line (e.g. a bare expression or statement)
      nextIsTest = false;
      nextIsBench = false;
      docCommentLines = [];
      scenarioAnnotations = [];
      sourceAnnotations = [];
    }

    return { entities, references, errors: [] };
  }

  /**
   * Determine the layer based on file path.
   */
  private detectLayer(path: string): Layer {
    if (path.includes("/benches/")) return "perf_test";
    if (path.includes("/tests/")) return "unit_test";
    return "source";
  }

  /**
   * Build a qualified name from file path and entity name.
   */
  private qualifiedName(path: string, name: string): string {
    // Extract crate::module path from file path
    const match = path.match(/\/src\/(.+)\.rs$/);
    if (match) {
      const modulePath = match[1].replace(/\/mod$/, "").replace(/\//g, "::");
      return `${modulePath}::${name}`;
    }
    const testMatch = path.match(/\/tests\/(.+)\.rs$/);
    if (testMatch) {
      return `tests::${testMatch[1].replace(/\//g, "::")}::${name}`;
    }
    return name;
  }

  /**
   * Extract concept tags from file path and entity name.
   */
  private extractTags(path: string, name: string): string[] {
    const tags: string[] = [];

    // Path-based tags from config
    const pathRules = this.config.tags.path.rust ?? {};
    for (const [substring, tagOrTags] of Object.entries(pathRules)) {
      if (path.includes(substring)) {
        if (Array.isArray(tagOrTags)) {
          tags.push(...tagOrTags);
        } else {
          tags.push(tagOrTags);
        }
      }
    }

    // Name-based tags from compiled config patterns
    const namePatterns = this.config._compiled.namePatterns.rust ?? [];
    for (const { regex, tag } of namePatterns) {
      if (regex.test(name)) {
        tags.push(tag);
      }
    }

    return [...new Set(tags)];
  }

  /**
   * Parse visibility modifier.
   */
  private parseVisibility(visMod: string | undefined): Visibility | undefined {
    if (!visMod) return "private";
    if (visMod.includes("pub(crate)")) return "internal";
    if (visMod.includes("pub")) return "public";
    return "private";
  }

  /**
   * Build metadata object with doc comment and scenario annotation info.
   */
  private buildMetadata(
    docCommentLines: string[],
    scenarioAnnotations: Array<{
      annotation: ScenarioAnnotation;
      line: number;
    }>,
    sourceAnnotations: Array<{
      annotation: SourceAnnotation;
      line: number;
    }> = [],
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};
    if (docCommentLines.length > 0) {
      metadata.hasDocComment = true;
      metadata.docCommentLines = docCommentLines.length;
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
      for (const ch of lines[i]) {
        if (ch === "{") {
          depth++;
          started = true;
        }
        if (ch === "}") {
          depth--;
        }
      }
      if (started && depth <= 0) {
        return i + 1; // 1-indexed
      }
    }

    return startIdx + 1;
  }
}
