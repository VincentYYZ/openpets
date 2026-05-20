import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";

import { getAppStateSnapshot, installPetState, removePetState, setDefaultPet, type OpenPetsStateV1 } from "./app-state.js";
import { getCatalogPet } from "./catalog.js";
import { builtInPet } from "./built-in-pet.js";
import { assertInsideRoot, assertSafePetId, getInstalledPetDir, getPetsRoot } from "./pet-paths.js";
import { assertOutputPathInside, hasSupportedZipMagic, ZipEntryPathTracker } from "./zip-safety.js";

const maxZipDownloadBytes = 50 * 1024 * 1024;
const maxExtractedTotalBytes = 200 * 1024 * 1024;
const maxFiles = 500;
const maxIndividualFileBytes = 100 * 1024 * 1024;
const downloadTimeoutMs = 90_000;
const maxDownloadAttempts = 2;

const operations = new Set<string>();

export async function installPet(petId: string): Promise<OpenPetsStateV1> {
  return withPetOperation(petId, async () => {
    assertSafePetId(petId);

    if (getAppStateSnapshot().pets.installed.some((pet) => pet.id === petId)) {
      throw new Error(`Pet is already installed: ${petId}`);
    }

    const catalogPet = await getCatalogPet(petId);
    const zip = await downloadPetZip(catalogPet.zip);
    const petsRoot = getPetsRoot();
    await mkdir(petsRoot, { recursive: true, mode: 0o700 });

    const finalDir = getInstalledPetDir(petId);
    const tempDir = await mkdtemp(join(petsRoot, `.install-${petId}-`));

    try {
      assertInsideRoot(petsRoot, tempDir);
      await extractPetZip(zip, tempDir);
      await validateExtractedPet(tempDir);
      await rm(finalDir, { recursive: true, force: true });
      await rename(tempDir, finalDir);

      try {
        return installPetState({
          id: catalogPet.id,
          displayName: catalogPet.displayName,
          description: catalogPet.description,
          source: {
            catalogVersion: 2,
            zip: catalogPet.zip,
            preview: catalogPet.preview,
          },
        });
      } catch (error) {
        await rm(finalDir, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  });
}

export async function removePet(petId: string): Promise<OpenPetsStateV1> {
  return withPetOperation(petId, async () => {
    if (petId === builtInPet.id) {
      throw new Error("Built-in pet cannot be removed.");
    }
    assertSafePetId(petId);
    const dir = getInstalledPetDir(petId);
    const state = removePetState(petId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`Pet was removed from OpenPets state, but local files could not be deleted from ${dir}. You may need to remove them manually. ${error instanceof Error ? error.message : ""}`.trim());
    }
    return state;
  });
}

export async function setDefaultInstalledPet(petId: string): Promise<OpenPetsStateV1> {
  return withPetOperation(petId, async () => {
    if (petId !== builtInPet.id) {
      assertSafePetId(petId);
    }
    return setDefaultPet(petId);
  });
}

export async function withPetOperation<T>(key: string, callback: () => Promise<T>): Promise<T> {
  if (operations.has(key)) {
    throw new Error("An operation for this pet is already in progress.");
  }

  operations.add(key);
  try {
    return await callback();
  } finally {
    operations.delete(key);
  }
}

async function downloadPetZip(zipUrl: string): Promise<Buffer> {
  validateZipUrl(zipUrl);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxDownloadAttempts; attempt += 1) {
    try {
      return await downloadPetZipOnce(zipUrl);
    } catch (error) {
      lastError = error;
      if (attempt >= maxDownloadAttempts || !isRetryableDownloadError(error)) {
        throw toPetZipDownloadError(zipUrl, error);
      }
    }
  }
  throw toPetZipDownloadError(zipUrl, lastError);
}

async function downloadPetZipOnce(zipUrl: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);

  try {
    const response = await fetch(zipUrl, {
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
    });

    validateZipUrl(response.url);
    if (response.url !== zipUrl) throw new Error("Zip download final URL changed.");
    if (!response.ok) throw new Error(`Zip download failed with HTTP ${response.status}.`);

    const buffer = await readLimitedResponse(response, maxZipDownloadBytes);
    validateZipMagic(buffer);
    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableDownloadError(error: unknown): boolean {
  return isAbortError(error) || error instanceof TypeError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toPetZipDownloadError(zipUrl: string, error: unknown): Error {
  if (isAbortError(error)) {
    return new Error(`Pet download timed out after ${Math.round(downloadTimeoutMs / 1000)}s. Check network access to ${new URL(zipUrl).host} and try again.`);
  }
  if (error instanceof TypeError) {
    return new Error(`Pet download failed. Check network access to ${new URL(zipUrl).host}. ${error.message}`);
  }
  return error instanceof Error ? error : new Error("Pet download failed.");
}

function validateZipUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Zip URL must use https.");
  if (url.hostname !== "zip.openpets.dev") throw new Error("Zip URL host is not allowed.");
  if (!url.pathname.startsWith("/pets/")) throw new Error("Zip URL path is not allowed.");
  if (url.username || url.password) throw new Error("Zip URL cannot include credentials.");
  if (url.port) throw new Error("Zip URL cannot include a custom port.");
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Zip response body is unavailable for bounded reading.");

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) throw new Error("Zip download is too large.");
    chunks.push(value);
  }

  return Buffer.concat(chunks, total);
}

