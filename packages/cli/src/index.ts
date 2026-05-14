#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

import { allowedReactions, createOpenPetsClient, OpenPetsClientError, type OpenPetsPetListItem, type OpenPetsReaction } from "@open-pets/client";
import { claudeHookEvents, openPetsHookMarker, removeOpenPetsHooks, runClaudeHookFromStdin, validateOpenPetsPetArg } from "@open-pets/claude";
import { buildCursorRulesPreview, buildOpenPetsOnlyPreview, classifyCursorMcpStatus, classifyCursorRulesStatus, executeCursorMcpWrite, executeCursorRulesWrite, getCursorProjectMcpPath, getCursorProjectRulesPath, planCursorMcpInstall, planCursorMcpReplace, planCursorRulesInstall, planCursorRulesRemove, planCursorRulesReplace, readCursorMcpConfig, readCursorOpenPetsRules } from "@open-pets/cursor";
import { prepareOpenCodeProjectSetup, writePreparedOpenCodeProjectSetup } from "@open-pets/opencode";

export const cliPackageName = "@open-pets/cli";

interface ConfigureOptions {
  readonly agent: "claude" | "opencode" | "cursor";
  readonly petId?: string;
  readonly cwd: string;
  readonly yes: boolean;
  readonly force: boolean;
  readonly localDev: boolean;
  readonly cursorRulesMode?: "with" | "only" | "remove";
}

interface InstallOptions {
  readonly petId: string;
}

interface ReactOptions {
  readonly reaction: OpenPetsReaction;
}

interface SayOptions {
  readonly message: string;
  readonly reaction?: OpenPetsReaction;
}

interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
}

interface PreparedHooks {
  readonly settingsPath: string;
  readonly settings: Record<string, unknown>;
}

interface ConfiguredPet {
  readonly id: string;
  readonly displayName: string;
}

const require = createRequire(import.meta.url);

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }
  if (command === "configure") {
    if (hasHelp(args)) {
      printConfigureUsage();
      return;
    }
    await configureProject(parseConfigureArgs(args));
    return;
  }
  if (command === "install") {
    if (hasHelp(args)) {
      printInstallUsage();
      return;
    }
    await installPetFromCatalog(parseInstallArgs(args));
    return;
  }
  if (command === "status") {
    if (hasHelp(args)) {
      printStatusUsage();
      return;
    }
    await showStatus(args);
    return;
  }
  if (command === "pets") {
    if (hasHelp(args)) {
      printPetsUsage();
      return;
    }
    await showPets(args);
    return;
  }
  if (command === "react") {
    if (hasHelp(args)) {
      printReactUsage();
      return;
    }
    await sendReaction(parseReactArgs(args));
    return;
  }
  if (command === "say") {
    if (hasHelp(args)) {
      printSayUsage();
      return;
    }
    await sendMessage(parseSayArgs(args));
    return;
  }
  if (command === "mcp") {
    if (hasHelp(args)) {
      printMcpUsage();
      return;
    }
    await runMcp(args);
    return;
  }
  if (command === "hook") {
    if (hasHelp(args)) {
      printHookUsage();
      return;
    }
    const code = await runClaudeHookFromStdin(process.stdin, { configuredPetId: readPetArg(args), projectLocal: hasProjectLocalArg(args), debug: process.env.OPENPETS_DEBUG === "1" });
    process.exitCode = code;
    return;
  }
  throw new CliError(`Unknown command: ${command}`);
}

async function installPetFromCatalog(options: InstallOptions): Promise<void> {
  const client = createOpenPetsClient({ responseTimeoutMs: 60_000 });
  const result = await client.installPet(options.petId);
  process.stdout.write(`Installed OpenPets pet: ${sanitizeTerminalText(result.displayName)} (${result.petId})\n`);
}

async function showStatus(args: readonly string[]): Promise<void> {
  if (args.length !== 0) throw new CliError(`Unknown status option: ${args[0]}`);
  const result = await createOpenPetsClient().status();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok || !result.appRunning) process.exitCode = 1;
}

