#!/usr/bin/env node
/**
 * drift-detector MCP server entry point
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { DriftDatabase } from "./db/database.js";
import { createServer } from "./server.js";
import { Indexer } from "./indexer.js";
import { loadConfig, CONFIG_FILENAME } from "./config.js";
import {
  parseCliArgs,
  parseSyncArgs,
  runAudit,
  formatAuditOutput,
  formatCiOutput,
} from "./cli.js";
import { execFileSync } from "node:child_process";
import {
  buildChangeset,
  extractTrailersFromLog,
  buildGitLogCommand,
} from "./sync/index.js";
import { applyChangeset } from "./sync/apply.js";

async function main() {
  // Parse --root <path> from argv (works for both MCP and CLI modes)
  const { root, remainingArgs } = parseRootArg(process.argv.slice(2));
  const projectRoot = root ?? findProjectRoot(process.cwd());
  const dbPath = path.join(projectRoot, ".drift.db");

  // Load project configuration
  const config = loadConfig(projectRoot);

  // Check for CLI mode (e.g., "audit --ci --fail-on=high")
  const cliArgs = parseCliArgs(remainingArgs);
  if (cliArgs) {
    const db = new DriftDatabase(dbPath);
    db.initialize();

    // Reindex before auditing
    const indexer = new Indexer(db, config);
    if (config.workspace.repos.length > 0) {
      await indexer.indexWorkspace(projectRoot, config.workspace.repos);
    } else {
      await indexer.indexDirectory(projectRoot);
    }

    const result = runAudit(db, cliArgs, projectRoot);

    if (cliArgs.ci) {
      console.log(formatCiOutput(result, projectRoot));
    } else {
      console.log(formatAuditOutput(result, cliArgs, projectRoot));
    }

    db.close();
    process.exit(result.exitCode);
  }

  // Check for sync subcommand (e.g., "sync --since HEAD~5")
  const syncArgs = parseSyncArgs(remainingArgs);
  if (syncArgs) {
    const gitCmd = buildGitLogCommand(syncArgs.since);
    const [cmd, ...gitArgs] = gitCmd;
    const logOutput = execFileSync(cmd, gitArgs, {
      cwd: projectRoot,
      encoding: "utf-8",
    });

    const trailers = extractTrailersFromLog(logOutput);
    const changeset = await buildChangeset(projectRoot, trailers);

    if (syncArgs.output) {
      fs.writeFileSync(syncArgs.output, JSON.stringify(changeset, null, 2));
      console.log(`Changeset written to ${syncArgs.output}`);
    } else {
      console.log(JSON.stringify(changeset, null, 2));
    }

    if (syncArgs.apply && !syncArgs.dryRun) {
      const applyResult = await applyChangeset(projectRoot, changeset);
      console.log(JSON.stringify(applyResult, null, 2));
    }

    process.exit(0);
  }

  // MCP server mode (default)
  const db = new DriftDatabase(dbPath);
  db.initialize();

  // Create MCP server
  const server = createServer(db, projectRoot, config);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    db.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    db.close();
    process.exit(0);
  });
}

/**
 * Extract --root <path> from argv, returning the resolved path and remaining args.
 */
function parseRootArg(argv: string[]): {
  root: string | null;
  remainingArgs: string[];
} {
  const remaining: string[] = [];
  let root: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && i + 1 < argv.length) {
      root = path.resolve(argv[i + 1]);
      i++; // skip the value
    } else {
      remaining.push(argv[i]);
    }
  }

  return { root, remainingArgs: remaining };
}

/**
 * Find project root by walking up from cwd looking for markers.
 */
function findProjectRoot(startDir: string): string {
  const markers = [
    CONFIG_FILENAME,
    ".drift.toml",
    ".git",
    "package.json",
    "Cargo.toml",
  ];
  let dir = startDir;

  while (dir !== path.dirname(dir)) {
    for (const marker of markers) {
      if (fs.existsSync(path.join(dir, marker))) {
        return dir;
      }
    }
    dir = path.dirname(dir);
  }

  // Fallback to cwd if no marker found
  return startDir;
}

main().catch((error) => {
  console.error("Failed to start drift-detector:", error);
  process.exit(1);
});
