import { readFileSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";

import { getAgentSetupSnapshot, runAgentSetupAction, updateAgentSetupCommandPaths } from "./agent-setup.js";
import { refreshAgentPetContent } from "./agent-pet-controller.js";
import { completeOnboarding, getAppStateSnapshot, normalizePetScale, petScaleOptions, updatePreferences } from "./app-state.js";
import { getCatalogPageUiState, getCatalogSearchUiState, getCatalogUiState } from "./catalog.js";
import { getCodexPetsUiState, importCodexPet } from "./codex-pets.js";
import { refreshDefaultPetContent, resetDefaultPetToInitialPosition } from "./default-pet-controller.js";
import { installPet, removePet, setDefaultInstalledPet } from "./pet-installation.js";
import { checkForGitHubReleaseUpdate, getUpdateStatus, openUpdateReleasePage } from "./update-checker.js";

type TaskWindowKind = "pet-manager" | "agent-setup" | "settings" | "onboarding";

interface TaskWindowDefinition {
  readonly title: string;
  readonly heading: string;
  readonly description: string;
}

const taskWindowDefinitions: Record<TaskWindowKind, TaskWindowDefinition> = {
  "pet-manager": {
    title: "OpenPets — Pet Manager",
    heading: "Manage Pets",
    description: "Install pets from the validated catalog, switch your active companion, and manage local pets.",
  },
  "agent-setup": {
    title: "OpenPets — Integrations",
    heading: "Integrations",
    description: "Connect OpenPets to coding tools with explicit confirmation.",
  },
  settings: {
    title: "OpenPets — Settings",
    heading: "Settings",
    description: "Tune how OpenPets starts and resets your desktop companion.",
  },
  onboarding: {
    title: "OpenPets — Welcome",
    heading: "Welcome to OpenPets",
    description: "Set up your pets and coding-agent integrations, or skip anything and come back later from the tray.",
  },
};

const taskWindows = new Map<TaskWindowKind, BrowserWindow>();
let internalUiHandlersInstalled = false;
const taskWindowWidth = 900;
const taskWindowHeight = 760;
const petManagerWindowWidth = 1160;
const petManagerWindowHeight = 780;
const agentSetupWindowWidth = 1160;
const agentSetupWindowHeight = 780;
const assetDataUrlCache = new Map<string, string>();

export function installInternalUiHandlers(): void {
  if (internalUiHandlersInstalled) {
    return;
  }

  internalUiHandlersInstalled = true;

  ipcMain.handle("openpets:get-state", (event) => {
    assertAllowedSender(event, ["pet-manager", "settings", "agent-setup"]);
    return getAppStateSnapshot();
  });

  ipcMain.handle("openpets:onboarding-snapshot", (event) => {
    assertAllowedSender(event, ["onboarding"]);
    const state = getAppStateSnapshot();
    const defaultPet = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId) ?? state.pets.installed[0];
    return {
      defaultPetName: defaultPet?.displayName ?? "Built-in Pet",
      onboardingCompleted: state.preferences.onboardingCompleted,
    };
  });

  ipcMain.handle("openpets:onboarding-complete", async (event) => {
    assertAllowedSender(event, ["onboarding"]);
    completeOnboarding();
    const { refreshTrayMenu } = await import("./tray.js");
    refreshTrayMenu();
    setTimeout(() => closeTaskWindow("onboarding"), 0);
    return { onboardingCompleted: true };
  });

  ipcMain.handle("openpets:onboarding-open-pet-manager", (event) => {
    assertAllowedSender(event, ["onboarding"]);
    openTaskWindow("pet-manager");
  });

  ipcMain.handle("openpets:onboarding-open-agent-setup", (event) => {
    assertAllowedSender(event, ["onboarding"]);
    openTaskWindow("agent-setup");
  });

  ipcMain.handle("openpets:get-catalog", async (event) => {
    assertAllowedSender(event, ["pet-manager"]);
    return getCatalogUiState();
  });

  ipcMain.handle("openpets:get-catalog-page", async (event, page: unknown) => {
    assertAllowedSender(event, ["pet-manager"]);
    if (typeof page !== "number" || !Number.isInteger(page) || page < 0) throw new Error("Invalid catalog page.");
    return getCatalogPageUiState(page);
  });

  ipcMain.handle("openpets:get-catalog-search", async (event) => {
    assertAllowedSender(event, ["pet-manager"]);
    return getCatalogSearchUiState();
  });

  ipcMain.handle("openpets:get-codex-pets", async (event) => {
    assertAllowedSender(event, ["pet-manager"]);
    return getCodexPetsUiState();
  });

  ipcMain.handle("openpets:update-preferences", (event, patch: unknown) => {
    assertAllowedSender(event, ["settings"]);
    const previousScale = getAppStateSnapshot().preferences.petScale;
    const state = updatePreferences(validatePreferencePatch(patch));
    if (state.preferences.petScale !== previousScale) {
      refreshDefaultPetContent();
      refreshAgentPetContent();
    }
    return state;
  });

  ipcMain.handle("openpets:get-launch-at-login", (event) => {
    assertAllowedSender(event, ["settings"]);
    return getLaunchAtLoginState();
  });

  ipcMain.handle("openpets:set-launch-at-login", (event, enabled: unknown) => {
    assertAllowedSender(event, ["settings"]);
    if (typeof enabled !== "boolean") throw new Error("Invalid launch-at-login value.");
    if (!isLaunchAtLoginSupported()) return getLaunchAtLoginState();
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    return getLaunchAtLoginState();
  });

  ipcMain.handle("openpets:get-update-status", (event) => {
    assertAllowedSender(event, ["settings"]);
    return getUpdateStatus();
  });

  ipcMain.handle("openpets:check-for-updates", async (event) => {
    assertAllowedSender(event, ["settings"]);
    const status = await checkForGitHubReleaseUpdate();
    const { refreshTrayMenu } = await import("./tray.js");
    refreshTrayMenu();
    return status;
  });

  ipcMain.handle("openpets:open-update-release-page", async (event) => {
    assertAllowedSender(event, ["settings"]);
    await openUpdateReleasePage();
  });

  ipcMain.handle("openpets:set-default-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["pet-manager"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    const state = await setDefaultInstalledPet(petId);
    refreshDefaultPetContent();
    return state;
  });

  ipcMain.handle("openpets:install-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["pet-manager"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    return installPet(petId);
  });

  ipcMain.handle("openpets:import-codex-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["pet-manager"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    return importCodexPet(petId);
  });

  ipcMain.handle("openpets:remove-pet", async (event, petId: unknown) => {
    assertAllowedSender(event, ["pet-manager"]);
    if (typeof petId !== "string") {
      throw new Error("Invalid pet id.");
    }

    const state = await removePet(petId);
    refreshDefaultPetContent();
    return state;
  });

  ipcMain.handle("openpets:reset-default-pet-position", (event) => {
    assertAllowedSender(event, ["settings"]);
    resetDefaultPetToInitialPosition();
    return getAppStateSnapshot();
  });

  ipcMain.handle("openpets:agent-setup-snapshot", async (event, selectedPetId: unknown, commandMode: unknown) => {
    assertAllowedSender(event, ["agent-setup"]);
    return getAgentSetupSnapshot(selectedPetId, commandMode);
  });

  ipcMain.handle("openpets:agent-setup-action", async (event, action: unknown, selectedPetId: unknown, commandMode: unknown) => {
    assertAllowedSender(event, ["agent-setup"]);
    if (action !== "configure" && action !== "replace" && action !== "remove" && action !== "install-memory" && action !== "doctor-hooks" && action !== "install-hooks" && action !== "uninstall-hooks" && action !== "opencode-install" && action !== "opencode-remove") {
      throw new Error("Invalid agent setup action.");
    }

    return runAgentSetupAction(action, selectedPetId, commandMode);
  });

  ipcMain.handle("openpets:agent-setup-command-paths", (event, patch: unknown) => {
    assertAllowedSender(event, ["agent-setup"]);
    return updateAgentSetupCommandPaths(patch);
  });
}

export function openTaskWindow(kind: TaskWindowKind): void {
  const existingWindow = taskWindows.get(kind);

  if (existingWindow && !existingWindow.isDestroyed()) {
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }

    existingWindow.show();
    existingWindow.focus();
    console.log(`Focused existing ${kind} window.`);
    return;
  }

  const definition = taskWindowDefinitions[kind];
  const width = kind === "pet-manager" ? petManagerWindowWidth : kind === "agent-setup" ? agentSetupWindowWidth : taskWindowWidth;
  const height = kind === "pet-manager" ? petManagerWindowHeight : kind === "agent-setup" ? agentSetupWindowHeight : taskWindowHeight;
  const window = new BrowserWindow({
    title: definition.title,
    width,
    height,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: "#0f172a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      ...(kind === "pet-manager" || kind === "settings" || kind === "agent-setup" || kind === "onboarding" ? { preload: getPreloadPath() } : {}),
    },
  });

  taskWindows.set(kind, window);
  window.setMenu(null);

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => {
    event.preventDefault();
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error(`Failed to load ${kind} placeholder window.`, { errorCode, errorDescription });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`${kind} placeholder renderer process gone.`, details);
  });

  window.on("closed", () => {
    taskWindows.delete(kind);
    console.log(`Closed ${kind} window.`);
  });

  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });

  window.loadURL(createTaskWindowDataUrl(kind, definition)).catch((error: unknown) => {
    console.error(`Failed to load ${kind} placeholder URL.`, error);
  });

  console.log(`Opened ${kind} window.`);
}

export function closeTaskWindow(kind: TaskWindowKind): void {
  const window = taskWindows.get(kind);
  if (window && !window.isDestroyed()) {
    window.close();
  }
}

export function focusOpenTaskWindows(): void {
  for (const window of taskWindows.values()) {
    if (window.isDestroyed()) {
      continue;
    }

    if (window.isMinimized()) {
      window.restore();
    }

    window.show();
    window.focus();
  }
}

function createTaskWindowDataUrl(kind: TaskWindowKind, definition: TaskWindowDefinition): string {
  if (kind === "pet-manager") {
    return createDataUrl(createPetManagerHtml(definition));
  }

  if (kind === "settings") {
    return createDataUrl(createSettingsHtml(definition));
  }

  if (kind === "onboarding") {
    return createDataUrl(createOnboardingHtml(definition));
  }

  return createDataUrl(createAgentSetupHtml(definition));
}

function createPlaceholderHtml(definition: TaskWindowDefinition): string {
  const html = `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(definition.title)}</title>
        <style>
          :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top, #1e293b, #020617); color: #e5e7eb; }
          main { width: min(520px, calc(100vw - 48px)); border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 24px; background: rgba(15, 23, 42, 0.82); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35); padding: 32px; }
          p.eyebrow { margin: 0 0 12px; color: #93c5fd; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
          h1 { margin: 0; font-size: 32px; line-height: 1.1; }
          p { color: #cbd5e1; font-size: 16px; line-height: 1.6; }
          .badge { display: inline-flex; align-items: center; border: 1px solid rgba(147, 197, 253, 0.35); border-radius: 999px; color: #bfdbfe; padding: 6px 10px; font-size: 13px; }
        </style>
      </head>
      <body>
        <main>
          <p class="eyebrow">OpenPets Phase 01</p>
          <h1>${escapeHtml(definition.heading)}</h1>
          <p>${escapeHtml(definition.description)}</p>
          <span class="badge">Placeholder window</span>
        </main>
      </body>
    </html>`;

  return html;
}