async function showPets(args: readonly string[]): Promise<void> {
  if (args.length !== 0) throw new CliError(`Unknown pets option: ${args[0]}`);
  const result = await createOpenPetsClient().listPets();
  for (const pet of result.pets) {
    const flags = [pet.id === result.defaultPetId ? "default" : undefined, pet.broken ? "broken" : undefined].filter(Boolean).join(", ");
    process.stdout.write(`${sanitizeTerminalText(pet.displayName)} (${pet.id})${flags ? ` [${flags}]` : ""}\n`);
  }
}

async function sendReaction(options: ReactOptions): Promise<void> {
  await createOpenPetsClient().react(options.reaction);
  process.stdout.write(`OpenPets reaction sent: ${options.reaction}\n`);
}

async function sendMessage(options: SayOptions): Promise<void> {
  await createOpenPetsClient().say(options.message, options.reaction ? { reaction: options.reaction } : undefined);
  process.stdout.write("OpenPets message sent.\n");
}

export async function configureProject(options: ConfigureOptions): Promise<void> {
  const projectDir = resolveProjectDir(options.cwd);
  if (options.agent === "cursor") {
    await configureCursorProject(options, projectDir);
    return;
  }
  if (options.agent === "opencode") {
    await configureOpenCodeProject(options, projectDir);
    return;
  }
  assertClaudeAvailable();
  assertSafeProjectHookPath(projectDir);
  const client = createOpenPetsClient();
  const selectedPet = await resolveConfiguredPet(client, options.petId);
  const petId = selectedPet.id;
  const packageVersion = getPackageVersion();
  const mcpCommand = options.localDev ? createLocalDevCliCommand(["mcp", "--pet", petId]) : createVersionPinnedCliCommand(packageVersion, ["mcp", "--pet", petId]);
  const hookCommand = formatShellCommand(options.localDev ? createLocalDevCliCommand(["hook", openPetsHookMarker, "--project-local", "--pet", petId]) : createVersionPinnedCliCommand(packageVersion, ["hook", openPetsHookMarker, "--project-local", "--pet", petId]));
  const mcpConfig = { type: "stdio", command: mcpCommand.command, args: mcpCommand.args, env: {} };
  const preparedHooks = prepareProjectLocalHooks(projectDir, hookCommand);
  runClaudeMcpAddJson(projectDir, mcpConfig, options.force);
  writePreparedHooks(preparedHooks);
  process.stdout.write(`OpenPets configured for Claude in ${projectDir}.\nPet: ${sanitizeTerminalText(selectedPet.displayName)} (${selectedPet.id})\n`);
}

