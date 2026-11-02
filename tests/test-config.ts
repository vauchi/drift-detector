/**
 * Test configuration helpers
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  DEFAULT_CONFIG,
  compileConfig,
  type DriftConfig,
  type CompiledConfig,
} from "../src/config.js";

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: DeepPartial<T>,
): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    if (sourceVal !== undefined) {
      if (
        typeof sourceVal === "object" &&
        sourceVal !== null &&
        !Array.isArray(sourceVal) &&
        typeof result[key] === "object" &&
        result[key] !== null &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(
          result[key] as Record<string, unknown>,
          sourceVal as Record<string, unknown>,
        ) as T[keyof T];
      } else {
        result[key] = sourceVal as T[keyof T];
      }
    }
  }
  return result;
}

/**
 * Create a CompiledConfig for testing, optionally overriding specific values.
 */
export function testConfig(
  overrides?: DeepPartial<DriftConfig>,
): CompiledConfig {
  if (!overrides) return compileConfig(DEFAULT_CONFIG);
  const merged = deepMerge(
    DEFAULT_CONFIG as Record<string, unknown>,
    overrides as Record<string, unknown>,
  ) as DriftConfig;
  return compileConfig(merged);
}