function createPetManagerHtml(definition: TaskWindowDefinition): string {
  const logoUrl = createAssetDataUrl("onboarding-logo.webp", "image/webp");
  const defaultThumbnailUrl = createAssetDataUrl("default-pet-thumbnail.png", "image/png");

  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https://openpets.dev; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
        <meta name="referrer" content="no-referrer" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(definition.title)}</title>
        ${createTaskWindowStyles()}
      </head>
      <body data-openpets-view="pet-manager" data-default-pet-thumbnail-src="${escapeHtml(defaultThumbnailUrl)}">
        <main class="pm-shell">
          <section class="pm-gallery-pane" aria-labelledby="pm-title">
            <img class="pm-logo" src="${escapeHtml(logoUrl)}" alt="OpenPets" draggable="false" />
            <header class="pm-header">
              <h1 id="pm-title">Install a Pet</h1>
              <p class="lede">Pick a companion for your terminal.</p>
              <span id="catalog-status" class="pm-status-pill">Loading…</span>
            </header>
            <label class="pm-search-wrap" for="catalog-search">
              <span class="pm-search-icon" aria-hidden="true"></span>
              <input id="catalog-search" type="search" placeholder="Search pets…" />
            </label>
            <div class="pm-filters" role="group" aria-label="Pet filters">
              <div class="pm-filter-buttons primary">
                <button id="pm-filter-all" class="pm-filter active" type="button" data-pet-filter="all" aria-pressed="true">All</button>
                <button id="pm-filter-codex" class="pm-filter" type="button" data-pet-filter="codex" aria-pressed="false">Codex</button>
                <button id="pm-filter-installed" class="pm-filter" type="button" data-pet-filter="installed" aria-pressed="false">Installed</button>
              </div>
              <div class="pm-filter-buttons secondary">
                <button id="pm-filter-original" class="pm-filter" type="button" data-pet-filter="original" aria-pressed="false">OpenPets</button>
                <button id="pm-filter-western" class="pm-filter" type="button" data-pet-filter="western" aria-pressed="false">Western</button>
                <button id="pm-filter-asian" class="pm-filter" type="button" data-pet-filter="asian" aria-pressed="false">Asian</button>
              </div>
            </div>
            <div id="catalog-pets" class="pm-pet-grid" aria-label="Pets"></div>
          </section>

          <aside id="pm-detail" class="pm-detail-pane" aria-live="polite"></aside>
          <p class="error" data-error></p>
        </main>
      </body>
    </html>`;
}

function createOnboardingHtml(definition: TaskWindowDefinition): string {
  const logoUrl = createAssetDataUrl("onboarding-logo.webp", "image/webp");
  const petsUrl = createAssetDataUrl("onboarding-pets.webp", "image/webp");

  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(definition.title)}</title>
        ${createTaskWindowStyles()}
      </head>
      <body data-openpets-view="onboarding">
        <main class="onboarding-main">
          <header class="onboarding-header" id="onboarding-header">
            <p class="eyebrow">OpenPets</p>
            <h1>${escapeHtml(definition.heading)}</h1>
            <p class="lede">${escapeHtml(definition.description)}</p>
          </header>
          <nav class="steps" aria-label="Onboarding steps">
            <span class="step active" data-step-indicator="0">Welcome</span>
            <span class="step" data-step-indicator="1">Pets</span>
            <span class="step" data-step-indicator="2">Integrations</span>
            <span class="step" data-step-indicator="3">Ready</span>
          </nav>
          
          <section class="onboarding-step welcome-hero" data-step-panel="0">
            <div class="welcome-content">
              <img class="welcome-logo" src="${escapeHtml(logoUrl)}" alt="OpenPets" draggable="false" />
              <h2 class="welcome-title">Your AI coding companion</h2>
              <p class="welcome-body">OpenPets lives in your tray and gives your coding agents a friendly desktop companion — one command at a time.</p>
              <p class="welcome-default">Starting with <strong id="onboarding-default-pet">the bundled pet</strong>.</p>
              <div class="welcome-actions">
                <button id="onboarding-welcome-next" class="welcome-primary-btn">Next ›</button>
              </div>
            </div>
            <div class="welcome-visual" aria-hidden="true">
              <span class="welcome-sparkle s1">✦</span>
              <span class="welcome-sparkle s2">✧</span>
              <span class="welcome-sparkle s3">+</span>
              <img class="welcome-pets" src="${escapeHtml(petsUrl)}" alt="" draggable="false" />
            </div>
          </section>

          <section class="onboarding-step onboarding-flow-card" data-step-panel="1" hidden>
            <span class="onboarding-step-badge">Step 2</span>
            <h2>Pick your desktop companion</h2>
            <p>Your current default pet is <strong id="onboarding-pets-default-pet">the bundled pet</strong>. Pet Manager is opening so you can browse what is installed and add more later.</p>
            <p id="onboarding-pets-status" class="onboarding-status-line" aria-live="polite">Open Pet Manager to browse pets, then return here to continue.</p>
            <p class="onboarding-helper">You can also continue now. OpenPets still works with the bundled pet.</p>
            <div class="onboarding-flow-actions">
              <button id="onboarding-open-pets">Open Pet Manager</button>
              <button id="onboarding-pets-next" class="onboarding-continue-link">Continue to next step</button>
            </div>
          </section>
          <section class="onboarding-step onboarding-flow-card" data-step-panel="2" hidden>
            <span class="onboarding-step-badge">Step 3</span>
            <h2>Connect your coding tools</h2>
            <p>Open Integrations to connect Claude Code or OpenCode when you are ready. OpenPets shows previews and asks before changing MCP, hook, or OpenCode settings.</p>
            <p id="onboarding-agents-status" class="onboarding-status-line" aria-live="polite">Open Integrations to review agent setup, then return here to continue.</p>
            <p class="onboarding-helper">You can also continue now. Configuration is optional and can be done later from the tray.</p>
            <div class="onboarding-flow-actions">
              <button id="onboarding-open-agents">Open Integrations</button>
              <button id="onboarding-agents-next" class="onboarding-continue-link">Continue to next step</button>
            </div>
          </section>
          <section class="onboarding-step onboarding-flow-card ready-card" data-step-panel="3" hidden>
            <span class="onboarding-step-badge">Ready</span>
            <h2>OpenPets is ready</h2>
            <p>You can manage pets, open integrations, change settings, or quit from the tray at any time.</p>
            <p class="onboarding-helper">Nothing else is required. Start using OpenPets now, or reopen the setup windows below.</p>
            <div class="onboarding-flow-actions ready-actions">
              <button id="onboarding-finish">Start using OpenPets</button>
              <button id="onboarding-ready-pets" class="onboarding-continue-link">Open Pet Manager</button>
              <button id="onboarding-ready-agents" class="onboarding-continue-link">Open Integrations</button>
            </div>
          </section>
          <p class="note" id="onboarding-note">Closing this window before finishing keeps setup available from the tray.</p>
          <p class="error" data-error></p>
        </main>
      </body>
    </html>`;
}

