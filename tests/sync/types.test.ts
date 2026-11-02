/**
 * Tests for plan-sync type definitions and trailer parsers
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  parsePlanTaskTrailer,
  parseProblemTrailer,
} from "../../src/sync/types.js";

/* ── Arbitraries ── */

/** Generates a valid slug: lowercase alphanumeric, optionally with hyphens, never starts/ends with hyphen */
const slugArb = fc.stringMatching(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
  size: "small",
});

/** Generates a valid Plan-Task trailer string like "slug#N" or "slug" */
const planTaskTrailerArb = fc
  .tuple(
    slugArb,
    fc.option(fc.integer({ min: 0, max: 9999 }), {
      nil: undefined as undefined,
    }),
  )
  .map(([slug, num]) => (num !== undefined ? `${slug}#${num}` : slug));

describe("parsePlanTaskTrailer", () => {
  it("should parse a valid Plan-Task trailer", () => {
    const result = parsePlanTaskTrailer("sp24-desktop-exchange#4");
    expect(result).toEqual({ slug: "sp24-desktop-exchange", taskNumber: 4 });
  });

  it("should parse trailer with only slug (no task number)", () => {
    const result = parsePlanTaskTrailer("sp24-desktop-exchange");
    expect(result).toEqual({
      slug: "sp24-desktop-exchange",
      taskNumber: undefined,
    });
  });

  it("should return null for empty string", () => {
    expect(parsePlanTaskTrailer("")).toBeNull();
  });

  it("should return null for malformed input", () => {
    expect(parsePlanTaskTrailer("#4")).toBeNull();
    expect(parsePlanTaskTrailer("##")).toBeNull();
  });

  it("should handle slug with multiple hyphens", () => {
    const result = parsePlanTaskTrailer("unified-transport-layer#12");
    expect(result).toEqual({ slug: "unified-transport-layer", taskNumber: 12 });
  });

  /* ── Property-based tests (CC-04) ── */

  it("never throws on arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = parsePlanTaskTrailer(input);
        expect(result === null || typeof result.slug === "string").toBe(true);
      }),
    );
  });

  it("returns non-null with correct slug for any valid slug", () => {
    fc.assert(
      fc.property(slugArb, (slug) => {
        const result = parsePlanTaskTrailer(slug);
        expect(result).not.toBeNull();
        expect(result!.slug).toBe(slug);
      }),
    );
  });

  it("roundtrip: parsed slug and taskNumber reconstruct the original trailer", () => {
    fc.assert(
      fc.property(planTaskTrailerArb, (trailer) => {
        const result = parsePlanTaskTrailer(trailer);
        expect(result).not.toBeNull();
        const reconstructed =
          result!.taskNumber !== undefined
            ? `${result!.slug}#${result!.taskNumber}`
            : result!.slug;
        expect(reconstructed).toBe(trailer);
      }),
    );
  });
});

describe("parseProblemTrailer", () => {
  it("returns ProblemRef for a valid slug", () => {
    const result = parseProblemTrailer("sp24-desktop-exchange");
    expect(result).toEqual({ slug: "sp24-desktop-exchange" });
  });

  it("returns ProblemRef for single-char slug", () => {
    const result = parseProblemTrailer("a");
    expect(result).toEqual({ slug: "a" });
  });

  it("returns null for empty string", () => {
    expect(parseProblemTrailer("")).toBeNull();
  });

  it("returns null for input starting with #", () => {
    expect(parseProblemTrailer("#something")).toBeNull();
  });

  it("returns null for input with spaces", () => {
    expect(parseProblemTrailer("has spaces")).toBeNull();
  });

  it("returns null for input with uppercase letters", () => {
    expect(parseProblemTrailer("HasUpperCase")).toBeNull();
  });

  it("returns null for slug ending with hyphen", () => {
    expect(parseProblemTrailer("bad-slug-")).toBeNull();
  });

  /* ── Property-based tests (CC-04) ── */

  it("never throws on arbitrary string input", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = parseProblemTrailer(input);
        expect(result === null || typeof result.slug === "string").toBe(true);
      }),
    );
  });

  it("returns non-null with correct slug for any valid slug", () => {
    fc.assert(
      fc.property(slugArb, (slug) => {
        const result = parseProblemTrailer(slug);
        expect(result).not.toBeNull();
        expect(result!.slug).toBe(slug);
      }),
    );
  });
});
