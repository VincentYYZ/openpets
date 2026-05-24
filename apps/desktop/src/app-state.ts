import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { app } from "electron";

import { defaultPetScale, defaultPetWalkSpeed, defaultWindowsRenderMode, markOnboardingCompleted, maxPetWalkSpeed, minPetWalkSpeed, normalizeOnboardingCompleted, normalizePetScale, normalizePetWalkSpeed, normalizeWindowsRenderMode, petScaleOptions, petWalkSpeedStep, type PetScaleValue, type WindowsRenderMode } from "./app-state-core.js";
import { builtInPet } from "./built-in-pet.js";
import type { Point } from "./display.js";
import { normalizeAppLanguage, type AppLanguage } from "./i18n.js";
import { assertSafePetId, getInstalledPetDir } from "./pet-paths.js";
import { normalizeReactionMessageOverrides, type ReactionMessageOverrides } from "./reaction-messages.js";
import { normalizeReactionAnimationOverrides, type ReactionAnimationOverrides } from "./reaction-animation-mapping.js";

export interface PetAmbientSpeechSettings {
  readonly movingIntervalMs?: number;
  readonly hoveredIntervalMs?: number;
}

export type PetHelpProviderMode = "claude" | "third-party";

export type PetHelpApiStyle = "openai" | "anthropic";

export interface PetHelpThirdPartyConfig {
  readonly apiStyle: PetHelpApiStyle;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
}

export const minAmbientSpeechIntervalMs = 1_000;
export const maxAmbientSpeechIntervalMs = 60_000;
export const defaultMovingAmbientSpeechIntervalMs = 6_500;
export const defaultHoveredAmbientSpeechIntervalMs = 6_500;

export interface InstalledPetState {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly reactionMessageOverrides?: ReactionMessageOverrides;
  readonly ambientSpeechSettings?: PetAmbientSpeechSettings;
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
    readonly petWalkSpeed: number;
    readonly windowsRenderMode: WindowsRenderMode;
    readonly reactionAnimationOverrides?: ReactionAnimationOverrides;
    readonly onboardingCompleted: boolean;
    readonly claudeCommandPath?: string;
    readonly nodeCommandPath?: string;
    readonly opencodeCommandPath?: string;
    readonly petHelpProviderMode: PetHelpProviderMode;
    readonly petHelpThirdPartyConfig: PetHelpThirdPartyConfig;
  };
  readonly pets: {
    readonly installed: readonly InstalledPetState[];
  };
  readonly defaultPet: {
    readonly position?: Point;
  };
}

export { defaultPetScale, defaultPetWalkSpeed, defaultWindowsRenderMode, maxPetWalkSpeed, minPetWalkSpeed, normalizePetScale, normalizePetWalkSpeed, normalizeWindowsRenderMode, petScaleOptions, petWalkSpeedStep, type PetScaleValue, type WindowsRenderMode };

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

export function updateInstalledPetReactionMessageOverrides(petId: string, reactionMessageOverrides: ReactionMessageOverrides | undefined): OpenPetsStateV1 {
  return updateInstalledPetSpeechConfig(petId, { reactionMessageOverrides });
}

export function updateInstalledPetSpeechConfig(petId: string, config: { readonly reactionMessageOverrides?: ReactionMessageOverrides; readonly ambientSpeechSettings?: PetAmbientSpeechSettings }): OpenPetsStateV1 {
  const state = getInitializedState();
  const existing = state.pets.installed.find((pet) => pet.id === petId);

  if (!existing) {
    throw new Error(`Cannot update unknown pet: ${petId}`);
  }

  const nextState = normalizeState({
    ...state,
    pets: {
      installed: state.pets.installed.map((pet) => pet.id === petId ? {
        ...pet,
        reactionMessageOverrides: config.reactionMessageOverrides,
        ambientSpeechSettings: config.ambientSpeechSettings,
      } : pet),
    },
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
    petWalkSpeed: normalizePetWalkSpeed(value.petWalkSpeed),
    windowsRenderMode: normalizeWindowsRenderMode(value.windowsRenderMode),
    reactionAnimationOverrides: normalizeReactionAnimationOverrides(value.reactionAnimationOverrides),
    onboardingCompleted: normalizeOnboardingCompleted(value),
    claudeCommandPath: normalizeCommandPath(value.claudeCommandPath),
    nodeCommandPath: normalizeCommandPath(value.nodeCommandPath),
    opencodeCommandPath: normalizeCommandPath(value.opencodeCommandPath),
    petHelpProviderMode: normalizePetHelpProviderMode(value.petHelpProviderMode),
    petHelpThirdPartyConfig: normalizePetHelpThirdPartyConfig(value.petHelpThirdPartyConfig),
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

function normalizePetHelpProviderMode(value: unknown): PetHelpProviderMode {
  return value === "third-party" ? "third-party" : "claude";
}

function normalizePetHelpThirdPartyConfig(value: unknown): PetHelpThirdPartyConfig {
  const record = isRecord(value) ? value : {};
  const apiStyle = record.apiStyle === "anthropic" ? "anthropic" : "openai";
  return {
    apiStyle,
    baseUrl: normalizePetHelpBaseUrl(record.baseUrl, apiStyle),
    apiKey: normalizePetHelpApiKey(record.apiKey),
    model: normalizePetHelpModel(record.model),
  };
}

function normalizePetHelpBaseUrl(value: unknown, apiStyle: PetHelpApiStyle): string {
  const fallback = apiStyle === "anthropic" ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com";
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || /[\r\n\0]/.test(trimmed)) return fallback;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function normalizePetHelpApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || /[\r\n\0]/.test(trimmed)) return undefined;
  return trimmed;
}

function normalizePetHelpModel(value: unknown): string {
  if (typeof value !== "string") return "deepseek-v4-flash";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || /[\r\n\0]/.test(trimmed)) return "deepseek-v4-flash";
  return trimmed;
}

