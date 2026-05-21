import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { app } from "electron";

import { debug, error as logError } from "./logger.js";

export interface PetReminder {
  readonly id: string;
  readonly text: string;
  readonly fireAt: number;
  readonly createdAt: number;
  readonly fired: boolean;
}

const reminderFileName = "openpets-reminders.json";
const maxReminderTextLength = 200;
const maxReminderCount = 100;
const firedRetentionMs = 7 * 24 * 60 * 60 * 1000;

let reminders: PetReminder[] = [];
let storeInitialized = false;

export function initializePetReminderStore(): void {
  if (storeInitialized) return;
  storeInitialized = true;
  const path = getReminderFilePath();
  reminders = pruneFiredReminders(normalizeReminders(readReminderFile(path)));
  writeReminderFile(reminders);
  debug("pet.reminder", "store initialized", { count: reminders.length, path });
}

export function getPetReminders(): readonly PetReminder[] {
  assertInitialized();
  return reminders;
}

export function getPendingPetReminders(): readonly PetReminder[] {
  assertInitialized();
  return reminders.filter((reminder) => !reminder.fired);
}

export function addPetReminder(input: { readonly text: string; readonly fireAt: number }): PetReminder {
  assertInitialized();
  const text = normalizeReminderText(input.text);
  if (!text) {
    throw new Error("提醒内容不能为空。");
  }
  const fireAt = normalizeFireAt(input.fireAt);
  if (fireAt === null) {
    throw new Error("请选择一个有效的提醒时间。");
  }

  const pendingCount = reminders.filter((reminder) => !reminder.fired).length;
  if (pendingCount >= maxReminderCount) {
    throw new Error(`最多只能保存 ${maxReminderCount} 条待提醒。`);
  }

  const reminder: PetReminder = {
    id: createReminderId(),
    text,
    fireAt,
    createdAt: Date.now(),
    fired: false,
  };
  reminders = [...reminders, reminder];
  writeReminderFile(reminders);
  return reminder;
}

export function removePetReminder(id: string): void {
  assertInitialized();
  const next = reminders.filter((reminder) => reminder.id !== id);
  if (next.length === reminders.length) return;
  reminders = next;
  writeReminderFile(reminders);
}

export function markPetReminderFired(id: string): PetReminder | null {
  assertInitialized();
  let updated: PetReminder | null = null;
  reminders = reminders.map((reminder) => {
    if (reminder.id !== id || reminder.fired) return reminder;
    updated = { ...reminder, fired: true };
    return updated;
  });
  if (updated) writeReminderFile(reminders);
  return updated;
}

function getReminderFilePath(): string {
  return join(app.getPath("userData"), reminderFileName);
}

function readReminderFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    logError("pet.reminder", "failed to read reminders; resetting to empty list", error instanceof Error ? error : { error });
    return undefined;
  }
}

function writeReminderFile(value: readonly PetReminder[]): void {
  const path = getReminderFilePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    logError("pet.reminder", "failed to persist reminders", error instanceof Error ? error : { error });
  }
}

function normalizeReminders(value: unknown): PetReminder[] {
  if (!Array.isArray(value)) return [];
  const result: PetReminder[] = [];
  for (const entry of value) {
    const reminder = normalizeReminder(entry);
    if (reminder) result.push(reminder);
  }
  return result;
}

function normalizeReminder(value: unknown): PetReminder | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && /^[a-z0-9-]{1,64}$/i.test(record.id) ? record.id : null;
  const text = typeof record.text === "string" ? normalizeReminderText(record.text) : "";
  const fireAt = typeof record.fireAt === "number" && Number.isFinite(record.fireAt) ? Math.round(record.fireAt) : null;
  const createdAt = typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? Math.round(record.createdAt) : Date.now();
  const fired = record.fired === true;
  if (!id || !text || fireAt === null) return null;
  return { id, text, fireAt, createdAt, fired };
}

function pruneFiredReminders(list: readonly PetReminder[]): PetReminder[] {
  const cutoff = Date.now() - firedRetentionMs;
  return list.filter((reminder) => !reminder.fired || reminder.fireAt >= cutoff);
}

function normalizeReminderText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxReminderTextLength);
}

function normalizeFireAt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > Number.MAX_SAFE_INTEGER) return null;
  return rounded;
}

function createReminderId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return `${stamp}-${random}`;
}

function assertInitialized(): void {
  if (!storeInitialized) {
    throw new Error("Pet reminder store has not been initialized.");
  }
}
