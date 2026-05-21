import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { app } from "electron";

import { info, warn } from "./logger.js";
import type { ExtractedPetMemoryFact, PetMemoryKind } from "./pet-memory-extractor.js";

export interface PetMemoryFact {
  readonly id: string;
  readonly kind: PetMemoryKind;
  readonly text: string;
  readonly confidence: number;
  readonly source: "conversation" | "manual";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt?: string;
}

export interface PetMemoryConversationSummary {
  readonly id: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface PetMemoryState {
  readonly version: 1;
  readonly enabled: boolean;
  readonly facts: readonly PetMemoryFact[];
  readonly conversations: readonly PetMemoryConversationSummary[];
  readonly updatedAt: string;
}

export interface PetMemorySnapshot {
  readonly enabled: boolean;
  readonly storagePath: string;
  readonly facts: readonly PetMemoryFact[];
  readonly conversations: readonly PetMemoryConversationSummary[];
  readonly updatedAt: string;
}

const memoryFileName = "openpets-memory.json";
const maxFacts = 120;
const maxConversations = 80;
const maxFactTextLength = 260;
const maxConversationSummaryLength = 900;

let memoryPath: string | null = null;
let currentMemory: PetMemoryState | null = null;

export function initializePetMemoryStore(): void {
  memoryPath = join(app.getPath("userData"), memoryFileName);
  const state = normalizeMemoryState(readMemoryFile(memoryPath));
  writeMemoryToDisk(state);
  currentMemory = state;
  info("pet.memory", "memory store initialized", { path: memoryPath, enabled: state.enabled, facts: state.facts.length, conversations: state.conversations.length });
}

export function getPetMemorySnapshot(): PetMemorySnapshot {
  const state = getInitializedMemory();
  return {
    enabled: state.enabled,
    storagePath: getPetMemoryPath(),
    facts: state.facts.map((fact) => ({ ...fact })),
    conversations: state.conversations.map((conversation) => ({ ...conversation })),
    updatedAt: state.updatedAt,
  };
}

export function setPetMemoryEnabled(enabled: boolean): PetMemorySnapshot {
  const state = getInitializedMemory();
  commitMemory({ ...state, enabled, updatedAt: new Date().toISOString() });
  return getPetMemorySnapshot();
}

export function clearPetMemory(): PetMemorySnapshot {
  commitMemory(createDefaultMemoryState());
  return getPetMemorySnapshot();
}

export function deletePetMemoryFact(id: string): PetMemorySnapshot {
  const state = getInitializedMemory();
  const nextFacts = state.facts.filter((fact) => fact.id !== id);
  commitMemory({ ...state, facts: nextFacts, updatedAt: new Date().toISOString() });
  return getPetMemorySnapshot();
}

export function recordPetHelpMemory(summary: string, facts: readonly ExtractedPetMemoryFact[]): PetMemorySnapshot {
  const state = getInitializedMemory();
  if (!state.enabled) return getPetMemorySnapshot();

  const now = new Date().toISOString();
  const nextConversations = normalizeConversationSummary(summary)
    ? [{ id: createMemoryId("conv"), summary: normalizeConversationSummary(summary), createdAt: now }, ...state.conversations].slice(0, maxConversations)
    : state.conversations;
  const nextFacts = mergeFacts(state.facts, facts, now).slice(0, maxFacts);
  commitMemory({ ...state, facts: nextFacts, conversations: nextConversations, updatedAt: now });
  return getPetMemorySnapshot();
}

export function markPetMemoryFactsUsed(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const state = getInitializedMemory();
  const idSet = new Set(ids);
  const now = new Date().toISOString();
  const nextFacts = state.facts.map((fact) => idSet.has(fact.id) ? { ...fact, lastUsedAt: now } : fact);
  commitMemory({ ...state, facts: nextFacts, updatedAt: now });
}

export function getPetMemoryPath(): string {
  if (!memoryPath) throw new Error("OpenPets pet memory has not been initialized.");
  return memoryPath;
}

function mergeFacts(existingFacts: readonly PetMemoryFact[], incomingFacts: readonly ExtractedPetMemoryFact[], now: string): PetMemoryFact[] {
  const facts = [...existingFacts];

  for (const incoming of incomingFacts) {
    const text = normalizeFactText(incoming.text);
    if (!text) continue;
    const existingIndex = facts.findIndex((fact) => fact.kind === incoming.kind && areSimilarFacts(fact.text, text));
    if (existingIndex >= 0) {
      const existing = facts[existingIndex];
      facts[existingIndex] = {
        ...existing,
        text: text.length > existing.text.length ? text : existing.text,
        confidence: Math.max(existing.confidence, normalizeConfidence(incoming.confidence)),
        updatedAt: now,
      };
      continue;
    }

    facts.unshift({
      id: createMemoryId("fact"),
      kind: incoming.kind,
      text,
      confidence: normalizeConfidence(incoming.confidence),
      source: "conversation",
      createdAt: now,
      updatedAt: now,
    });
  }

  return facts.sort((a, b) => scoreFact(b) - scoreFact(a));
}

function scoreFact(fact: PetMemoryFact): number {
  const updated = Date.parse(fact.updatedAt) || 0;
  return fact.confidence * 10_000_000_000_000 + updated;
}

function areSimilarFacts(a: string, b: string): boolean {
  const left = normalizeSimilarityText(a);
  const right = normalizeSimilarityText(b);
  if (left === right) return true;
  if (left.length >= 18 && right.includes(left)) return true;
  if (right.length >= 18 && left.includes(right)) return true;
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / Math.max(leftTokens.size, rightTokens.size) >= 0.72;
}

function tokenize(value: string): readonly string[] {
  return value.split(/[^a-z0-9\u4e00-\u9fff]+/iu).filter((token) => token.length >= 2);
}

function normalizeSimilarityText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "").replace(/[，。,.!?！？：:；;]/g, "");
}

