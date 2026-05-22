#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const issuePath = join(repoRoot, "issue.md");

const help = `
Usage:
  pnpm record:issue -- --question "..." --solution "..." --architecture "..."

Options:
  -q, --question      Issue or user question to record.
  -s, --solution      Change, answer, or resolution summary.
  -a, --architecture  Related architecture principle.
  -h, --help          Show this help.
`;

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(help.trimStart());
  process.exit(1);
}

if (args.help) {
  process.stdout.write(help.trimStart());
  process.exit(0);
}

const question = normalizeField(args.question);
const solution = normalizeField(args.solution);
const architecture = normalizeField(args.architecture);

const missing = [
  ["question", question],
  ["solution", solution],
  ["architecture", architecture],
].filter(([, value]) => !value).map(([name]) => name);

if (missing.length > 0) {
  console.error(`Missing required option(s): ${missing.join(", ")}`);
  console.error(help.trimStart());
  process.exit(1);
}

await mkdir(dirname(issuePath), { recursive: true });
await appendFile(issuePath, formatEntry(question, solution, architecture), "utf8");
console.log(`Recorded issue entry in ${issuePath}`);

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }

    const inline = arg.match(/^--([^=]+)=(.*)$/u);
    if (inline) {
      assignOption(parsed, inline[1], inline[2]);
      continue;
    }

    if (arg === "-q" || arg === "--question") {
      parsed.question = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "-s" || arg === "--solution") {
      parsed.solution = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "-a" || arg === "--architecture") {
      parsed.architecture = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function assignOption(parsed, name, value) {
  if (name === "question") {
    parsed.question = value;
    return;
  }
  if (name === "solution") {
    parsed.solution = value;
    return;
  }
  if (name === "architecture") {
    parsed.architecture = value;
    return;
  }
  throw new Error(`Unknown option: --${name}`);
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function normalizeField(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim()
    : "";
}

function formatEntry(question, solution, architecture) {
  return `\n问题：${question}\n解决方案：${solution}\n相关架构原理：${architecture}\n`;
}
