/**
 * Tests for sync CLI subcommand argument parsing
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import { parseSyncArgs, parseCliArgs } from "../../src/cli.js";

describe("parseSyncArgs", () => {
  it("parses --since flag", () => {
    const result = parseSyncArgs(["sync", "--since", "HEAD~5"]);
    expect(result).toEqual({
      command: "sync",
      since: "HEAD~5",
      output: null,
      dryRun: false,
      apply: false,
    });
  });

  it("parses --output flag", () => {
    const result = parseSyncArgs([
      "sync",
      "--since",
      "abc123",
      "--output",
      "changes.json",
    ]);
    expect(result).not.toBeNull();
    expect(result!.output).toBe("changes.json");
  });

  it("parses --dry-run flag", () => {
    const result = parseSyncArgs(["sync", "--since", "main", "--dry-run"]);
    expect(result).not.toBeNull();
    expect(result!.dryRun).toBe(true);
  });

  it("parses --apply flag", () => {
    const result = parseSyncArgs(["sync", "--since", "main", "--apply"]);
    expect(result).not.toBeNull();
    expect(result!.apply).toBe(true);
  });

  it("parses all flags together", () => {
    const result = parseSyncArgs([
      "sync",
      "--since",
      "v1.0",
      "--output",
      "out.json",
      "--dry-run",
      "--apply",
    ]);
    expect(result).toEqual({
      command: "sync",
      since: "v1.0",
      output: "out.json",
      dryRun: true,
      apply: true,
    });
  });

  it("returns null when --since is missing", () => {
    const result = parseSyncArgs(["sync", "--output", "out.json"]);
    expect(result).toBeNull();
  });

  it("returns null when argv is empty", () => {
    const result = parseSyncArgs([]);
    expect(result).toBeNull();
  });

  it("returns null when command is not sync", () => {
    const result = parseSyncArgs(["audit", "--since", "HEAD~1"]);
    expect(result).toBeNull();
  });

  it("returns null when --since has no value (at end of argv)", () => {
    const result = parseSyncArgs(["sync", "--since"]);
    expect(result).toBeNull();
  });
});

describe("parseCliArgs regression", () => {
  it("returns null for sync command (no false match)", () => {
    const result = parseCliArgs(["sync", "--since", "HEAD~5"]);
    expect(result).toBeNull();
  });
});
