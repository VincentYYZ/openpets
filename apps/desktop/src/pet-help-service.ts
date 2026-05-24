import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { app } from "electron";
import { join } from "node:path";

import { getAppStateSnapshot } from "./app-state.js";
import { buildPetMemoryContext } from "./pet-memory-context.js";
import { askPetHelpWithThirdParty } from "./pet-help-third-party-service.js";

export interface PetHelpTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface PetHelpAskRequest {
  readonly message: string;
  readonly history: readonly PetHelpTurn[];
}

interface PetHelpStreamOptions {
  readonly onChunk?: (chunk: string) => void;
  readonly signal?: AbortSignal;
}

interface CommandResult {
  readonly ok: boolean;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly parsedAnswer: string;
  readonly error?: string;
}

export class PetHelpCancelledError extends Error {
  constructor() {
    super("Claude Code 请求已取消。");
    this.name = "PetHelpCancelledError";
  }
}

const petHelpTimeoutMs = 120_000;
const petHelpChatOnlyTimeoutMs = 45_000;
const maxClaudeOutputBytes = 96_000;

export async function askPetHelp(request: PetHelpAskRequest, options: PetHelpStreamOptions = {}): Promise<{ readonly answer: string }> {
  const preferences = getAppStateSnapshot().preferences;
  return preferences.petHelpProviderMode === "third-party"
    ? askPetHelpWithThirdParty(request, preferences.petHelpThirdPartyConfig, options)
    : askPetHelpWithClaude(request, options);
}

export async function askPetHelpWithClaude(request: PetHelpAskRequest, options: PetHelpStreamOptions = {}): Promise<{ readonly answer: string }> {
  const prompt = createClaudePetHelpPrompt(request);
  const command = getAppStateSnapshot().preferences.claudeCommandPath || "claude";
  const chatOnly = true;
  let lastResult: CommandResult | null = null;

  for (const candidate of getClaudeCommandCandidates(command)) {
    if (options.signal?.aborted) {
      throw new PetHelpCancelledError();
    }
    const result = await runClaudePrintCommand(candidate, prompt, chatOnly, options.onChunk, options.signal);
    lastResult = result;
    if (result.cancelled) {
      throw new PetHelpCancelledError();
    }
    if (result.ok) {
      const answer = result.parsedAnswer || sanitizeClaudeOutput(result.stdout || result.stderr);
      return { answer: answer || "Claude Code 没有返回内容。" };
    }
    if (!isCommandNotFound(result)) break;
  }

  throw new Error(summarizeClaudeFailure(lastResult));
}

function createClaudePetHelpPrompt(request: PetHelpAskRequest): string {
  const history = request.history.slice(-8).map((turn) => `${turn.role === "user" ? "用户" : "宠物"}：${turn.content}`).join("\n\n");
  const memoryContext = buildPetMemoryContext().text;
  return [
    "你是用户桌面宠物背后的 Claude Code 助手。请用简洁、友好、可执行的中文回答。",
    "当前窗口是一个轻量聊天气泡，你只能用文字回答，不能打开终端、执行命令、读写文件或调用任何工具。",
    "不要让用户点击任何「Approve」、「允许」按钮，这个 UI 不提供它们。如果用户要求你打开终端、运行脚本、修改代码等需要实际执行的操作，请明确告诉他这里只能聊天，并用文字描述在终端或 Claude Code 主窗口里应该怎么做。",
    "如果问题与代码、终端、文件或项目有关，请优先给出具体步骤。",
    memoryContext ? `本地长期记忆：\n${memoryContext}` : "",
    history ? `最近对话：\n${history}` : "",
    `用户现在的问题：\n${request.message}`,
  ].filter(Boolean).join("\n\n");
}

function runClaudePrintCommand(command: string, prompt: string, chatOnly: boolean, onChunk?: (chunk: string) => void, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, cancelled: true, timedOut: false, exitCode: null, stdout: "", stderr: "", parsedAnswer: "", error: "Claude Code 请求已取消。" });
      return;
    }
    const commandLine = process.platform === "win32" && command.toLowerCase().endsWith(".cmd") ? "cmd.exe" : command;
    const claudeArgs = createClaudePrintArgs(prompt, chatOnly);
    const args = process.platform === "win32" && command.toLowerCase().endsWith(".cmd") ? ["/d", "/s", "/c", command, ...claudeArgs] : claudeArgs;
    let child;
    try {
      child = spawn(commandLine, args, { cwd: app.getPath("home"), env: createCommandEnv(), windowsHide: true, shell: false });
    } catch (error) {
      resolve({ ok: false, cancelled: false, timedOut: false, exitCode: null, stdout: "", stderr: "", parsedAnswer: "", error: error instanceof Error ? error.message : "Claude Code 启动失败。" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const streamParser = createClaudeStreamParser((delta) => {
      const sanitized = sanitizeClaudeStreamChunk(delta);
      if (sanitized) onChunk?.(sanitized);
    });
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      resolve(result);
    };
    const abortHandler = (): void => {
      child.kill();
      finish({ ok: false, cancelled: true, timedOut: false, exitCode: null, stdout: sanitizeClaudeOutput(stdout), stderr: sanitizeClaudeOutput(stderr), parsedAnswer: streamParser.getAnswer(), error: "Claude Code 请求已取消。" });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      finish({ ok: false, cancelled: false, timedOut: true, exitCode: null, stdout: sanitizeClaudeOutput(stdout), stderr: sanitizeClaudeOutput(stderr), parsedAnswer: streamParser.getAnswer(), error: "Claude Code 响应超时。" });
    }, chatOnly ? petHelpChatOnlyTimeoutMs : petHelpTimeoutMs);
    signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = appendBounded(stdout, text);
      streamParser.push(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error: Error) => {
      finish({ ok: false, cancelled: false, timedOut: false, exitCode: null, stdout: sanitizeClaudeOutput(stdout), stderr: sanitizeClaudeOutput(stderr), parsedAnswer: streamParser.getAnswer(), error: error.message });
    });
    child.on("close", (code: number | null) => {
      streamParser.flush();
      finish({ ok: code === 0, cancelled: false, timedOut: false, exitCode: code, stdout: sanitizeClaudeOutput(stdout), stderr: sanitizeClaudeOutput(stderr), parsedAnswer: streamParser.getAnswer() });
    });
  });
}

