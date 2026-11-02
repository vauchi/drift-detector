// SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
//
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Integration tests for Ollama embedding provider
 * Requires Ollama running with qwen3-embedding:0.6B
 *
 * Run with: OLLAMA_INTEGRATION=1 npx vitest run tests/embeddings-integration.test.ts
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import {
  OllamaEmbeddingProvider,
  cosineSimilarity,
} from "../src/embeddings.js";

const ollamaRunning = !!process.env.OLLAMA_INTEGRATION;

describe.skipIf(!ollamaRunning)("OllamaEmbeddingProvider integration", () => {
  it("embeds text and returns a vector", async () => {
    const provider = new OllamaEmbeddingProvider();
    const vector = await provider.embed(
      "pub fn shred_key(key: &SymmetricKey) -> Result<()>",
    );

    expect(vector).not.toBeNull();
    expect(Array.isArray(vector)).toBe(true);
    expect(vector!.length).toBeGreaterThan(100);
  });

  it("similar code concepts have high cosine similarity", async () => {
    const provider = new OllamaEmbeddingProvider();

    const [vecA, vecB, vecC] = await Promise.all([
      provider.embed("emergency data destruction shred crypto key"),
      provider.embed("pub fn shred_all_data(key: &SymmetricKey) -> Result<()>"),
      provider.embed("pub fn render_theme_preview(colors: &ThemeColors)"),
    ]);

    expect(vecA).not.toBeNull();
    expect(vecB).not.toBeNull();
    expect(vecC).not.toBeNull();

    const simAB = cosineSimilarity(vecA!, vecB!);
    const simAC = cosineSimilarity(vecA!, vecC!);

    expect(simAB).toBeGreaterThan(simAC);
    expect(simAB).toBeGreaterThan(0.5);
  });

  it("Gherkin scenario matches related source code", async () => {
    const provider = new OllamaEmbeddingProvider();

    const [vecScenario, vecSource, vecUnrelated] = await Promise.all([
      provider.embed("User emergency shreds all contact data within 5 seconds"),
      provider.embed(
        "pub fn emergency_shred(storage: &Storage, key: &MasterKey) -> Result<ShredReport>",
      ),
      provider.embed("pub fn list_themes() -> Vec<Theme>"),
    ]);

    expect(vecScenario).not.toBeNull();
    expect(vecSource).not.toBeNull();
    expect(vecUnrelated).not.toBeNull();

    const simScenarioSource = cosineSimilarity(vecScenario!, vecSource!);
    const simScenarioUnrelated = cosineSimilarity(vecScenario!, vecUnrelated!);

    expect(simScenarioSource).toBeGreaterThan(simScenarioUnrelated);
  });
});
