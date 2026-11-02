/**
 * Tests for configuration loading
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  DEFAULT_CONFIG,
  compileConfig,
  CONFIG_FILENAME,
} from "../src/config.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-config-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("loadConfig", () => {
    it("should return DEFAULT_CONFIG when no file exists", () => {
      const config = loadConfig(tempDir);
      expect(config.indexing).toEqual(DEFAULT_CONFIG.indexing);
      expect(config.concepts).toEqual(DEFAULT_CONFIG.concepts);
      expect(config.layers).toEqual(DEFAULT_CONFIG.layers);
    });

    it("should parse valid TOML file", () => {
      const toml = `
[indexing]
ignore = ["**/vendor/**"]

[concepts.aliases]
auth = "security"
qr = ["exchange", "qr"]

[[tags.heading_keywords]]
keyword = "security"
tag = "security"

[tags.path.rust]
"/crypto/" = "crypto"

[[tags.name_patterns.rust]]
pattern = "contact.?card"
tag = "contact-card"

[layers.markdown]
dev_doc_filenames = ["ARCHITECTURE.md"]
dev_doc_paths = ["_private/"]
user_doc_paths = ["/docs/"]
user_doc_filenames = ["README.md"]

[layers.gherkin]
problem_paths = ["_private/features/"]
`;
      fs.writeFileSync(path.join(tempDir, CONFIG_FILENAME), toml);
      const config = loadConfig(tempDir);

      expect(config.indexing.ignore).toEqual(["**/vendor/**"]);
      expect(config.concepts.aliases.auth).toBe("security");
      expect(config.concepts.aliases.qr).toEqual(["exchange", "qr"]);
      expect(config.tags.headingKeywords).toEqual([
        { keyword: "security", tag: "security" },
      ]);
      expect(config.tags.path.rust).toEqual({ "/crypto/": "crypto" });
      expect(config.tags.namePatterns.rust).toEqual([
        { pattern: "contact.?card", tag: "contact-card" },
      ]);
      expect(config.layers.markdown.devDocFilenames).toEqual([
        "ARCHITECTURE.md",
      ]);
      expect(config.layers.gherkin.problemPaths).toEqual([
        "_private/features/",
      ]);
    });

    it("should parse workspace.repos section", () => {
      const toml = `
[workspace]
repos = [
  { name = "core", path = "core/" },
  { name = "relay", path = "relay/" },
]
`;
      fs.writeFileSync(path.join(tempDir, CONFIG_FILENAME), toml);
      const config = loadConfig(tempDir);

      expect(config.workspace.repos).toHaveLength(2);
      expect(config.workspace.repos[0]).toEqual({
        name: "core",
        path: "core/",
      });
      expect(config.workspace.repos[1]).toEqual({
        name: "relay",
        path: "relay/",
      });
    });

    it("includes default embeddings config", () => {
      const config = loadConfig(tempDir);
      expect(config.embeddings).toBeDefined();
      expect(config.embeddings.model).toBe("qwen3-embedding:0.6B");
      expect(config.embeddings.enabled).toBe(true);
    });

    it("should default to empty repos when no workspace section", () => {
      const toml = `
[indexing]
ignore = ["**/test/**"]
`;
      fs.writeFileSync(path.join(tempDir, CONFIG_FILENAME), toml);
      const config = loadConfig(tempDir);

      expect(config.workspace.repos).toEqual([]);
    });

    it("should use defaults for missing sections", () => {
      const toml = `
[indexing]
ignore = ["**/test/**"]
`;
      fs.writeFileSync(path.join(tempDir, CONFIG_FILENAME), toml);
      const config = loadConfig(tempDir);

      expect(config.indexing.ignore).toEqual(["**/test/**"]);
      // Other sections should have defaults
      expect(config.concepts.aliases).toEqual({});
      expect(config.layers.markdown.devDocFilenames).toEqual(
        DEFAULT_CONFIG.layers.markdown.devDocFilenames,
      );
      expect(config.layers.markdown.userDocPaths).toEqual(
        DEFAULT_CONFIG.layers.markdown.userDocPaths,
      );
    });
  });

  describe("compileConfig", () => {
    it("should compile regex patterns from name_patterns", () => {
      const config = compileConfig({
        ...DEFAULT_CONFIG,
        tags: {
          ...DEFAULT_CONFIG.tags,
          namePatterns: {
            rust: [
              { pattern: "contact.?card", tag: "contact-card" },
              { pattern: "crypt|encrypt", tag: "crypto" },
            ],
          },
        },
      });

      expect(config._compiled.namePatterns.rust).toHaveLength(2);
      expect(config._compiled.namePatterns.rust[0].regex).toBeInstanceOf(
        RegExp,
      );
      expect(
        config._compiled.namePatterns.rust[0].regex.test("ContactCard"),
      ).toBe(true);
      expect(
        config._compiled.namePatterns.rust[0].regex.test("contact_card"),
      ).toBe(true);
      expect(
        config._compiled.namePatterns.rust[1].regex.test("encrypt_data"),
      ).toBe(true);
    });

    it("should handle empty name patterns", () => {
      const config = compileConfig(DEFAULT_CONFIG);
      expect(config._compiled.namePatterns).toEqual({});
    });
  });
});