function validateZipMagic(buffer: Buffer): void {
  if (!hasSupportedZipMagic(buffer)) {
    throw new Error("Downloaded file has an unsupported zip signature.");
  }
}

async function extractPetZip(zip: Buffer, tempDir: string): Promise<void> {
  const zipFile = await openZipFromBuffer(zip);
  const pathTracker = new ZipEntryPathTracker();
  const seenRequired = new Set<string>();
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

        if (safePath.isDirectory) {
          return;
        }

        if (!safePath.relativeOutputPath) {
          throw new Error("Zip file entry is missing an output path.");
        }

        fileCount += 1;
        if (fileCount > maxFiles) throw new Error("Zip contains too many files.");
        if (entry.uncompressedSize > maxIndividualFileBytes) throw new Error("Zip entry is too large.");
        extractedTotal += entry.uncompressedSize;
        if (extractedTotal > maxExtractedTotalBytes) throw new Error("Zip extracted total is too large.");

        const outputPath = resolve(tempDir, safePath.relativeOutputPath);
        assertOutputPathInside(tempDir, outputPath);
        seenRequired.add(safePath.relativeOutputPath);
        await writeEntry(entry, zipFile, outputPath, entry.uncompressedSize);
      };

      zipFile.readEntry();
    });
  } finally {
    zipFile.close();
  }

  if (!seenRequired.has("pet.json") || !seenRequired.has("spritesheet.webp")) {
    throw new Error("Zip must contain pet.json and spritesheet.webp.");
  }
}

function openZipFromBuffer(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zipFile) => {
      if (error) {
        rejectPromise(error);
        return;
      }

      if (!zipFile) {
        rejectPromise(new Error("Zip file could not be opened."));
        return;
      }

      resolvePromise(zipFile);
    });
  });
}

function validateEntryMetadata(entry: Entry): void {
  if (entry.isEncrypted()) throw new Error("Encrypted zip entries are not supported.");
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error("Unsupported zip entry compression method.");
  }
  if (entry.compressedSize > maxZipDownloadBytes) throw new Error("Zip entry compressed size is too large.");
  if (entry.uncompressedSize > maxIndividualFileBytes) throw new Error("Zip entry uncompressed size is too large.");

  const unixMode = getUnixMode(entry);
  if (unixMode === null) return;

  const type = unixMode & 0o170000;
  const isKnownFileType = type !== 0;
  const isRegularFile = type === 0o100000;
  const isDirectory = type === 0o040000;
  if (isKnownFileType && !isRegularFile && !isDirectory) {
    throw new Error("Zip entry special files are not supported.");
  }
}

function getUnixMode(entry: Entry): number | null {
  if ((entry.versionMadeBy >> 8) !== 3) {
    return null;
  }

  return (entry.externalFileAttributes >> 16) & 0o177777;
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
          if (actualBytes > maxIndividualFileBytes) {
            callback(new Error("Zip entry exceeded individual size limit."));
            return;
          }
          callback(null, chunk);
        },
      });

      pipeline(readStream, counter, createWriteStream(outputPath, { mode: 0o600 }))
        .then(() => {
          if (actualBytes !== expectedBytes) {
            rejectPromise(new Error("Zip entry extracted size did not match metadata."));
            return;
          }

          resolvePromise();
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