async function configureCursorProject(options: ConfigureOptions, projectDir: string): Promise<void> {
  const configPath = getCursorProjectMcpPath(projectDir);
  const rulesPath = getCursorProjectRulesPath(projectDir);

  if (options.cursorRulesMode === "only") {
    configureCursorRulesOnly(projectDir, rulesPath, options.force);
    return;
  }

  if (options.cursorRulesMode === "remove") {
    removeCursorRulesOnly(projectDir, rulesPath);
    return;
  }

  const client = createOpenPetsClient();
  const selectedPet = await resolveConfiguredPet(client, options.petId);
  const packageVersion = getPackageVersion();
  const previewOptions = { mcpVersion: packageVersion, petId: selectedPet.id, commandMode: options.localDev ? "local" as const : "published" as const, mcpEntryPath: options.localDev ? require.resolve("@open-pets/mcp") : undefined };
  const readResult = readCursorMcpConfig(configPath);
  const status = classifyCursorMcpStatus(readResult, configPath, previewOptions);
  process.stdout.write(`Cursor config: ${configPath}\nStatus: ${status.status} - ${status.message}\nOpenPets MCP preview:\n${JSON.stringify(buildOpenPetsOnlyPreview(previewOptions), null, 2)}\n`);

  const rulesRequested = options.cursorRulesMode === "with";
  const rulesReadResult = rulesRequested ? readCursorOpenPetsRules(projectDir) : undefined;
  const rulesStatus = rulesReadResult ? classifyCursorRulesStatus(rulesReadResult, rulesPath) : undefined;
  if (rulesStatus) {
    process.stdout.write(`Cursor rules: ${rulesPath}\nRules status: ${rulesStatus.status} - ${rulesStatus.message}\nOpenPets rules preview:\n${buildCursorRulesPreview()}\n`);
  }

  if (status.status === "installed" && (!rulesRequested || rulesStatus?.status === "installed")) {
    process.stdout.write(`OpenPets is already configured for Cursor in ${projectDir}.\nRestart or reload Cursor or start a new chat in this project to load OpenPets.\n`);
    return;
  }
  if (status.status === "invalid" || status.status === "error") {
    throw new CliError(`${status.message} Fix ${configPath}, then rerun setup.`);
  }
  if (status.status === "conflict" && !options.force) {
    throw new CliError(`Cursor already has a non-OpenPets openpets MCP entry. Rerun with --force to replace only mcpServers.openpets.`);
  }
  if (rulesStatus && (rulesStatus.status === "invalid" || rulesStatus.status === "error")) {
    throw new CliError(`${rulesStatus.message} Fix ${rulesPath}, then rerun setup.`);
  }
  if (rulesStatus?.status === "conflict" && !options.force) {
    throw new CliError("Cursor already has .cursor/rules/openpets.mdc with user content. Rerun with --force to replace only that file.");
  }

  const plan = status.status === "installed" ? undefined : status.status === "conflict" ? planCursorMcpReplace(configPath, previewOptions) : planCursorMcpInstall(configPath, previewOptions, options.force);
  if (plan && "ok" in plan) throw new CliError(plan.message);
  const rulesPlan = rulesRequested && rulesStatus?.status !== "installed" ? rulesStatus?.status === "conflict" ? planCursorRulesReplace(projectDir) : planCursorRulesInstall(projectDir, options.force) : undefined;
  if (rulesPlan && "ok" in rulesPlan) throw new CliError(rulesPlan.message);

  if (plan) executeCursorMcpWrite(plan);
  if (rulesPlan) executeCursorRulesWrite(rulesPlan);

  const backups = [plan?.backupPath ? `MCP backup: ${plan.backupPath}` : undefined, rulesPlan?.backupPath ? `Rules backup: ${rulesPlan.backupPath}` : undefined].filter(Boolean).join("\n");
  process.stdout.write(`OpenPets configured for Cursor in ${projectDir}.\nPet: ${sanitizeTerminalText(selectedPet.displayName)} (${selectedPet.id})\n${backups ? `${backups}\n` : ""}Restart or reload Cursor or start a new chat in this project to load OpenPets.\nTo remove MCP, delete mcpServers.openpets from ${configPath}. To remove rules, run with --remove-rules.\n`);
}

function configureCursorRulesOnly(projectDir: string, rulesPath: string, force: boolean): void {
  const readResult = readCursorOpenPetsRules(projectDir);
  const status = classifyCursorRulesStatus(readResult, rulesPath);
  process.stdout.write(`Cursor rules: ${rulesPath}\nRules status: ${status.status} - ${status.message}\nOpenPets rules preview:\n${buildCursorRulesPreview()}\n`);
  if (status.status === "installed") {
    process.stdout.write("OpenPets Cursor rules are already installed. Cursor may use changed rules in a new or refreshed chat.\n");
    return;
  }
  if (status.status === "invalid" || status.status === "error") throw new CliError(`${status.message} Fix ${rulesPath}, then rerun setup.`);
  if (status.status === "conflict" && !force) throw new CliError("Cursor already has .cursor/rules/openpets.mdc with user content. Rerun with --force to replace only that file.");
  const plan = status.status === "conflict" ? planCursorRulesReplace(projectDir) : planCursorRulesInstall(projectDir, force);
  if ("ok" in plan) throw new CliError(plan.message);
  executeCursorRulesWrite(plan);
  process.stdout.write(`Installed OpenPets Cursor rules in ${projectDir}.\nRules file: ${rulesPath}\n${plan.backupPath ? `Backup: ${plan.backupPath}\n` : ""}Cursor may use changed rules in a new or refreshed chat.\n`);
}

function removeCursorRulesOnly(projectDir: string, rulesPath: string): void {
  const readResult = readCursorOpenPetsRules(projectDir);
  const status = classifyCursorRulesStatus(readResult, rulesPath);
  process.stdout.write(`Cursor rules: ${rulesPath}\nRules status: ${status.status} - ${status.message}\n`);
  if (status.status === "missing") {
    process.stdout.write("OpenPets Cursor rules are already absent.\n");
    return;
  }
  if (status.status === "invalid" || status.status === "error") throw new CliError(`${status.message} Fix ${rulesPath}, then rerun setup.`);
  if (status.status === "conflict") throw new CliError("Cannot remove .cursor/rules/openpets.mdc because it is not managed by OpenPets.");
  const plan = planCursorRulesRemove(projectDir);
  if ("ok" in plan) throw new CliError(plan.message);
  executeCursorRulesWrite(plan);
  process.stdout.write(`Removed OpenPets Cursor rules from ${projectDir}.\n${plan.backupPath ? `Backup: ${plan.backupPath}\n` : ""}Cursor may use changed rules in a new or refreshed chat.\n`);
}

