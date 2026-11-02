/**
 * Embedding providers for semantic matching
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { EntityRow } from "./db/database.js";

/**
 * Abstraction for embedding text into vectors.
 * Implementations must degrade gracefully — return null on failure.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[] | null>;
  isAvailable(): Promise<boolean>;
}

/**
 * Embedding provider backed by a local Ollama instance.
 *
 * - Caches embeddings in memory (keyed by input text)
 * - Caches availability check result
 * - Returns null on any error (graceful degradation)
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly cache = new Map<string, number[]>();
  private available: boolean | null = null;

  constructor(
    model = "qwen3-embedding:0.6B",
    baseUrl = "http://localhost:11434",
    fetchFn?: typeof fetch,
  ) {
    this.model = model;
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    try {
      await this.fetchFn(`${this.baseUrl}/api/tags`, {
        method: "HEAD",
        signal: AbortSignal.timeout(2000),
      });
      this.available = true;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  async embed(text: string): Promise<number[] | null> {
    const cached = this.cache.get(text);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return null;

      const data = (await response.json()) as { embeddings?: number[][] };
      const embedding = data.embeddings?.[0];
      if (!embedding || embedding.length === 0) return null;

      this.cache.set(text, embedding);
      return embedding;
    } catch {
      this.available = false;
      return null;
    }
  }
}

/**
 * Cosine similarity between two vectors.
 * Returns 0.0 if either vector has zero magnitude (avoids NaN).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0.0;
  }

  return dot / denom;
}

/**
 * Build a single text string from an entity for embedding.
 * Combines name, signature (if present), and first 3 doc comment lines.
 */
export function buildEntityText(entity: EntityRow): string {
  const parts: string[] = [entity.name];

  if (entity.signature) {
    parts.push(entity.signature);
  }

  let metadata: Record<string, unknown> = {};
  try {
    if (entity.metadata) {
      metadata = JSON.parse(entity.metadata) as Record<string, unknown>;
    }
  } catch {
    // metadata is not valid JSON — skip
  }

  const docLines = metadata.docCommentLines;
  if (Array.isArray(docLines) && docLines.length > 0) {
    const first3 = docLines.slice(0, 3).join(" ");
    parts.push(first3);
  }

  return parts.join(" | ");
}
