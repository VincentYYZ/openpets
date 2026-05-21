import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { app } from "electron";
import { join } from "node:path";

import { getAppStateSnapshot } from "./app-state.js";
import { buildPetMemoryContext } from "./pet-memory-context.js";

export interface PetHelpTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface PetHelpAskRequest {
  readonly message: string;
  readonly history: readonly PetHelpTurn[];
}

interface CommandResult {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

const petHelpTimeoutMs = 120_000;
const petHelpChatOnlyTimeoutMs = 45_000;
const maxClaudeOutputBytes = 96_000;

export async function askPetHelpWithClaude(request: PetHelpAskRequest): Promise<{ readonly answer: string }> {
  const prompt = createClaudePetHelpPrompt(request);
  const command = getAppStateSnapshot().preferences.claudeCommandPath || "claude";
  const chatOnly = shouldUseChatOnlyClaudeMode(request);
  let lastResult: CommandResult | null = null;

  for (const candidate of getClaudeCommandCandidates(command)) {
    const result = await runClaudePrintCommand(candidate, prompt, chatOnly);
    lastResult = result;
    if (result.ok) {
      const answer = sanitizeClaudeOutput(result.stdout || result.stderr);
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
    "如果问题与代码、终端、文件或项目有关，请优先给出具体步骤。",
    memoryContext ? `本地长期记忆：\n${memoryContext}` : "",
    history ? `最近对话：\n${history}` : "",
    `用户现在的问题：\n${request.message}`,
  ].filter(Boolean).join("\n\n");
}

function runClaudePrintCommand(command: string, prompt: string, chatOnly: boolean): Promise<CommandResult> {
  return new Promise((resolve) => {
    const commandLine = process.platform === "win32" && command.toLowerCase().endsWith(".cmd") ? "cmd.exe" : command;
    const claudeArgs = createClaudePrintArgs(prompt, chatOnly);
    const args = process.platform === "win32" && command.toLowerCase().endsWith(".cmd") ? ["/d", "/s", "/c", command, ...claudeArgs] : claudeArgs;
    let child;
    try {
      child = spawn(commandLine, args, { cwd: app.getPath("home"), env: createCommandEnv(), windowsHide: true, shell: false });
    } catch (error) {
      resolve({ ok: false, timedOut: false, exitCode: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : "Claude Code 启动失败。" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, timedOut: true, exitCode: null, stdout: sanitizeClaudeOutput(stdout), stderr: sanitizeClaudeOutput(stderr), error: "Claude Code 响应超时。" });
    }, chatOnly ? petHelpChatOnlyTimeoutMs : petHelpTimeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk.toString("utf8")); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk.toString("utf8")); });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, exitCode: null, stdout: sanitizeClaudeOutput(stdout), stderr: sanitizeClaudeOutput(stderr), error: error.message });
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, timedOut: false, exitCode: code, stdout: sanitizeClaudeOutput(stdout), stderr: sanitizeClaudeOutput(stderr) });
    });
  });
}

function createClaudePrintArgs(prompt: string, chatOnly: boolean): readonly string[] {
  const baseArgs = ["--output-format", "text", "--no-session-persistence", "-p", prompt];
  return chatOnly ? ["--tools", "", ...baseArgs] : baseArgs;
}

function shouldUseChatOnlyClaudeMode(request: PetHelpAskRequest): boolean {
  const text = `${request.message}\n${request.history.slice(-4).map((turn) => turn.content).join("\n")}`;
  if (/(代码|项目|仓库|文件|终端|命令|报错|错误|bug|修复|实现|函数|类|接口|TypeScript|JavaScript|Electron|pnpm|npm|git|PowerShell|Windows|macOS|路径|目录|构建|打包|测试|日志|配置|API|JSON|IPC|MCP|Claude Code|OpenPets)/i.test(text)) {
    return false;
  }
  return true;
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

function sanitizeClaudeOutput(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "").trim();
}

function isCommandNotFound(result: CommandResult): boolean {
  return Boolean(result.error && /ENOENT|not found/i.test(result.error));
}

function summarizeClaudeFailure(result: CommandResult | null): string {
  if (!result) return "Claude Code 启动失败。";
  if (result.timedOut) return "Claude Code 响应超时，请稍后再试。";
  const output = result.stderr || result.stdout || result.error || `Claude Code 退出码：${result.exitCode ?? "unknown"}`;
  return sanitizeClaudeOutput(output) || "Claude Code 请求失败。";
}