async function configureOpenCodeProject(options: ConfigureOptions, projectDir: string): Promise<void> {
  const client = createOpenPetsClient();
  const selectedPet = await resolveConfiguredPet(client, options.petId);
  const packageVersion = getPackageVersion();
  const prepared = prepareOpenCodeProjectSetup({ projectDir, petId: selectedPet.id, cliVersion: packageVersion, commandMode: options.localDev ? "local" : "published", cliEntryPath: options.localDev ? fileURLToPath(import.meta.url) : undefined });
  writePreparedOpenCodeProjectSetup(prepared);
  process.stdout.write(`OpenPets configured for OpenCode in ${projectDir}.\nPet: ${sanitizeTerminalText(selectedPet.displayName)} (${selectedPet.id})\nConfig: ${prepared.configPath}\nInstructions: ${prepared.instructionPath}\nWarning: .opencode config/instructions can be committed and include the selected pet id.\nRestart OpenCode in this project to load OpenPets.\n`);
}

export async function resolveConfiguredPet(client: Pick<ReturnType<typeof createOpenPetsClient>, "listPets">, petId?: string): Promise<ConfiguredPet> {
  if (petId) {
    const id = validateOpenPetsPetArg(petId);
    return { id, displayName: id };
  }

  const petList = await getInstalledPets(client);
  const id = validateOpenPetsPetArg(await pickPet(petList.pets));
  const selectedPet = petList.pets.find((pet) => pet.id === id);
  if (!selectedPet || selectedPet.broken) throw new CliError(`Pet is not installed or usable: ${id}`);
  return { id: selectedPet.id, displayName: selectedPet.displayName };
}

export function parseConfigureArgs(args: readonly string[]): ConfigureOptions {
  let agent = "claude";
  let petId: string | undefined;
  let cwd = process.cwd();
  let yes = false;
  let force = false;
  let localDev = false;
  let cursorRulesMode: ConfigureOptions["cursorRulesMode"];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--force" || arg === "--replace") force = true;
    else if (arg === "--local-dev") localDev = true;
    else if (arg === "--with-rules") cursorRulesMode = setCursorRulesMode(cursorRulesMode, "with");
    else if (arg === "--rules-only") cursorRulesMode = setCursorRulesMode(cursorRulesMode, "only");
    else if (arg === "--remove-rules") cursorRulesMode = setCursorRulesMode(cursorRulesMode, "remove");
    else if (arg === "--agent") { agent = readRequiredArg(args, index, "--agent"); index += 1; }
    else if (arg.startsWith("--agent=")) agent = arg.slice("--agent=".length);
    else if (arg === "--pet") { petId = validateOpenPetsPetArg(readRequiredArg(args, index, "--pet")); index += 1; }
    else if (arg.startsWith("--pet=")) petId = validateOpenPetsPetArg(arg.slice("--pet=".length));
    else if (arg === "--cwd") { cwd = readRequiredArg(args, index, "--cwd"); index += 1; }
    else if (arg.startsWith("--cwd=")) cwd = arg.slice("--cwd=".length);
    else throw new CliError(`Unknown configure option: ${arg}`);
  }
  if (agent !== "claude" && agent !== "opencode" && agent !== "cursor") throw new CliError(`Unsupported agent: ${agent}. Supported agents: claude, opencode, cursor.`);
  if (cursorRulesMode && agent !== "cursor") throw new CliError("Cursor rules flags require --agent cursor.");
  return { agent, petId, cwd, yes, force, localDev, cursorRulesMode };
}

function setCursorRulesMode(current: ConfigureOptions["cursorRulesMode"], next: ConfigureOptions["cursorRulesMode"]): ConfigureOptions["cursorRulesMode"] {
  if (current && current !== next) throw new CliError("Use only one of --with-rules, --rules-only, or --remove-rules.");
  return next;
}

