#!/usr/bin/env node
import { createWriteStream, existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";

import { createOpenPetsClient, OpenPetsClientError } from "@open-pets/client";
import yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";

const catalogUrl = "https://openpets.dev/pets/catalog.v2.json";
const zipHost = "zip.openpets.dev";
const maxCatalogBytes = 1_000_000;
const maxZipDownloadBytes = 50 * 1024 * 1024;
const maxExtractedTotalBytes = 200 * 1024 * 1024;
const maxFiles = 500;
const maxIndividualFileBytes = 100 * 1024 * 1024;
const fetchTimeoutMs = 30_000;
const directInstallLockName = ".install-pet.lock";
const directInstallLockStaleMs = 10 * 60 * 1000;
const appUnavailableErrorCodes = new Set(["unavailable", "connect_timeout", "connection_closed"]);
const appTooOldErrorCodes = new Set(["unknown_method", "invalid_version"]);

const builtInPet = {
  id: "builtin",
  displayName: "Built-in Pet",
  builtIn: true,
  protected: true,
  installed: true,
} as const;

export interface CatalogPet {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly preview: string;
  readonly zip: string;
}

export interface InstallPetOptions {
  readonly petId: string;
  readonly preferRunningApp?: boolean;
}

export interface InstallPetResult {
  readonly petId: string;
  readonly displayName: string;
  readonly via: "app" | "direct";
}

interface InstalledPetState {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly builtIn: boolean;
  readonly protected: boolean;
  readonly installed: boolean;
  readonly source?: {
    readonly kind: "catalog";
    readonly catalogVersion: 2;
    readonly zip: string;
    readonly preview: string;
  };
  readonly broken?: boolean;
  readonly brokenReason?: string;
}

interface OpenPetsState {
  readonly version: 1;
  readonly preferences: {
    readonly defaultPetId: string;
    readonly openDefaultPetOnLaunch: boolean;
    readonly speechBubblesEnabled: boolean;
    readonly petScale: number;
    readonly onboardingCompleted: boolean;
    readonly claudeCommandPath?: string;
    readonly opencodeCommandPath?: string;
  };
  readonly pets: {
    readonly installed: readonly InstalledPetState[];
  };
  readonly defaultPet: Record<string, unknown>;
}

interface SafeZipPath {
  readonly isDirectory: boolean;
  readonly relativeOutputPath?: string;
}

export async function installPet(options: InstallPetOptions): Promise<InstallPetResult> {
  const petId = validatePetId(options.petId);

  if (options.preferRunningApp !== false) {
    const appInstall = await tryInstallThroughRunningApp(petId);
    if (appInstall) return appInstall;
  }

  return installPetDirectly(petId);
}

export function parseArgs(args: readonly string[]): { readonly petId: string; readonly help: boolean } {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { petId: "", help: true };
  if (args.length !== 1) throw new Error("Usage: install-pet <pet-id>");
  return { petId: validatePetId(args[0] ?? ""), help: false };
}

export function getOpenPetsUserDataPath(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENPETS_USER_DATA) return env.OPENPETS_USER_DATA;
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "OpenPets");
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "OpenPets");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "OpenPets");
}

export function validatePetId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || value === builtInPet.id) {
    throw new Error(`Invalid OpenPets pet id: ${value}`);
  }
  return value;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return;
  }

  const result = await installPet({ petId: parsed.petId });
  process.stdout.write(`Installed OpenPets pet: ${result.displayName} (${result.petId})\n`);
  if (result.via === "direct") {
    process.stdout.write("Open or restart OpenPets to use the installed pet.\n");
  }
}

async function tryInstallThroughRunningApp(petId: string): Promise<InstallPetResult | null> {
  try {
    const result = await createOpenPetsClient({ responseTimeoutMs: 60_000 }).installPet(petId);
    return { petId: result.petId, displayName: result.displayName, via: "app" };
  } catch (error) {
    if (error instanceof OpenPetsClientError && appUnavailableErrorCodes.has(error.code)) return null;
    if (error instanceof OpenPetsClientError && appTooOldErrorCodes.has(error.code)) {
      throw new Error("Your running OpenPets app is too old for CLI pet installs. Quit OpenPets and retry, or update OpenPets.");
    }
    throw error;
  }
}

