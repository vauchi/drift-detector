/**
 * Tests for matching module
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import {
  normalizeName,
  parseTags,
  matchByTags,
  matchByName,
  matchByPathStem,
  bestMatch,
} from "../src/matching.js";
import type { EntityRow } from "../src/db/database.js";

function makeEntity(overrides: Partial<EntityRow> = {}): EntityRow {
  return {
    id: 1,
    file_id: 1,
    entity_type: "function",
    name: "test_entity",
    qualified_name: null,
    layer: "source",
    start_line: 1,
    end_line: 10,
    visibility: null,
    signature: null,
    metadata: JSON.stringify({ tags: [] }),
    ...overrides,
  };
}

describe("matching", () => {
  describe("normalizeName", () => {
    it("should strip test prefixes", () => {
      expect(normalizeName("test_user_login")).toEqual(["login", "user"]);
      expect(normalizeName("should_authenticate")).toEqual(["authenticate"]);
    });

    it("should split camelCase", () => {
      expect(normalizeName("userLoginFlow")).toEqual(["flow", "login", "user"]);
    });

    it("should remove stop words and short tokens", () => {
      expect(normalizeName("the_user_is_in")).toEqual(["user"]);
    });

    it("should sort tokens alphabetically", () => {
      expect(normalizeName("zebra_alpha_middle")).toEqual([
        "alpha",
        "middle",
        "zebra",
      ]);
    });

    it("should handle mixed separators", () => {
      expect(normalizeName("user-login_flow test")).toEqual([
        "flow",
        "login",
        "test",
        "user",
      ]);
    });
  });

  describe("parseTags", () => {
    it("should parse tags from metadata JSON", () => {
      const entity = makeEntity({
        metadata: JSON.stringify({ tags: ["auth", "security"] }),
      });
      expect(parseTags(entity)).toEqual(["auth", "security"]);
    });

    it("should return empty array for missing tags", () => {
      const entity = makeEntity({ metadata: "{}" });
      expect(parseTags(entity)).toEqual([]);
    });

    it("should return empty array for invalid JSON", () => {
      const entity = makeEntity({ metadata: "not json" });
      expect(parseTags(entity)).toEqual([]);
    });
  });

  describe("matchByTags", () => {
    it("should match entities with shared tags", () => {
      const a = makeEntity({
        metadata: JSON.stringify({ tags: ["auth", "security"] }),
      });
      const b = makeEntity({
        metadata: JSON.stringify({ tags: ["auth", "crypto"] }),
      });

      const result = matchByTags(a, b);
      expect(result).not.toBeNull();
      expect(result!.method).toBe("exact_tag");
      expect(result!.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it("should return null for no shared tags", () => {
      const a = makeEntity({
        metadata: JSON.stringify({ tags: ["auth"] }),
      });
      const b = makeEntity({
        metadata: JSON.stringify({ tags: ["crypto"] }),
      });

      expect(matchByTags(a, b)).toBeNull();
    });

    it("should return null when either entity has no tags", () => {
      const a = makeEntity({ metadata: JSON.stringify({ tags: [] }) });
      const b = makeEntity({
        metadata: JSON.stringify({ tags: ["auth"] }),
      });

      expect(matchByTags(a, b)).toBeNull();
    });

    it("should have higher confidence for more overlap", () => {
      const a = makeEntity({
        metadata: JSON.stringify({ tags: ["auth", "security"] }),
      });
      const bPartial = makeEntity({
        metadata: JSON.stringify({ tags: ["auth", "crypto"] }),
      });
      const bFull = makeEntity({
        metadata: JSON.stringify({ tags: ["auth", "security"] }),
      });

      const partial = matchByTags(a, bPartial)!;
      const full = matchByTags(a, bFull)!;

      expect(full.confidence).toBeGreaterThan(partial.confidence);
    });
  });

  describe("matchByName", () => {
    it("should match similar names with name_convention method", () => {
      const result = matchByName(
        "user_authentication",
        "test_user_authentication",
      );
      expect(result).not.toBeNull();
      expect(result!.method).toBe("name_convention");
    });

    it("should match fuzzy similar names", () => {
      const result = matchByName("user_login_flow", "login_user_process");
      expect(result).not.toBeNull();
    });

    it("should return null for completely different names", () => {
      const result = matchByName("zebra_handler", "quantum_parser");
      expect(result).toBeNull();
    });

    it("should return null for empty/short names", () => {
      expect(matchByName("a", "b")).toBeNull();
    });

    it("should match via containment when test name contains all source tokens", () => {
      // Integration test pattern: test name contains source function name
      const result = matchByName(
        "test_get_recovery_readiness_returns_not_ready_below_threshold",
        "get_recovery_readiness",
      );
      expect(result).not.toBeNull();
      expect(result!.method).toBe("containment");
      expect(result!.confidence).toBeGreaterThanOrEqual(0.6);
      expect(result!.confidence).toBeLessThanOrEqual(0.75);
    });

    it("should match via containment in either direction", () => {
      // Source name is shorter
      const result = matchByName(
        "create_contact_card",
        "test_create_contact_card_validates_fields_and_returns_error",
      );
      expect(result).not.toBeNull();
      expect(result!.method).toBe("containment");
    });

    it("should not match via containment with single-token source name", () => {
      // Single token is too generic for containment
      const result = matchByName(
        "encrypt",
        "test_encrypt_data_with_wrong_key_returns_error",
      );
      // Should not match via containment (only 1 token in shorter)
      // May still match via other methods
      if (result && result.method === "containment") {
        expect.fail("Should not match via containment with single token");
      }
    });
  });

  describe("matchByPathStem", () => {
    it("should match similar file stems", () => {
      const result = matchByPathStem(
        "/src/auth/login.rs",
        "/tests/auth/login.test.rs",
      );
      expect(result).not.toBeNull();
      expect(result!.method).toBe("path_stem");
      expect(result!.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it("should match stems with test suffix stripped", () => {
      const result = matchByPathStem(
        "/src/exchange.rs",
        "/tests/exchange_test.rs",
      );
      expect(result).not.toBeNull();
    });

    it("should return null for different stems", () => {
      const result = matchByPathStem("/src/auth.rs", "/src/relay.rs");
      expect(result).toBeNull();
    });
  });

  describe("bestMatch", () => {
    it("should prefer tag match over name match", () => {
      const a = makeEntity({
        name: "user_auth",
        metadata: JSON.stringify({ tags: ["auth"] }),
      });
      const b = makeEntity({
        name: "user_auth",
        metadata: JSON.stringify({ tags: ["auth"] }),
      });

      const result = bestMatch(a, b);
      expect(result).not.toBeNull();
      expect(result!.method).toBe("exact_tag");
    });

    it("should fall back to name match when no tags", () => {
      const a = makeEntity({
        name: "user_authentication",
        metadata: JSON.stringify({ tags: [] }),
      });
      const b = makeEntity({
        name: "test_user_authentication",
        metadata: JSON.stringify({ tags: [] }),
      });

      const result = bestMatch(a, b);
      expect(result).not.toBeNull();
      expect(["name_convention", "fuzzy"]).toContain(result!.method);
    });

    it("should fall back to path stem when no name match", () => {
      const a = makeEntity({
        name: "foo",
        metadata: JSON.stringify({ tags: [] }),
      });
      const b = makeEntity({
        name: "bar",
        metadata: JSON.stringify({ tags: [] }),
      });

      const result = bestMatch(a, b, "/src/auth.rs", "/tests/auth_test.rs");
      expect(result).not.toBeNull();
      expect(result!.method).toBe("path_stem");
    });

    it("should return null when nothing matches", () => {
      const a = makeEntity({
        name: "xyzzy",
        metadata: JSON.stringify({ tags: [] }),
      });
      const b = makeEntity({
        name: "plugh",
        metadata: JSON.stringify({ tags: [] }),
      });

      expect(bestMatch(a, b, "/src/foo.rs", "/tests/bar.rs")).toBeNull();
    });
  });
});