export function parseInstallArgs(args: readonly string[]): InstallOptions {
  if (args.length !== 1) throw new CliError("Usage: openpets install <pet-id>");
  return { petId: validateOpenPetsPetArg(args[0] ?? "") };
}

export function parseReactArgs(args: readonly string[]): ReactOptions {
  if (args.length !== 1) throw new CliError("Usage: openpets react <reaction>");
  return { reaction: parseReaction(args[0] ?? "") };
}

export function parseSayArgs(args: readonly string[]): SayOptions {
  let reaction: OpenPetsReaction | undefined;
  const messageParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--reaction") {
      reaction = parseReaction(readRequiredArg(args, index, "--reaction"));
      index += 1;
    } else if (arg.startsWith("--reaction=")) {
      reaction = parseReaction(arg.slice("--reaction=".length));
    } else if (arg.startsWith("--")) {
      throw new CliError(`Unknown say option: ${arg}`);
    } else {
      messageParts.push(arg);
    }
  }
  const message = messageParts.join(" ").trim();
  if (!message) throw new CliError("Usage: openpets say <message> [--reaction <reaction>]");
  return { message, reaction };
}

function parseReaction(value: string): OpenPetsReaction {
  if (!allowedReactions.includes(value as OpenPetsReaction)) {
    throw new CliError(`Invalid OpenPets reaction: ${value}. Allowed reactions: ${allowedReactions.join(", ")}.`);
  }
  return value as OpenPetsReaction;
}

export function createVersionPinnedCliCommand(version: string, args: readonly string[]): CommandSpec {
  return { command: "npx", args: ["-y", `${cliPackageName}@${version}`, ...args] };
}

export function createLocalDevCliCommand(args: readonly string[]): CommandSpec {
  return { command: process.execPath, args: [fileURLToPath(import.meta.url), ...args] };
}

export function createClaudeMcpAddJsonArgs(config: unknown): readonly string[] {
  return ["mcp", "add-json", "openpets", JSON.stringify(config), "--scope", "local"];
}

export function installProjectLocalHooks(projectDir: string, hookCommand: string): void {
  writePreparedHooks(prepareProjectLocalHooks(projectDir, hookCommand));
}

export function prepareProjectLocalHooks(projectDir: string, hookCommand: string): PreparedHooks {
  assertSafeProjectHookPath(projectDir);
  const settingsPath = getProjectLocalSettingsPath(realpathSync(projectDir));
  const current = readJsonObject(settingsPath);
  const cleaned = removeOpenPetsHooks(current);
  const hooks = isRecord(cleaned.hooks) ? { ...cleaned.hooks } : {};
  for (const event of claudeHookEvents) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new CliError(`Claude local settings hooks.${event} must be an array.`);
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...existing, { hooks: [createHookCommandEntry(hookCommand)] }];
  }
  return { settingsPath, settings: { ...cleaned, hooks } };
}

function writePreparedHooks(prepared: PreparedHooks): void {
  writeJsonFile(prepared.settingsPath, prepared.settings);
}

function createHookCommandEntry(command: string): Record<string, unknown> {
  return { type: "command", command, timeout: 10, async: true, asyncRewake: false };
}

export function runClaudeMcpAddJson(projectDir: string, config: unknown, force = false): void {
  if (force) runClaudeMcpRemove(projectDir);
  const result = spawnSync("claude", createClaudeMcpAddJsonArgs(config), { cwd: projectDir, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  if (result.error) throw new CliError(`Claude Code is unavailable on PATH: ${result.error.message}`);
  if (result.status !== 0) throw new CliError(`Claude MCP configuration failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
}

function runClaudeMcpRemove(projectDir: string): void {
  const result = spawnSync("claude", ["mcp", "remove", "openpets", "--scope", "local"], { cwd: projectDir, encoding: "utf8", shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  if (result.error) throw new CliError(`Claude Code is unavailable on PATH: ${result.error.message}`);
  const output = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (result.status !== 0 && !/not found|does not exist|no server|unknown/i.test(output)) {
    throw new CliError(`Claude MCP remove failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
}

async function runMcp(args: readonly string[]): Promise<void> {
  const entry = require.resolve("@open-pets/mcp");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit" });
    const forwardSigint = (): void => { child.kill("SIGINT"); };
    const forwardSigterm = (): void => { child.kill("SIGTERM"); };
    process.once("SIGINT", forwardSigint);
    process.once("SIGTERM", forwardSigterm);
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forwardSigint);
      process.off("SIGTERM", forwardSigterm);
      if (signal) { process.kill(process.pid, signal); return; }
      process.exitCode = code ?? 1;
      resolvePromise();
    });
  });
}

