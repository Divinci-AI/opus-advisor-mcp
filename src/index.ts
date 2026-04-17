#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, basename, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

// --- Config ---

const MAX_HISTORY_TOKENS = 6000;  // ~24K chars at 4 chars/token
const MAX_FILE_SIZE = 50 * 1024;  // 50KB per file
const MAX_TOTAL_FILE_SIZE = 200 * 1024; // 200KB total across all files

// Project-aware log directory: ~/.opus-advisor/<project-hash>/
// Falls back to ADVISOR_LOG_DIR env var if set.
function getAdvisorDir(): string {
  if (process.env.ADVISOR_LOG_DIR) {
    return process.env.ADVISOR_LOG_DIR;
  }
  const home = process.env.HOME || "~";
  const cwd = process.cwd();
  const projectName = basename(cwd);
  const projectHash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return join(home, ".opus-advisor", `${projectName}-${projectHash}`);
}

const ADVISOR_DIR = getAdvisorDir();
const ADVISOR_LOG = join(ADVISOR_DIR, "advisor-log.md");
const ADVISOR_META = join(ADVISOR_DIR, "advisor-meta.jsonl");

const ADVISOR_SYSTEM_PROMPT = `You are a senior technical advisor (Claude Opus). A developer or AI coding assistant running as a faster model (Sonnet) is consulting you for strategic guidance mid-task.

Your role:
- Provide clear, actionable technical advice
- Focus on architecture decisions, trade-offs, pitfalls, and best practices
- Use numbered steps when prescribing an approach
- Be concise — the executor will implement your guidance, not you
- If prior consultation history is provided, build on it rather than repeating yourself
- Go straight to the advice — do not restate the question`;

// --- Token Estimation ---

/** Rough token count: ~4 chars per token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// --- Log Management ---

async function ensureAdvisorDir(): Promise<void> {
  await mkdir(ADVISOR_DIR, { recursive: true });
}

async function readAdvisorLog(): Promise<string> {
  try {
    return await readFile(ADVISOR_LOG, "utf-8");
  } catch {
    return "";
  }
}

/** Parse the log into individual consultations by ## Consultation headers */
function parseConsultations(log: string): string[] {
  const parts = log.split(/(?=\n## Consultation)/);
  // First part is the header, rest are consultations
  return parts.length > 1 ? parts.slice(1) : [];
}

/**
 * Get recent history capped by both count AND estimated token budget.
 * Walks backwards from most recent, adding complete consultations until
 * the token budget is exhausted.
 */
function getRecentHistory(
  log: string,
  maxConsultations: number = 5,
  maxTokens: number = MAX_HISTORY_TOKENS,
): string {
  if (!log) return "";
  const consultations = parseConsultations(log);
  if (consultations.length === 0) return "";

  const selected: string[] = [];
  let tokenBudget = maxTokens;
  // Walk backwards from most recent
  const candidates = consultations.slice(-maxConsultations).reverse();
  for (const entry of candidates) {
    const entryTokens = estimateTokens(entry);
    if (entryTokens > tokenBudget && selected.length > 0) break;
    selected.unshift(entry);
    tokenBudget -= entryTokens;
  }
  return selected.join("");
}

async function appendToLog(
  question: string,
  context: string | undefined,
  advice: string,
): Promise<void> {
  await ensureAdvisorDir();
  const timestamp = new Date().toISOString();
  const entry = [
    `\n## Consultation — ${timestamp}`,
    "",
    `### Question`,
    question,
    "",
    ...(context ? [`### Context`, context, ""] : []),
    `### Advice`,
    advice,
    "",
    "---",
    "",
  ].join("\n");

  const existing = await readAdvisorLog();
  if (!existing) {
    await writeFile(
      ADVISOR_LOG,
      `# Opus Advisor Log\n\nProject: ${basename(process.cwd())}\nPath: ${process.cwd()}\n\n---\n${entry}`,
    );
  } else {
    await writeFile(ADVISOR_LOG, existing + entry);
  }
}

/** Append structured metadata as a JSONL entry alongside the markdown log */
async function appendMetadata(meta: {
  timestamp: string;
  effort: string;
  latencyMs: number;
  questionTokens: number;
  contextTokens: number;
  historyTokens: number;
  adviceTokens: number;
  signal: string | null;
}): Promise<void> {
  try {
    await ensureAdvisorDir();
    const line = JSON.stringify(meta) + "\n";
    const existing = await readFile(ADVISOR_META, "utf-8").catch(() => "");
    await writeFile(ADVISOR_META, existing + line);
  } catch {
    // Non-critical — don't fail the consultation if metadata write fails
  }
}

// --- File Reading ---

/** Map file extension to a markdown language tag for code fences */
function extToLang(filePath: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".py": "python", ".go": "go", ".rs": "rust", ".rb": "ruby",
    ".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c",
    ".cpp": "cpp", ".h": "c", ".cs": "csharp", ".php": "php",
    ".sql": "sql", ".sh": "bash", ".zsh": "bash", ".fish": "fish",
    ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".json": "json",
    ".md": "markdown", ".html": "html", ".css": "css", ".scss": "scss",
    ".xml": "xml", ".graphql": "graphql", ".proto": "protobuf",
    ".dockerfile": "dockerfile", ".tf": "hcl", ".vue": "vue",
    ".svelte": "svelte",
  };
  return map[extname(filePath).toLowerCase()] || "";
}

/** Binary extensions that should be skipped */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".wasm", ".bin", ".exe", ".dll", ".so", ".dylib",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".pyc", ".class", ".o", ".obj",
]);