function normalizeMemoryState(value: unknown): PetMemoryState {
  const record = isRecord(value) ? value : {};
  const conversations = Array.isArray(record.conversations) ? record.conversations.map(normalizeConversation).filter((conversation): conversation is PetMemoryConversationSummary => Boolean(conversation)).slice(0, maxConversations) : [];
  const facts = Array.isArray(record.facts) ? record.facts.map(normalizeFact).filter((fact): fact is PetMemoryFact => Boolean(fact)).slice(0, maxFacts) : [];
  return {
    version: 1,
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    facts: migrateFactsFromConversationSummaries(facts, conversations).slice(0, maxFacts),
    conversations,
    updatedAt: normalizeIsoString(record.updatedAt) ?? new Date().toISOString(),
  };
}

function normalizeFact(value: unknown): PetMemoryFact | null {
  if (!isRecord(value)) return null;
  if (!isMemoryKind(value.kind)) return null;
  const text = normalizeFactText(value.text);
  if (!text) return null;
  const now = new Date().toISOString();
  return {
    id: normalizeId(value.id, "fact"),
    kind: value.kind,
    text,
    confidence: normalizeConfidence(value.confidence),
    source: value.source === "manual" ? "manual" : "conversation",
    createdAt: normalizeIsoString(value.createdAt) ?? now,
    updatedAt: normalizeIsoString(value.updatedAt) ?? now,
    lastUsedAt: normalizeIsoString(value.lastUsedAt),
  };
}

function normalizeConversation(value: unknown): PetMemoryConversationSummary | null {
  if (!isRecord(value)) return null;
  const summary = normalizeConversationSummary(value.summary);
  if (!summary) return null;
  return {
    id: normalizeId(value.id, "conv"),
    summary,
    createdAt: normalizeIsoString(value.createdAt) ?? new Date().toISOString(),
  };
}

function normalizeFactText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxFactTextLength);
}

function normalizeConversationSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxConversationSummaryLength);
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.7;
  return Number(Math.min(Math.max(value, 0.1), 1).toFixed(2));
}

function normalizeIsoString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizeId(value: unknown, prefix: "fact" | "conv"): string {
  return typeof value === "string" && new RegExp(`^${prefix}-[a-z0-9-]{8,80}$`, "u").test(value) ? value : createMemoryId(prefix);
}

function isMemoryKind(value: unknown): value is PetMemoryKind {
  return value === "user_profile" || value === "user_preference" || value === "project_fact" || value === "pet_persona" || value === "workflow" || value === "constraint";
}

function migrateFactsFromConversationSummaries(facts: readonly PetMemoryFact[], conversations: readonly PetMemoryConversationSummary[]): PetMemoryFact[] {
  const migrated = [...facts];
  if (migrated.some((fact) => fact.kind === "user_profile" && /名字是/.test(fact.text))) {
    return migrated;
  }

  for (const conversation of conversations) {
    const name = extractUserNameFromSummary(conversation.summary);
    if (!name) continue;
    migrated.unshift({
      id: createMemoryId("fact"),
      kind: "user_profile",
      text: `用户的名字是 ${name}。`,
      confidence: 0.9,
      source: "conversation",
      createdAt: conversation.createdAt,
      updatedAt: conversation.createdAt,
    });
    break;
  }

  return migrated;
}

function extractUserNameFromSummary(summary: string): string | null {
  const patterns = [
    /(?:用户问题：)?(?:我的名字叫|我的名字是|我名字叫|我名字是|我叫|我是)\s*([A-Za-z0-9_\-\u4e00-\u9fff·]{1,32})/u,
    /(?:用户问题：)?(?:你可以叫我|以后叫我|请叫我)\s*([A-Za-z0-9_\-\u4e00-\u9fff·]{1,32})/u,
  ];
  for (const pattern of patterns) {
    const match = summary.match(pattern);
    const name = match?.[1]?.trim();
    if (!name || /^(谁|什么|啥|吗|呢|一个|这个|那个|用户|名字|什么名字)$/u.test(name)) continue;
    return name;
  }
  return null;
}

function readMemoryFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    warn("pet.memory", "failed to read memory file; using defaults", { path, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

function writeMemoryToDisk(state: PetMemoryState): void {
  const path = getPetMemoryPath();
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function commitMemory(nextState: PetMemoryState): void {
  writeMemoryToDisk(nextState);
  currentMemory = nextState;
}

function getInitializedMemory(): PetMemoryState {
  if (!currentMemory) throw new Error("OpenPets pet memory has not been initialized.");
  return currentMemory;
}

function createDefaultMemoryState(): PetMemoryState {
  return {
    version: 1,
    enabled: true,
    facts: [],
    conversations: [],
    updatedAt: new Date().toISOString(),
  };
}

function createMemoryId(prefix: "fact" | "conv"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deletePetMemoryFileForTests(): void {
  if (memoryPath) rmSync(memoryPath, { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
