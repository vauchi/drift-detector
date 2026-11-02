# drift-detector

Cross-layer coherence tool for detecting drift between problem statements,
features, tests, code, and documentation.

## What it does

drift-detector indexes every layer of a software project — problem
statements, Gherkin features, tests, source code, and documentation — then
cross-references them to detect:

- **Missing test coverage**: Features without corresponding tests
- **Undocumented code**: Public APIs without documentation
- **Orphan tests**: Tests without corresponding features
- **Stale documentation**: Docs referencing non-existent code
- **Naming drift**: Inconsistent naming across layers

## Installation

```bash
npm install -g @megloff1/drift-detector
```

Or use directly with npx:

```bash
npx @megloff1/drift-detector
```

## Usage with Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "drift-detector": {
      "command": "npx",
      "args": ["-y", "@megloff1/drift-detector"]
    }
  }
}
```

Or add globally:

```bash
claude mcp add --transport stdio drift-detector -- npx -y @megloff1/drift-detector
```

## MCP Tools

### `reindex`

Rebuild the project index. Run this on first setup or after major changes.

```text
Parameters:
- full (boolean, default: false): If true, drops and rebuilds entire index
```

### `check_concept`

Look up a concept across all project layers.

```text
Parameters:
- concept (string, required): The concept name to look up
- include_code (boolean, default: true): Include code snippets in response
```

### `audit_drift`

Scan for inconsistencies across layers.

```text
Parameters:
- scope (enum: all|features|tests|docs|code, default: all)
- severity (enum: all|high|medium|low, default: all)
- limit (number, default: 20)
- offset (number, default: 0)
```

### `get_coverage`

Show which concepts are covered at each layer.

```text
Parameters:
- filter (enum: all|undocumented|untested|unimplemented, default: all)
- component (string, optional): Filter to specific component
```

### `search`

Search across all indexed entities.

```text
Parameters:
- query (string, required): Search query
- layer (enum: all|feature|test|source|doc, default: all)
- limit (number, default: 20)
- offset (number, default: 0)
```

### `get_overview`

High-level coherence status.

## Supported Layers

| Layer | Description | File Types |
|-------|-------------|------------|
| problem | Problem statements, ADRs | `*.md` in requirements/ |
| feature | Gherkin specifications | `*.feature` |
| e2e_test | End-to-end tests | Test files in e2e/ |
| unit_test | Unit tests | `*.test.ts`, `*.spec.ts` |
| perf_test | Performance tests | `*.bench.ts`, benches/ |
| source | Production code | `*.ts`, `*.rs`, etc. |
| dev_doc | Developer docs | `CLAUDE.md`, `ARCHITECTURE.md` |
| user_doc | User documentation | `README.md`, docs/ |

## Configuration

Create `.drift.toml` in your project root:

```toml
[project]
name = "my-app"
languages = ["typescript", "rust"]

[layers.features]
patterns = ["features/**/*.feature"]

[layers.tests]
patterns = ["tests/**/*.ts", "**/*.test.ts"]

[[concepts]]
name = "authentication"
aliases = ["auth", "login", "signin"]
```

## Semantic Matching

drift-detector uses embedding-based semantic matching to reduce false
positives and enable self-healing tag overrides.

### Self-healing tag override

`@planned` scenarios with implementation evidence (from any matching
phase — tags, names, paths, or semantic embeddings) are reported as
`stale_tag` LOW rather than silently skipped. This surfaces stale tags
without manual `@implemented` sweeps.

### Ollama setup

Semantic matching requires a locally running Ollama instance:

```bash
ollama pull qwen3-embedding:0.6B
```

Ollama must be running at `http://localhost:11434` (default). If Ollama is unavailable, drift-detector falls back to keyword/tag matching only — all other functionality is unaffected.

### Configuration

Add an `[embeddings]` section to `driftconfig.toml` (or `.drift.toml`) in your project root:

```toml
[embeddings]
model = "qwen3-embedding:0.6B"
base_url = "http://localhost:11434"
enabled = true
```

Set `enabled = false` to disable semantic matching without removing the config.

### Integration test

To run the full integration test suite including Ollama-backed embedding tests:

```bash
OLLAMA_INTEGRATION=1 npm test
```

Without `OLLAMA_INTEGRATION=1`, embedding integration tests are skipped automatically.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Run locally
npm start
```

## License

GPL-3.0-or-later
