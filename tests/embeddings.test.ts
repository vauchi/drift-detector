/**
 * Tests for embedding providers and utilities
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  OllamaEmbeddingProvider,
  buildEntityText,
} from "../src/embeddings.js";
import type { EntityRow } from "../src/db/database.js";

function makeEntity(overrides: Partial<EntityRow> = {}): EntityRow {
  return {
    id: 1,
    file_id: 1,
    entity_type: "function",
    name: "create_identity",
    qualified_name: null,
    layer: "source",
    start_line: 1,
    end_line: 10,
    visibility: "public",
    signature: "pub fn create_identity(name: &str) -> Identity",
    metadata: JSON.stringify({
      docCommentLines: [
        "Creates a new identity from a display name.",
        "Generates keypair and stores in vault.",
        "Returns the newly created identity.",
        "This line should be excluded.",
      ],
      tags: ["identity"],
    }),
    ...overrides,
  };
}

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
  });

  it("returns value between 0.9 and 1.0 for similar vectors", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3.1];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9);
    expect(sim).toBeLessThan(1.0);
  });

  it("returns 0.0 for zero vector without divide-by-zero", () => {
    const zero = [0, 0, 0];
    const v = [1, 2, 3];
    expect(cosineSimilarity(zero, v)).toBe(0.0);
    expect(cosineSimilarity(v, zero)).toBe(0.0);
    expect(cosineSimilarity(zero, zero)).toBe(0.0);
  });
});

describe("OllamaEmbeddingProvider", () => {
  function mockFetchReject(): typeof fetch {
    return async () => {
      throw new TypeError("fetch failed");
    };
  }

  it("caches repeated embed calls — one fetch for two calls, same reference", async () => {
    let fetchCount = 0;
    const embedding = [0.1, 0.2, 0.3];
    const fakeFetch: typeof fetch = async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ) => {
      fetchCount++;
      return new Response(JSON.stringify({ embeddings: [embedding] }), {
        status: 200,
      });
    };

    const provider = new OllamaEmbeddingProvider(
      "test-model",
      "http://localhost:11434",
      fakeFetch,
    );

    const result1 = await provider.embed("hello world");
    const result2 = await provider.embed("hello world");

    expect(fetchCount).toBe(1);
    expect(result1).toBe(result2); // same reference
    expect(result1).toEqual([0.1, 0.2, 0.3]);
  });

  it("returns null when Ollama is unavailable (fetch rejects)", async () => {
    const provider = new OllamaEmbeddingProvider(
      "test-model",
      "http://localhost:11434",
      mockFetchReject(),
    );

    const result = await provider.embed("hello");
    expect(result).toBeNull();
  });

  it("isAvailable returns false on connection error and caches result", async () => {
    let fetchCount = 0;
    const fakeFetch: typeof fetch = async () => {
      fetchCount++;
      throw new TypeError("fetch failed");
    };

    const provider = new OllamaEmbeddingProvider(
      "test-model",
      "http://localhost:11434",
      fakeFetch,
    );

    const available1 = await provider.isAvailable();
    const available2 = await provider.isAvailable();

    expect(available1).toBe(false);
    expect(available2).toBe(false);
    expect(fetchCount).toBe(1); // cached after first call
  });

  it("isAvailable returns true when server responds", async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response("", { status: 200 });
    };

    const provider = new OllamaEmbeddingProvider(
      "test-model",
      "http://localhost:11434",
      fakeFetch,
    );

    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it("sets available to false on embed connection error", async () => {
    const provider = new OllamaEmbeddingProvider(
      "test-model",
      "http://localhost:11434",
      mockFetchReject(),
    );

    await provider.embed("test");
    const available = await provider.isAvailable();

    expect(available).toBe(false);
  });

  it("embed sends correct request body", async () => {
    let capturedBody: string | undefined;
    const fakeFetch: typeof fetch = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ embeddings: [[0.1]] }), {
        status: 200,
      });
    };

    const provider = new OllamaEmbeddingProvider(
      "qwen3-embedding:0.6B",
      "http://localhost:11434",
      fakeFetch,
    );

    await provider.embed("test input");
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({
      model: "qwen3-embedding:0.6B",
      input: "test input",
    });
  });
});

describe("buildEntityText", () => {
  it("combines name, signature, and first 3 doc comment lines", () => {
    const entity = makeEntity();
    const text = buildEntityText(entity);
    expect(text).toBe(
      "create_identity | pub fn create_identity(name: &str) -> Identity | " +
        "Creates a new identity from a display name. " +
        "Generates keypair and stores in vault. " +
        "Returns the newly created identity.",
    );
  });

  it("handles missing signature gracefully", () => {
    const entity = makeEntity({ signature: null });
    const text = buildEntityText(entity);
    expect(text).toBe(
      "create_identity | Creates a new identity from a display name. " +
        "Generates keypair and stores in vault. " +
        "Returns the newly created identity.",
    );
  });

  it("handles missing metadata gracefully", () => {
    const entity = makeEntity({ metadata: "{}" });
    const text = buildEntityText(entity);
    expect(text).toBe(
      "create_identity | pub fn create_identity(name: &str) -> Identity",
    );
  });

  it("handles empty metadata string", () => {
    const entity = makeEntity({ metadata: "" });
    const text = buildEntityText(entity);
    expect(text).toBe(
      "create_identity | pub fn create_identity(name: &str) -> Identity",
    );
  });

  it("returns only name when no signature or doc comments", () => {
    const entity = makeEntity({ signature: null, metadata: "{}" });
    const text = buildEntityText(entity);
    expect(text).toBe("create_identity");
  });
});
