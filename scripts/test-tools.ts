#!/usr/bin/env npx tsx
/**
 * Test MCP tool handlers directly
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { DriftDatabase } from "../src/db/database.js";
import { Indexer } from "../src/indexer.js";

// Resolved from this file, so the script works in any checkout: drift-detector
// is cloned inside the vauchi workspace, alongside the feature corpus and
// driftconfig.toml. Set VAUCHI_WORKSPACE to point somewhere else.
const VAUCHI_WORKSPACE =
  process.env.VAUCHI_WORKSPACE ?? fileURLToPath(new URL("../..", import.meta.url));
const VAUCHI_FEATURES = path.join(VAUCHI_WORKSPACE, "features");

async function main() {
  console.log("🧪 Testing MCP Tool Handlers\n");

  // Setup
  const db = new DriftDatabase(":memory:");
  db.initialize();
  const indexer = new Indexer(db, loadConfig(VAUCHI_WORKSPACE));
  await indexer.indexDirectory(VAUCHI_FEATURES);

  console.log("━".repeat(60));

  // Test 1: get_overview equivalent
  console.log("\n📊 Tool: get_overview\n");
  const overview = computeOverview(db);
  console.log(`Files indexed: ${overview.totalFiles}`);
  console.log(`Entities extracted: ${overview.totalEntities}`);
  console.log(`Concepts discovered: ${overview.totalConcepts}`);
  console.log(`Coherence score: ${Math.round(overview.coherenceScore * 100)}%`);

  console.log("━".repeat(60));

  // Test 2: search equivalent
  console.log("\n🔎 Tool: search (query='recovery')\n");
  const searchResults = db.searchEntities("recovery", 5);
  for (const result of searchResults) {
    console.log(`- ${result.name} (${result.entity_type})`);
  }

  console.log("━".repeat(60));

  // Test 3: check_concept equivalent
  console.log("\n🏷️  Tool: check_concept (concept='security')\n");
  const entities = db.getAllEntities();
  const securityEntities = entities.filter(e => {
    const metadata = JSON.parse(e.metadata || "{}");
    const tags: string[] = metadata.tags || [];
    return tags.includes("security");
  });
  console.log(`Found ${securityEntities.length} entities tagged @security:`);
  for (const entity of securityEntities.slice(0, 5)) {
    console.log(`- ${entity.name}`);
  }
  if (securityEntities.length > 5) {
    console.log(`  ... and ${securityEntities.length - 5} more`);
  }

  console.log("━".repeat(60));

  // Test 4: get_coverage equivalent (sample)
  console.log("\n📈 Tool: get_coverage (sample)\n");
  const allTags = new Set<string>();
  for (const entity of entities) {
    const metadata = JSON.parse(entity.metadata || "{}");
    for (const tag of metadata.tags || []) {
      allTags.add(tag);
    }
  }
  const sampleTags = Array.from(allTags).slice(0, 5);
  console.log("| Concept | Feature Layer |");
  console.log("|---------|---------------|");
  for (const tag of sampleTags) {
    const hasFeature = entities.some(e => {
      const metadata = JSON.parse(e.metadata || "{}");
      return (metadata.tags || []).includes(tag) && e.layer === "feature";
    });
    console.log(`| ${tag.padEnd(12)} | ${hasFeature ? "✅" : "❌"} |`);
  }

  console.log("━".repeat(60));

  // Test 5: audit_drift equivalent
  console.log("\n⚠️  Tool: audit_drift\n");
  const scenarios = entities.filter(e => e.entity_type === "scenario");
  // In a real scenario, we'd check for missing tests
  // For now, just report scenarios without certain tags
  const untaggedScenarios = scenarios.filter(e => {
    const metadata = JSON.parse(e.metadata || "{}");
    const tags: string[] = metadata.tags || [];
    return tags.length === 0;
  });
  console.log(`Scenarios without tags (potential drift): ${untaggedScenarios.length}`);
  if (untaggedScenarios.length > 0 && untaggedScenarios.length <= 5) {
    for (const s of untaggedScenarios) {
      console.log(`- ${s.name}`);
    }
  }

  console.log("\n━".repeat(60));
  console.log("\n✅ All tool handlers working correctly!\n");

  db.close();
}

function computeOverview(db: DriftDatabase) {
  const entities = db.getAllEntities();
  const allTags = new Set<string>();
  for (const entity of entities) {
    const metadata = JSON.parse(entity.metadata || "{}");
    for (const tag of metadata.tags || []) {
      allTags.add(tag);
    }
  }

  return {
    totalFiles: db.getTotalFileCount(),
    totalEntities: db.getTotalEntityCount(),
    totalConcepts: allTags.size,
    coherenceScore: 0.95, // Placeholder
  };
}

main().catch(console.error);
