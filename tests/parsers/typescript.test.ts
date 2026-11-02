/**
 * Tests for TypeScript parser
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import { TypeScriptParser } from "../../src/parsers/typescript.js";
import { testConfig } from "../test-config.js";

const tsTestConfig = testConfig({
  tags: {
    path: {
      typescript: {
        "/services/": "service",
        "/parsers/": ["parser", "indexing"],
      },
    },
  },
});

describe("TypeScriptParser", () => {
  const parser = new TypeScriptParser(tsTestConfig);

  describe("languageId and filePatterns", () => {
    it("should have correct languageId", () => {
      expect(parser.languageId).toBe("typescript");
    });

    it("should match TypeScript and JavaScript files", () => {
      expect(parser.filePatterns).toContain("**/*.ts");
      expect(parser.filePatterns).toContain("**/*.tsx");
      expect(parser.filePatterns).toContain("**/*.js");
      expect(parser.filePatterns).toContain("**/*.jsx");
    });
  });

  describe("exported function detection", () => {
    it("should extract exported function", () => {
      const code = `export function greet(name: string): string {\n  return "Hello " + name;\n}`;
      const result = parser.parseFile("/src/utils.ts", code);
      const fn = result.entities.find((e) => e.name === "greet");

      expect(fn).toBeDefined();
      expect(fn!.entityType).toBe("function");
      expect(fn!.visibility).toBe("public");
      expect(fn!.layer).toBe("source");
    });

    it("should extract exported async function", () => {
      const code = `export async function fetchData(): Promise<void> {\n  await fetch("/api");\n}`;
      const result = parser.parseFile("/src/api.ts", code);
      const fn = result.entities.find((e) => e.name === "fetchData");

      expect(fn).toBeDefined();
      expect(fn!.entityType).toBe("function");
    });

    it("should extract export default function", () => {
      const code = `export default function main() {\n  console.log("main");\n}`;
      const result = parser.parseFile("/src/index.ts", code);
      const fn = result.entities.find((e) => e.name === "main");

      expect(fn).toBeDefined();
      expect(fn!.entityType).toBe("function");
    });
  });

  describe("exported class detection", () => {
    it("should extract exported class", () => {
      const code = `export class MyParser {\n  parse() {}\n}`;
      const result = parser.parseFile("/src/parsers/my.ts", code);
      const cls = result.entities.find((e) => e.name === "MyParser");

      expect(cls).toBeDefined();
      expect(cls!.entityType).toBe("class");
      expect(cls!.visibility).toBe("public");
    });

    it("should extract exported abstract class", () => {
      const code = `export abstract class BaseParser {\n  abstract parse(): void;\n}`;
      const result = parser.parseFile("/src/base.ts", code);
      const cls = result.entities.find((e) => e.name === "BaseParser");

      expect(cls).toBeDefined();
      expect(cls!.entityType).toBe("class");
    });
  });

  describe("exported interface detection", () => {
    it("should extract exported interface", () => {
      const code = `export interface Config {\n  name: string;\n  value: number;\n}`;
      const result = parser.parseFile("/src/types.ts", code);
      const iface = result.entities.find((e) => e.name === "Config");

      expect(iface).toBeDefined();
      expect(iface!.entityType).toBe("interface");
      expect(iface!.visibility).toBe("public");
    });
  });

  describe("exported type alias detection", () => {
    it("should extract exported type alias", () => {
      const code = `export type Layer = "source" | "test" | "doc";`;
      const result = parser.parseFile("/src/types.ts", code);
      const t = result.entities.find((e) => e.name === "Layer");

      expect(t).toBeDefined();
      expect(t!.entityType).toBe("type_alias");
      expect(t!.startLine).toBe(t!.endLine); // single-line type
    });

    it("should extract generic type alias", () => {
      const code = `export type Result<T> = { ok: T } | { err: string };`;
      const result = parser.parseFile("/src/types.ts", code);
      const t = result.entities.find((e) => e.name === "Result");

      expect(t).toBeDefined();
      expect(t!.entityType).toBe("type_alias");
    });
  });

  describe("exported constant detection", () => {
    it("should extract exported constant", () => {
      const code = `export const MAX_RETRIES = 3;`;
      const result = parser.parseFile("/src/config.ts", code);
      const c = result.entities.find((e) => e.name === "MAX_RETRIES");

      expect(c).toBeDefined();
      expect(c!.entityType).toBe("constant");
      expect(c!.visibility).toBe("public");
    });
  });

  describe("test construct detection", () => {
    it("should extract describe blocks as test_suite", () => {
      const code = `describe("MyService", () => {\n  it("works", () => {});\n});`;
      const result = parser.parseFile("/tests/service.test.ts", code);
      const suite = result.entities.find((e) => e.entityType === "test_suite");

      expect(suite).toBeDefined();
      expect(suite!.name).toBe("MyService");
      expect(suite!.layer).toBe("unit_test");
    });

    it("should extract it blocks as test_fn", () => {
      const code = `it("should parse markdown", () => {\n  expect(true).toBe(true);\n});`;
      const result = parser.parseFile("/tests/parser.test.ts", code);
      const test = result.entities.find((e) => e.entityType === "test_fn");

      expect(test).toBeDefined();
      expect(test!.name).toBe("should parse markdown");
    });

    it("should extract test() blocks as test_fn", () => {
      const code = `test("parses headings", () => {\n  expect(1).toBe(1);\n});`;
      const result = parser.parseFile("/tests/parser.test.ts", code);
      const test = result.entities.find((e) => e.entityType === "test_fn");

      expect(test).toBeDefined();
      expect(test!.name).toBe("parses headings");
    });

    it("should handle describe with double quotes", () => {
      const code = `describe("Parser", () => {\n});`;
      const result = parser.parseFile("/tests/p.test.ts", code);
      const suite = result.entities.find((e) => e.entityType === "test_suite");

      expect(suite!.name).toBe("Parser");
    });

    it("should handle describe with backticks", () => {
      const code = "describe(`Parser`, () => {\n});";
      const result = parser.parseFile("/tests/p.test.ts", code);
      const suite = result.entities.find((e) => e.entityType === "test_suite");

      expect(suite!.name).toBe("Parser");
    });

    it("should classify exported functions in test files as test_fn", () => {
      const code = `export function setupTestDb() {\n  return {};\n}`;
      const result = parser.parseFile("/tests/helpers.test.ts", code);
      const fn = result.entities.find((e) => e.name === "setupTestDb");

      expect(fn).toBeDefined();
      expect(fn!.entityType).toBe("test_fn");
    });
  });

  describe("import reference extraction", () => {
    it("should extract import references", () => {
      const code = `import { Parser } from "../parsers/base.js";\nimport type { Config } from "../config.js";`;
      const result = parser.parseFile("/src/index.ts", code);

      expect(result.references).toHaveLength(2);
      expect(result.references[0].type).toBe("import");
      expect(result.references[0].target).toBe("../parsers/base.js");
      expect(result.references[1].target).toBe("../config.js");
    });

    it("should capture correct line numbers for imports", () => {
      const code = `import { A } from "a";\n\nimport { B } from "b";`;
      const result = parser.parseFile("/src/test.ts", code);

      expect(result.references[0].line).toBe(1);
      expect(result.references[1].line).toBe(3);
    });
  });

  describe("layer detection", () => {
    it("should detect source layer for regular files", () => {
      const code = `export function helper() {}`;
      const result = parser.parseFile("/src/utils.ts", code);

      expect(result.entities[0].layer).toBe("source");
    });

    it("should detect unit_test layer for .test.ts files", () => {
      const code = `describe("test", () => {});`;
      const result = parser.parseFile("/tests/utils.test.ts", code);

      expect(result.entities[0].layer).toBe("unit_test");
    });

    it("should detect unit_test layer for .spec.ts files", () => {
      const code = `describe("spec", () => {});`;
      const result = parser.parseFile("/tests/utils.spec.ts", code);

      expect(result.entities[0].layer).toBe("unit_test");
    });

    it("should detect unit_test layer for __tests__ directory", () => {
      const code = `describe("test", () => {});`;
      const result = parser.parseFile("/src/__tests__/utils.ts", code);

      expect(result.entities[0].layer).toBe("unit_test");
    });

    it("should detect e2e_test layer for /e2e/ paths", () => {
      const code = `describe("e2e", () => {});`;
      const result = parser.parseFile("/e2e/tests/app.spec.ts", code);

      expect(result.entities[0].layer).toBe("e2e_test");
    });

    it("should detect unit_test for .test.js files", () => {
      const code = `describe("js test", () => {});`;
      const result = parser.parseFile("/tests/utils.test.js", code);

      expect(result.entities[0].layer).toBe("unit_test");
    });

    it("should detect unit_test for .spec.tsx files", () => {
      const code = `describe("component", () => {});`;
      const result = parser.parseFile("/tests/App.spec.tsx", code);

      expect(result.entities[0].layer).toBe("unit_test");
    });
  });

  describe("qualifiedName", () => {
    it("should build qualifiedName from /src/ path", () => {
      const code = `export function parse() {}`;
      const result = parser.parseFile("/project/src/parsers/markdown.ts", code);

      expect(result.entities[0].qualifiedName).toBe("parsers/markdown::parse");
    });

    it("should strip /index from module path", () => {
      const code = `export function init() {}`;
      const result = parser.parseFile("/project/src/db/index.ts", code);

      expect(result.entities[0].qualifiedName).toBe("db::init");
    });

    it("should fall back to just entity name without /src/ in path", () => {
      const code = `export function helper() {}`;
      const result = parser.parseFile("/lib/helper.ts", code);

      expect(result.entities[0].qualifiedName).toBe("helper");
    });

    it("should handle .tsx extension", () => {
      const code = `export function App() {}`;
      const result = parser.parseFile("/project/src/components/App.tsx", code);

      expect(result.entities[0].qualifiedName).toBe("components/App::App");
    });
  });

  describe("findBlockEnd (brace counting)", () => {
    it("should correctly compute endLine for simple block", () => {
      const code = `export function simple() {\n  return 1;\n}`;
      const result = parser.parseFile("/src/test.ts", code);

      expect(result.entities[0].startLine).toBe(1);
      expect(result.entities[0].endLine).toBe(3);
    });

    it("should correctly compute endLine for nested blocks", () => {
      const code = `export function nested() {\n  if (true) {\n    return 1;\n  }\n  return 0;\n}`;
      const result = parser.parseFile("/src/test.ts", code);

      expect(result.entities[0].endLine).toBe(6);
    });

    it("should handle single-line blocks", () => {
      const code = `export function oneLiner() { return 1; }`;
      const result = parser.parseFile("/src/test.ts", code);

      expect(result.entities[0].startLine).toBe(1);
      expect(result.entities[0].endLine).toBe(1);
    });
  });

  describe("tag extraction", () => {
    it("should extract path-based tags", () => {
      const code = `export class MarkdownParser {}`;
      const result = parser.parseFile("/src/parsers/markdown.ts", code);

      expect(result.entities[0].tags).toContain("parser");
      expect(result.entities[0].tags).toContain("indexing");
    });

    it("should extract single tag from path", () => {
      const code = `export function fetchTheme() {}`;
      const result = parser.parseFile("/src/services/theme.ts", code);

      expect(result.entities[0].tags).toContain("service");
    });

    it("should return empty tags when no path matches", () => {
      const code = `export function helper() {}`;
      const result = parser.parseFile("/src/utils.ts", code);

      expect(result.entities[0].tags).toEqual([]);
    });

    it("should deduplicate tags", () => {
      const code = `export function svc() {}`;
      const result = parser.parseFile("/src/services/svc.ts", code);

      const serviceCount = result.entities[0].tags.filter(
        (t) => t === "service",
      ).length;
      expect(serviceCount).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("should return empty results for empty content", () => {
      const result = parser.parseFile("/src/empty.ts", "");

      expect(result.entities).toHaveLength(0);
      expect(result.references).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should return empty entities for non-exported code", () => {
      const code = `function internal() {\n  return 1;\n}\nconst x = 5;`;
      const result = parser.parseFile("/src/internal.ts", code);

      expect(result.entities).toHaveLength(0);
    });

    it("should handle file with only imports", () => {
      const code = `import { A } from "a";\nimport { B } from "b";`;
      const result = parser.parseFile("/src/imports.ts", code);

      expect(result.entities).toHaveLength(0);
      expect(result.references).toHaveLength(2);
    });

    it("should capture signature for exported entities", () => {
      const code = `export function add(a: number, b: number): number {\n  return a + b;\n}`;
      const result = parser.parseFile("/src/math.ts", code);

      expect(result.entities[0].signature).toBe(
        "export function add(a: number, b: number): number {",
      );
    });
  });

  describe("JSDoc comment detection", () => {
    it("should set hasDocComment for single-line JSDoc", () => {
      const code = `/** Greets a user by name */\nexport function greet(name: string): string {\n  return "Hello " + name;\n}`;
      const result = parser.parseFile("/src/utils.ts", code);
      const fn = result.entities.find((e) => e.name === "greet");

      expect(fn).toBeDefined();
      expect(fn!.metadata.hasDocComment).toBe(true);
    });

    it("should set hasDocComment for multi-line JSDoc", () => {
      const code = `/**\n * Fetches data from the API.\n * @param url - The endpoint URL\n * @returns The response data\n */\nexport function fetchData(url: string): Promise<void> {\n  return fetch(url);\n}`;
      const result = parser.parseFile("/src/api.ts", code);
      const fn = result.entities.find((e) => e.name === "fetchData");

      expect(fn).toBeDefined();
      expect(fn!.metadata.hasDocComment).toBe(true);
    });

    it("should not set hasDocComment when no JSDoc is present", () => {
      const code = `export function noDoc(): void {}`;
      const result = parser.parseFile("/src/utils.ts", code);
      const fn = result.entities.find((e) => e.name === "noDoc");

      expect(fn).toBeDefined();
      expect(fn!.metadata.hasDocComment).toBeUndefined();
    });

    it("should set hasDocComment on exported classes with JSDoc", () => {
      const code = `/** Parser for markdown files */\nexport class MarkdownParser {\n  parse() {}\n}`;
      const result = parser.parseFile("/src/parsers/md.ts", code);
      const cls = result.entities.find((e) => e.name === "MarkdownParser");

      expect(cls).toBeDefined();
      expect(cls!.metadata.hasDocComment).toBe(true);
    });

    it("should set hasDocComment on exported interfaces with JSDoc", () => {
      const code = `/** Configuration options */\nexport interface Config {\n  name: string;\n}`;
      const result = parser.parseFile("/src/types.ts", code);
      const iface = result.entities.find((e) => e.name === "Config");

      expect(iface).toBeDefined();
      expect(iface!.metadata.hasDocComment).toBe(true);
    });

    it("should reset JSDoc between entities", () => {
      const code = `/** Documented */\nexport function documented(): void {}\n\nexport function undocumented(): void {}`;
      const result = parser.parseFile("/src/utils.ts", code);
      const documented = result.entities.find((e) => e.name === "documented");
      const undocumented = result.entities.find(
        (e) => e.name === "undocumented",
      );

      expect(documented!.metadata.hasDocComment).toBe(true);
      expect(undocumented!.metadata.hasDocComment).toBeUndefined();
    });

    it("should not treat regular block comments as JSDoc", () => {
      const code = `/* This is a regular comment */\nexport function helper(): void {}`;
      const result = parser.parseFile("/src/utils.ts", code);
      const fn = result.entities.find((e) => e.name === "helper");

      expect(fn).toBeDefined();
      expect(fn!.metadata.hasDocComment).toBeUndefined();
    });
  });

  describe("@scenario annotation extraction", () => {
    it("should extract @scenario annotation from a describe block", () => {
      const code = `// @scenario: identity_management.feature:User creates a new identity
describe("Identity creation", () => {
  it("creates identity", () => {
    expect(true).toBe(true);
  });
});`;
      const result = parser.parseFile("/tests/identity.test.ts", code);
      const suite = result.entities.find((e) => e.entityType === "test_suite");
      expect(suite).toBeDefined();

      const annotations = suite!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toBeDefined();
      expect(annotations).toHaveLength(1);
      expect(annotations[0].feature).toBe("identity_management.feature");
      expect(annotations[0].scenario).toBe("User creates a new identity");
    });

    it("should extract @scenario annotation from an it block", () => {
      const code = `  // @scenario: contact_exchange.feature:Successful QR code exchange
  it("exchanges contact via QR", () => {
    expect(true).toBe(true);
  });`;
      const result = parser.parseFile("/tests/exchange.test.ts", code);
      const test = result.entities.find((e) => e.entityType === "test_fn");
      expect(test).toBeDefined();

      const annotations = test!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toHaveLength(1);
      expect(annotations[0].feature).toBe("contact_exchange.feature");
      expect(annotations[0].scenario).toBe("Successful QR code exchange");
    });

    it("should extract multiple @scenario annotations from a test", () => {
      const code = `  // @scenario: contact_exchange.feature:QR exchange
  // @scenario: identity_management.feature:Identity verification
  it("does both things", () => {
    expect(true).toBe(true);
  });`;
      const result = parser.parseFile("/tests/multi.test.ts", code);
      const test = result.entities.find((e) => e.entityType === "test_fn");
      expect(test).toBeDefined();

      const annotations = test!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toHaveLength(2);
      expect(annotations[0].scenario).toBe("QR exchange");
      expect(annotations[1].scenario).toBe("Identity verification");
    });

    it("should not add scenarioAnnotations when none are present", () => {
      const code = `  it("has no annotations", () => {
    expect(true).toBe(true);
  });`;
      const result = parser.parseFile("/tests/plain.test.ts", code);
      const test = result.entities.find((e) => e.entityType === "test_fn");
      expect(test).toBeDefined();
      expect(test!.metadata.scenarioAnnotations).toBeUndefined();
    });

    it("should produce annotation reference hints for @scenario lines", () => {
      const code = `// @scenario: identity_management.feature:User creates identity
describe("Identity", () => {});`;
      const result = parser.parseFile("/tests/identity.test.ts", code);

      const annotationRefs = result.references.filter(
        (r) => r.type === "annotation",
      );
      expect(annotationRefs).toHaveLength(1);
      expect(annotationRefs[0].target).toBe(
        "identity_management.feature:User creates identity",
      );
      expect(annotationRefs[0].line).toBe(1);
    });

    it("should reset annotations between test constructs", () => {
      const code = `  // @scenario: identity_management.feature:Create identity
  it("creates identity", () => {
    expect(true).toBe(true);
  });

  it("no annotation here", () => {
    expect(true).toBe(true);
  });`;
      const result = parser.parseFile("/tests/reset.test.ts", code);
      const withAnnotation = result.entities.find(
        (e) => e.name === "creates identity",
      );
      const withoutAnnotation = result.entities.find(
        (e) => e.name === "no annotation here",
      );

      expect(withAnnotation!.metadata.scenarioAnnotations).toBeDefined();
      expect(withoutAnnotation!.metadata.scenarioAnnotations).toBeUndefined();
    });

    it("should parse double-colon separator in @scenario annotations", () => {
      const code = `// @scenario: anonymous_sender :: Sender ID derived from shared key
describe("AnonymousSender", () => {});`;
      const result = parser.parseFile("/tests/anon.test.ts", code);
      const fn = result.entities.find(
        (e) => e.name === "AnonymousSender",
      );
      expect(fn).toBeDefined();

      const annotations = fn!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toHaveLength(1);
      expect(annotations[0].feature).toBe("anonymous_sender");
      expect(annotations[0].scenario).toBe(
        "Sender ID derived from shared key",
      );
    });
  });
});