function createAgentSetupHtml(definition: TaskWindowDefinition): string {
  const logoUrl = createAssetDataUrl("onboarding-logo.webp", "image/webp");
  const integrationIcons = {
    claude: createAssetDataUrl("integrations/claude.svg", "image/svg+xml"),
    cursor: createAssetDataUrl("integrations/cursor.svg", "image/svg+xml"),
    opencode: createAssetDataUrl("integrations/opencode.svg", "image/svg+xml"),
    vscode: createAssetDataUrl("integrations/vscode.svg", "image/svg+xml"),
    windsurf: createAssetDataUrl("integrations/windsurf.svg", "image/svg+xml"),
    zed: createAssetDataUrl("integrations/zed.svg", "image/svg+xml"),
  };

  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(definition.title)}</title>
        ${createTaskWindowStyles()}
      </head>
      <body data-openpets-view="agent-setup">
        <main class="agent-shell">
          <section id="integrations-view" class="integrations-view" aria-labelledby="agent-title">
            <header class="integrations-header">
              <img class="agent-logo" src="${escapeHtml(logoUrl)}" alt="OpenPets" draggable="false" />
              <p class="eyebrow">OpenPets</p>
              <h1 id="agent-title" tabindex="-1">Integrations</h1>
              <p class="lede">Install Claude or OpenCode integrations now, or configure the details when you need them.</p>
            </header>

            <div class="integration-grid" aria-label="Available integrations">
              <article class="integration-card featured" data-integration-card="claude" tabindex="-1">
                <div class="integration-card-top">
                  <span class="integration-icon"><img src="${escapeHtml(integrationIcons.claude)}" alt="" draggable="false" /></span>
                  <span id="integration-claude-status" class="agent-status-pill">Checking</span>
                </div>
                <h2>Claude Code</h2>
                <p>Connect Claude Code to your OpenPets companion.</p>
                <div class="integration-actions stacked">
                  <button id="integration-claude-install" class="agent-action primary" disabled data-loading="true">
                    <svg class="pm-button-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Checking…
                  </button>
                  <button id="integration-claude-configure" class="agent-action secondary" disabled data-loading="true">
                    <svg class="pm-button-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Checking…
                  </button>
                </div>
              </article>

              <article class="integration-card" data-integration-card="opencode" tabindex="-1">
                <div class="integration-card-top"><span class="integration-icon"><img src="${escapeHtml(integrationIcons.opencode)}" alt="" draggable="false" /></span><span id="integration-opencode-status" class="agent-status-pill">Checking</span></div>
                <h2>OpenCode</h2><p>Connect OpenCode globally to your OpenPets companion.</p>
                <div class="integration-actions stacked">
                  <button id="integration-opencode-install" class="agent-action primary" disabled data-loading="true">Checking…</button>
                  <button id="integration-opencode-configure" class="agent-action secondary" disabled data-loading="true">Checking…</button>
                </div>
              </article>
              <article class="integration-card disabled">
                <div class="integration-card-top"><span class="integration-icon"><img src="${escapeHtml(integrationIcons.cursor)}" alt="" draggable="false" /></span><span class="agent-status-pill muted">Soon</span></div>
                <h2>Cursor</h2><p>Coming soon.</p><button class="agent-action secondary" disabled>Coming soon</button>
              </article>
              <article class="integration-card disabled">
                <div class="integration-card-top"><span class="integration-icon"><img src="${escapeHtml(integrationIcons.vscode)}" alt="" draggable="false" /></span><span class="agent-status-pill muted">Soon</span></div>
                <h2>VS Code</h2><p>Coming soon.</p><button class="agent-action secondary" disabled>Coming soon</button>
              </article>
              <article class="integration-card disabled">
                <div class="integration-card-top"><span class="integration-icon"><img src="${escapeHtml(integrationIcons.windsurf)}" alt="" draggable="false" /></span><span class="agent-status-pill muted">Soon</span></div>
                <h2>Windsurf</h2><p>Coming soon.</p><button class="agent-action secondary" disabled>Coming soon</button>
              </article>
              <article class="integration-card disabled">
                <div class="integration-card-top"><span class="integration-icon"><img src="${escapeHtml(integrationIcons.zed)}" alt="" draggable="false" /></span><span class="agent-status-pill muted">Soon</span></div>
                <h2>Zed</h2><p>Coming soon.</p><button class="agent-action secondary" disabled>Coming soon</button>
              </article>
            </div>
          </section>

          <section id="claude-detail-view" class="claude-detail-view" aria-labelledby="claude-detail-title" hidden>
            <div class="claude-detail-toolbar">
              <button id="integration-back" class="agent-action secondary compact">Back to integrations</button>
            </div>

            <section class="agent-setup-pane" aria-labelledby="claude-detail-title">
              <header class="agent-title-block compact-title">
                <p class="eyebrow">Integration</p>
                <h1 id="claude-detail-title" tabindex="-1">Claude Code</h1>
                <p class="lede">Connect Claude to your OpenPets companion. Basic setup is one card; hooks and command details are optional.</p>
              </header>

              <article class="agent-status-card connection-card">
                <div class="agent-section-header">
                  <span>
                    <small>Connection</small>
                    <strong id="claude-status-title">Checking setup…</strong>
                  </span>
                  <span id="claude-status" class="agent-status-pill">Checking</span>
                </div>
                <p id="claude-details" class="agent-note">Checking Claude Code…</p>

                <div class="agent-control-group">
                  <label class="agent-field-label" for="claude-pet-select">Pet routing</label>
                  <select id="claude-pet-select" class="agent-select"></select>
                </div>

                <section class="agent-command-paths" aria-labelledby="claude-command-paths-title">
                  <div class="agent-command-paths-title"><small>Configuration</small><strong id="claude-command-paths-title">Command paths</strong></div>
                  <p class="agent-note">If Claude or Node.js is not detected from the app, paste the full executable path. Leave blank for automatic PATH detection.</p>
                  <label class="agent-subfield" for="claude-command-path"><span>Claude command</span><div class="agent-path-row"><input id="claude-command-path" class="agent-text-input" type="text" spellcheck="false" placeholder="/Users/alvin/.local/bin/claude" /><button id="claude-command-path-save" class="agent-action secondary compact">Save path</button></div></label>
                  <label class="agent-subfield" for="node-command-path"><span>Node.js command</span><div class="agent-path-row"><input id="node-command-path" class="agent-text-input" type="text" spellcheck="false" placeholder="/Users/name/.nvm/versions/node/v22/bin/node" /><button id="node-command-path-save" class="agent-action secondary compact">Save path</button></div></label>
                </section>

                <label class="agent-mode-row dev-mode-row" hidden>
                  <span>
                    <strong>Use local dev commands</strong>
                    <small>Developer-only: use this checkout instead of published packages.</small>
                  </span>
                  <input id="claude-dev-mode" type="checkbox" />
                </label>

                <div class="agent-actions agent-main-actions">
                  <button id="claude-configure" class="agent-action primary">Install integration</button>
                  <button id="claude-replace" class="agent-action primary">Replace configuration</button>
                  <button id="claude-remove" class="agent-action danger">Remove integration</button>
                  <button id="claude-refresh" class="agent-action secondary">Refresh status</button>
                </div>

                <p id="claude-warning" class="agent-inline-note">Nothing changes until you choose an action.</p>

                <details class="agent-inline-details">
                  <summary>
                    <span>
                      <small>Advanced MCP details</small>
                      <strong>Command and JSON preview</strong>
                    </span>
                  </summary>
                  <p class="agent-note">Inspect the MCP command OpenPets will add to Claude, or copy it for manual setup.</p>
                  <div class="agent-actions advanced-actions">
                    <button id="claude-copy-command" class="agent-action secondary compact">Copy command</button>
                  </div>
                  <pre id="claude-command-preview" class="agent-preview-code command-preview" aria-label="Claude MCP command preview" aria-live="polite"></pre>
                  <h2>MCP JSON</h2>
                  <pre id="claude-json-preview" class="agent-preview-code json-preview" aria-label="Claude MCP JSON preview" aria-live="polite"></pre>
                </details>
              </article>

              <article class="agent-memory-card">
                <div class="agent-section-header">
                  <span>
                    <small>Included</small>
                    <strong>Claude instructions</strong>
                  </span>
                  <span id="claude-memory-status" class="agent-status-pill">Checking</span>
                </div>
                <p id="claude-memory-details" class="agent-note">Checking Claude instructions…</p>
                <p class="agent-inline-note">OpenPets writes its guidance to <code>~/.claude/openpets.md</code> and adds one managed import to <code>~/.claude/CLAUDE.md</code>. Existing Claude instructions are preserved.</p>
                <div class="agent-actions memory-actions">
                  <button id="claude-memory-install" class="agent-action secondary">Update instructions</button>
                </div>
              </article>

              <article class="agent-hooks-card">
                <div class="agent-section-header">
                  <span>
                    <small>Optional</small>
                    <strong>Claude hooks</strong>
                  </span>
                  <span id="claude-hooks-status" class="agent-status-pill">Checking</span>
                </div>
                <p id="claude-hooks-details" class="agent-note">Checking hooks…</p>
                <p class="agent-hook-warning warning">Hooks let Claude events trigger pet reactions. They modify your global Claude Code settings.</p>
                <div class="agent-actions hook-actions">
                  <button id="claude-hooks-install" class="agent-action primary">Install hooks</button>
                  <button id="claude-hooks-doctor" class="agent-action secondary">Check hooks</button>
                  <button id="claude-hooks-uninstall" class="agent-action danger">Remove hooks</button>
                </div>
                <details class="agent-inline-details">
                  <summary>
                    <span>
                      <small>Advanced hook details</small>
                      <strong>Hooks JSON preview</strong>
                    </span>
                  </summary>
                  <p class="agent-note">Preview the OpenPets-managed Claude hook settings before installing or updating hooks.</p>
                  <pre id="claude-hooks-preview" class="agent-preview-code hooks-preview" aria-label="Claude hooks JSON preview" aria-live="polite"></pre>
                </details>
              </article>

              <p id="claude-action-result" class="agent-result" aria-live="polite">Claude Code may need to be restarted after MCP changes.</p>
            </section>
          </section>

          <section id="opencode-detail-view" class="claude-detail-view" aria-labelledby="opencode-detail-title" hidden>
            <div class="claude-detail-toolbar"><button id="opencode-integration-back" class="agent-action secondary compact">Back to integrations</button></div>
            <section class="agent-setup-pane" aria-labelledby="opencode-detail-title">
              <header class="agent-title-block compact-title"><p class="eyebrow">Integration</p><h1 id="opencode-detail-title" tabindex="-1">OpenCode</h1><p class="lede">Connect OpenCode to OpenPets. Desktop setup writes global OpenCode config; use the CLI for project-local setup.</p></header>
              <article class="agent-status-card connection-card">
                <div class="agent-section-header"><span><small>Global connection</small><strong id="opencode-status-title">Checking setup…</strong></span><span id="opencode-status" class="agent-status-pill">Checking</span></div>
                <p id="opencode-details" class="agent-note">Checking OpenCode…</p>
                <div class="agent-control-group"><label class="agent-field-label" for="opencode-pet-select">Pet routing</label><select id="opencode-pet-select" class="agent-select"></select></div>
                <section class="agent-command-paths" aria-labelledby="opencode-command-paths-title"><div class="agent-command-paths-title"><small>Configuration</small><strong id="opencode-command-paths-title">Command paths</strong></div><p class="agent-note">If OpenCode or Node.js is not detected from the app, paste the full executable path. Leave blank for automatic PATH detection.</p><label class="agent-subfield" for="opencode-command-path"><span>OpenCode command</span><div class="agent-path-row"><input id="opencode-command-path" class="agent-text-input" type="text" spellcheck="false" placeholder="/Users/alvin/.opencode/bin/opencode" /><button id="opencode-command-path-save" class="agent-action secondary compact">Save path</button></div></label><label class="agent-subfield" for="opencode-node-command-path"><span>Node.js command</span><div class="agent-path-row"><input id="opencode-node-command-path" class="agent-text-input" type="text" spellcheck="false" placeholder="/Users/name/.nvm/versions/node/v22/bin/node" /><button id="opencode-node-command-path-save" class="agent-action secondary compact">Save path</button></div></label></section>
                <p class="agent-hook-warning warning">Desktop OpenCode setup is global and can affect every OpenCode project. For project-local setup, run <code>openpets configure --agent opencode --pet &lt;id&gt;</code>. OpenCode may need npm/network access to load the published OpenPets plugin unless it is already cached or installed.</p>
                <div class="agent-actions agent-main-actions"><button id="opencode-install" class="agent-action primary">Install global setup</button><button id="opencode-remove" class="agent-action danger">Remove global setup</button><button id="opencode-refresh" class="agent-action secondary">Refresh</button></div>
                <details class="agent-inline-details" open><summary><span><small>Preview</small><strong>Global OpenCode config</strong></span></summary><p id="opencode-paths" class="agent-note"></p><div class="agent-actions advanced-actions"><button id="opencode-copy-config" class="agent-action secondary compact">Copy config preview</button></div><pre id="opencode-json-preview" class="agent-preview-code json-preview" aria-label="OpenCode config preview" aria-live="polite"></pre></details>
              </article>
              <p id="opencode-action-result" class="agent-result" aria-live="polite">OpenCode may need to be restarted after global setup changes.</p>
            </section>
          </section>

          <p class="error" data-error></p>
        </main>
      </body>
    </html>`;
}
function createSettingsHtml(definition: TaskWindowDefinition): string {
  const scaleOptionsHtml = petScaleOptions.map((option) => `<option value="${option.value}">${escapeHtml(option.label)}</option>`).join("");
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(definition.title)}</title>
        ${createTaskWindowStyles()}
      </head>
      <body data-openpets-view="settings">
        <main class="settings-shell">
          <header class="settings-header">
            <p class="eyebrow">OpenPets</p>
            <h1>${escapeHtml(definition.heading)}</h1>
            <p class="lede">${escapeHtml(definition.description)}</p>
          </header>
          <section class="settings-panel" aria-labelledby="settings-general-title">
            <div class="settings-section-heading">
              <span>
                <small>General</small>
                <h2 id="settings-general-title">Startup and companion behavior</h2>
              </span>
            </div>
            <label class="setting-row">
              <span>
                <strong>Open default pet on app launch</strong>
                <small>When disabled, OpenPets starts in the tray and the default pet can still be shown manually.</small>
              </span>
              <input id="open-default-pet-on-launch" type="checkbox" />
            </label>
            <label class="setting-row">
              <span>
                <strong>Launch OpenPets at login</strong>
                <small id="launch-at-login-detail">Start OpenPets automatically when you sign in.</small>
              </span>
              <input id="launch-at-login" type="checkbox" />
            </label>
          </section>
          <section class="settings-panel" aria-labelledby="settings-pet-title">
            <div class="settings-section-heading">
              <span>
                <small>Pet</small>
                <h2 id="settings-pet-title">Desktop pet controls</h2>
              </span>
            </div>
            <label class="setting-row">
              <span>
                <strong>Pet scale</strong>
                <small id="pet-scale-value">Small</small>
              </span>
              <select id="pet-scale" class="settings-select" aria-label="Pet scale">${scaleOptionsHtml}</select>
            </label>
            <div class="setting-row">
              <span>
                <strong>Reset default pet position</strong>
                <small>Moves the default pet back near the bottom-right of the primary display.</small>
              </span>
              <button id="reset-default-pet-position">Reset</button>
            </div>
          </section>
          <section class="settings-panel" aria-labelledby="settings-updates-title">
            <div class="settings-section-heading">
              <span>
                <small>Updates</small>
                <h2 id="settings-updates-title">App updates</h2>
              </span>
            </div>
            <div class="setting-row">
              <span>
                <strong id="update-status-title">Checking for updates</strong>
                <small id="update-status-detail">OpenPets checks public GitHub releases and opens the release page when an update is available.</small>
              </span>
              <span class="settings-actions-inline">
                <button id="check-for-updates">Check</button>
                <button id="open-update-release" class="secondary" hidden>Open release</button>
              </span>
            </div>
          </section>
          <p id="settings-status" class="settings-status" role="status" aria-live="polite">Changes save automatically.</p>
          <p class="error" data-error></p>
        </main>
      </body>
    </html>`;
}

