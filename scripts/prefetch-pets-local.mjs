#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const userDataPath = join(repoRoot, "local", "openpets-user-data");
const installerPath = join(repoRoot, "packages", "install-pet", "dist", "index.js");
const catalogV2Url = "https://openpets.dev/pets/catalog.v2.json";
const catalogV3Url = "https://openpets.dev/pets/catalog.v3.json";
const fetchTimeoutMs = 30_000;

await mkdir(userDataPath, { recursive: true });
assertInstallerBuilt();

const petIds = await loadAllPetIds();
console.log(`Preparing to prefetch ${petIds.length} pets into ${userDataPath}`);

const installed = [];
const skipped = [];
const failed = [];

for (const petId of petIds) {
  process.stdout.write(`Installing ${petId}... `);
  const result = spawnSync(process.execPath, [installerPath, petId], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENPETS_USER_DATA: userDataPath,
    },
    encoding: "utf8",
  });

  const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0) {
    installed.push(petId);
    process.stdout.write("done\n");
    continue;
  }

  if (combinedOutput.includes(`Pet is already installed: ${petId}`)) {
    skipped.push(petId);
    process.stdout.write("already installed\n");
    continue;
  }

  failed.push({ petId, output: combinedOutput.trim() || `exit ${String(result.status)}` });
  process.stdout.write("failed\n");
}

console.log(`Installed: ${installed.length}`);
console.log(`Skipped: ${skipped.length}`);
console.log(`Failed: ${failed.length}`);

if (failed.length > 0) {
  for (const failure of failed) {
    console.error(`- ${failure.petId}: ${failure.output}`);
  }
  process.exitCode = 1;
}

function assertInstallerBuilt() {
  if (!existsSync(installerPath)) {
    throw new Error(`Missing installer build at ${installerPath}. Run the workspace build first.`);
  }
}

async function loadAllPetIds() {
  try {
    return await loadAllPetIdsFromV3();
  } catch (error) {
    console.warn(`Catalog v3 unavailable, falling back to v2: ${error instanceof Error ? error.message : String(error)}`);
    return await loadAllPetIdsFromV2();
  }
}

async function loadAllPetIdsFromV3() {
  const index = await fetchJson(catalogV3Url);
  if (!isRecord(index) || index.version !== 3 || typeof index.search !== "string") {
    throw new Error("Catalog v3 index is invalid.");
  }

  const searchIndex = await fetchJson(index.search);
  if (!isRecord(searchIndex) || searchIndex.version !== 3 || !Array.isArray(searchIndex.pages)) {
    throw new Error("Catalog v3 search index is invalid.");
  }

  const ids = new Set();
  for (const pageUrl of searchIndex.pages) {
    if (typeof pageUrl !== "string" || pageUrl.length === 0) {
      throw new Error("Catalog v3 search page URL is invalid.");
    }
    const page = await fetchJson(pageUrl);
    if (!isRecord(page) || page.version !== 3 || !Array.isArray(page.pets)) {
      throw new Error("Catalog v3 search page is invalid.");
    }
    for (const pet of page.pets) {
      if (!isRecord(pet) || typeof pet.id !== "string" || pet.id.length === 0) {
        throw new Error("Catalog v3 search pet is invalid.");
      }
      ids.add(pet.id);
    }
  }

  return [...ids].sort();
}

async function loadAllPetIdsFromV2() {
  const catalog = await fetchJson(catalogV2Url);
  if (!isRecord(catalog) || catalog.version !== 2 || !Array.isArray(catalog.pets)) {
    throw new Error("Catalog v2 is invalid.");
  }

  return catalog.pets
    .filter((pet) => isRecord(pet) && typeof pet.id === "string" && pet.id.length > 0)
    .map((pet) => pet.id)
    .sort();
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
