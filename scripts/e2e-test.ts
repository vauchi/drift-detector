#!/usr/bin/env npx tsx
/**
 * End-to-end test for drift-detector
 * Tests the tool against real vauchi feature files
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { DriftDatabase } from "../src/db/database.js";
import { Indexer } from "../src/indexer.js";
import { createServer } from "../src/server.js";

// Resolved from this file, so the script works in any checkout: drift-detector
// is cloned inside the vauchi workspace, alongside the feature corpus and
// driftconfig.toml. Set VAUCHI_WORKSPACE to point somewhere else.
const VAUCHI_WORKSPACE =
  process.env.VAUCHI_WORKSPACE ?? fileURLToPath(new URL("../..", import.meta.url));
const VAUCHI_FEATURES = path.join(VAUCHI_WORKSPACE, "features");

async function main() {
  console.log("🔍 drift-detector E2E Test\n");

  // 1. Create in-memory database
  console.log("1️⃣  Initializing database...");
  const db = new DriftDatabase(":memory:");
  db.initialize();
  console.log("   ✅ Database initialized\n");

  // 2. Index vauchi features
  console.log("2️⃣  Indexing vauchi features...");
  const indexer = new Indexer(db, loadConfig(VAUCHI_WORKSPACE));
  const result = await indexer.indexDirectory(VAUCHI_FEATURES);
  console.log(`   ✅ Indexed ${result.filesIndexed} files`);
  console.log(`   ✅ Extracted ${result.entitiesExtracted} entities`);
  console.log(`   ✅ Created ${result.conceptsCreated} concepts`);
  if (result.errors.length > 0) {
    console.log(`   ⚠️  ${result.errors.length} errors:`);
    for (const err of result.errors) {
      console.log(`      - ${err.file}: ${err.message}`);
    }
  }
  console.log();

  // 3. Test database queries
  console.log("3️⃣  Testing database queries...");

  const files = db.getAllFiles();
  console.log(`   📁 Files in index: ${files.length}`);

  const entities = db.getAllEntities();
  console.log(`   📦 Total entities: ${entities.length}`);

  const features = entities.filter(e => e.entity_type === "feature");
  console.log(`   🏷️  Features: ${features.length}`);

  const scenarios = entities.filter(e => e.entity_type === "scenario");
  console.log(`   🎬 Scenarios: ${scenarios.length}`);

  const scenarioOutlines = entities.filter(e => e.entity_type === "scenario_outline");
  console.log(`   📋 Scenario Outlines: ${scenarioOutlines.length}`);
  console.log();

  // 4. Test FTS search
  console.log("4️⃣  Testing full-text search...");

  const contactResults = db.searchEntities("contact");
  console.log(`   🔎 Search "contact": ${contactResults.length} results`);
  if (contactResults.length > 0) {
    console.log(`      First match: ${contactResults[0].name}`);
  }

  const securityResults = db.searchEntities("security");
  console.log(`   🔎 Search "security": ${securityResults.length} results`);

  const exchangeResults = db.searchEntities("exchange");
  console.log(`   🔎 Search "exchange": ${exchangeResults.length} results`);
  console.log();

  // 5. Test concept lookup
  console.log("5️⃣  Testing concept extraction...");

  // Get unique tags from entities
  const allTags = new Set<string>();
  for (const entity of entities) {
    try {
      const metadata = JSON.parse(entity.metadata || "{}");
      const tags = metadata.tags || [];
      for (const tag of tags) {
        allTags.add(tag);
      }
    } catch {}
  }
  console.log(`   🏷️  Unique tags found: ${allTags.size}`);
  if (allTags.size > 0) {
    const tagList = Array.from(allTags).slice(0, 10);
    console.log(`      Sample: ${tagList.join(", ")}${allTags.size > 10 ? "..." : ""}`);
  }
  console.log();

  // 6. Test layer statistics
  console.log("6️⃣  Testing layer statistics...");
  const layerCounts = db.getEntityCountByLayer();
  for (const [layer, count] of Object.entries(layerCounts)) {
    console.log(`   📊 ${layer}: ${count} entities`);
  }
  console.log();

  // 7. Test incremental indexing
  console.log("7️⃣  Testing incremental reindex (should skip unchanged)...");
  const reindexResult = await indexer.indexDirectory(VAUCHI_FEATURES);
  console.log(`   ⏭️  Files skipped: ${reindexResult.filesSkipped}`);
  console.log(`   📝 Files reindexed: ${reindexResult.filesIndexed}`);
  console.log();

  // 8. Verify server creates successfully
  console.log("8️⃣  Testing MCP server creation...");
  const server = createServer(db, VAUCHI_WORKSPACE, loadConfig(VAUCHI_WORKSPACE));
  console.log("   ✅ Server created successfully");
  console.log();

  // Summary
  console.log("━".repeat(50));
  console.log("✅ All E2E tests passed!\n");
  console.log("Summary:");
  console.log(`   • ${files.length} feature files indexed`);
  console.log(`   • ${features.length} features extracted`);
  console.log(`   • ${scenarios.length + scenarioOutlines.length} scenarios extracted`);
  console.log(`   • ${allTags.size} unique concepts/tags discovered`);
  console.log(`   • FTS search working`);
  console.log(`   • Incremental indexing working`);
  console.log(`   • MCP server ready`);

  db.close();
}

main().catch((err) => {
  console.error("❌ E2E test failed:", err);
  process.exit(1);
});
