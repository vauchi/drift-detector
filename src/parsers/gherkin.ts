/**
 * Gherkin (.feature file) parser
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as Gherkin from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";
import type {
  LayerParser,
  ParseResult,
  ParsedEntity,
  ParseError,
  ReferenceHint,
} from "../types.js";
import type { CompiledConfig } from "../config.js";

/**
 * Parser for Gherkin .feature files.
 * Extracts features, scenarios, backgrounds, and their relationships.
 */
export class GherkinParser implements LayerParser {
  readonly languageId = "gherkin";
  readonly filePatterns = ["**/*.feature"];
  private config: CompiledConfig;
  private uuidFn = IdGenerator.uuid();

  constructor(config: CompiledConfig) {
    this.config = config;
  }

  parseFile(path: string, content: string): ParseResult {
    const entities: ParsedEntity[] = [];
    const references: ReferenceHint[] = [];
    const errors: ParseError[] = [];

    // Handle empty content
    if (!content.trim()) {
      return { entities, references, errors };
    }

    try {
      const builder = new Gherkin.AstBuilder(this.uuidFn);
      const matcher = new Gherkin.GherkinClassicTokenMatcher();
      const parser = new Gherkin.Parser(builder, matcher);
      const doc = parser.parse(content);

      const feature = doc.feature;
      if (!feature) {
        return { entities, references, errors };
      }

      // Extract feature-level tags
      const featureTags = this.extractTags(feature.tags);

      // Add tag references
      for (const tag of featureTags) {
        references.push({
          type: "tag",
          target: tag,
          line: feature.location.line,
        });
      }

      // Create feature entity
      const featureEntity: ParsedEntity = {
        name: feature.name,
        entityType: "feature",
        layer: "feature",
        startLine: feature.location.line,
        endLine: this.getFeatureEndLine(feature),
        tags: featureTags,
        metadata: {
          description: feature.description?.trim() || undefined,
          language: feature.language,
        },
      };
      entities.push(featureEntity);

      // Process feature children (backgrounds, scenarios, scenario outlines)
      for (const child of feature.children) {
        if (child.background) {
          entities.push(this.parseBackground(child.background, featureTags));
        } else if (child.scenario) {
          const scenario = child.scenario;
          const isOutline =
            scenario.keyword.trim() === "Scenario Outline" ||
            scenario.keyword.trim() === "Scenario Template";

          if (isOutline) {
            entities.push(
              this.parseScenarioOutline(scenario, feature.name, featureTags),
            );
          } else {
            entities.push(
              this.parseScenario(scenario, feature.name, featureTags),
            );
          }

          // Add scenario tag references
          for (const tag of this.extractTags(scenario.tags)) {
            if (!featureTags.includes(tag)) {
              references.push({
                type: "tag",
                target: tag,
                line: scenario.location.line,
              });
            }
          }
        }
      }
    } catch (error) {
      // Handle parse errors
      if (error instanceof Error) {
        // Gherkin errors often have location info
        const gherkinError = error as Error & {
          location?: { line?: number; column?: number };
        };
        errors.push({
          severity: "error",
          message: error.message,
          line: gherkinError.location?.line,
          column: gherkinError.location?.column,
        });
      }
    }

    // Override layer to "problem" for draft scenarios in configured paths
    const problemPaths = this.config.layers.gherkin.problemPaths;
    if (problemPaths.length > 0 && problemPaths.some((p) => path.includes(p))) {
      for (const entity of entities) {
        entity.layer = "problem";
      }
    }

    return { entities, references, errors };
  }

  private extractTags(
    tags: readonly { name: string; location: { line: number } }[],
  ): string[] {
    return tags.map((t) => t.name.replace(/^@/, ""));
  }