async function getInstalledPets(client: Pick<ReturnType<typeof createOpenPetsClient>, "listPets">) {
  try {
    return await client.listPets();
  } catch (error) {
    if (error instanceof OpenPetsClientError && error.code === "unknown_method") throw new CliError("OpenPets desktop app is too old for project setup. Update/restart OpenPets and try again.");
    throw new CliError("OpenPets desktop app is not running. Open OpenPets, then run this command again.");
  }
}

async function pickPet(pets: readonly OpenPetsPetListItem[]): Promise<string> {
  const usable = pets.filter((pet) => !pet.broken);
  if (usable.length === 0) throw new CliError("No usable installed pets found. Open OpenPets and install a pet first.");
  if (!process.stdin.isTTY) throw new CliError("Missing --pet <id>. Non-interactive shells must pass --pet.");
  process.stdout.write("Pick pet for this project:\n");
  usable.forEach((pet, index) => process.stdout.write(`  ${index + 1}. ${sanitizeTerminalText(pet.displayName)} (${pet.id})\n`));
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question("Pet number: ");
    const index = Number(answer.trim()) - 1;
    if (!Number.isInteger(index) || !usable[index]) throw new CliError("Invalid pet selection.");
    return usable[index].id;
  } finally {
    rl.close();
  }
}

function sanitizeTerminalText(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, "").slice(0, 100);
}

function resolveProjectDir(cwd: string): string {
  const resolved = resolve(cwd);
  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink()) throw new CliError("Project directory cannot be a symlink.");
  if (!stats.isDirectory()) throw new CliError("Project path must be a directory.");
  return realpathSync(resolved);
}

function assertClaudeAvailable(): void {
  const result = spawnSync("claude", ["--version"], { shell: false, stdio: "ignore", timeout: 5_000 });
  if (result.error || result.status !== 0) throw new CliError("Claude Code is unavailable on PATH. Install Claude Code, then try again.");
}

export function assertSafeProjectHookPath(projectDir: string): void {
  const projectReal = realpathSync(projectDir);
  const claudeDir = join(projectReal, ".claude");
  if (existsSync(claudeDir)) {
    const claudeStats = lstatSync(claudeDir);
    if (claudeStats.isSymbolicLink()) throw new CliError("Project .claude directory cannot be a symlink.");
    if (!claudeStats.isDirectory()) throw new CliError("Project .claude path must be a directory.");
    const rel = relative(projectReal, realpathSync(claudeDir));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new CliError("Project .claude directory escapes the project.");
  }
  const settingsPath = getProjectLocalSettingsPath(projectReal);
  if (existsSync(settingsPath)) {
    const settingsStats = lstatSync(settingsPath);
    if (settingsStats.isSymbolicLink()) throw new CliError("Project Claude local settings file cannot be a symlink.");
    if (!settingsStats.isFile()) throw new CliError("Project Claude local settings path must be a file.");
  }
  const settingsRel = relative(projectReal, resolve(settingsPath));
  if (settingsRel.startsWith("..") || isAbsolute(settingsRel)) throw new CliError("Project Claude local settings path escapes the project.");
}

function getProjectLocalSettingsPath(projectDir: string): string {
  return join(projectDir, ".claude", "settings.local.json");
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed) || Array.isArray(parsed)) throw new CliError("Claude local settings must be a JSON object.");
  if (parsed.hooks !== undefined && !isRecord(parsed.hooks)) throw new CliError("Claude local settings hooks field must be an object.");
  return parsed;
}

function writeJsonFile(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parentStats = lstatSync(dirname(path));
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) throw new CliError("Project .claude directory is unsafe after creation.");
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tempPath, path);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