function normalizeInstalledPets(value: Record<string, unknown>): InstalledPetState[] {
  const installed = isRecord(value.pets) && Array.isArray(value.pets.installed)
    ? value.pets.installed
    : [];

  const normalized = installed
    .map((pet) => normalizeInstalledPet(pet))
    .filter((pet): pet is InstalledPetState => Boolean(pet));

  const builtInState = normalized.find((pet) => pet.id === builtInPet.id);
  const explicitPets = normalized.filter((pet) => pet.id !== builtInPet.id);

  return [
    {
      ...builtInPet,
      description: builtInState?.description,
      reactionMessageOverrides: builtInState?.reactionMessageOverrides,
      ambientSpeechSettings: builtInState?.ambientSpeechSettings,
      broken: builtInState?.broken,
      brokenReason: builtInState?.brokenReason,
    },
    ...explicitPets,
  ];
}

function normalizeInstalledPet(value: unknown): InstalledPetState | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.displayName !== "string") {
    return null;
  }

  if (value.id !== builtInPet.id) {
    try {
      assertSafePetId(value.id);
    } catch {
      return null;
    }
  }

  const brokenReason = value.id === builtInPet.id ? undefined : validateInstalledPetFiles(value.id);

  return {
    id: value.id,
    displayName: value.displayName,
    description: typeof value.description === "string" ? value.description : undefined,
    reactionMessageOverrides: normalizeReactionMessageOverrides(value.reactionMessageOverrides),
    ambientSpeechSettings: normalizePetAmbientSpeechSettings(value.ambientSpeechSettings),
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
      petWalkSpeed: defaultPetWalkSpeed,
      windowsRenderMode: defaultWindowsRenderMode,
      reactionAnimationOverrides: undefined,
      onboardingCompleted: false,
      claudeCommandPath: undefined,
      nodeCommandPath: undefined,
      opencodeCommandPath: undefined,
      petHelpProviderMode: "claude",
      petHelpThirdPartyConfig: {
        apiStyle: "openai",
        baseUrl: "https://api.deepseek.com",
        apiKey: undefined,
        model: "deepseek-v4-flash",
      },
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

export function validatePetAmbientSpeechSettings(value: unknown): PetAmbientSpeechSettings | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid pet ambient speech settings.");
  const movingIntervalMs = validateAmbientSpeechIntervalMs(value.movingIntervalMs, "moving");
  const hoveredIntervalMs = validateAmbientSpeechIntervalMs(value.hoveredIntervalMs, "hovered");
  return movingIntervalMs === undefined && hoveredIntervalMs === undefined
    ? undefined
    : {
      ...(movingIntervalMs === undefined ? {} : { movingIntervalMs }),
      ...(hoveredIntervalMs === undefined ? {} : { hoveredIntervalMs }),
    };
}

function normalizePetAmbientSpeechSettings(value: unknown): PetAmbientSpeechSettings | undefined {
  if (!isRecord(value)) return undefined;
  const movingIntervalMs = normalizeAmbientSpeechIntervalMs(value.movingIntervalMs);
  const hoveredIntervalMs = normalizeAmbientSpeechIntervalMs(value.hoveredIntervalMs);
  return movingIntervalMs === undefined && hoveredIntervalMs === undefined
    ? undefined
    : {
      ...(movingIntervalMs === undefined ? {} : { movingIntervalMs }),
      ...(hoveredIntervalMs === undefined ? {} : { hoveredIntervalMs }),
    };
}

function validateAmbientSpeechIntervalMs(value: unknown, mode: "moving" | "hovered"): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${mode} ambient speech interval.`);
  const rounded = Math.round(value);
  if (rounded < minAmbientSpeechIntervalMs || rounded > maxAmbientSpeechIntervalMs) {
    throw new Error(`Invalid ${mode} ambient speech interval.`);
  }
  return rounded;
}

function normalizeAmbientSpeechIntervalMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded < minAmbientSpeechIntervalMs || rounded > maxAmbientSpeechIntervalMs) return undefined;
  return rounded;
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