/**
 * Validate that a resolved path stays within the project root.
 * Prevents path traversal (e.g., ../../etc/passwd).
 */
function isPathWithinRoot(absPath: string, root: string): boolean {
  const normalizedPath = resolve(absPath);
  const normalizedRoot = resolve(root);
  return normalizedPath.startsWith(normalizedRoot + "/") || normalizedPath === normalizedRoot;
}

interface FileBlock {
  path: string;
  content: string;
  truncated: boolean;
  error?: string;
}

/**
 * Read files and format as labeled code blocks.
 * Respects per-file and total size caps.
 * Validates paths stay within project root (prevents path traversal).
 */
async function readFilesForContext(
  filePaths: string[],
  cwd: string,
): Promise<{ blocks: string; totalSize: number; fileCount: number; errors: string[] }> {
  const results: FileBlock[] = [];
  const errors: string[] = [];
  let totalSize = 0;

  for (const filePath of filePaths) {
    const absPath = resolve(cwd, filePath);

    // Path traversal guard
    if (!isPathWithinRoot(absPath, cwd)) {
      errors.push(`${filePath}: path outside project root (rejected)`);
      continue;
    }

    // Skip binary files
    if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) {
      errors.push(`${filePath}: binary file (skipped)`);
      continue;
    }

    try {
      const fileStat = await stat(absPath);
      if (!fileStat.isFile()) {
        errors.push(`${filePath}: not a file`);
        continue;
      }

      const remaining = MAX_TOTAL_FILE_SIZE - totalSize;
      if (remaining <= 0) {
        errors.push(`${filePath}: skipped (total file size budget exhausted)`);
        continue;
      }

      const cap = Math.min(MAX_FILE_SIZE, remaining);
      const raw = await readFile(absPath, "utf-8");
      const truncated = raw.length > cap;
      const content = truncated ? raw.slice(0, cap) + "\n... (truncated)" : raw;

      totalSize += content.length;
      results.push({ path: filePath, content, truncated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      errors.push(`${filePath}: ${msg}`);
    }
  }

  const blocks = results
    .map((f) => {
      const lang = extToLang(f.path);
      const label = f.truncated ? `${f.path} (truncated to ${MAX_FILE_SIZE / 1024}KB)` : f.path;
      return `### File: ${label}\n\`\`\`${lang}\n${f.content}\n\`\`\``;
    })
    .join("\n\n");

  return { blocks, totalSize, fileCount: results.length, errors };
}

// --- Claude CLI Execution ---

interface ClaudeResult {
  output: string;
  signal: string | null;
}

/**
 * Run `claude -p` with the prompt piped via stdin.
 * Returns the output and the exit signal (null if clean exit).
 * Discards partial output if the process was killed by a signal.
 */
function runClaude(prompt: string, options: {
  model: string;
  effort: string;
  systemPrompt: string;
  maxTurns?: number;
  cwd?: string;
}): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--model", options.model,
      "--effort", options.effort,
      "--system-prompt", options.systemPrompt,
      "--max-turns", String(options.maxTurns ?? 1),
      "--no-session-persistence",
      "--disable-slash-commands",
    ];

    const child = spawn("claude", args, {
      cwd: options.cwd || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      timeout: 300_000, // 5 min
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    // Pipe the prompt via stdin, then close it
    child.stdin.write(prompt);
    child.stdin.end();

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      // If killed by signal (timeout, OOM, etc.), discard partial output
      if (signal) {
        reject(
          new Error(
            `claude CLI killed by signal ${signal}. Partial output discarded.\nstderr: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `claude CLI exited with code ${code}\nstderr: ${stderr.slice(0, 500)}`,
          ),
        );
        return;
      }
      const output = stdout.trim();
      if (!output) {
        reject(new Error("claude CLI returned empty output"));
        return;
      }
      resolve({ output, signal: null });
    });
  });
}

// --- MCP Server ---

const server = new McpServer(
  { name: "opus-advisor", version: "1.0.0" },
  {
    instructions:
      "Consult Claude Opus as a strategic advisor via the Claude Code CLI. " +
      "Use this when you need deeper reasoning for architecture decisions, " +
      "complex debugging, or a second opinion. The advisor maintains a " +
      "per-project log of prior consultations for continuity. " +
      "Metadata (latency, token counts) is tracked in advisor-meta.jsonl.",
  },
);

server.registerTool("consult_opus", {
  title: "Consult Opus Advisor",
  description:
    "Consult Claude Opus 4.7 for strategic advice. Opus runs via the Claude Code CLI " +
    "with your existing subscription — no API key needed. The advisor maintains a " +
    "per-project consultation log for continuity across calls. History is capped by " +
    "both entry count (5) and token budget (~6K tokens) to prevent context bloat. " +
    "Use this for architecture decisions, complex debugging, code review, or any " +
    "problem that benefits from deeper reasoning.",
  inputSchema: {
    question: z
      .string()
      .describe(
        "The question or problem you need advice on. Be specific about what decision " +
        "you're facing or what you're stuck on.",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "Additional context: relevant code snippets, error messages, constraints, or " +
        "background. Include enough that the advisor can give specific guidance without " +
        "needing to read files.",
      ),
    effort: z
      .enum(["low", "medium", "high"])
      .optional()
      .default("medium")
      .describe(
        "Reasoning effort level for Opus. 'low' for quick opinions, 'medium' (default) " +
        "for thorough advice, 'high' for deep analysis.",
      ),
    files: z
      .array(z.string())
      .optional()
      .describe(
        "File paths (relative to project root) to include as code context. " +
        "Each file is read and prepended as a labeled code block. " +
        "Max 50KB per file, 200KB total. Example: ['src/index.ts', 'lib/utils.ts']",
      ),
    include_history: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Whether to include prior consultation history for continuity. Defaults to true. " +
        "Set to false for standalone questions unrelated to prior advice.",
      ),
  },
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
}, async ({ question, context, effort, files, include_history }) => {
  const startTime = Date.now();
  try {
    await ensureAdvisorDir();
    const cwd = process.cwd();

    // Build the prompt with optional history, files, and context
    const parts: string[] = [];
    let historyTokens = 0;
    let fileTokens = 0;

    if (include_history) {
      const history = await readAdvisorLog();
      const recentHistory = getRecentHistory(history, 5, MAX_HISTORY_TOKENS);
      if (recentHistory) {
        historyTokens = estimateTokens(recentHistory);
        parts.push(
          `## Prior Consultation History (for continuity — ~${historyTokens} tokens)`,
          recentHistory,
          "",
        );
      }
    }

    // Read and inject file contents
    if (files && files.length > 0) {
      const fileResult = await readFilesForContext(files, cwd);
      if (fileResult.blocks) {
        fileTokens = estimateTokens(fileResult.blocks);
        parts.push(
          `## Files (${fileResult.fileCount} files, ~${fileTokens} tokens)`,
          fileResult.blocks,
          "",
        );
      }
      if (fileResult.errors.length > 0) {
        parts.push(
          `> File warnings: ${fileResult.errors.join("; ")}`,
          "",
        );
      }
    }

    parts.push("## Current Question", question);
    if (context) {
      parts.push("", "## Context", context);
    }

    const fullPrompt = parts.join("\n");

    const result = await runClaude(fullPrompt, {
      model: "opus",
      effort: effort ?? "medium",
      systemPrompt: ADVISOR_SYSTEM_PROMPT,
    });

    const latencyMs = Date.now() - startTime;

    // Log the consultation (include file names in context for the log)
    const logContext = [
      context || "",
      files && files.length > 0 ? `\nFiles consulted: ${files.join(", ")}` : "",
    ].filter(Boolean).join("") || undefined;

    await appendToLog(question, logContext, result.output);

    // Write structured metadata
    await appendMetadata({
      timestamp: new Date().toISOString(),
      effort: effort ?? "medium",
      latencyMs,
      questionTokens: estimateTokens(question),
      contextTokens: (context ? estimateTokens(context) : 0) + fileTokens,
      historyTokens,
      adviceTokens: estimateTokens(result.output),
      signal: result.signal,
    });

    return {
      content: [{ type: "text" as const, text: result.output }],
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message =
      err instanceof Error ? err.message : "Unknown error consulting Opus";

    // Log failed attempts to metadata too
    await appendMetadata({
      timestamp: new Date().toISOString(),
      effort: effort ?? "medium",
      latencyMs,
      questionTokens: estimateTokens(question),
      contextTokens: context ? estimateTokens(context) : 0,
      historyTokens: 0,
      adviceTokens: 0,
      signal: message.includes("signal") ? message : null,
    }).catch(() => {});

    return {
      content: [{ type: "text" as const, text: `Advisor error: ${message}` }],
      isError: true,
    };
  }
});