function createClaudePrintArgs(prompt: string, chatOnly: boolean): readonly string[] {
  const baseArgs = ["--output-format", "stream-json", "--verbose", "--no-session-persistence", "-p", prompt];
  return chatOnly ? ["--tools", "", ...baseArgs] : baseArgs;
}

interface ClaudeStreamParser {
  push(chunk: string): void;
  flush(): void;
  getAnswer(): string;
}

function createClaudeStreamParser(onDelta: (delta: string) => void): ClaudeStreamParser {
  let buffer = "";
  let assistantText = "";
  let emittedText = "";
  let resultText = "";

  const emit = (next: string): void => {
    if (!next || next.length <= emittedText.length) return;
    const delta = next.slice(emittedText.length);
    emittedText = next;
    if (delta) onDelta(delta);
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    const record = event as { type?: unknown; message?: unknown; result?: unknown };
    if (record.type === "assistant" && record.message && typeof record.message === "object") {
      const message = record.message as { content?: unknown };
      const turnText = extractAssistantTurnText(message.content);
      if (turnText) {
        assistantText = assistantText ? `${assistantText}\n\n${turnText}` : turnText;
        emit(assistantText);
      }
      return;
    }
    if (record.type === "result" && typeof record.result === "string" && record.result.trim()) {
      resultText = record.result;
      emit(resultText);
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      if (!buffer) return;
      const remaining = buffer;
      buffer = "";
      handleLine(remaining);
    },
    getAnswer() {
      return (assistantText || resultText).trim();
    },
  };
}

function extractAssistantTurnText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.join("");
}

function getClaudeCommandCandidates(command: string): readonly string[] {
  if (command !== "claude") return [command];
  if (process.platform === "win32") return ["claude", "claude.cmd"];
  return ["claude"];
}

function createCommandEnv(): NodeJS.ProcessEnv {
  const separator = process.platform === "win32" ? ";" : ":";
  const existingPath = process.env.PATH ?? "";
  return { ...process.env, PATH: dedupePathEntries([existingPath, ...getExtraCommandPaths()], separator).join(separator) };
}

function getExtraCommandPaths(): readonly string[] {
  if (process.platform === "win32") return [];
  const home = app.getPath("home");
  const env = process.env;
  return filterExistingPaths([
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    join(home, "bin"),
    join(home, ".local", "bin"),
    join(env.VOLTA_HOME || join(home, ".volta"), "bin"),
    join(env.BUN_INSTALL || join(home, ".bun"), "bin"),
    join(env.MISE_DATA_DIR || join(home, ".local", "share", "mise"), "shims"),
    join(env.ASDF_DATA_DIR || join(home, ".asdf"), "shims"),
    env.PNPM_HOME,
    join(home, ".local", "share", "pnpm"),
    join(home, "Library", "pnpm"),
    join(env.NVM_DIR || join(home, ".nvm"), "current", "bin"),
  ]);
}

function filterExistingPaths(paths: readonly (string | undefined)[]): readonly string[] {
  return paths.filter((path): path is string => Boolean(path && existsSync(path)));
}

function dedupePathEntries(paths: readonly string[], separator: string): readonly string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const path of paths.flatMap((value) => value.split(separator)).filter(Boolean)) {
    if (seen.has(path)) continue;
    seen.add(path);
    entries.push(path);
  }
  return entries;
}

function appendBounded(existing: string, next: string): string {
  const combined = existing + next;
  return combined.length > maxClaudeOutputBytes ? combined.slice(combined.length - maxClaudeOutputBytes) : combined;
}

function sanitizeClaudeStreamChunk(value: string): string {
  return stripAnsi(value);
}

function sanitizeClaudeOutput(value: string): string {
  return stripAnsi(value).trim();
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function isCommandNotFound(result: CommandResult): boolean {
  if (result.cancelled) return false;
  return Boolean(result.error && /ENOENT|not found/i.test(result.error));
}

function summarizeClaudeFailure(result: CommandResult | null): string {
  if (!result) return "Claude Code 启动失败。";
  if (result.cancelled) return "Claude Code 请求已取消。";
  if (result.timedOut) return "Claude Code 响应超时，请稍后再试。";
  const output = result.stderr || result.stdout || result.error || `Claude Code 退出码：${result.exitCode ?? "unknown"}`;
  return sanitizeClaudeOutput(output) || "Claude Code 请求失败。";
}