function createTaskWindowStyles(): string {
  return `<style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #1e293b, #020617); color: #e5e7eb; -webkit-font-smoothing: antialiased; transition: color 240ms ease; }
    main { width: min(760px, calc(100vw - 48px)); margin: 0 auto; padding: 36px 0; }
    .eyebrow { margin: 0 0 10px; color: #93c5fd; font-size: 13px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
    h1 { margin: 0 0 12px; font-size: 34px; line-height: 1.1; text-wrap: balance; }
    h2 { margin: 28px 0 12px; font-size: 20px; }
    .lede, .note, small { color: #cbd5e1; line-height: 1.5; text-wrap: pretty; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin: 24px 0; }
    .card, .setting-row { border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 20px; background: rgba(15, 23, 42, 0.82); box-shadow: 0 18px 54px rgba(0, 0, 0, 0.28); padding: 20px; transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s ease; }
    .card:hover { border-color: rgba(147, 197, 253, 0.3); }
    .card h2 { margin: 0 0 14px; }
    .badges, .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .actions { margin-top: 18px; }
    .badge { display: inline-flex; border: 1px solid rgba(147, 197, 253, 0.35); border-radius: 999px; color: #bfdbfe; padding: 5px 9px; font-size: 12px; font-weight: 700; background: rgba(30, 64, 175, 0.15); }
    button { border: 1px solid rgba(147, 197, 253, 0.4); border-radius: 999px; background: rgba(30, 64, 175, 0.5); color: #dbeafe; font-weight: 800; padding: 8px 12px; cursor: pointer; transition: transform 0.1s ease, background 0.2s ease; }
    button:hover:not(:disabled) { background: rgba(30, 64, 175, 0.8); }
    button:active:not(:disabled) { transform: scale(0.96); }
    button:disabled { opacity: 0.55; cursor: not-allowed; }
    button.secondary { background: transparent; border-color: rgba(148, 163, 184, 0.4); color: #cbd5e1; }
    button.secondary:hover:not(:disabled) { background: rgba(148, 163, 184, 0.1); }
    select { appearance: none; }
    pre.preview { overflow: auto; white-space: pre-wrap; border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 14px; background: rgba(2, 6, 23, 0.72); color: #dbeafe; padding: 14px; }
    .agent-header { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; }
    .agent-header h2 { margin-top: 0; }
    .steps { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0; }
    .step { border: 1px solid rgba(148, 163, 184, 0.24); border-radius: 999px; color: #94a3b8; padding: 6px 10px; font-size: 12px; font-weight: 800; }
    .step.active { border-color: rgba(147, 197, 253, 0.55); color: #dbeafe; background: rgba(30, 64, 175, 0.35); }
    .onboarding-step[hidden] { display: none !important; }
    .field-label { display: block; margin: 18px 0 8px; color: #bfdbfe; font-weight: 800; }
    .warning { color: #fde68a; min-height: 1.2em; }
    .settings-list { display: grid; gap: 14px; margin-top: 24px; }
    .setting-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    .setting-row span { display: grid; gap: 5px; }
    .setting-row.disabled { opacity: 0.72; }
    input[type="checkbox"] { width: 22px; height: 22px; accent-color: #60a5fa; cursor: pointer; }
    .search { width: 100%; box-sizing: border-box; border: 1px solid rgba(148, 163, 184, 0.28); border-radius: 999px; background: rgba(15, 23, 42, 0.82); color: #e5e7eb; padding: 11px 14px; font: inherit; outline: none; transition: border-color 0.2s ease, box-shadow 0.2s ease; }
    .search:focus { border-color: #60a5fa; box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.2); }
    .error { color: #fca5a5; min-height: 1.2em; }

    html:has(body[data-openpets-view="settings"]), html:has(body[data-openpets-view="onboarding"]) { color-scheme: light; background: #eef7ff; scrollbar-color: rgba(96, 165, 250, 0.42) transparent; }
    body[data-openpets-view="settings"] { overflow: auto; color-scheme: light; background: radial-gradient(circle at 12% 8%, rgba(219, 234, 254, 0.9), transparent 24%), linear-gradient(180deg, #f8fbff 0%, #eff7ff 54%, #e9f3ff 100%); color: #10244a; }
    html:has(body[data-openpets-view="settings"]), html:has(body[data-openpets-view="onboarding"]), body[data-openpets-view="settings"], body[data-openpets-view="onboarding"], body[data-openpets-view="agent-setup"] .integration-grid, body[data-openpets-view="agent-setup"] .agent-setup-pane, body[data-openpets-view="agent-setup"] .agent-preview-code { scrollbar-color: rgba(96, 165, 250, 0.42) transparent; }
    html:has(body[data-openpets-view="settings"])::-webkit-scrollbar, html:has(body[data-openpets-view="onboarding"])::-webkit-scrollbar, body[data-openpets-view="settings"]::-webkit-scrollbar, body[data-openpets-view="onboarding"]::-webkit-scrollbar, body[data-openpets-view="agent-setup"] .integration-grid::-webkit-scrollbar, body[data-openpets-view="agent-setup"] .agent-setup-pane::-webkit-scrollbar, body[data-openpets-view="agent-setup"] .agent-preview-code::-webkit-scrollbar { width: 8px; height: 8px; }
    html:has(body[data-openpets-view="settings"])::-webkit-scrollbar-track, html:has(body[data-openpets-view="onboarding"])::-webkit-scrollbar-track, body[data-openpets-view="settings"]::-webkit-scrollbar-track, body[data-openpets-view="onboarding"]::-webkit-scrollbar-track, body[data-openpets-view="agent-setup"] .integration-grid::-webkit-scrollbar-track, body[data-openpets-view="agent-setup"] .agent-setup-pane::-webkit-scrollbar-track, body[data-openpets-view="agent-setup"] .agent-preview-code::-webkit-scrollbar-track { background: transparent; }
    html:has(body[data-openpets-view="settings"])::-webkit-scrollbar-thumb, html:has(body[data-openpets-view="onboarding"])::-webkit-scrollbar-thumb, body[data-openpets-view="settings"]::-webkit-scrollbar-thumb, body[data-openpets-view="onboarding"]::-webkit-scrollbar-thumb, body[data-openpets-view="agent-setup"] .integration-grid::-webkit-scrollbar-thumb, body[data-openpets-view="agent-setup"] .agent-setup-pane::-webkit-scrollbar-thumb, body[data-openpets-view="agent-setup"] .agent-preview-code::-webkit-scrollbar-thumb { background: rgba(126, 161, 210, 0.45); border-radius: 999px; }
    html:has(body[data-openpets-view="settings"])::-webkit-scrollbar-thumb:hover, html:has(body[data-openpets-view="onboarding"])::-webkit-scrollbar-thumb:hover, body[data-openpets-view="settings"]::-webkit-scrollbar-thumb:hover, body[data-openpets-view="onboarding"]::-webkit-scrollbar-thumb:hover, body[data-openpets-view="agent-setup"] .integration-grid::-webkit-scrollbar-thumb:hover, body[data-openpets-view="agent-setup"] .agent-setup-pane::-webkit-scrollbar-thumb:hover, body[data-openpets-view="agent-setup"] .agent-preview-code::-webkit-scrollbar-thumb:hover { background: rgba(99, 130, 178, 0.65); }
    body[data-openpets-view="settings"] .settings-shell { width: min(760px, calc(100vw - 40px)); padding: 30px 0 28px; }
    body[data-openpets-view="settings"] .settings-header { display: grid; justify-items: center; text-align: center; margin-bottom: 18px; }
    body[data-openpets-view="settings"] .settings-header .eyebrow { margin: 0 0 5px; color: #2478ff; }
    body[data-openpets-view="settings"] .settings-header h1 { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 34px; line-height: 1.05; letter-spacing: -0.05em; color: #102149; }
    body[data-openpets-view="settings"] .settings-header .lede { max-width: 520px; margin: 8px 0 0; color: #63708f; line-height: 1.38; }
    body[data-openpets-view="settings"] .settings-panel { display: grid; gap: 12px; margin: 0 0 14px; padding: 20px; border: 1px solid rgba(126, 161, 210, 0.44); border-radius: 22px; background: rgba(255,255,255,0.76); box-shadow: 0 18px 42px rgba(61, 99, 160, 0.11), inset 0 1px 0 rgba(255,255,255,0.94); }
    body[data-openpets-view="settings"] .settings-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 2px; }
    body[data-openpets-view="settings"] .settings-section-heading span { display: grid; gap: 4px; }
    body[data-openpets-view="settings"] .settings-section-heading small { color: #2478ff; font-size: 11px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; }
    body[data-openpets-view="settings"] .settings-section-heading h2 { margin: 0; color: #102149; font-size: 19px; line-height: 1.2; }
    body[data-openpets-view="settings"] .setting-row { min-height: 58px; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 15px; border: 1px solid rgba(126, 161, 210, 0.32); border-radius: 16px; background: rgba(255,255,255,0.68); box-shadow: inset 0 1px 0 rgba(255,255,255,0.82); color: #17284f; }
    body[data-openpets-view="settings"] .setting-row strong { display: block; margin-bottom: 4px; color: #102149; font-size: 14px; }
    body[data-openpets-view="settings"] .setting-row small { color: #63708f; line-height: 1.35; }
    body[data-openpets-view="settings"] .setting-row.disabled { opacity: 0.76; }
    body[data-openpets-view="settings"] input[type="checkbox"] { width: 42px; height: 24px; flex: 0 0 auto; accent-color: #2478ff; cursor: pointer; }
    body[data-openpets-view="settings"] .settings-select { min-height: 38px; min-width: 128px; box-sizing: border-box; border: 1px solid rgba(37, 99, 235, 0.34); border-radius: 11px; background: rgba(255,255,255,0.82); color: #17284f; padding: 0 12px; font: inherit; font-weight: 850; outline: none; }
    body[data-openpets-view="settings"] .settings-actions-inline { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    body[data-openpets-view="settings"] input[type="checkbox"]:focus-visible, body[data-openpets-view="settings"] button:focus-visible, body[data-openpets-view="settings"] .settings-select:focus-visible { outline: 3px solid rgba(37, 99, 235, 0.34); outline-offset: 3px; }
    body[data-openpets-view="settings"] button { min-height: 36px; border: 1px solid rgba(37, 99, 235, 0.34); border-radius: 11px; padding: 0 13px; background: rgba(255,255,255,0.76); color: #176df2; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; font-weight: 950; box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 8px 18px rgba(61, 99, 160, 0.08); }
    body[data-openpets-view="settings"] button:hover:not(:disabled) { background: #eff6ff; border-color: rgba(37, 99, 235, 0.64); transform: translateY(-1px); }
    body[data-openpets-view="settings"] button:disabled { cursor: default; opacity: 0.58; transform: none; }
    body[data-openpets-view="settings"] .settings-status { min-height: 20px; margin: 12px 0 0; padding: 12px 14px; border-radius: 14px; background: rgba(239, 246, 255, 0.78); border: 1px solid rgba(37, 99, 235, 0.18); color: #36547d; line-height: 1.4; }
    body[data-openpets-view="settings"] [data-error] { color: #b91c1c; }
    @media (max-width: 620px) { body[data-openpets-view="settings"] .setting-row { align-items: flex-start; flex-direction: column; } }

    body[data-openpets-view="agent-setup"] { overflow: hidden; background: radial-gradient(circle at 12% 8%, rgba(219, 234, 254, 0.9), transparent 24%), linear-gradient(180deg, #f8fbff 0%, #eff7ff 54%, #e9f3ff 100%); color: #101f3f; }
    body[data-openpets-view="agent-setup"] .agent-shell { width: min(1160px, calc(100vw - 36px)); height: calc(100vh - 44px); padding: 22px 0 22px; overflow: hidden; }
    body[data-openpets-view="agent-setup"] .integrations-view { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    body[data-openpets-view="agent-setup"] .integrations-view[hidden], body[data-openpets-view="agent-setup"] .claude-detail-view[hidden] { display: none !important; }
    body[data-openpets-view="agent-setup"] .integrations-header { flex: 0 0 auto; display: grid; justify-items: center; text-align: center; margin-bottom: 12px; }
    body[data-openpets-view="agent-setup"] .integrations-header .agent-logo { margin-bottom: 0; }
    body[data-openpets-view="agent-setup"] .integrations-header .eyebrow { margin: 0 0 5px; color: #2478ff; }
    body[data-openpets-view="agent-setup"] .integrations-header h1 { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 32px; line-height: 1; letter-spacing: -0.05em; color: #102149; }
    body[data-openpets-view="agent-setup"] .integrations-header .lede { max-width: 560px; margin: 6px 0 0; color: #63708f; line-height: 1.3; }
    body[data-openpets-view="agent-setup"] .integration-grid { min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; padding: 2px 4px 16px; }
    body[data-openpets-view="agent-setup"] .integration-card { min-height: 248px; box-sizing: border-box; display: flex; flex-direction: column; gap: 9px; border: 1px solid rgba(126, 161, 210, 0.44); border-radius: 20px; background: rgba(255,255,255,0.76); box-shadow: 0 16px 38px rgba(61, 99, 160, 0.1), inset 0 1px 0 rgba(255,255,255,0.94); padding: 16px; }
    body[data-openpets-view="agent-setup"] .integration-card.featured { border-color: rgba(37, 99, 235, 0.36); background: linear-gradient(180deg, rgba(239, 247, 255, 0.92), rgba(255,255,255,0.78)); }
    body[data-openpets-view="agent-setup"] .integration-card.disabled { opacity: 0.74; }
    body[data-openpets-view="agent-setup"] .integration-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    body[data-openpets-view="agent-setup"] .integration-icon { width: 48px; height: 48px; display: grid; place-items: center; border: 1px solid rgba(126, 161, 210, 0.34); border-radius: 16px; background: rgba(255,255,255,0.76); box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 10px 20px rgba(61, 99, 160, 0.08); }
    body[data-openpets-view="agent-setup"] .integration-icon img { width: 28px; height: 28px; object-fit: contain; }
    body[data-openpets-view="agent-setup"] .integration-card h2 { margin: 0; font-size: 20px; color: #102149; }
    body[data-openpets-view="agent-setup"] .integration-card p { flex: 1 1 auto; margin: 0; color: #526483; line-height: 1.35; font-size: 14px; }
    body[data-openpets-view="agent-setup"] .integration-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: auto; }
    body[data-openpets-view="agent-setup"] .integration-actions.stacked { grid-template-columns: 1fr; gap: 8px; }
    body[data-openpets-view="agent-setup"] .integration-actions .agent-action:only-child { grid-column: 1 / -1; }
    @keyframes openpets-agent-spin { to { transform: rotate(360deg); } }
    body[data-openpets-view="agent-setup"] .agent-action[data-loading] { cursor: progress; opacity: 0.85; }
    body[data-openpets-view="agent-setup"] .agent-action[data-loading] .pm-button-icon { animation: openpets-agent-spin 0.85s linear infinite; transform-origin: 50% 50%; }
    body[data-openpets-view="agent-setup"] .integration-card > .agent-action { margin-top: auto; }
    body[data-openpets-view="agent-setup"] .claude-detail-view { height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 12px; overflow: hidden; }
    body[data-openpets-view="agent-setup"] .claude-detail-toolbar { display: flex; justify-content: flex-start; padding: 4px 2px 0; }
    body[data-openpets-view="agent-setup"] .compact-title { margin-bottom: 0; }
    body[data-openpets-view="agent-setup"] .agent-setup-pane { width: min(760px, 100%); min-width: 0; min-height: 0; justify-self: center; display: flex; flex-direction: column; gap: 14px; overflow-y: auto; overflow-x: hidden; padding: 2px 8px 16px; scrollbar-gutter: stable; }
    body[data-openpets-view="agent-setup"] .agent-setup-pane::-webkit-scrollbar { width: 8px; }
    body[data-openpets-view="agent-setup"] .agent-setup-pane::-webkit-scrollbar-thumb { background: rgba(126, 161, 210, 0.45); border-radius: 999px; }
    body[data-openpets-view="agent-setup"] .agent-setup-pane::-webkit-scrollbar-thumb:hover { background: rgba(99, 130, 178, 0.65); }
    body[data-openpets-view="agent-setup"] .agent-logo { width: min(210px, 68%); display: block; margin: 0 auto -2px; filter: drop-shadow(0 10px 14px rgba(42, 80, 138, 0.12)); }
    body[data-openpets-view="agent-setup"] .agent-title-block { display: grid; gap: 2px; margin-bottom: 2px; }
    body[data-openpets-view="agent-setup"] .agent-title-block .eyebrow { margin: 0; color: #2478ff; }
    body[data-openpets-view="agent-setup"] .agent-title-block h1 { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 28px; line-height: 1.08; letter-spacing: -0.04em; color: #102149; text-wrap: balance; }
    body[data-openpets-view="agent-setup"] .agent-title-block .lede { margin: 0; color: #63708f; line-height: 1.35; }
    body[data-openpets-view="agent-setup"] .agent-status-card, body[data-openpets-view="agent-setup"] .agent-control-card, body[data-openpets-view="agent-setup"] .agent-risk-card, body[data-openpets-view="agent-setup"] .agent-preview-card, body[data-openpets-view="agent-setup"] .agent-memory-card, body[data-openpets-view="agent-setup"] .agent-hooks-card { box-sizing: border-box; border: 1px solid rgba(126, 161, 210, 0.44); border-radius: 20px; background: rgba(255,255,255,0.76); box-shadow: 0 16px 38px rgba(61, 99, 160, 0.1), inset 0 1px 0 rgba(255,255,255,0.94); }
    body[data-openpets-view="agent-setup"] .agent-status-card, body[data-openpets-view="agent-setup"] .agent-control-card, body[data-openpets-view="agent-setup"] .agent-risk-card { padding: 18px; }
    body[data-openpets-view="agent-setup"] .agent-preview-card, body[data-openpets-view="agent-setup"] .agent-memory-card, body[data-openpets-view="agent-setup"] .agent-hooks-card { padding: 18px; }
    body[data-openpets-view="agent-setup"] .agent-section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
    body[data-openpets-view="agent-setup"] .agent-section-header span:first-child { display: grid; gap: 4px; min-width: 0; }
    body[data-openpets-view="agent-setup"] .agent-section-header small { color: #2478ff; font-size: 11px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; }
    body[data-openpets-view="agent-setup"] .agent-section-header strong { color: #102149; font-size: 18px; line-height: 1.2; }
    body[data-openpets-view="agent-setup"] .agent-status-pill { height: 30px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; border: 1px solid rgba(126, 161, 210, 0.36); border-radius: 10px; padding: 0 10px; background: rgba(255,255,255,0.68); color: #526483; font-size: 10px; font-weight: 900; white-space: nowrap; }
    body[data-openpets-view="agent-setup"] .agent-status-pill.success { color: #047857; background: rgba(236, 253, 245, 0.86); border-color: rgba(16, 185, 129, 0.28); }
    body[data-openpets-view="agent-setup"] .agent-status-pill.info { color: #176df2; background: rgba(239, 246, 255, 0.9); border-color: rgba(37, 99, 235, 0.28); }
    body[data-openpets-view="agent-setup"] .agent-status-pill.error { color: #b91c1c; background: rgba(254, 242, 242, 0.9); border-color: rgba(248, 113, 113, 0.32); }
    body[data-openpets-view="agent-setup"] .agent-status-pill.muted { color: #64748b; background: rgba(248, 250, 252, 0.82); }
    body[data-openpets-view="agent-setup"] .agent-note { margin: 0; color: #4f6389; line-height: 1.48; text-wrap: pretty; }
    body[data-openpets-view="agent-setup"] .connection-card { display: grid; gap: 16px; padding: 20px; }
    body[data-openpets-view="agent-setup"] .agent-control-group { display: grid; gap: 8px; }
    body[data-openpets-view="agent-setup"] .agent-field-label { display: block; margin: 0 0 8px; color: #102149; font-weight: 900; }
    body[data-openpets-view="agent-setup"] .agent-select { width: 100%; box-sizing: border-box; min-height: 42px; border: 1px solid rgba(126, 161, 210, 0.54); border-radius: 12px; background: rgba(255,255,255,0.82); color: #17284f; padding: 0 12px; font: inherit; outline: none; }
    body[data-openpets-view="agent-setup"] .agent-select:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15); }
    body[data-openpets-view="agent-setup"] .agent-command-paths { display: grid; gap: 10px; margin-top: 2px; padding: 14px; border: 1px solid rgba(126, 161, 210, 0.28); border-radius: 16px; background: rgba(239, 246, 255, 0.5); }
    body[data-openpets-view="agent-setup"] .agent-command-paths-title { display: grid; gap: 4px; }
    body[data-openpets-view="agent-setup"] .agent-command-paths-title small { color: #2478ff; font-size: 11px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; }
    body[data-openpets-view="agent-setup"] .agent-command-paths-title strong { color: #102149; font-size: 15px; }
    body[data-openpets-view="agent-setup"] .agent-path-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    body[data-openpets-view="agent-setup"] .agent-subfield { display: grid; gap: 7px; margin-top: 10px; }
    body[data-openpets-view="agent-setup"] .agent-subfield span { color: #102149; font-size: 12px; font-weight: 900; }
    body[data-openpets-view="agent-setup"] .agent-text-input { width: 100%; box-sizing: border-box; min-height: 38px; border: 1px solid rgba(126, 161, 210, 0.54); border-radius: 11px; background: rgba(255,255,255,0.82); color: #17284f; padding: 0 11px; font: 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; outline: none; }
    body[data-openpets-view="agent-setup"] .agent-text-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15); }
    body[data-openpets-view="agent-setup"] .agent-mode-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 0; color: #17284f; }
    body[data-openpets-view="agent-setup"] .agent-mode-row span { display: grid; gap: 4px; }
    body[data-openpets-view="agent-setup"] .agent-mode-row small { color: #63708f; line-height: 1.35; }
    body[data-openpets-view="agent-setup"] .agent-risk-card { border-color: rgba(245, 158, 11, 0.28); background: rgba(255, 251, 235, 0.78); }
    body[data-openpets-view="agent-setup"] .agent-risk-card strong { display: block; margin-bottom: 5px; color: #92400e; }
    body[data-openpets-view="agent-setup"] .agent-risk-card .warning, body[data-openpets-view="agent-setup"] .agent-hook-warning { margin: 0; color: #92400e; line-height: 1.45; }
    body[data-openpets-view="agent-setup"] .agent-inline-note { margin: 0; color: #64748b; font-size: 13px; line-height: 1.4; }
    body[data-openpets-view="agent-setup"] .agent-inline-note code { color: #176df2; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-weight: 800; }
    body[data-openpets-view="agent-setup"] .agent-actions { display: flex; flex-wrap: wrap; gap: 10px; }
    body[data-openpets-view="agent-setup"] .agent-main-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    body[data-openpets-view="agent-setup"] .agent-action[hidden] { display: none !important; }
    body[data-openpets-view="agent-setup"] .agent-action { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid rgba(37, 99, 235, 0.34); border-radius: 11px; padding: 0 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; font-weight: 950; background: rgba(255,255,255,0.76); color: #176df2; box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 8px 18px rgba(61, 99, 160, 0.08); }
    body[data-openpets-view="agent-setup"] .agent-action.primary { background: linear-gradient(180deg, #3b96ff, #176df2); color: #fff; box-shadow: 0 14px 28px rgba(37, 99, 235, 0.24), inset 0 1px 0 rgba(255,255,255,0.38); }
    body[data-openpets-view="agent-setup"] .agent-action.danger { color: #dc2626; border-color: rgba(239, 68, 68, 0.42); }
    body[data-openpets-view="agent-setup"] .agent-action:hover:not(:disabled) { transform: translateY(-1px); }
    body[data-openpets-view="agent-setup"] .agent-action.primary:hover:not(:disabled) { background: linear-gradient(180deg, #55a6ff, #176df2); }
    body[data-openpets-view="agent-setup"] .agent-action.danger:hover:not(:disabled) { background: #fef2f2; border-color: rgba(239, 68, 68, 0.62); box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.08), inset 0 1px 0 rgba(255,255,255,0.94); }
    body[data-openpets-view="agent-setup"] .agent-action:active:not(:disabled) { transform: scale(0.96); }
    body[data-openpets-view="agent-setup"] .agent-action:disabled { cursor: default; opacity: 0.54; transform: none; }
    body[data-openpets-view="agent-setup"] .agent-action.compact { min-height: 34px; padding: 0 11px; font-size: 12px; }
    body[data-openpets-view="agent-setup"] .pm-button-icon { width: 16px; height: 16px; flex: 0 0 auto; stroke: currentColor; }
    body[data-openpets-view="agent-setup"] .agent-result { min-height: 42px; margin: 0; padding: 12px 14px; border-radius: 14px; background: rgba(239, 246, 255, 0.78); border: 1px solid rgba(37, 99, 235, 0.18); color: #36547d; line-height: 1.4; }
    body[data-openpets-view="agent-setup"] .agent-preview-card { flex: 0 0 auto; display: flex; flex-direction: column; }
    body[data-openpets-view="agent-setup"] .agent-hooks-card { flex: 0 0 auto; }
    body[data-openpets-view="agent-setup"] .agent-inline-details { margin-top: 12px; border-top: 1px solid rgba(126, 161, 210, 0.28); padding-top: 2px; overflow: hidden; }
    body[data-openpets-view="agent-setup"] .agent-inline-details summary { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 0 0; cursor: pointer; list-style: none; }
    body[data-openpets-view="agent-setup"] .agent-inline-details summary::-webkit-details-marker { display: none; }
    body[data-openpets-view="agent-setup"] .agent-inline-details summary::after { content: "▸"; color: #526483; font-size: 17px; transition: transform 140ms ease; }
    body[data-openpets-view="agent-setup"] .agent-inline-details[open] summary::after { transform: rotate(90deg); }
    body[data-openpets-view="agent-setup"] .agent-inline-details summary span { display: grid; gap: 4px; }
    body[data-openpets-view="agent-setup"] .agent-inline-details summary small { color: #2478ff; font-size: 11px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; }
    body[data-openpets-view="agent-setup"] .agent-inline-details summary strong { color: #102149; font-size: 15px; }
    body[data-openpets-view="agent-setup"] .agent-inline-details > :not(summary) { margin-top: 10px; }
    body[data-openpets-view="agent-setup"] .agent-preview-card h2 { margin: 14px 0 8px; font-size: 15px; color: #102149; }
    body[data-openpets-view="agent-setup"] .agent-inline-details h2 { margin: 14px 0 8px; font-size: 15px; color: #102149; }
    body[data-openpets-view="agent-setup"] .agent-preview-code { box-sizing: border-box; width: 100%; margin: 10px 0 0; overflow: auto; white-space: pre; border: 1px solid rgba(126, 161, 210, 0.34); border-radius: 14px; background: rgba(15, 23, 42, 0.92); color: #dbeafe; padding: 13px; font-size: 12px; line-height: 1.45; box-shadow: inset 0 1px 0 rgba(255,255,255,0.06); }
    body[data-openpets-view="agent-setup"] .command-preview { min-height: 74px; max-height: 110px; }
    body[data-openpets-view="agent-setup"] .json-preview { min-height: 160px; max-height: 260px; }
    body[data-openpets-view="agent-setup"] .hooks-preview { max-height: 140px; }
    body[data-openpets-view="agent-setup"] .hook-actions { margin-top: 12px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    body[data-openpets-view="agent-setup"] .memory-actions { margin-top: 12px; }
    body[data-openpets-view="agent-setup"] .advanced-actions { margin-top: 12px; }
    body[data-openpets-view="agent-setup"] [data-error] { position: fixed; left: 18px; right: 18px; bottom: 8px; max-height: 3.4em; overflow: hidden; margin: 0; color: #b91c1c; pointer-events: none; line-height: 1.35; text-overflow: ellipsis; }
    body[data-openpets-view="agent-setup"] .connection-card.needs-command-path { border-color: rgba(239, 68, 68, 0.42); box-shadow: 0 16px 38px rgba(185, 28, 28, 0.12), 0 0 0 3px rgba(239, 68, 68, 0.08), inset 0 1px 0 rgba(255,255,255,0.94); }
    body[data-openpets-view="agent-setup"] .agent-command-paths.needs-command-path { border-color: rgba(239, 68, 68, 0.44); background: rgba(254, 242, 242, 0.58); }
    body[data-openpets-view="agent-setup"] .agent-command-paths.needs-command-path .agent-command-paths-title strong { color: #b91c1c; }
    @media (prefers-reduced-motion: reduce) { body[data-openpets-view="agent-setup"] .agent-action:hover:not(:disabled), body[data-openpets-view="agent-setup"] .agent-action:active:not(:disabled) { transform: none; } }
    @media (max-width: 980px) { body[data-openpets-view="agent-setup"] .integration-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 860px) { body[data-openpets-view="agent-setup"] { overflow: auto; } body[data-openpets-view="agent-setup"] .agent-shell { height: auto; min-height: calc(100vh - 36px); overflow: visible; } body[data-openpets-view="agent-setup"] .integrations-view, body[data-openpets-view="agent-setup"] .claude-detail-view { height: auto; overflow: visible; } body[data-openpets-view="agent-setup"] .integration-grid { overflow: visible; } }
    @media (max-width: 620px) { body[data-openpets-view="agent-setup"] .integration-grid, body[data-openpets-view="agent-setup"] .agent-main-actions, body[data-openpets-view="agent-setup"] .hook-actions { grid-template-columns: 1fr; } }
    
    body[data-openpets-view="pet-manager"] { overflow: hidden; background: radial-gradient(circle at 12% 8%, rgba(219, 234, 254, 0.9), transparent 24%), linear-gradient(180deg, #f8fbff 0%, #eff7ff 54%, #e9f3ff 100%); color: #101f3f; }
    body[data-openpets-view="pet-manager"] .pm-shell { width: min(1160px, calc(100vw - 36px)); height: calc(100vh - 28px); display: grid; grid-template-columns: minmax(330px, 0.78fr) minmax(510px, 1.22fr); gap: 32px; align-items: stretch; padding: 10px 0 18px; overflow: hidden; }
    body[data-openpets-view="pet-manager"] .pm-gallery-pane { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding-bottom: 28px; }
    body[data-openpets-view="pet-manager"] .pm-logo { width: min(218px, 72%); flex: 0 0 auto; display: block; margin: -2px auto 0; filter: drop-shadow(0 10px 14px rgba(42, 80, 138, 0.12)); }
    body[data-openpets-view="pet-manager"] .pm-header { flex: 0 0 auto; position: relative; display: grid; align-items: center; row-gap: 0; margin-bottom: 6px; padding-right: 108px; }
    body[data-openpets-view="pet-manager"] .pm-header h1 { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 24px; line-height: 1.08; letter-spacing: -0.03em; color: #102149; text-shadow: 0 1px 0 rgba(255,255,255,0.9); }
    body[data-openpets-view="pet-manager"] .pm-header .lede { grid-column: 1 / -1; margin: 0; color: #63708f; line-height: 1.25; }
    body[data-openpets-view="pet-manager"] .pm-status-pill { position: absolute; right: 0; top: 2px; height: 22px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; border: 1px solid rgba(126, 161, 210, 0.28); border-radius: 8px; padding: 0 8px; color: #526483; background: rgba(255, 255, 255, 0.58); font-size: 9px; line-height: 1; font-weight: 850; font-variant-numeric: tabular-nums; white-space: nowrap; box-shadow: 0 8px 18px rgba(61, 99, 160, 0.05), inset 0 1px 0 rgba(255,255,255,0.85); }
    body[data-openpets-view="pet-manager"] .pm-status-pill.success { color: #047857; background: rgba(236, 253, 245, 0.82); border-color: rgba(16, 185, 129, 0.26); }
    body[data-openpets-view="pet-manager"] .pm-status-pill.error { color: #b91c1c; background: rgba(254, 242, 242, 0.86); border-color: rgba(248, 113, 113, 0.28); }
    body[data-openpets-view="pet-manager"] .pm-search-wrap { height: 40px; flex: 0 0 auto; display: flex; align-items: center; gap: 11px; box-sizing: border-box; margin: 0 0 8px; padding: 0 13px; border: 1px solid rgba(126, 161, 210, 0.54); border-radius: 12px; background: rgba(255,255,255,0.82); box-shadow: inset 0 1px 0 rgba(255,255,255,0.92), 0 10px 24px rgba(61, 99, 160, 0.08); color: #526483; }
    body[data-openpets-view="pet-manager"] .pm-search-wrap:focus-within { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15), inset 0 1px 0 rgba(255,255,255,0.9); }
    body[data-openpets-view="pet-manager"] .pm-search-icon { width: 17px; height: 17px; flex: 0 0 17px; box-sizing: border-box; border: 2px solid #5d6e8e; border-radius: 999px; position: relative; opacity: 0.9; }
    body[data-openpets-view="pet-manager"] .pm-search-icon::after { content: ""; width: 7px; height: 2px; border-radius: 999px; background: #5d6e8e; position: absolute; right: -5px; bottom: -2px; transform: rotate(45deg); transform-origin: center; }
    body[data-openpets-view="pet-manager"] #catalog-search { width: 100%; border: 0; outline: 0; background: transparent; color: #17284f; font: inherit; font-size: 15px; }
    body[data-openpets-view="pet-manager"] #catalog-search::placeholder { color: #8290aa; }
    body[data-openpets-view="pet-manager"] .pm-filters { flex: 0 0 auto; position: relative; display: grid; gap: 7px; margin-bottom: 9px; }
    body[data-openpets-view="pet-manager"] .pm-filter-buttons { display: grid; align-items: center; justify-content: stretch; gap: 8px; min-width: 0; }
    body[data-openpets-view="pet-manager"] .pm-filter-buttons.primary { grid-template-columns: repeat(3, minmax(0, 1fr)); max-width: 315px; }
    body[data-openpets-view="pet-manager"] .pm-filter-buttons.secondary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    body[data-openpets-view="pet-manager"] .pm-filter { min-width: 0; min-height: 30px; padding: 5px 12px; border: 1px solid rgba(126, 161, 210, 0.46); border-radius: 10px; background: rgba(255,255,255,0.76); color: #526483; font-weight: 850; box-shadow: 0 8px 20px rgba(61, 99, 160, 0.06); display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
    body[data-openpets-view="pet-manager"] .pm-filter[data-pet-filter="original"] { border-color: rgba(217, 119, 6, 0.36); background: linear-gradient(180deg, rgba(255, 251, 235, 0.96), rgba(254, 243, 199, 0.82)); color: #9a5a08; box-shadow: 0 9px 20px rgba(217, 119, 6, 0.09), inset 0 1px 0 rgba(255,255,255,0.9); }
    body[data-openpets-view="pet-manager"] .pm-filter.active { border-color: rgba(29, 113, 255, 0.5); background: linear-gradient(180deg, #53a3ff, #176df2); color: #fff; box-shadow: 0 10px 22px rgba(37, 99, 235, 0.25), inset 0 1px 0 rgba(255,255,255,0.34); }
    body[data-openpets-view="pet-manager"] .pm-filter[data-pet-filter="original"].active { border-color: rgba(180, 83, 9, 0.58); background: linear-gradient(180deg, #fbbf24, #d97706); color: #fff7ed; box-shadow: 0 12px 24px rgba(217, 119, 6, 0.24), inset 0 1px 0 rgba(255,255,255,0.34); }
    body[data-openpets-view="pet-manager"] .pm-pet-grid { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 2px 8px 14px 2px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; scrollbar-color: rgba(96, 165, 250, 0.42) transparent; }
    body[data-openpets-view="pet-manager"] .pm-pet-card { min-height: 164px; display: grid; grid-template-rows: 58px 40px 31px; gap: 7px; justify-items: center; box-sizing: border-box; padding: 11px 10px 12px; border: 1px solid rgba(126, 161, 210, 0.45); border-radius: 14px; background: rgba(255,255,255,0.74); color: #14264d; box-shadow: 0 12px 28px rgba(61, 99, 160, 0.1), inset 0 1px 0 rgba(255,255,255,0.92); transition: box-shadow 140ms ease, border-color 140ms ease, background-color 140ms ease; }
    body[data-openpets-view="pet-manager"] .pm-pet-card:hover { border-color: rgba(37, 99, 235, 0.44); background: rgba(255,255,255,0.9); box-shadow: 0 13px 28px rgba(61, 99, 160, 0.13), inset 0 1px 0 rgba(255,255,255,0.94); }
    body[data-openpets-view="pet-manager"] .pm-pet-card:focus-visible { outline: 3px solid rgba(37, 99, 235, 0.42); outline-offset: 3px; border-color: rgba(37, 99, 235, 0.72); }
    body[data-openpets-view="pet-manager"] .pm-pet-card:active { border-color: rgba(37, 99, 235, 0.64); }
    body[data-openpets-view="pet-manager"] .pm-pet-card.active { border: 2px solid #2478ff; padding: 10px 9px 11px; background: linear-gradient(180deg, rgba(239, 247, 255, 0.95), rgba(255,255,255,0.78)); box-shadow: 0 16px 34px rgba(37, 99, 235, 0.18), inset 0 1px 0 rgba(255,255,255,0.96); }
    body[data-openpets-view="pet-manager"] .pm-thumb, body[data-openpets-view="pet-manager"] .pm-preview-sprite { position: relative; overflow: hidden; display: grid; place-items: center; background: radial-gradient(circle at 50% 72%, rgba(125, 211, 252, 0.16), transparent 44%); }
    body[data-openpets-view="pet-manager"] .pm-thumb { width: 54px; height: 58px; border-radius: 13px; }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame { background-repeat: no-repeat; background-size: 800% 900%; background-position: 0 0; image-rendering: auto; filter: drop-shadow(0 9px 8px rgba(25, 44, 83, 0.16)); }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-thumbnail-frame { background-size: contain; background-position: center; }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-empty-sprite { background: transparent; filter: none; }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-animate-sprite { animation: pm-sprite-idle 1.65s steps(6) infinite; }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-sprite-state-idle { background-position: 0 0; }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-sprite-state-thinking { background-position: 0 100%; }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-sprite-state-wave { background-position: 0 37.5%; }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-sprite-state-happy { background-position: 0 50%; }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-sprite-state-thinking.pm-animate-sprite { animation: pm-sprite-thinking 1.55s steps(6) infinite; }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-sprite-state-wave.pm-animate-sprite { animation: pm-sprite-wave 1.25s steps(4) infinite; }
    body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-sprite-state-happy.pm-animate-sprite { animation: pm-sprite-happy 1.35s steps(5) infinite; }
    body[data-openpets-view="pet-manager"] .pm-pet-name { width: 100%; align-self: center; min-height: 36px; max-height: 36px; font-weight: 950; font-size: 14px; line-height: 18px; text-align: center; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    body[data-openpets-view="pet-manager"] .pm-card-action { width: calc(100% - 10px); min-height: 28px; align-self: end; margin-top: 0; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; font-weight: 900; border: 1px solid rgba(37, 99, 235, 0.46); background: rgba(255,255,255,0.72); color: #176df2; box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 5px 12px rgba(61, 99, 160, 0.05); }
    body[data-openpets-view="pet-manager"] .pm-card-action.danger { border-color: rgba(239, 68, 68, 0.42); color: #dc2626; }
    body[data-openpets-view="pet-manager"] .pm-card-action.danger:hover:not(:disabled) { background: #fef2f2; border-color: rgba(239, 68, 68, 0.62); box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.08), inset 0 1px 0 rgba(255,255,255,0.94); }
    body[data-openpets-view="pet-manager"] .pm-card-action:hover:not(:disabled) { background: #eff6ff; border-color: rgba(37, 99, 235, 0.72); box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1), inset 0 1px 0 rgba(255,255,255,0.94); }
    body[data-openpets-view="pet-manager"] .pm-card-action:active:not(:disabled) { transform: scale(0.96); }
    body[data-openpets-view="pet-manager"] .pm-card-action.status { border-color: rgba(37, 99, 235, 0.22); background: linear-gradient(180deg, #ecf5ff, #dbeafe); color: #176df2; box-shadow: inset 0 1px 0 rgba(255,255,255,0.9); }
    body[data-openpets-view="pet-manager"] .pm-card-action:disabled { cursor: default; opacity: 1; }
    body[data-openpets-view="pet-manager"] .pm-load-more-wrap { grid-column: 1 / -1; display: flex; justify-content: center; padding: 10px 0 2px; }
    body[data-openpets-view="pet-manager"] .pm-load-more { min-height: 32px; padding: 7px 14px; border-radius: 10px; border: 1px solid rgba(37, 99, 235, 0.34); background: rgba(255,255,255,0.82); color: #176df2; font-weight: 900; box-shadow: 0 8px 20px rgba(61,99,160,0.07), inset 0 1px 0 rgba(255,255,255,0.9); }
    body[data-openpets-view="pet-manager"] .pm-detail-pane { min-height: 0; height: 100%; overflow: hidden; box-sizing: border-box; padding: 30px 34px; border: 1px solid rgba(126, 161, 210, 0.48); border-radius: 24px; background: rgba(255,255,255,0.76); box-shadow: 0 24px 60px rgba(61, 99, 160, 0.15), inset 0 1px 0 rgba(255,255,255,0.96); color: #14264d; }
    body[data-openpets-view="pet-manager"] .pm-detail-title { margin: 0 0 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 34px; color: #102149; }
    body[data-openpets-view="pet-manager"] .pm-detail-description { height: 74px; margin: 0 0 16px; color: #253b67; font-size: 16px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-wrap: pretty; }
    body[data-openpets-view="pet-manager"] .pm-hero-stage { height: 235px; display: grid; place-items: center; margin: 0 0 20px; border-radius: 22px; background: radial-gradient(circle at 82% 24%, rgba(191, 219, 254, 0.62), transparent 13%), radial-gradient(circle at 18% 35%, rgba(219, 234, 254, 0.72), transparent 12%), linear-gradient(180deg, rgba(255,255,255,0.54), rgba(239, 247, 255, 0.26)); position: relative; overflow: hidden; }
    body[data-openpets-view="pet-manager"] .pm-preview-sprite { width: 144px; height: 156px; z-index: 1; animation: pm-idle-bob 2.6s ease-in-out infinite; filter: drop-shadow(0 18px 18px rgba(25, 44, 83, 0.22)); }
    body[data-openpets-view="pet-manager"] .pm-status-line { min-height: 25px; margin: 0 0 16px; color: #526483; font-size: 13px; font-weight: 850; }
    body[data-openpets-view="pet-manager"] .pm-preview-title { margin: 0 0 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 18px; }
    body[data-openpets-view="pet-manager"] .pm-mini-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 24px; }
    body[data-openpets-view="pet-manager"] .pm-mini { display: grid; gap: 7px; justify-items: center; padding: 12px 10px; border: 1px solid rgba(126, 161, 210, 0.34); border-radius: 13px; background: rgba(255,255,255,0.68); box-shadow: 0 10px 22px rgba(61, 99, 160, 0.08); }
    body[data-openpets-view="pet-manager"] .pm-mini-sprite { width: 56px; height: 61px; overflow: hidden; border-radius: 14px; }
    body[data-openpets-view="pet-manager"] .pm-mini span { color: #22385f; font-size: 13px; font-weight: 800; }
    body[data-openpets-view="pet-manager"] .pm-detail-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.88fr); gap: 16px; }
    body[data-openpets-view="pet-manager"] .pm-detail-actions button { min-height: 50px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; gap: 9px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 16px; font-weight: 950; border: 1px solid rgba(37, 99, 235, 0.32); background: linear-gradient(180deg, #3b96ff, #176df2); color: #fff; box-shadow: 0 14px 28px rgba(37, 99, 235, 0.24), inset 0 1px 0 rgba(255,255,255,0.38); }
    body[data-openpets-view="pet-manager"] .pm-button-icon { flex: 0 0 auto; width: 16px; height: 16px; stroke: currentColor; }
    body[data-openpets-view="pet-manager"] .pm-detail-actions .pm-button-icon { width: 18px; height: 18px; }
    body[data-openpets-view="pet-manager"] .pm-detail-actions button:hover:not(:disabled) { background: linear-gradient(180deg, #55a6ff, #176df2); transform: translateY(-1px); }
    body[data-openpets-view="pet-manager"] .pm-detail-actions button:active:not(:disabled) { transform: scale(0.96); }
    body[data-openpets-view="pet-manager"] .pm-detail-actions button.secondary { background: rgba(255,255,255,0.76); color: #176df2; border-color: rgba(37, 99, 235, 0.42); box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 8px 18px rgba(61, 99, 160, 0.08); }
    body[data-openpets-view="pet-manager"] .pm-detail-actions button.secondary:hover:not(:disabled) { background: #fef2f2; color: #dc2626; border-color: rgba(239, 68, 68, 0.58); box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.1), inset 0 1px 0 rgba(255,255,255,0.94); }
    body[data-openpets-view="pet-manager"] .pm-detail-actions button:disabled { opacity: 1; cursor: default; background: linear-gradient(180deg, #ecf5ff, #dbeafe); color: #176df2; box-shadow: inset 0 1px 0 rgba(255,255,255,0.9); }
    body[data-openpets-view="pet-manager"] .pm-detail-actions button:only-child { grid-column: 1 / -1; }
    body[data-openpets-view="pet-manager"] .pm-empty-state { grid-column: 1 / -1; padding: 28px; text-align: center; color: #667694; border: 1px dashed rgba(126, 161, 210, 0.48); border-radius: 18px; background: rgba(255,255,255,0.5); }
    body[data-openpets-view="pet-manager"] [data-error] { position: fixed; left: 18px; right: 18px; bottom: 8px; margin: 0; color: #b91c1c; pointer-events: none; }
    @keyframes pm-idle-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
    @keyframes pm-sprite-idle { from { background-position: 0 0; } to { background-position: 85.714% 0; } }
    @keyframes pm-sprite-thinking { from { background-position: 0 100%; } to { background-position: 85.714% 100%; } }
    @keyframes pm-sprite-wave { from { background-position: 0 37.5%; } to { background-position: 57.142% 37.5%; } }
    @keyframes pm-sprite-happy { from { background-position: 0 50%; } to { background-position: 71.428% 50%; } }
    @media (prefers-reduced-motion: reduce) { body[data-openpets-view="pet-manager"] .pm-detail-pane, body[data-openpets-view="pet-manager"] .pm-preview-sprite, body[data-openpets-view="pet-manager"] .pm-sprite-frame.pm-animate-sprite { animation: none; } body[data-openpets-view="pet-manager"] .pm-pet-card, body[data-openpets-view="pet-manager"] .pm-pet-card:hover, body[data-openpets-view="pet-manager"] .pm-pet-card:active { transform: none; transition: none; } }
    @media (max-width: 860px) { body[data-openpets-view="pet-manager"] { overflow: auto; } body[data-openpets-view="pet-manager"] .pm-shell { height: auto; min-height: calc(100vh - 36px); grid-template-columns: 1fr; overflow: visible; } body[data-openpets-view="pet-manager"] .pm-gallery-pane, body[data-openpets-view="pet-manager"] .pm-pet-grid { overflow: visible; } body[data-openpets-view="pet-manager"] .pm-detail-pane { height: auto; overflow: visible; } }
    @media (max-width: 620px) { body[data-openpets-view="pet-manager"] .pm-pet-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } body[data-openpets-view="pet-manager"] .pm-detail-actions, body[data-openpets-view="pet-manager"] .pm-mini-grid { grid-template-columns: 1fr; } }
    
    body[data-openpets-view="onboarding"] { overflow: auto; background: radial-gradient(circle at 85% 10%, rgba(191, 219, 254, 0.72), transparent 24%), linear-gradient(180deg, #f8fbff 0%, #eef7ff 58%, #e8f2ff 100%); color: #10244a; }
    body[data-openpets-view="onboarding"] main { padding: 24px 0 28px; }
    body[data-openpets-view="onboarding"] .onboarding-main:has([data-step-panel="0"]:not([hidden])) .onboarding-header,
    body[data-openpets-view="onboarding"] .onboarding-main:has([data-step-panel="0"]:not([hidden])) #onboarding-note { display: none; }
    body[data-openpets-view="onboarding"] .onboarding-main:has([data-step-panel="0"]:not([hidden])) .steps { justify-content: flex-start; margin: 0 0 18px; }
    body[data-openpets-view="onboarding"] .onboarding-main:has([data-step-panel="0"]:not([hidden])) .step { width: 12px; height: 12px; overflow: hidden; color: transparent; padding: 0; border-radius: 999px; border: 0; background: #cbd8ea; }
    body[data-openpets-view="onboarding"] .onboarding-main:has([data-step-panel="0"]:not([hidden])) .step.active { width: 34px; background: #2f7df4; box-shadow: 0 8px 18px rgba(47, 125, 244, 0.28); }
    
    body[data-openpets-view="onboarding"] .welcome-hero { display: grid; grid-template-columns: minmax(0, 0.82fr) minmax(260px, 1.08fr); gap: 22px; align-items: center; min-height: 360px; padding: 28px 30px 30px; background: rgba(255, 255, 255, 0.72); border: 1px solid rgba(147, 197, 253, 0.45); border-radius: 28px; box-shadow: 0 28px 70px rgba(40, 91, 160, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.88); position: relative; overflow: hidden; }
    body[data-openpets-view="onboarding"] .welcome-hero::before, body[data-openpets-view="onboarding"] .welcome-hero::after { content: ""; position: absolute; width: 120px; height: 38px; border-radius: 999px; background: linear-gradient(180deg, rgba(219, 234, 254, 0.72), rgba(191, 219, 254, 0.16)); filter: blur(0.2px); }
    body[data-openpets-view="onboarding"] .welcome-hero::before { left: 34px; top: 34px; }
    body[data-openpets-view="onboarding"] .welcome-hero::after { right: -18px; top: 58px; width: 160px; }
    body[data-openpets-view="onboarding"] .welcome-content, body[data-openpets-view="onboarding"] .welcome-visual { position: relative; z-index: 1; }
    body[data-openpets-view="onboarding"] .welcome-logo { width: min(330px, 100%); height: auto; display: block; margin: 0 0 24px -8px; filter: drop-shadow(0 16px 20px rgba(19, 42, 85, 0.16)); }
    body[data-openpets-view="onboarding"] .welcome-title { max-width: 340px; margin: 0 0 16px; font-size: 34px; line-height: 1.12; font-weight: 900; letter-spacing: -0.04em; color: #132a55; text-wrap: balance; }
    body[data-openpets-view="onboarding"] .welcome-body { max-width: 354px; margin: 0 0 10px; color: #233d67; font-size: 16px; line-height: 1.62; text-wrap: pretty; }
    body[data-openpets-view="onboarding"] .welcome-default { margin: 0 0 28px; color: #5b7193; font-size: 13px; font-weight: 750; }
    body[data-openpets-view="onboarding"] .welcome-primary-btn { font-size: 16px; min-width: 148px; padding: 13px 28px; background: linear-gradient(180deg, #3294ff, #176cf0); color: white; border: 1px solid rgba(5, 40, 115, 0.22); border-radius: 14px; box-shadow: 0 14px 28px rgba(47, 125, 244, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.42); }
    body[data-openpets-view="onboarding"] .welcome-primary-btn:hover:not(:disabled) { background: linear-gradient(180deg, #4aa1ff, #176cf0); transform: translateY(-1px); box-shadow: 0 18px 34px rgba(47, 125, 244, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.48); }
    body[data-openpets-view="onboarding"] .welcome-primary-btn:active:not(:disabled) { transform: scale(0.96); }
    body[data-openpets-view="onboarding"] .welcome-visual { min-height: 268px; display: grid; place-items: center; }
    body[data-openpets-view="onboarding"] .welcome-pets { width: min(390px, 112%); max-height: 310px; object-fit: contain; filter: drop-shadow(0 24px 34px rgba(19, 42, 85, 0.24)); transform: translateX(8px); }
    body[data-openpets-view="onboarding"] .welcome-sparkle { position: absolute; color: #f59e0b; font-weight: 900; font-size: 25px; text-shadow: 0 4px 12px rgba(245, 158, 11, 0.2); }
    body[data-openpets-view="onboarding"] .welcome-sparkle.s1 { left: 6px; top: 80px; }
    body[data-openpets-view="onboarding"] .welcome-sparkle.s2 { right: 28px; top: 44px; color: #8b5cf6; }
    body[data-openpets-view="onboarding"] .welcome-sparkle.s3 { right: 0; bottom: 62px; color: #93c5fd; }
    body[data-openpets-view="onboarding"] .onboarding-flow-card { max-width: 760px; min-height: 360px; margin: 0 auto; box-sizing: border-box; padding: 34px 36px; border: 1px solid rgba(147, 197, 253, 0.45); border-radius: 28px; background: rgba(255,255,255,0.72); color: #132a55; box-shadow: 0 28px 70px rgba(40, 91, 160, 0.16), inset 0 1px 0 rgba(255,255,255,0.88); position: relative; overflow: hidden; }
    body[data-openpets-view="onboarding"] .onboarding-flow-card::before, body[data-openpets-view="onboarding"] .onboarding-flow-card::after { content: ""; position: absolute; width: 120px; height: 38px; border-radius: 999px; background: linear-gradient(180deg, rgba(219, 234, 254, 0.72), rgba(191, 219, 254, 0.16)); filter: blur(0.2px); }
    body[data-openpets-view="onboarding"] .onboarding-flow-card::before { left: 34px; top: 34px; }
    body[data-openpets-view="onboarding"] .onboarding-flow-card::after { right: -18px; top: 58px; width: 160px; }
    body[data-openpets-view="onboarding"] .onboarding-flow-card > * { position: relative; z-index: 1; }
    body[data-openpets-view="onboarding"] .onboarding-flow-card h2 { max-width: 460px; margin: 14px 0 14px; font-size: 34px; line-height: 1.12; font-weight: 900; letter-spacing: -0.04em; color: #132a55; text-wrap: balance; }
    body[data-openpets-view="onboarding"] .onboarding-flow-card p { margin: 0 0 14px; color: #253f68; font-size: 15px; line-height: 1.62; text-wrap: pretty; }
    body[data-openpets-view="onboarding"] .onboarding-step-badge { display: inline-flex; min-height: 28px; align-items: center; border: 1px solid rgba(37, 99, 235, 0.2); border-radius: 999px; padding: 0 11px; background: rgba(239, 246, 255, 0.86); color: #176df2; font-size: 11px; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase; }
    body[data-openpets-view="onboarding"] .onboarding-status-line { display: flex; align-items: center; gap: 9px; margin: 18px 0 12px; padding: 12px 14px; border: 1px solid rgba(37, 99, 235, 0.18); border-radius: 14px; background: rgba(239, 246, 255, 0.78); color: #315886; font-size: 14px; font-weight: 800; }
    body[data-openpets-view="onboarding"] .onboarding-status-line::before { content: ""; width: 9px; height: 9px; flex: 0 0 auto; border-radius: 999px; background: #60a5fa; box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.14); }
    body[data-openpets-view="onboarding"] .onboarding-status-line.success::before { background: #10b981; box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.14); }
    body[data-openpets-view="onboarding"] .onboarding-status-line.error::before { background: #ef4444; box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.12); }
    body[data-openpets-view="onboarding"] .onboarding-flow-card .onboarding-helper { color: #64748b; font-size: 13px; font-weight: 650; }
    body[data-openpets-view="onboarding"] .onboarding-flow-actions { display: grid; justify-items: center; gap: 12px; margin-top: 28px; }
    body[data-openpets-view="onboarding"] .onboarding-flow-actions button:first-child { min-width: 188px; min-height: 48px; padding: 13px 28px; border: 1px solid rgba(5, 40, 115, 0.22); border-radius: 14px; background: linear-gradient(180deg, #3294ff, #176cf0); color: white; font-size: 16px; font-weight: 950; box-shadow: 0 14px 28px rgba(47, 125, 244, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.42); }
    body[data-openpets-view="onboarding"] .onboarding-flow-actions button:first-child:hover:not(:disabled) { background: linear-gradient(180deg, #4aa1ff, #176cf0); transform: translateY(-1px); box-shadow: 0 18px 34px rgba(47, 125, 244, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.48); }
    body[data-openpets-view="onboarding"] .onboarding-flow-actions button[hidden] { display: none !important; }
    body[data-openpets-view="onboarding"] .onboarding-continue-link { min-height: 28px; border: 0; background: transparent; color: #5b7193; padding: 3px 8px; font-size: 12px; font-weight: 850; box-shadow: none; text-decoration: none; }
    body[data-openpets-view="onboarding"] .onboarding-continue-link:hover:not(:disabled) { color: #176df2; background: transparent; transform: none; text-decoration: underline; }
    body[data-openpets-view="onboarding"] .onboarding-promoted-continue { min-width: 188px; min-height: 48px; padding: 13px 28px; border: 1px solid rgba(5, 40, 115, 0.22); border-radius: 14px; background: linear-gradient(180deg, #3294ff, #176cf0); color: white; font-size: 16px; font-weight: 950; box-shadow: 0 14px 28px rgba(47, 125, 244, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.42); }
    body[data-openpets-view="onboarding"] .onboarding-promoted-continue:hover:not(:disabled) { background: linear-gradient(180deg, #4aa1ff, #176cf0); transform: translateY(-1px); box-shadow: 0 18px 34px rgba(47, 125, 244, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.48); }
    body[data-openpets-view="onboarding"] .ready-actions { grid-template-columns: 1fr 1fr; justify-content: center; max-width: 430px; margin-left: auto; margin-right: auto; }
    body[data-openpets-view="onboarding"] .ready-actions button:first-child { grid-column: 1 / -1; justify-self: center; }
    @media (prefers-reduced-motion: reduce) { body { transition: none; } body[data-openpets-view="onboarding"] .welcome-primary-btn:hover:not(:disabled), body[data-openpets-view="onboarding"] .welcome-primary-btn:active:not(:disabled), button:active:not(:disabled) { transform: none; } }
    @media (max-width: 680px) { body[data-openpets-view="onboarding"] .welcome-hero { grid-template-columns: 1fr; padding: 24px; } body[data-openpets-view="onboarding"] .welcome-logo { width: min(280px, 100%); } body[data-openpets-view="onboarding"] .welcome-visual { display: none; } body[data-openpets-view="onboarding"] .onboarding-flow-card { padding: 24px; } body[data-openpets-view="onboarding"] .ready-actions { grid-template-columns: 1fr; } }
  </style>`;
}

function createDataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createAssetDataUrl(fileName: string, mimeType: string): string {
  const cacheKey = `${mimeType}:${fileName}`;
  const cached = assetDataUrlCache.get(cacheKey);
  if (cached) return cached;

  const bytes = readFileSync(join(app.getAppPath(), "assets", fileName));
  const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
  assetDataUrlCache.set(cacheKey, dataUrl);
  return dataUrl;
}

function getPreloadPath(): string {
  return join(app.getAppPath(), "preload.cjs");
}

function assertAllowedSender(event: IpcMainInvokeEvent, allowedKinds: readonly TaskWindowKind[]): void {
  const actualKind = getTaskWindowKindForWebContents(event.sender.id);

  if (!actualKind || !allowedKinds.includes(actualKind)) {
    throw new Error("OpenPets internal UI request came from an unexpected window.");
  }
}

function getTaskWindowKindForWebContents(webContentsId: number): TaskWindowKind | null {
  for (const [kind, window] of taskWindows) {
    if (!window.isDestroyed() && window.webContents.id === webContentsId) {
      return kind;
    }
  }

  return null;
}

function validatePreferencePatch(value: unknown): { openDefaultPetOnLaunch?: boolean; petScale?: number } {
  if (!isRecord(value)) {
    throw new Error("Invalid preferences patch.");
  }

  const patch: { openDefaultPetOnLaunch?: boolean; petScale?: number } = {};

  if ("openDefaultPetOnLaunch" in value) {
    if (typeof value.openDefaultPetOnLaunch !== "boolean") throw new Error("Invalid open-on-launch value.");
    patch.openDefaultPetOnLaunch = value.openDefaultPetOnLaunch;
  }

  if ("petScale" in value) {
    const scale = normalizePetScale(value.petScale);
    if (scale !== value.petScale) throw new Error("Invalid pet scale value.");
    patch.petScale = scale;
  }

  return patch;
}

function getLaunchAtLoginState(): { supported: boolean; enabled: boolean } {
  if (!isLaunchAtLoginSupported()) return { supported: false, enabled: false };
  return { supported: true, enabled: app.getLoginItemSettings().openAtLogin };
}

function isLaunchAtLoginSupported(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