async function installPetDirectly(petId: string): Promise<InstallPetResult> {
  const userData = getOpenPetsUserDataPath();
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireDirectInstallLock(userData);
  try {
    const catalogPet = await getCatalogPet(petId);
    const initialState = await readCurrentState(userData);
    if (initialState.pets.installed.some((pet) => pet.id === catalogPet.id)) throw new Error(`Pet is already installed: ${catalogPet.id}`);

    const zip = await downloadPetZip(catalogPet.zip);
    const petsRoot = join(userData, "pets");
    await mkdir(petsRoot, { recursive: true, mode: 0o700 });

    const finalDir = getInstalledPetDir(petsRoot, petId);
    const tempDir = await mkdtemp(join(petsRoot, `.install-${petId}-`));

    try {
      assertInsideRoot(petsRoot, tempDir);
      await extractPetZip(zip, tempDir);
      await validateExtractedPet(tempDir);
      await rm(finalDir, { recursive: true, force: true });
      await rename(tempDir, finalDir);
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }

    await writeInstalledPetState(userData, catalogPet);
    return { petId: catalogPet.id, displayName: catalogPet.displayName, via: "direct" };
  } finally {
    await releaseLock();
  }
}

async function acquireDirectInstallLock(userData: string): Promise<() => Promise<void>> {
  const lockPath = join(userData, directInstallLockName);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), command: "install-pet" })}\n`, "utf8");
      return async () => {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      if (await isStaleInstallLock(lockPath)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      throw new Error("Another OpenPets pet install or startup is already in progress.");
    }
  }
  throw new Error("Could not acquire OpenPets install lock.");
}

async function isStaleInstallLock(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { readonly pid?: unknown; readonly createdAt?: unknown };
    if (typeof owner.createdAt === "number" && Date.now() - owner.createdAt > directInstallLockStaleMs) return true;
    if (typeof owner.pid === "number" && owner.pid > 0) return !isProcessAlive(owner.pid);
  } catch {
    // Fall back to mtime for old/partial locks.
  }
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > directInstallLockStaleMs;
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

async function getCatalogPet(petId: string): Promise<CatalogPet> {
  const catalog = await fetchCatalog();
  const pet = catalog.find((candidate) => candidate.id === petId);
  if (!pet) throw new Error(`Pet is not available in the OpenPets catalog: ${petId}`);
  return pet;
}

async function fetchCatalog(): Promise<readonly CatalogPet[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(catalogUrl, { signal: controller.signal, redirect: "error", credentials: "omit" });
    if (response.url !== catalogUrl) throw new Error("Catalog final URL is not allowed.");
    if (!response.ok) throw new Error(`Catalog download failed with HTTP ${response.status}.`);
    return validateCatalog(JSON.parse(await readLimitedTextResponse(response, maxCatalogBytes)) as unknown);
  } finally {
    clearTimeout(timeout);
  }
}

export function validateCatalog(value: unknown): readonly CatalogPet[] {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.pets)) throw new Error("OpenPets catalog is invalid.");
  const ids = new Set<string>();
  return value.pets.map((pet) => validateCatalogPet(pet, ids));
}

function validateCatalogPet(value: unknown, ids: Set<string>): CatalogPet {
  if (!isRecord(value)) throw new Error("Catalog pet is invalid.");
  const id = validatePetId(readString(value.id, "id", 64));
  if (ids.has(id)) throw new Error(`Duplicate catalog pet id: ${id}`);
  ids.add(id);
  return {
    id,
    displayName: readString(value.displayName, "displayName", 120),
    description: readString(value.description, "description", 500),
    preview: validateCatalogUrl(value.preview, "preview"),
    zip: validateCatalogUrl(value.zip, "zip"),
  };
}

function validateCatalogUrl(value: unknown, field: "preview" | "zip"): string {
  const raw = readString(value, field, 2048);
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error(`${field} URL is invalid.`);
  if (field === "preview" && (url.hostname !== "openpets.dev" || !url.pathname.startsWith("/pets/"))) throw new Error("Preview URL host/path is not allowed.");
  if (field === "zip" && (url.hostname !== zipHost || !url.pathname.startsWith("/pets/"))) throw new Error("Zip URL host/path is not allowed.");
  return url.toString();
}

async function downloadPetZip(zipUrl: string): Promise<Buffer> {
  validateCatalogUrl(zipUrl, "zip");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(zipUrl, { signal: controller.signal, redirect: "error", credentials: "omit" });
    if (response.url !== zipUrl) throw new Error("Zip download final URL changed.");
    if (!response.ok) throw new Error(`Zip download failed with HTTP ${response.status}.`);
    const buffer = await readLimitedBinaryResponse(response, maxZipDownloadBytes);
    if (!hasSupportedZipMagic(buffer)) throw new Error("Downloaded file has an unsupported zip signature.");
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedTextResponse(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readLimitedBinaryResponse(response, maxBytes));
}

async function readLimitedBinaryResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is unavailable.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error("Download is too large.");
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

async function extractPetZip(zip: Buffer, tempDir: string): Promise<void> {
  const zipFile = await openZipFromBuffer(zip);
  const seen = new Set<string>();
  const pathTracker = new ZipEntryPathTracker();
  let fileCount = 0;
  let extractedTotal = 0;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const reject = (error: unknown): void => {
        if (settled) return;
        settled = true;
        zipFile.close();
        rejectPromise(error instanceof Error ? error : new Error("Zip extraction failed."));
      };
      zipFile.on("error", reject);
      zipFile.on("end", () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      });
      zipFile.on("entry", (entry) => {
        void processEntry(entry).then(() => {
          if (!settled) zipFile.readEntry();
        }).catch(reject);
      });
      const processEntry = async (entry: Entry): Promise<void> => {
        validateEntryMetadata(entry);
        const safePath = pathTracker.accept(entry.fileName);
        if (safePath.isDirectory) return;
        if (!safePath.relativeOutputPath) throw new Error("Zip file entry is missing an output path.");
        fileCount += 1;
        if (fileCount > maxFiles) throw new Error("Zip contains too many files.");
        extractedTotal += entry.uncompressedSize;
        if (extractedTotal > maxExtractedTotalBytes) throw new Error("Zip extracted total is too large.");
        const outputPath = resolve(tempDir, safePath.relativeOutputPath);
        assertOutputPathInside(tempDir, outputPath);
        seen.add(safePath.relativeOutputPath);
        await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
        await writeEntry(entry, zipFile, outputPath, entry.uncompressedSize);
      };
      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }
  if (!seen.has("pet.json") || !seen.has("spritesheet.webp")) throw new Error("Zip must contain pet.json and spritesheet.webp.");
}

function openZipFromBuffer(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zipFile) => {
      if (error) rejectPromise(error);
      else if (!zipFile) rejectPromise(new Error("Zip file could not be opened."));
      else resolvePromise(zipFile);
    });
  });
}

function validateEntryMetadata(entry: Entry): void {
  if (entry.isEncrypted()) throw new Error("Encrypted zip entries are not supported.");
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new Error("Unsupported zip entry compression method.");
  if (entry.compressedSize > maxZipDownloadBytes) throw new Error("Zip entry compressed size is too large.");
  if (entry.uncompressedSize > maxIndividualFileBytes) throw new Error("Zip entry uncompressed size is too large.");
  const unixMode = (entry.versionMadeBy >> 8) === 3 ? (entry.externalFileAttributes >> 16) & 0o177777 : null;
  if (unixMode === null) return;
  const type = unixMode & 0o170000;
  if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new Error("Zip entry special files are not supported.");
}

function writeEntry(entry: Entry, zipFile: ZipFile, outputPath: string, expectedBytes: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    zipFile.openReadStream(entry, (error, readStream) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      if (!readStream) {
        rejectPromise(new Error("Zip entry stream could not be opened."));
        return;
      }
      let actualBytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          actualBytes += chunk.byteLength;
          if (actualBytes > maxIndividualFileBytes) callback(new Error("Zip entry exceeded individual size limit."));
          else callback(null, chunk);
        },
      });
      pipeline(readStream, counter, createWriteStream(outputPath, { mode: 0o600 }))
        .then(() => {
          if (actualBytes !== expectedBytes) rejectPromise(new Error("Zip entry extracted size did not match metadata."));
          else resolvePromise();
        })
        .catch(rejectPromise);
    });
  });
}

async function validateExtractedPet(tempDir: string): Promise<void> {
  const petJsonPath = join(tempDir, "pet.json");
  const spritesheetPath = join(tempDir, "spritesheet.webp");
  assertOutputPathInside(tempDir, petJsonPath);
  assertOutputPathInside(tempDir, spritesheetPath);
  JSON.parse(await readFile(petJsonPath, "utf8")) as unknown;
  const spritesheet = await stat(spritesheetPath);
  if (!spritesheet.isFile()) throw new Error("spritesheet.webp must be a file.");
  if (spritesheet.size <= 0) throw new Error("spritesheet.webp is empty.");
  if (spritesheet.size > maxIndividualFileBytes) throw new Error("spritesheet.webp is too large.");
}

async function readCurrentState(userData: string): Promise<OpenPetsState> {
  const statePath = join(userData, "openpets-state.json");
  return normalizeState(existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) as unknown : undefined, userData);
}

async function writeInstalledPetState(userData: string, catalogPet: CatalogPet): Promise<void> {
  const statePath = join(userData, "openpets-state.json");
  const current = await readCurrentState(userData);
  if (current.pets.installed.some((pet) => pet.id === catalogPet.id)) throw new Error(`Pet is already installed: ${catalogPet.id}`);
  const next: OpenPetsState = {
    ...current,
    pets: {
      installed: [
        ...current.pets.installed,
        {
          id: catalogPet.id,
          displayName: catalogPet.displayName,
          description: catalogPet.description,
          builtIn: false,
          protected: false,
          installed: true,
          source: { kind: "catalog", catalogVersion: 2, zip: catalogPet.zip, preview: catalogPet.preview },
        },
      ],
    },
  };
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(tempPath, statePath);
}

function normalizeState(value: unknown, userData: string): OpenPetsState {
  const record = isRecord(value) ? value : {};
  const preferences = isRecord(record.preferences) ? record.preferences : {};
  const petsRecord = isRecord(record.pets) ? record.pets : {};
  const installed = Array.isArray(petsRecord.installed)
    ? petsRecord.installed.map((pet) => normalizeInstalledPet(pet, userData)).filter((pet): pet is InstalledPetState => Boolean(pet && pet.id !== builtInPet.id))
    : [];
  const defaultPetId = typeof preferences.defaultPetId === "string" && [builtInPet, ...installed].some((pet) => pet.id === preferences.defaultPetId) ? preferences.defaultPetId : builtInPet.id;
  return {
    version: 1,
    preferences: {
      defaultPetId,
      openDefaultPetOnLaunch: typeof preferences.openDefaultPetOnLaunch === "boolean" ? preferences.openDefaultPetOnLaunch : true,
      speechBubblesEnabled: true,
      petScale: typeof preferences.petScale === "number" ? preferences.petScale : 1,
      onboardingCompleted: typeof preferences.onboardingCompleted === "boolean" ? preferences.onboardingCompleted : false,
      claudeCommandPath: typeof preferences.claudeCommandPath === "string" ? preferences.claudeCommandPath : undefined,
      opencodeCommandPath: typeof preferences.opencodeCommandPath === "string" ? preferences.opencodeCommandPath : undefined,
    },
    pets: { installed: [builtInPet, ...installed] },
    defaultPet: isRecord(record.defaultPet) ? record.defaultPet : {},
  };
}

function normalizeInstalledPet(value: unknown, userData: string): InstalledPetState | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.displayName !== "string") return null;
  try {
    validatePetId(value.id);
  } catch {
    return null;
  }
  const petDir = getInstalledPetDir(join(userData, "pets"), value.id);
  const missingFiles = !existsSync(join(petDir, "pet.json")) || !existsSync(join(petDir, "spritesheet.webp"));
  return {
    id: value.id,
    displayName: value.displayName,
    description: typeof value.description === "string" ? value.description : undefined,
    builtIn: false,
    protected: false,
    installed: true,
    source: isRecord(value.source) && value.source.catalogVersion === 2 && typeof value.source.zip === "string" && typeof value.source.preview === "string"
      ? { kind: "catalog", catalogVersion: 2, zip: value.source.zip, preview: value.source.preview }
      : undefined,
    broken: missingFiles ? true : typeof value.broken === "boolean" ? value.broken : undefined,
    brokenReason: missingFiles ? "Installed pet files are missing." : typeof value.brokenReason === "string" ? value.brokenReason : undefined,
  };
}

class ZipEntryPathTracker {
  private readonly seen = new Set<string>();

  accept(rawPath: string): SafeZipPath {
    const normalized = rawPath.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!normalized || normalized.includes("../") || normalized === ".." || /^[a-zA-Z]:/.test(normalized)) throw new Error(`Unsafe zip path: ${rawPath}`);
    const isDirectory = normalized.endsWith("/");
    const outputPath = isDirectory ? normalized.slice(0, -1) : normalized;
    if (!outputPath || outputPath.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe zip path: ${rawPath}`);
    const key = outputPath.toLowerCase();
    if (this.seen.has(key)) throw new Error(`Duplicate zip entry path: ${outputPath}`);
    this.seen.add(key);
    return isDirectory ? { isDirectory } : { isDirectory, relativeOutputPath: outputPath };
  }
}

function getInstalledPetDir(petsRoot: string, petId: string): string {
  validatePetId(petId);
  const target = resolve(petsRoot, petId);
  assertInsideRoot(petsRoot, target);
  return target;
}

function assertInsideRoot(root: string, target: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) throw new Error("Resolved path escapes OpenPets directory.");
}

function assertOutputPathInside(root: string, target: string): void {
  assertInsideRoot(root, target);
}

function hasSupportedZipMagic(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) && (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08);
}

function readString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) throw new Error(`Catalog pet ${field} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function printUsage(): void {
  process.stdout.write("Usage:\n  install-pet <pet-id>\n\nInstalls a pet from the OpenPets gallery into your local OpenPets app data.\nExample:\n  npx -y install-pet review-owl\n");
}

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