server.registerTool("read_advisor_log", {
  title: "Read Advisor Log",
  description:
    "Read the consultation log from prior Opus advisor calls for this project. " +
    "Useful for reviewing past advice or getting context on decisions already made.",
  inputSchema: {
    last_n: z
      .number()
      .optional()
      .describe(
        "Number of recent consultations to return. Omit for the full log.",
      ),
  },
  annotations: {
    readOnlyHint: true,
  },
}, async ({ last_n }) => {
  try {
    const log = await readAdvisorLog();
    if (!log) {
      return {
        content: [
          { type: "text" as const, text: "No advisor consultations yet." },
        ],
      };
    }
    if (last_n) {
      const recent = getRecentHistory(log, last_n, Infinity);
      return {
        content: [{ type: "text" as const, text: recent || "No consultations found." }],
      };
    }
    return { content: [{ type: "text" as const, text: log }] };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error reading log";
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

server.registerTool("read_advisor_meta", {
  title: "Read Advisor Metadata",
  description:
    "Read structured metadata (latency, token counts, effort levels) from all " +
    "consultations. Useful for understanding cost and performance patterns.",
  inputSchema: {
    last_n: z
      .number()
      .optional()
      .describe("Number of recent entries to return. Omit for all."),
  },
  annotations: {
    readOnlyHint: true,
  },
}, async ({ last_n }) => {
  try {
    const raw = await readFile(ADVISOR_META, "utf-8").catch(() => "");
    if (!raw.trim()) {
      return {
        content: [{ type: "text" as const, text: "No metadata yet." }],
      };
    }
    const lines = raw.trim().split("\n");
    const selected = last_n ? lines.slice(-last_n) : lines;

    // Parse and format as a summary table
    const entries = selected.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    const totalLatency = entries.reduce(
      (sum: number, e: { latencyMs: number }) => sum + e.latencyMs, 0,
    );
    const totalAdviceTokens = entries.reduce(
      (sum: number, e: { adviceTokens: number }) => sum + e.adviceTokens, 0,
    );

    const summary = [
      `## Advisor Metadata (${entries.length} consultations)`,
      "",
      `| # | Timestamp | Effort | Latency | Q Tokens | Advice Tokens |`,
      `|---|-----------|--------|---------|----------|---------------|`,
      ...entries.map((e: {
        timestamp: string;
        effort: string;
        latencyMs: number;
        questionTokens: number;
        adviceTokens: number;
      }, i: number) =>
        `| ${i + 1} | ${e.timestamp.slice(0, 19)} | ${e.effort} | ${(e.latencyMs / 1000).toFixed(1)}s | ~${e.questionTokens} | ~${e.adviceTokens} |`,
      ),
      "",
      `**Totals**: ${(totalLatency / 1000).toFixed(1)}s latency, ~${totalAdviceTokens} advice tokens`,
    ].join("\n");

    return { content: [{ type: "text" as const, text: summary }] };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error reading metadata";
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

server.registerTool("clear_advisor_log", {
  title: "Clear Advisor Log",
  description: "Clear the consultation log and metadata to start fresh for this project.",
  inputSchema: {},
  annotations: {
    destructiveHint: true,
  },
}, async () => {
  try {
    await ensureAdvisorDir();
    await writeFile(
      ADVISOR_LOG,
      `# Opus Advisor Log\n\nProject: ${basename(process.cwd())}\nPath: ${process.cwd()}\n\n---\n`,
    );
    await writeFile(ADVISOR_META, "");
    return {
      content: [{ type: "text" as const, text: "Advisor log and metadata cleared." }],
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error clearing log";
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start opus-advisor MCP server:", err);
  process.exit(1);
});