function readPetArg(args: readonly string[]): string | undefined {
  const equals = args.find((arg) => arg.startsWith("--pet="));
  if (equals) return validateOpenPetsPetArg(equals.slice("--pet=".length));
  const index = args.indexOf("--pet");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && (!value || value.startsWith("--"))) throw new CliError("Missing value for --pet.");
  return value && value.length > 0 ? validateOpenPetsPetArg(value) : undefined;
}

function hasProjectLocalArg(args: readonly string[]): boolean {
  return args.includes("--project-local");
}

function readRequiredArg(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new CliError(`Missing value for ${flag}.`);
  return value;
}

function formatShellCommand(command: CommandSpec): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) return value;
  if (/[\r\n"]/.test(value) || value.includes("\0")) throw new CliError("Command argument contains unsupported shell characters.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function getPackageVersion(): string {
  const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as unknown;
  if (!isRecord(parsed) || typeof parsed.version !== "string") throw new CliError("Cannot read OpenPets CLI package version.");
  return parsed.version;
}

function printUsage(): void {
  process.stdout.write("Usage:\n  openpets status\n  openpets pets\n  openpets react <reaction>\n  openpets say <message> [--reaction <reaction>]\n  openpets install <pet-id>\n  openpets configure [--agent claude|opencode|cursor] [--pet <id>] [--cwd <path>] [--yes] [--force] [--with-rules|--rules-only|--remove-rules]\n  openpets mcp [--pet <id>]\n  openpets hook --openpets-managed [--pet <id>]\n\nRun `openpets <command> --help` for command options.\n");
}

function printInstallUsage(): void {
  process.stdout.write("Usage:\n  openpets install <pet-id>\n\nDownloads a gallery pet through the running OpenPets desktop app and installs it locally.\n");
}

function printStatusUsage(): void {
  process.stdout.write("Usage:\n  openpets status\n\nChecks whether the OpenPets desktop app is reachable and prints the status response as JSON.\n");
}

function printPetsUsage(): void {
  process.stdout.write("Usage:\n  openpets pets\n\nLists pets installed in the running OpenPets desktop app.\n");
}

function printReactUsage(): void {
  process.stdout.write(`Usage:\n  openpets react <reaction>\n\nSends a reaction to the running OpenPets desktop app.\nAllowed reactions: ${allowedReactions.join(", ")}.\n`);
}

function printSayUsage(): void {
  process.stdout.write(`Usage:\n  openpets say <message> [--reaction <reaction>]\n\nShows a short message in the running OpenPets desktop app. Optionally sends a reaction with the message.\nAllowed reactions: ${allowedReactions.join(", ")}.\n`);
}

function printConfigureUsage(): void {
  process.stdout.write("Usage:\n  openpets configure [--agent claude|opencode|cursor] [--pet <id>] [--cwd <path>] [--yes] [--force] [--with-rules|--rules-only|--remove-rules]\n\nOptions:\n  --pet <id>           Pet id to use for this project. If omitted, prompts with installed pets. Cursor --rules-only/--remove-rules do not need a pet.\n  --agent <agent>      Agent to configure: claude, opencode, or cursor. Defaults to claude.\n  --cwd <path>         Project directory to configure. Defaults to current directory. Cursor uses <cwd>/.cursor/mcp.json and <cwd>/.cursor/rules/openpets.mdc; global Cursor setup is not enabled here.\n  --with-rules         For Cursor, install MCP config and project rules after preflighting both writes.\n  --rules-only         For Cursor, install/update only .cursor/rules/openpets.mdc.\n  --remove-rules       For Cursor, remove only managed .cursor/rules/openpets.mdc.\n  --yes, -y            Accepted for scripts; no confirmation prompt is shown.\n  --force              Replace supported managed entries where applicable. Required for conflicting Cursor rules.\n  --replace            Alias for --force.\n  --local-dev          Use local development command paths where supported.\n  -h, --help           Show this help.\n");
}

function printMcpUsage(): void {
  process.stdout.write("Usage:\n  openpets mcp [--pet <id>]\n\nStarts the OpenPets MCP server wrapper. This command is written into Claude MCP config by `openpets configure`.\n");
}

function printHookUsage(): void {
  process.stdout.write("Usage:\n  openpets hook --openpets-managed [--pet <id>]\n\nRuns one Claude hook event from stdin. This command is written into Claude project hooks by `openpets configure`.\n");
}

function hasHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class CliError extends Error {}

if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}
