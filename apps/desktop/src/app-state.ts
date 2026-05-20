import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { app } from "electron";

import { defaultPetScale, markOnboardingCompleted, normalizeOnboardingCompleted, normalizePetScale, petScaleOptions, type PetScaleValue } from "./app-state-core.js";
import { builtInPet } from "./built-in-pet.js";
import type { Point } from "./display.js";
import { normalizeAppLanguage, type AppLanguage } from "./i18n.js";
import { assertSafePetId, getInstalledPetDir } from "./pet-paths.js";
import { normalizeReactionAnimationOverrides, type ReactionAnimationOverrides } from "./reaction-animation-mapping.js";

export interface InstalledPetState {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly builtIn: boolean;
  readonly protected: boolean;
  readonly installed: boolean;
  readonly source?: {
    readonly kind?: "catalog";
    readonly catalogVersion: 2;
    readonly zip: string;
    readonly preview: string;
  } | {
    readonly kind: "codex";
    readonly path: string;
  };
  readonly broken?: boolean;
  readonly brokenReason?: string;
}

export interface OpenPetsStateV1 {
  readonly version: 1;
  readonly preferences: {
    readonly language: AppLanguage;
    readonly defaultPetId: string;
    readonly openDefaultPetOnLaunch: boolean;
    readonly speechBubblesEnabled: boolean;
    readonly petScale: number;
    readonly reactionAnimationOverrides?: ReactionAnimationOverrides;
    readonly onboardingCompleted: boolean;
    readonly claudeCommandPath?: string;
    readonly nodeCommandPath?: string;
    readonly opencodeCommandPath?: string;
  };
  readonly pets: {
    readonly installed: readonly InstalledPetState[];
  };
  readonly defaultPet: {
    readonly position?: Point;
  };
}

export { defaultPetScale, normalizePetScale, petScaleOptions, type PetScaleValue };

const stateFileName = "openpets-state.json";
const directInstallLockName = ".install-pet.lock";
const directInstallLockStaleMs = 10 * 60 * 1000;
let statePath: string | null = null;
let currentState: OpenPetsStateV1 | null = null;
let startupInstallLockPath: string | null = null;

export function initializeAppState(): void {
  const userDataPath = app.getPath("userData");
  startupInstallLockPath = acquireStartupInstallLock(userDataPath);

  statePath = join(userDataPath, stateFileName);
  const nextState = normalizeState(readStateFile(statePath));
  writeStateToDisk(nextState);
  currentState = nextState;
  console.log(`OpenPets state initialized at ${statePath}.`);
}

export function releaseStartupInstallLock(): void {
  const lockPath = startupInstallLockPath;
  startupInstallLockPath = null;
  if (lockPath) rmSync(lockPath, { recursive: true, force: true });
}

export function getAppStateSnapshot(): OpenPetsStateV1 {
  return cloneState(getInitializedState());
}