  private parseBackground(
    background: GherkinBackground,
    featureTags: string[],
  ): ParsedEntity {
    const steps = background.steps.map((s) =>
      `${s.keyword.trim()} ${s.text}`.trim(),
    );
    const endLine =
      background.steps.length > 0
        ? background.steps[background.steps.length - 1].location.line
        : background.location.line;

    return {
      name: background.name || "Background",
      entityType: "background",
      layer: "feature",
      startLine: background.location.line,
      endLine,
      tags: featureTags,
      metadata: {
        steps,
        description: background.description?.trim() || undefined,
      },
    };
  }

  private parseScenario(
    scenario: GherkinScenario,
    featureName: string,
    featureTags: string[],
  ): ParsedEntity {
    const scenarioTags = this.extractTags(scenario.tags);
    const allTags = [...new Set([...featureTags, ...scenarioTags])];

    const steps = scenario.steps.map((s) =>
      `${s.keyword.trim()} ${s.text}`.trim(),
    );
    const endLine =
      scenario.steps.length > 0
        ? scenario.steps[scenario.steps.length - 1].location.line
        : scenario.location.line;

    return {
      name: scenario.name,
      qualifiedName: `${featureName}::${scenario.name}`,
      entityType: "scenario",
      layer: "feature",
      startLine: scenario.location.line,
      endLine,
      tags: allTags,
      metadata: {
        steps,
        description: scenario.description?.trim() || undefined,
      },
    };
  }

  private parseScenarioOutline(
    scenario: GherkinScenario,
    featureName: string,
    featureTags: string[],
  ): ParsedEntity {
    const scenarioTags = this.extractTags(scenario.tags);
    const allTags = [...new Set([...featureTags, ...scenarioTags])];

    const steps = scenario.steps.map((s) =>
      `${s.keyword.trim()} ${s.text}`.trim(),
    );

    // Extract examples
    const examples = scenario.examples.map((ex) => ({
      name: ex.name,
      tags: this.extractTags(ex.tags),
      headers: ex.tableHeader?.cells.map((c) => c.value) || [],
      rows: ex.tableBody?.map((row) => row.cells.map((c) => c.value)) || [],
    }));

    // Calculate end line (last example row or last step)
    let endLine = scenario.location.line;
    if (scenario.examples.length > 0) {
      const lastExample = scenario.examples[scenario.examples.length - 1];
      if (lastExample.tableBody && lastExample.tableBody.length > 0) {
        endLine =
          lastExample.tableBody[lastExample.tableBody.length - 1].location.line;
      }
    } else if (scenario.steps.length > 0) {
      endLine = scenario.steps[scenario.steps.length - 1].location.line;
    }

    return {
      name: scenario.name,
      qualifiedName: `${featureName}::${scenario.name}`,
      entityType: "scenario_outline",
      layer: "feature",
      startLine: scenario.location.line,
      endLine,
      tags: allTags,
      metadata: {
        steps,
        examples,
        description: scenario.description?.trim() || undefined,
      },
    };
  }

  private getFeatureEndLine(feature: GherkinFeature): number {
    let endLine = feature.location.line;

    for (const child of feature.children) {
      if (child.background) {
        const bg = child.background;
        if (bg.steps.length > 0) {
          endLine = Math.max(
            endLine,
            bg.steps[bg.steps.length - 1].location.line,
          );
        }
      } else if (child.scenario) {
        const sc = child.scenario;
        if (sc.steps.length > 0) {
          endLine = Math.max(
            endLine,
            sc.steps[sc.steps.length - 1].location.line,
          );
        }
        for (const ex of sc.examples) {
          if (ex.tableBody && ex.tableBody.length > 0) {
            endLine = Math.max(
              endLine,
              ex.tableBody[ex.tableBody.length - 1].location.line,
            );
          }
        }
      }
    }

    return endLine;
  }
}

// Type aliases for Gherkin AST nodes
type GherkinDocument = ReturnType<InstanceType<typeof Gherkin.Parser>["parse"]>;
type GherkinFeature = NonNullable<GherkinDocument["feature"]>;
type GherkinBackground = NonNullable<
  GherkinFeature["children"][number]["background"]
>;
type GherkinScenario = NonNullable<
  GherkinFeature["children"][number]["scenario"]
>;
