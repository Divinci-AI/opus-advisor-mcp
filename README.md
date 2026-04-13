# opus-advisor-mcp

An MCP server that lets Claude Code consult Opus as a strategic advisor mid-task. Run your session on Sonnet or Haiku, and escalate complex decisions to Opus on demand — using your existing Claude Code subscription.

Inspired by [Anthropic's Advisor Strategy](https://claude.com/blog/the-advisor-strategy).

## How it works

```
┌─────────────────────────────────────────────┐
│  Claude Code (Sonnet)                       │
│                                             │
│  "I need to decide on the DB schema..."     │
│        │                                    │
│        ▼                                    │
│  calls consult_opus MCP tool                │
│        │                                    │
└────────┼────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│  opus-advisor MCP server                    │
│                                             │
│  1. Reads prior consultation history        │
│  2. Reads requested files from disk         │
│  3. Pipes prompt to: claude -p --model opus │
│  4. Logs advice to advisor-log.md           │
│  5. Returns advice to Sonnet                │
└─────────────────────────────────────────────┘
```

No API keys needed. The server shells out to the `claude` CLI, which uses your existing authentication.

## Install

```bash
npm install -g opus-advisor-mcp
```

Or clone and build locally:

```bash
git clone https://github.com/Divinci-AI/opus-advisor-mcp.git
cd opus-advisor-mcp
npm install
npm run build
```

## Configure

Add to your project's `.mcp.json` or `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "opus-advisor": {
      "command": "opus-advisor",
      "timeout": 180000
    }
  }
}
```

If installed locally (not globally):

```json
{
  "mcpServers": {
    "opus-advisor": {
      "command": "node",
      "args": ["/path/to/opus-advisor-mcp/dist/index.js"],
      "timeout": 180000
    }
  }
}
```

Restart Claude Code after adding the config.

## Tools

### `consult_opus`

Consult Opus for strategic advice.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `question` | string | required | The question or problem you need advice on |
| `context` | string | optional | Additional context, constraints, or background |
| `files` | string[] | optional | File paths (relative to project root) to include as code context |
| `effort` | `"low"` \| `"medium"` \| `"high"` | `"medium"` | Reasoning effort level for Opus |
| `include_history` | boolean | `true` | Include prior consultation history for continuity |

Example:

```json
{
  "question": "Is this database migration safe under concurrent writes?",
  "files": ["src/db/migration-042.ts", "src/db/schema.ts"],
  "effort": "high"
}
```

### `read_advisor_log`

Read the consultation log from prior calls.

| Parameter | Type | Description |
|-----------|------|-------------|
| `last_n` | number | Number of recent consultations to return (omit for all) |

### `read_advisor_meta`

Read structured metadata (latency, token counts, effort levels).

| Parameter | Type | Description |
|-----------|------|-------------|
| `last_n` | number | Number of recent entries to return (omit for all) |

### `clear_advisor_log`

Clear the consultation log and metadata to start fresh.

## Features

- **No API key required** — Uses your existing Claude Code subscription via the `claude` CLI
- **Per-project logs** — Consultation history is stored per project at `~/.opus-advisor/<project>-<hash>/`
- **Code-aware context** — Pass file paths directly; the server reads and injects them as labeled code blocks
- **Consultation continuity** — Prior advice is fed back as context so Opus can build on earlier decisions
- **Token-aware history** — History is capped by both entry count (5) and token budget (~6K tokens)
- **Metadata tracking** — Latency, token estimates, and effort levels tracked in `advisor-meta.jsonl`
- **Signal protection** — Partial output from killed processes is discarded, not returned as advice
- **Path traversal guard** — File reads are validated to stay within the project root

## Security

- **Path traversal protection**: The `files` parameter validates that all resolved paths remain within the project root directory. Paths like `../../etc/passwd` or absolute paths outside the project are rejected.
- **Binary file filtering**: Common binary extensions (images, executables, archives, etc.) are automatically skipped.
- **No shell execution**: The server uses `spawn` with array arguments and pipes the prompt via stdin. No shell interpolation occurs.
- **Local only**: The MCP server runs locally via stdio. No network ports are opened.
- **Consultation logs**: Stored at `~/.opus-advisor/` in plaintext. These may contain code snippets and questions from your consultations. Do not commit or share these files if they contain sensitive code.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ADVISOR_LOG_DIR` | Override the log directory (default: `~/.opus-advisor/<project>-<hash>/`) |

## How it compares to Anthropic's Advisor Tool

Anthropic's [`advisor_20260301`](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool) is a server-side API feature where the advisor sees the full conversation transcript within a single API request. This MCP server is a different approach:

| | Anthropic Advisor Tool | opus-advisor-mcp |
|---|---|---|
| **Context sharing** | Full transcript (server-side) | Question + files + history (client-side) |
| **Auth** | API key required | Uses existing Claude Code subscription |
| **Integration** | API-level (`tools` array) | MCP tool (works in Claude Code today) |
| **Persistence** | None | Markdown log + JSONL metadata |
| **Cost** | Billed per-token at Opus rates | Included in subscription |

## Requirements

- Node.js >= 18
- [Claude Code](https://claude.ai/code) CLI installed and authenticated

## License

MIT