export function updatePreferences(patch: Partial<OpenPetsStateV1["preferences"]>): OpenPetsStateV1 {
  const state = getInitializedState();
  const preferences = normalizePreferences({ ...state.preferences, ...patch });

  const nextState = normalizeState({
    ...state,
    preferences,
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function isOnboardingCompleted(): boolean {
  return getInitializedState().preferences.onboardingCompleted;
}

export function completeOnboarding(): OpenPetsStateV1 {
  const state = getInitializedState();
  const nextState = normalizeState(markOnboardingCompleted(state));
  commitState(nextState);
  return getAppStateSnapshot();
}

export function setDefaultPet(defaultPetId: string): OpenPetsStateV1 {
  const state = getInitializedState();
  const targetPet = state.pets.installed.find((pet) => pet.id === defaultPetId);

  if (!targetPet) {
    throw new Error(`Cannot set unknown pet as default: ${defaultPetId}`);
  }

  if (targetPet.broken) {
    throw new Error(`Cannot set broken pet as default: ${defaultPetId}`);
  }

  const nextState = normalizeState({
    ...state,
    preferences: {
      ...state.preferences,
      defaultPetId,
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function setDefaultPetPosition(position: Point): OpenPetsStateV1 {
  const state = getInitializedState();

  const nextState = normalizeState({
    ...state,
    defaultPet: {
      ...state.defaultPet,
      position: normalizePosition(position),
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function resetDefaultPetPosition(position: Point): OpenPetsStateV1 {
  return setDefaultPetPosition(position);
}

export function getDefaultPetPosition(): Point | undefined {
  return getInitializedState().defaultPet.position;
}

export function installPetState(pet: Omit<InstalledPetState, "builtIn" | "protected" | "installed">): OpenPetsStateV1 {
  const state = getInitializedState();

  if (state.pets.installed.some((installedPet) => installedPet.id === pet.id)) {
    throw new Error(`Pet is already installed: ${pet.id}`);
  }

  const nextState = normalizeState({
    ...state,
    pets: {
      installed: [
        ...state.pets.installed,
        {
          ...pet,
          builtIn: false,
          protected: false,
          installed: true,
        },
      ],
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function removePetState(petId: string): OpenPetsStateV1 {
  if (petId === builtInPet.id) {
    throw new Error("Built-in pet cannot be removed.");
  }

  const state = getInitializedState();
  const existing = state.pets.installed.find((pet) => pet.id === petId);

  if (!existing) {
    throw new Error(`Pet is not installed: ${petId}`);
  }

  const nextDefaultPetId = state.preferences.defaultPetId === petId ? builtInPet.id : state.preferences.defaultPetId;

  const nextState = normalizeState({
    ...state,
    preferences: {
      ...state.preferences,
      defaultPetId: nextDefaultPetId,
    },
    pets: {
      installed: state.pets.installed.filter((pet) => pet.id !== petId),
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function markPetBroken(petId: string, brokenReason: string): OpenPetsStateV1 {
  const state = getInitializedState();

  if (petId === builtInPet.id) {
    return getAppStateSnapshot();
  }

  const nextState = normalizeState({
    ...state,
    preferences: {
      ...state.preferences,
      defaultPetId: state.preferences.defaultPetId === petId ? builtInPet.id : state.preferences.defaultPetId,
    },
    pets: {
      installed: state.pets.installed.map((pet) => pet.id === petId ? { ...pet, broken: true, brokenReason } : pet),
    },
  });

  commitState(nextState);
  return getAppStateSnapshot();
}

export function getStateFilePath(): string {
  if (!statePath) {
    throw new Error("OpenPets app state has not been initialized.");
  }

  return statePath;
}

function getInitializedState(): OpenPetsStateV1 {
  if (!currentState) {
    throw new Error("OpenPets app state has not been initialized.");
  }

  return currentState;
}

function readStateFile(path: string): unknown {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    console.error(`Failed to read OpenPets state from ${path}; using defaults.`, error);
    return undefined;
  }
}

function normalizeState(value: unknown): OpenPetsStateV1 {
  const record = isRecord(value) ? value : {};
  const defaultPetRecord = isRecord(record.defaultPet) ? record.defaultPet : {};
  const preferencesRecord = isRecord(record.preferences) ? record.preferences : {};
  const defaultState = createDefaultState();
  const position = normalizeMaybePosition(defaultPetRecord.position);
  const installedPets = normalizeInstalledPets(record);
  const defaultPetId = typeof preferencesRecord.defaultPetId === "string"
    && installedPets.some((pet) => pet.id === preferencesRecord.defaultPetId && !pet.broken)
    ? preferencesRecord.defaultPetId
    : builtInPet.id;

  return {
    version: 1,
    preferences: normalizePreferences({
      ...defaultState.preferences,
      ...preferencesRecord,
      defaultPetId,
    }),
    pets: {
      installed: installedPets,
    },
    defaultPet: position ? { position } : {},
  };
}

function normalizePreferences(value: Partial<OpenPetsStateV1["preferences"]>): OpenPetsStateV1["preferences"] {
  const defaultState = createDefaultState();

  return {
    language: normalizeAppLanguage(value.language),
    defaultPetId: typeof value.defaultPetId === "string" ? value.defaultPetId : builtInPet.id,
    openDefaultPetOnLaunch: typeof value.openDefaultPetOnLaunch === "boolean"
      ? value.openDefaultPetOnLaunch
      : defaultState.preferences.openDefaultPetOnLaunch,
    speechBubblesEnabled: true,
    petScale: normalizePetScale(value.petScale),
    reactionAnimationOverrides: normalizeReactionAnimationOverrides(value.reactionAnimationOverrides),
    onboardingCompleted: normalizeOnboardingCompleted(value),
    claudeCommandPath: normalizeCommandPath(value.claudeCommandPath),
    nodeCommandPath: normalizeCommandPath(value.nodeCommandPath),
    opencodeCommandPath: normalizeCommandPath(value.opencodeCommandPath),
  };
}

function normalizeCommandPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || /[\r\n\0]/.test(trimmed) || !isAbsolute(trimmed)) return undefined;
  if (process.platform === "win32" && /[&|<>^%!]/.test(trimmed)) return undefined;
  try {
    if (!statSync(trimmed).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return trimmed;
}

function normalizeInstalledPets(value: Record<string, unknown>): InstalledPetState[] {
  const installed = isRecord(value.pets) && Array.isArray(value.pets.installed)
    ? value.pets.installed
    : [];

  const normalized = installed
    .map((pet) => normalizeInstalledPet(pet))
    .filter((pet): pet is InstalledPetState => Boolean(pet && pet.id !== builtInPet.id));

  return [builtInPet, ...normalized];
}

function normalizeInstalledPet(value: unknown): InstalledPetState | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.displayName !== "string") {
    return null;
  }

  try {
    assertSafePetId(value.id);
  } catch {
    return null;
  }

  const brokenReason = validateInstalledPetFiles(value.id);

  return {
    id: value.id,
    displayName: value.displayName,
    description: typeof value.description === "string" ? value.description : undefined,
    builtIn: value.id === builtInPet.id ? true : value.builtIn === true,
    protected: value.id === builtInPet.id ? true : value.protected === true,
    installed: true,
    source: normalizeSource(value.source),
    broken: brokenReason ? true : typeof value.broken === "boolean" ? value.broken : undefined,
    brokenReason: brokenReason ?? (typeof value.brokenReason === "string" ? value.brokenReason : undefined),
  };
}

function createDefaultState(): OpenPetsStateV1 {
  return {
    version: 1,
    preferences: {
      language: "en",
      defaultPetId: builtInPet.id,
      openDefaultPetOnLaunch: true,
      speechBubblesEnabled: true,
      petScale: defaultPetScale,
      reactionAnimationOverrides: undefined,
      onboardingCompleted: false,
      claudeCommandPath: undefined,
      nodeCommandPath: undefined,
      opencodeCommandPath: undefined,
    },
    pets: {
      installed: [builtInPet],
    },
    defaultPet: {},
  };
}

function commitState(nextState: OpenPetsStateV1): void {
  writeStateToDisk(nextState);
  currentState = nextState;
}

function writeStateToDisk(state: OpenPetsStateV1): void {
  const path = getStateFilePath();

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function validateInstalledPetFiles(petId: string): string | undefined {
  try {
    const dir = getInstalledPetDir(petId);
    const petJsonPath = join(dir, "pet.json");
    const spritesheetPath = join(dir, "spritesheet.webp");
    JSON.parse(readFileSync(petJsonPath, "utf8")) as unknown;
    const spritesheet = statSync(spritesheetPath);
    if (!spritesheet.isFile()) return "spritesheet.webp is not a file.";
    if (spritesheet.size <= 0) return "spritesheet.webp is empty.";
    if (spritesheet.size > 100 * 1024 * 1024) return "spritesheet.webp is too large.";
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Installed pet files are invalid.";
  }
}

function normalizeSource(value: unknown): InstalledPetState["source"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.kind === "codex" && typeof value.path === "string") {
    return { kind: "codex", path: value.path };
  }

  if (value.catalogVersion !== 2 || typeof value.zip !== "string" || typeof value.preview !== "string") return undefined;

  return {
    kind: "catalog",
    catalogVersion: 2,
    zip: value.zip,
    preview: value.preview,
  };
}

function normalizeMaybePosition(value: unknown): Point | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return normalizePosition(value);
}

function normalizePosition(value: Partial<Point>): Point | undefined {
  if (typeof value.x !== "number" || typeof value.y !== "number") {
    return undefined;
  }

  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    return undefined;
  }

  return {
    x: Math.round(value.x),
    y: Math.round(value.y),
  };
}

function cloneState(state: OpenPetsStateV1): OpenPetsStateV1 {
  return structuredClone(state) as OpenPetsStateV1;
}

function acquireStartupInstallLock(userDataPath: string): string {
  mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  const lockPath = join(userDataPath, directInstallLockName);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), command: "openpets-startup" })}\n`, "utf8");
      return lockPath;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      if (isStaleInstallLock(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      throw new Error("OpenPets cannot start while a direct pet install is in progress. Wait for install-pet to finish, then reopen OpenPets.");
    }
  }
  throw new Error("Could not acquire OpenPets startup lock.");
}

function isStaleInstallLock(lockPath: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as { readonly pid?: unknown; readonly createdAt?: unknown };
    if (typeof owner.createdAt === "number" && Date.now() - owner.createdAt > directInstallLockStaleMs) return true;
    if (typeof owner.pid === "number" && owner.pid > 0) return !isProcessAlive(owner.pid);
  } catch {
    // Fall back to mtime for old/partial locks.
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > directInstallLockStaleMs;
  } catch {
    return true;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return code === "EPERM";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
