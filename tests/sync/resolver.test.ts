/**
 * Tests for plan file and problem directory slug resolution
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePlanFile, resolveProblemDir } from "../../src/sync/resolver.js";

let tempRoot: string;

async function makeTempRoot(): Promise<string> {
  const dir = join(
    tmpdir(),
    `resolver-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createFile(
  base: string,
  relPath: string,
  content = "",
): Promise<void> {
  const full = join(base, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

async function createDir(base: string, relPath: string): Promise<void> {
  await mkdir(join(base, relPath), { recursive: true });
}

beforeEach(async () => {
  tempRoot = await makeTempRoot();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("resolvePlanFile", () => {
  it("should resolve slug to plan file by substring match in planning/todo/", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-02-26-sp24-desktop-phone-exchange.plan.md",
      "# Plan",
    );

    const result = await resolvePlanFile(tempRoot, "sp24-desktop-exchange");
    expect(result).toBe(
      join(
        tempRoot,
        "_private/docs/planning/todo/2026-02-26-sp24-desktop-phone-exchange.plan.md",
      ),
    );
  });

  it("should resolve slug to plan file in planning/todo/ directory", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-03-01-unified-transport.plan.md",
      "# Plan",
    );

    const result = await resolvePlanFile(tempRoot, "unified-transport");
    expect(result).toBe(
      join(
        tempRoot,
        "_private/docs/planning/todo/2026-03-01-unified-transport.plan.md",
      ),
    );
  });

  it("should return null for unmatched slug", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-02-26-some-plan.plan.md",
      "# Plan",
    );

    const result = await resolvePlanFile(tempRoot, "nonexistent-slug");
    expect(result).toBeNull();
  });

  // CC-11: failure-path tests
  it("should return null when plans directories do not exist", async () => {
    const result = await resolvePlanFile(tempRoot, "any-slug");
    expect(result).toBeNull();
  });

  it("should return null for empty slug", async () => {
    const result = await resolvePlanFile(tempRoot, "");
    expect(result).toBeNull();
  });

  it("should match after stripping YYYY-MM-DD- date prefix from filenames", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-15-my-feature.plan.md",
      "# Plan",
    );

    // Slug matches the portion after the date prefix
    const result = await resolvePlanFile(tempRoot, "my-feature");
    expect(result).toBe(
      join(
        tempRoot,
        "_private/docs/planning/todo/2026-01-15-my-feature.plan.md",
      ),
    );
  });

  it("should return null when multiple subsequence matches are ambiguous", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-sp24-desktop-phone-exchange.plan.md",
      "# Plan",
    );
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-02-sp24-desktop-tablet-exchange.plan.md",
      "# Plan",
    );

    // "sp24-desktop-exchange" is a subsequence match for both files — ambiguous
    const result = await resolvePlanFile(tempRoot, "sp24-desktop-exchange");
    expect(result).toBeNull();
  });

  it("should prefer exact match over substring match", async () => {
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      "# Plan",
    );
    await createFile(
      tempRoot,
      "_private/docs/planning/todo/2026-01-02-my-feature-extended.plan.md",
      "# Plan",
    );

    const result = await resolvePlanFile(tempRoot, "my-feature");
    expect(result).toBe(
      join(
        tempRoot,
        "_private/docs/planning/todo/2026-01-01-my-feature.plan.md",
      ),
    );
  });
});

describe("resolveProblemDir", () => {
  it("should resolve slug to problem directory by substring match", async () => {
    await createDir(
      tempRoot,
      "_private/docs/problems/2026-03-01-design-token-system",
    );

    const result = await resolveProblemDir(tempRoot, "design-token-system");
    expect(result).toBe(
      join(tempRoot, "_private/docs/problems/2026-03-01-design-token-system"),
    );
  });

  it("should return null for unmatched slug", async () => {
    await createDir(
      tempRoot,
      "_private/docs/problems/2026-03-01-design-token-system",
    );

    const result = await resolveProblemDir(tempRoot, "nonexistent-slug");
    expect(result).toBeNull();
  });

  // CC-11: failure-path tests
  it("should return null when problems directory does not exist", async () => {
    const result = await resolveProblemDir(tempRoot, "any-slug");
    expect(result).toBeNull();
  });

  it("should return null for empty slug", async () => {
    const result = await resolveProblemDir(tempRoot, "");
    expect(result).toBeNull();
  });

  it("should prefer exact match over subsequence match", async () => {
    await createDir(tempRoot, "_private/docs/problems/2026-01-01-my-feature");
    await createDir(
      tempRoot,
      "_private/docs/problems/2026-01-02-my-feature-extended",
    );

    const result = await resolveProblemDir(tempRoot, "my-feature");
    expect(result).toBe(
      join(tempRoot, "_private/docs/problems/2026-01-01-my-feature"),
    );
  });

  it("should match slug as substring of directory name after date prefix", async () => {
    await createDir(
      tempRoot,
      "_private/docs/problems/2026-02-15-sp24-desktop-phone-exchange",
    );

    const result = await resolveProblemDir(tempRoot, "sp24-desktop-exchange");
    expect(result).toBe(
      join(
        tempRoot,
        "_private/docs/problems/2026-02-15-sp24-desktop-phone-exchange",
      ),
    );
  });
});

// CC-04: property-based tests
describe("resolvePlanFile property tests", () => {
  const dateArb = fc
    .date({
      min: new Date("2026-01-01"),
      max: new Date("2026-12-31"),
      noInvalidDate: true,
    })
    .map((d) => d.toISOString().slice(0, 10));

  const slugArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}[a-z0-9]$/);

  it("exact slug in filename always resolves", async () => {
    await fc.assert(
      fc.asyncProperty(dateArb, slugArb, async (date, slug) => {
        const dir = await makeTempRoot();
        try {
          const filename = `${date}-${slug}.plan.md`;
          await createFile(
            dir,
            `_private/docs/planning/todo/${filename}`,
            "# Plan",
          );
          const result = await resolvePlanFile(dir, slug);
          expect(result).not.toBeNull();
          expect(result!).toContain(slug);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 20 },
    );
  });

  it("never throws on arbitrary slug input", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 50 }),
        async (slug) => {
          // Should never throw, even with weird input
          const result = await resolvePlanFile(tempRoot, slug);
          expect(result === null || typeof result === "string").toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("resolveProblemDir property tests", () => {
  const dateArb = fc
    .date({
      min: new Date("2026-01-01"),
      max: new Date("2026-12-31"),
      noInvalidDate: true,
    })
    .map((d) => d.toISOString().slice(0, 10));

  const slugArb = fc.stringMatching(/^[a-z][a-z0-9-]{2,20}[a-z0-9]$/);

  it("exact slug in dirname always resolves", async () => {
    await fc.assert(
      fc.asyncProperty(dateArb, slugArb, async (date, slug) => {
        const dir = await makeTempRoot();
        try {
          await createDir(dir, `_private/docs/problems/${date}-${slug}`);
          const result = await resolveProblemDir(dir, slug);
          expect(result).not.toBeNull();
          expect(result!).toContain(slug);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 20 },
    );
  });

  it("never throws on arbitrary slug input", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 50 }),
        async (slug) => {
          const result = await resolveProblemDir(tempRoot, slug);
          expect(result === null || typeof result === "string").toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});
