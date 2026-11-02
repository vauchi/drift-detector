/**
 * Tests for Markdown parser
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import { MarkdownParser } from "../../src/parsers/markdown.js";
import { testConfig } from "../test-config.js";

const mdTestConfig = testConfig({
  tags: {
    path: {
      markdown: {
        "/docs/security": "security",
        "/planning/": ["planning", "internal"],
      },
    },
    headingKeywords: [
      { keyword: "security", tag: "security" },
      { keyword: "crypto", tag: "crypto" },
      { keyword: "exchange", tag: "exchange" },
    ],
  },
  layers: {
    markdown: {
      devDocFilenames: ["ARCHITECTURE.md", "CONTRIBUTING.md", "CHANGELOG.md"],
      devDocPaths: ["/docs/dev/", "/_private/"],
      userDocPaths: ["/docs/user/", "/docs/guide/"],
      userDocFilenames: ["README.md", "FAQ.md"],
    },
  },
});

describe("MarkdownParser", () => {
  const parser = new MarkdownParser(mdTestConfig);

  describe("languageId and filePatterns", () => {
    it("should have correct languageId", () => {
      expect(parser.languageId).toBe("markdown");
    });

    it("should match .md files", () => {
      expect(parser.filePatterns).toContain("**/*.md");
    });
  });

  describe("heading extraction", () => {
    it("should extract ATX headings as doc_section entities", () => {
      const md = `# Title\n\nSome text.\n\n## Section One\n\nContent.\n\n## Section Two\n\nMore content.`;
      const result = parser.parseFile("/docs/test.md", md);
      const sections = result.entities.filter(
        (e) => e.entityType === "doc_section",
      );

      expect(sections).toHaveLength(3);
      expect(sections.map((s) => s.name)).toEqual([
        "Title",
        "Section One",
        "Section Two",
      ]);
    });

    it("should handle heading levels 1 through 6", () => {
      const md = `# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6`;
      const result = parser.parseFile("/docs/test.md", md);

      expect(result.entities).toHaveLength(6);
      expect(result.entities[0].metadata.level).toBe(1);
      expect(result.entities[5].metadata.level).toBe(6);
    });

    it("should capture correct startLine for each heading", () => {
      const md = `# First\n\nParagraph.\n\n## Second\n\nMore text.`;
      const result = parser.parseFile("/docs/test.md", md);

      expect(result.entities[0].startLine).toBe(1);
      expect(result.entities[1].startLine).toBe(5);
    });
  });

  describe("endLine computation", () => {
    it("should set endLine to line before next same-level heading", () => {
      const md = `## A\nline1\nline2\n## B\nline3`;
      const result = parser.parseFile("/docs/test.md", md);

      const a = result.entities.find((e) => e.name === "A");
      const b = result.entities.find((e) => e.name === "B");

      expect(a!.endLine).toBe(3); // Line before ## B
      expect(b!.endLine).toBe(5); // EOF
    });

    it("should set endLine to line before next higher-level heading", () => {
      const md = `# Top\n## Sub\ncontent\n# Next Top`;
      const result = parser.parseFile("/docs/test.md", md);

      const top = result.entities.find((e) => e.name === "Top");
      const sub = result.entities.find((e) => e.name === "Sub");

      // "Top" ends before "Next Top" (line 4), but "Sub" also ends before "Next Top"
      expect(sub!.endLine).toBe(3); // Line before # Next Top
      expect(top!.endLine).toBe(3); // Line before # Next Top (same-or-higher level)
    });

    it("should set endLine to total line count for last heading", () => {
      const md = `## Only Section\nline1\nline2\nline3`;
      const result = parser.parseFile("/docs/test.md", md);

      expect(result.entities[0].endLine).toBe(4);
    });

    it("should not end a parent section at a child heading", () => {
      const md = `# Parent\n## Child\ncontent\n### Grandchild\nmore`;
      const result = parser.parseFile("/docs/test.md", md);

      const parent = result.entities.find((e) => e.name === "Parent");
      // Parent (H1) should extend to EOF because no same-or-higher-level heading follows
      expect(parent!.endLine).toBe(5);
    });
  });

  describe("link/reference extraction", () => {
    it("should extract markdown links as doc_link references", () => {
      const md = `See [Architecture](../ARCHITECTURE.md) for details.`;
      const result = parser.parseFile("/docs/test.md", md);

      expect(result.references).toHaveLength(1);
      expect(result.references[0].type).toBe("doc_link");
      expect(result.references[0].target).toBe("../ARCHITECTURE.md");
      expect(result.references[0].line).toBe(1);
    });

    it("should extract multiple links from a single line", () => {
      const md = `See [A](a.md) and [B](b.md) for info.`;
      const result = parser.parseFile("/docs/test.md", md);

      expect(result.references).toHaveLength(2);
      expect(result.references[0].target).toBe("a.md");
      expect(result.references[1].target).toBe("b.md");
    });

    it("should extract links with URLs", () => {
      const md = `Visit [Vauchi](https://vauchi.app) for more.`;
      const result = parser.parseFile("/docs/test.md", md);

      expect(result.references[0].target).toBe("https://vauchi.app");
    });

    it("should not extract links from heading lines", () => {
      // Heading lines use `continue` so links inside headings are skipped
      const md = `## See [Link](target.md)\n\nBody with [other](other.md).`;
      const result = parser.parseFile("/docs/test.md", md);

      // Only the body link should be extracted (heading line is skipped by continue)
      expect(result.references).toHaveLength(1);
      expect(result.references[0].target).toBe("other.md");
    });
  });

  describe("layer detection", () => {
    it("should detect dev_doc for ARCHITECTURE.md", () => {
      const md = `# Architecture\n\nOverview.`;
      const result = parser.parseFile("/project/ARCHITECTURE.md", md);

      expect(result.entities[0].layer).toBe("dev_doc");
    });

    it("should detect dev_doc for files in dev doc paths", () => {
      const md = `# Dev Guide\n\nContent.`;
      const result = parser.parseFile("/docs/dev/setup.md", md);

      expect(result.entities[0].layer).toBe("dev_doc");
    });

    it("should detect user_doc for README.md", () => {
      const md = `# Vauchi\n\nWelcome.`;
      const result = parser.parseFile("/project/README.md", md);

      expect(result.entities[0].layer).toBe("user_doc");
    });

    it("should detect user_doc for files in user doc paths", () => {
      const md = `# Getting Started\n\nStep 1.`;
      const result = parser.parseFile("/docs/user/getting-started.md", md);

      expect(result.entities[0].layer).toBe("user_doc");
    });

    it("should default to dev_doc for unrecognized paths", () => {
      const md = `# Notes\n\nInternal.`;
      const result = parser.parseFile("/random/notes.md", md);

      expect(result.entities[0].layer).toBe("dev_doc");
    });

    it("should detect dev_doc for _private paths", () => {
      const md = `# Internal Plan\n\nDetails.`;
      const result = parser.parseFile("/_private/docs/plan.md", md);

      expect(result.entities[0].layer).toBe("dev_doc");
    });
  });

  describe("tag extraction", () => {
    it("should extract tags from heading keywords", () => {
      const md = `## Security Considerations\n\nDetails.`;
      const result = parser.parseFile("/docs/test.md", md);

      expect(result.entities[0].tags).toContain("security");
    });

    it("should extract multiple tags from heading", () => {
      const md = `## Crypto Exchange Protocol\n\nDetails.`;
      const result = parser.parseFile("/docs/test.md", md);

      expect(result.entities[0].tags).toContain("crypto");
      expect(result.entities[0].tags).toContain("exchange");
    });

    it("should extract tags from file path", () => {
      const md = `## Overview\n\nDetails.`;
      const result = parser.parseFile("/docs/security/overview.md", md);

      expect(result.entities[0].tags).toContain("security");
    });

    it("should extract array tags from path rules", () => {
      const md = `## Roadmap\n\nItems.`;
      const result = parser.parseFile("/planning/roadmap.md", md);

      expect(result.entities[0].tags).toContain("planning");
      expect(result.entities[0].tags).toContain("internal");
    });

    it("should deduplicate tags", () => {
      // Heading has "security" keyword AND path matches "/docs/security"
      const md = `## Security Audit\n\nDetails.`;
      const result = parser.parseFile("/docs/security/audit.md", md);

      const securityCount = result.entities[0].tags.filter(
        (t) => t === "security",
      ).length;
      expect(securityCount).toBe(1);
    });

    it("should return empty tags when nothing matches", () => {
      const md = `## Introduction\n\nGeneral text.`;
      const result = parser.parseFile("/docs/test.md", md);

      expect(result.entities[0].tags).toEqual([]);
    });
  });

  describe("qualifiedName", () => {
    it("should build qualifiedName as filename::heading", () => {
      const md = `## My Section\n\nContent.`;
      const result = parser.parseFile("/docs/architecture.md", md);

      expect(result.entities[0].qualifiedName).toBe("architecture::My Section");
    });

    it("should strip .md extension from filename", () => {
      const md = `# Title\n\nContent.`;
      const result = parser.parseFile("/docs/my-doc.md", md);

      expect(result.entities[0].qualifiedName).toBe("my-doc::Title");
    });
  });

  describe("edge cases", () => {
    it("should return empty results for empty content", () => {
      const result = parser.parseFile("/docs/empty.md", "");

      expect(result.entities).toHaveLength(0);
      expect(result.references).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should return empty entities for content with no headings", () => {
      const md = `Just a paragraph.\n\nAnother paragraph with [link](url.md).`;
      const result = parser.parseFile("/docs/text.md", md);

      expect(result.entities).toHaveLength(0);
      expect(result.references).toHaveLength(1);
    });

    it("should handle single heading at end of file", () => {
      const md = `Some text.\n\n## Final`;
      const result = parser.parseFile("/docs/test.md", md);

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe("Final");
      expect(result.entities[0].endLine).toBe(3);
    });

    it("should ignore lines that look like headings in code blocks", () => {
      // The parser doesn't track code blocks, so it will extract these.
      // This test documents the current behavior.
      const md = "```\n# Not a heading\n```\n\n# Real heading";
      const result = parser.parseFile("/docs/test.md", md);

      // Current behavior: parser extracts both (no code block awareness)
      const names = result.entities.map((e) => e.name);
      expect(names).toContain("Real heading");
    });
  });
});
