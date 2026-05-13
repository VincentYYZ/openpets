import { app, BrowserWindow, ipcMain, Menu, type IpcMainEvent } from "electron";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getAppStateSnapshot, markPetBroken, type PetScaleValue } from "./app-state.js";
import { clampToPrimaryWorkArea, defaultPetWindowSize, getDefaultPetInitialPosition, type Point } from "./display.js";
import { builtInPet } from "./built-in-pet.js";
import { getInstalledPetDir } from "./pet-paths.js";
import type { OpenPetsReaction } from "./local-ipc-protocol.js";
import { pickReactionMessage } from "./reaction-messages.js";

export interface DefaultPetWindowOptions {
  readonly position: Point;
  readonly paused: boolean;
  readonly display: PetTransientDisplay | null;
  readonly badge: PetStatusBadgeReaction | null;
  readonly onPositionChanged: (position: Point) => void;
  readonly onHideRequested: () => void;
}

export interface AgentPetWindowOptions {
  readonly petId: string;
  readonly displayName: string;
  readonly position: Point;
  readonly display: PetTransientDisplay | null;
  readonly badge: PetStatusBadgeReaction | null;
  readonly onCloseRequested: () => void;
}

export interface PetTransientDisplay {
  readonly reaction?: OpenPetsReaction;
  readonly message?: string;
  readonly reactionMessage?: string;
}

export type PetStatusBadgeReaction = Exclude<OpenPetsReaction, "idle">;

type PetMotionState = "idle" | "run-left" | "run-right";
type UniversalSpriteState = "idle" | "running-right" | "running-left" | "waving" | "jumping" | "failed" | "waiting" | "running" | "review";

const motionToSpriteState = {
  idle: "idle",
  "run-right": "running-right",
  "run-left": "running-left",
} as const satisfies Record<PetMotionState, UniversalSpriteState>;

const reactionToSpriteState = {
  idle: "idle",
  thinking: "review",
  working: "running",
  editing: "running",
  running: "running",
  testing: "waiting",
  waiting: "waiting",
  waving: "waving",
  success: "jumping",
  error: "failed",
  celebrating: "jumping",
} as const satisfies Record<OpenPetsReaction, UniversalSpriteState>;

const defaultPetSprite = {
  fileName: "default-pet-spritesheet.webp",
  frameWidth: 192,
  frameHeight: 208,
  columns: 8,
  rows: 9,
  states: {
    idle: { row: 0, frames: 6, durationMs: 5500, iterations: "infinite" },
    "running-right": { row: 1, frames: 8, durationMs: 1060 },
    "running-left": { row: 2, frames: 8, durationMs: 1060 },
    waving: { row: 3, frames: 4, durationMs: 700, iterations: 2 },
    jumping: { row: 4, frames: 5, durationMs: 840, iterations: 2 },
    failed: { row: 5, frames: 8, durationMs: 1220, iterations: 2 },
    waiting: { row: 6, frames: 6, durationMs: 1010 },
    running: { row: 7, frames: 6, durationMs: 820 },
    review: { row: 8, frames: 6, durationMs: 1030 },
  } satisfies Record<UniversalSpriteState, { readonly row: number; readonly frames: number; readonly durationMs: number; readonly iterations?: number | "infinite" }>,
} as const;

export function createDefaultPetWindow(options: DefaultPetWindowOptions): BrowserWindow {
  const window = createBasePetWindow("OpenPets — Default Pet", options.position);
  installMousePassthroughAndDrag(window);
  installMotionStatePublisher(window);
  installPetContextMenu(window, { label: "Hide pet", click: options.onHideRequested });

  const savePosition = debounce(() => {
    if (window.isDestroyed()) {
      return;
    }

    options.onPositionChanged(readWindowPosition(window));
  }, 150);

  window.on("move", savePosition);
  window.on("moved", savePosition);
  window.on("close", () => {
    options.onPositionChanged(readWindowPosition(window));
  });

  void loadDefaultPetContent(window, options.paused, options.display, options.badge);

  return window;
}

export function createAgentPetWindow(options: AgentPetWindowOptions): BrowserWindow {
  const window = createBasePetWindow(`OpenPets — ${options.displayName}`, options.position);
  installMousePassthroughAndDrag(window);
  installMotionStatePublisher(window);
  installPetContextMenu(window, { label: "Close pet", click: options.onCloseRequested });
  void loadExplicitPetContent(window, options.petId, options.display, options.badge);
  return window;
}

function installPetContextMenu(window: BrowserWindow, action: { readonly label: string; readonly click: () => void }): void {
  window.webContents.on("context-menu", (event) => {
    event.preventDefault();
    if (window.isDestroyed()) return;
    Menu.buildFromTemplate([{ label: action.label, click: action.click }]).popup({ window });
  });
}

function installMousePassthroughAndDrag(window: BrowserWindow): void {
  let dragging: { readonly startScreenX: number; readonly startScreenY: number; readonly startWindowX: number; readonly startWindowY: number } | null = null;
  const canForwardMouseEvents = process.platform === "darwin" || process.platform === "win32";

  const isFromWindow = (event: IpcMainEvent): boolean => event.sender === window.webContents;
  const setPassthrough = (passthrough: boolean): void => {
    if (window.isDestroyed()) return;
    if (process.platform === "linux") {
      // Electron does not support forwarded mouse events on Linux, so ignored
      // windows cannot receive the renderer events required to start dragging.
      // Keep Linux pet windows interactive; this trades click-through for reliable drag.
      window.setIgnoreMouseEvents(false);
      return;
    }

    if (passthrough && canForwardMouseEvents) window.setIgnoreMouseEvents(true, { forward: true });
    else if (passthrough) window.setIgnoreMouseEvents(true);
    else window.setIgnoreMouseEvents(false);
  };

  const handleHitTest = (event: IpcMainEvent, interactive: unknown): void => {
    if (!isFromWindow(event)) return;
    setPassthrough(!interactive && !dragging);
  };

  const handleDragStart = (event: IpcMainEvent, point: unknown): void => {
    if (!isFromWindow(event) || !isScreenPoint(point)) return;
    const [startWindowX, startWindowY] = window.getPosition();
    dragging = { startScreenX: point.screenX, startScreenY: point.screenY, startWindowX, startWindowY };
    setPassthrough(false);
  };

  const handleDragMove = (event: IpcMainEvent, point: unknown): void => {
    if (!isFromWindow(event) || !dragging || !isScreenPoint(point)) return;
    window.setPosition(dragging.startWindowX + Math.round(point.screenX - dragging.startScreenX), dragging.startWindowY + Math.round(point.screenY - dragging.startScreenY), false);
  };

  const handleDragEnd = (event: IpcMainEvent): void => {
    if (!isFromWindow(event)) return;
    dragging = null;
  };

  ipcMain.on("openpets:pet-hit-test", handleHitTest);
  ipcMain.on("openpets:pet-drag-start", handleDragStart);
  ipcMain.on("openpets:pet-drag-move", handleDragMove);
  ipcMain.on("openpets:pet-drag-end", handleDragEnd);
  window.webContents.once("did-finish-load", () => setPassthrough(true));
  window.on("closed", () => {
    ipcMain.off("openpets:pet-hit-test", handleHitTest);
    ipcMain.off("openpets:pet-drag-start", handleDragStart);
    ipcMain.off("openpets:pet-drag-move", handleDragMove);
    ipcMain.off("openpets:pet-drag-end", handleDragEnd);
  });
}

function isScreenPoint(value: unknown): value is { readonly screenX: number; readonly screenY: number } {
  return typeof value === "object" && value !== null && typeof (value as { readonly screenX?: unknown }).screenX === "number" && typeof (value as { readonly screenY?: unknown }).screenY === "number";
}

function createBasePetWindow(title: string, position: Point): BrowserWindow {
  const window = new BrowserWindow({
    title,
    width: defaultPetWindowSize.width,
    height: defaultPetWindowSize.height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(app.getAppPath(), "pet-preload.cjs"),
    },
  });

  window.setMenu(null);
  applyPetAlwaysOnTop(window);
  window.on("show", () => applyPetAlwaysOnTop(window));
  window.on("restore", () => applyPetAlwaysOnTop(window));

  // Show the pet window on all macOS Spaces (desktop workspaces).
  // Without this, the window is bound to the Space where it was created
  // and disappears when the user switches to another Space.
  if (process.platform === "darwin") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedPetDocumentUrl(url)) return;
    event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => {
    event.preventDefault();
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error("Failed to load default pet window.", { errorCode, errorDescription });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("Default pet renderer process gone.", details);
  });

  return window;
}

function applyPetAlwaysOnTop(window: BrowserWindow): void {
  if (window.isDestroyed()) return;

  window.setAlwaysOnTop(true, process.platform === "linux" ? "screen-saver" : "floating");

  if (process.platform === "linux") {
    window.setVisibleOnAllWorkspaces(true);
  }
}

export async function loadDefaultPetContent(window: BrowserWindow, paused: boolean, display: PetTransientDisplay | null = null, badge: PetStatusBadgeReaction | null = null): Promise<void> {
  const html = await createDefaultPetHtml(paused, display, badge);
  await loadPetHtmlFile(window, html, "default").catch((error: unknown) => {
    console.error("Failed to load default pet URL.", error);
  });
}

export async function loadExplicitPetContent(window: BrowserWindow, petId: string, display: PetTransientDisplay | null = null, badge: PetStatusBadgeReaction | null = null): Promise<void> {
  try {
    const state = getAppStateSnapshot();
    const pet = state.pets.installed.find((candidate) => candidate.id === petId);
    if (!pet || pet.broken || pet.id === builtInPet.id) {
      throw new Error(`Cannot render explicit pet: ${petId}`);
    }
    const html = await createInstalledPetHtml(pet.id, pet.displayName, false, display, state.preferences.petScale as PetScaleValue, badge);
    await loadPetHtmlFile(window, html, `explicit-${pet.id}`);
  } catch (error: unknown) {
    console.error(`Failed to load explicit pet ${petId} URL.`, error);
  }
}

export function preparePetTransientDisplay(display: PetTransientDisplay): PetTransientDisplay {
  if (!display.reaction || display.message || display.reactionMessage) return display;
  return { ...display, reactionMessage: pickReactionMessage(display.reaction) };
}

export function mergePetTransientDisplay(current: PetTransientDisplay | null, next: PetTransientDisplay): PetTransientDisplay {
  if (next.message || !next.reaction || !current?.message) return preparePetTransientDisplay(next);
  return { ...current, reaction: next.reaction };
}

export function getTransientReactionAnimationMs(display: PetTransientDisplay): number | null {
  if (!display.reaction) return null;
  const state = reactionToSpriteState[display.reaction];
  const row = defaultPetSprite.states[state];
  const iterations = "iterations" in row ? row.iterations : "infinite";
  return typeof iterations === "number" ? row.durationMs * iterations : null;
}

export function clearTransientReaction(display: PetTransientDisplay): PetTransientDisplay {
  if (!display.reaction) return display;
  return { ...display, reaction: undefined };
}

export function setPetReactionState(window: BrowserWindow, state: UniversalSpriteState): void {
  if (window.isDestroyed()) return;
  window.webContents.send("openpets:pet-reaction-state", state);
}

export function getSafeDefaultPetPosition(position: Point | undefined): Point {
  return clampToPrimaryWorkArea(position ?? getDefaultPetInitialPosition(), defaultPetWindowSize);
}

export function readWindowPosition(window: BrowserWindow): Point {
  const [x, y] = window.getPosition();
  return clampToPrimaryWorkArea({ x, y }, defaultPetWindowSize);
}

async function createDefaultPetHtml(paused: boolean, display: PetTransientDisplay | null, badge: PetStatusBadgeReaction | null): Promise<string> {
  const installedPetHtml = await tryCreateInstalledPetHtml(paused, display, badge);
  if (installedPetHtml) {
    return installedPetHtml;
  }

  const spriteUrl = pathToFileURL(join(app.getAppPath(), "assets", defaultPetSprite.fileName)).toString();
  const bubble = createBubbleMarkup(display, paused, badge);
  const stateRows = defaultPetSprite.states;
  const scale = getAppStateSnapshot().preferences.petScale as PetScaleValue;

  return `<!doctype html>
    <html lang="en" data-reaction-state="${getReactionSpriteState(display?.reaction)}" data-motion-state="idle">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>OpenPets Default Pet</title>
        <style>
          ${createPetWindowCss(paused, scale)}
          .sprite {
            width: ${defaultPetSprite.frameWidth}px;
            height: ${defaultPetSprite.frameHeight}px;
            background-image: url("${escapeCssUrl(spriteUrl)}");
            background-size: ${defaultPetSprite.frameWidth * defaultPetSprite.columns}px ${defaultPetSprite.frameHeight * defaultPetSprite.rows}px;
            background-repeat: no-repeat;
            --sprite-row-y: 0px;
            --sprite-frames: ${stateRows.idle.frames};
            --sprite-duration: ${stateRows.idle.durationMs}ms;
            --sprite-iterations: ${stateRows.idle.iterations};
            background-position: 0 var(--sprite-row-y);
            animation: pet-frames var(--sprite-duration) steps(var(--sprite-frames)) var(--sprite-iterations);
            animation-play-state: var(--play-state);
            transform: scale(${scale});
            transform-origin: top left;
          }
          ${createSpriteStateCss(".sprite")}
          @keyframes pet-frames {
            from { background-position: 0 var(--sprite-row-y); }
            to { background-position: calc(-${defaultPetSprite.frameWidth}px * var(--sprite-frames)) var(--sprite-row-y); }
          }
        </style>
      </head>
      <body>
        <div class="stage" aria-label="OpenPets default pet">
          ${bubble}
          <div class="pet-shell">
            <div class="sprite" role="img" aria-label="Claude animated default pet"></div>
          </div>
        </div>
      </body>
    </html>`;
}

async function tryCreateInstalledPetHtml(paused: boolean, display: PetTransientDisplay | null, badge: PetStatusBadgeReaction | null): Promise<string | null> {
  const state = getAppStateSnapshot();
  const selected = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);

  if (!selected || selected.id === builtInPet.id || selected.broken) {
    return null;
  }

  try {
    return await createInstalledPetHtml(selected.id, selected.displayName, paused, display, state.preferences.petScale as PetScaleValue, badge);
  } catch (error) {
    console.error(`Failed to render installed default pet ${selected.id}; falling back to built-in pet.`, error);
    try {
      markPetBroken(selected.id, error instanceof Error ? error.message : "Installed pet rendering failed.");
    } catch (markError) {
      console.error(`Failed to mark installed pet ${selected.id} broken.`, markError);
    }
    return null;
  }
}

async function createInstalledPetHtml(petId: string, displayName: string, paused: boolean, display: PetTransientDisplay | null, scale: PetScaleValue, badge: PetStatusBadgeReaction | null): Promise<string> {
  const spritesheetPath = join(getInstalledPetDir(petId), "spritesheet.webp");
  const spritesheet = await stat(spritesheetPath);
  if (!spritesheet.isFile() || spritesheet.size <= 0 || spritesheet.size > 100 * 1024 * 1024) {
    throw new Error("Installed pet spritesheet is missing or too large.");
  }

  const imageUrl = pathToFileURL(spritesheetPath).toString();
  const bubble = createBubbleMarkup(display, paused, badge);
  const stateRows = defaultPetSprite.states;

  return `<!doctype html>
      <html lang="en" data-reaction-state="${getReactionSpriteState(display?.reaction)}" data-motion-state="idle">
        <head>
          <meta charset="utf-8" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>OpenPets Default Pet</title>
          <style>
            ${createPetWindowCss(paused, scale)}
            .installed-card { width: ${Math.ceil(defaultPetSprite.frameWidth * scale)}px; height: ${Math.ceil(defaultPetSprite.frameHeight * scale)}px; overflow: visible; position: relative; }
            .installed-sprite {
              position: absolute;
              left: 0;
              top: 0;
              width: ${defaultPetSprite.frameWidth}px;
              height: ${defaultPetSprite.frameHeight}px;
              background-image: url("${escapeCssUrl(imageUrl)}");
              background-size: ${defaultPetSprite.frameWidth * defaultPetSprite.columns}px ${defaultPetSprite.frameHeight * defaultPetSprite.rows}px;
              background-repeat: no-repeat;
              --sprite-row-y: 0px;
              --sprite-frames: ${stateRows.idle.frames};
              --sprite-duration: ${stateRows.idle.durationMs}ms;
              --sprite-iterations: ${stateRows.idle.iterations};
              background-position: 0 var(--sprite-row-y);
              animation: pet-frames var(--sprite-duration) steps(var(--sprite-frames)) var(--sprite-iterations);
              animation-play-state: var(--play-state);
              transform: scale(${scale});
              transform-origin: top left;
            }
            ${createSpriteStateCss(".installed-sprite")}
            @keyframes pet-frames {
              from { background-position: 0 var(--sprite-row-y); }
              to { background-position: calc(-${defaultPetSprite.frameWidth}px * var(--sprite-frames)) var(--sprite-row-y); }
            }
          </style>
        </head>
        <body>
          <div class="stage" aria-label="${escapeHtml(displayName)}">
            ${bubble}
            <div class="pet-shell">
              <div class="installed-card" role="img" aria-label="${escapeHtml(displayName)}">
                <div class="installed-sprite"></div>
              </div>
            </div>
          </div>
        </body>
      </html>`;
}

function createPetWindowCss(paused: boolean, scale: PetScaleValue): string {
  const opacity = paused ? "0.62" : "1";
  const playState = paused ? "paused" : "running";
  const scaledWidth = Math.ceil(defaultPetSprite.frameWidth * scale);
  const scaledHeight = Math.ceil(defaultPetSprite.frameHeight * scale);
  const petBottom = 22;
  const bubbleBottom = Math.ceil(petBottom + scaledHeight + 8);
  return `
    :root { color-scheme: dark; --pet-opacity: ${opacity}; --play-state: ${playState}; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; user-select: none; -webkit-font-smoothing: antialiased; }
    html { color: #172033; }
    body { -webkit-app-region: no-drag; pointer-events: none; }
    .stage { width: 100%; height: 100%; position: relative; box-sizing: border-box; overflow: visible; }
    .pet-shell { position: absolute; left: 50%; bottom: ${petBottom}px; z-index: 1; width: ${scaledWidth}px; height: ${scaledHeight}px; display: block; opacity: var(--pet-opacity); filter: drop-shadow(0 10px 12px rgba(15, 23, 42, 0.24)) drop-shadow(0 2px 3px rgba(15, 23, 42, 0.18)); transform: translateX(-50%); transition-property: opacity, filter; transition-duration: 180ms; transition-timing-function: cubic-bezier(0.2, 0, 0, 1); pointer-events: auto; -webkit-app-region: no-drag; cursor: grab; }
    .bubble { position: absolute; left: 50%; bottom: ${bubbleBottom}px; z-index: 4; box-sizing: border-box; display: inline-flex; flex-direction: column; width: fit-content; min-width: 92px; max-width: min(220px, calc(100vw - 18px)); max-height: 128px; padding: 10px 12px; background: linear-gradient(135deg, rgba(239, 246, 255, 0.97), rgba(237, 233, 254, 0.96)); color: #172033; font: 760 11px/14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: left; border: 1px solid rgba(255, 255, 255, 0.78); border-radius: 14px; box-shadow: 0 12px 24px rgba(15, 23, 42, 0.16), 0 2px 5px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.82); white-space: normal; overflow-wrap: break-word; word-break: normal; overflow: visible; pointer-events: auto; -webkit-app-region: no-drag; opacity: 1; backdrop-filter: blur(10px); transform: translateX(-50%); transform-origin: 64% 100%; animation: bubble-in 180ms cubic-bezier(0.2, 0, 0, 1); }
    .bubble::after { content: ""; position: absolute; left: 64%; bottom: -7px; width: 12px; height: 12px; background: inherit; border-right: 1px solid rgba(255, 255, 255, 0.56); border-bottom: 1px solid rgba(255, 255, 255, 0.56); border-bottom-right-radius: 3px; transform: translateX(-50%) rotate(45deg); box-shadow: 3px 3px 7px rgba(15, 23, 42, 0.08); }
    .bubble-header { display: inline-flex; align-items: center; min-width: 0; gap: 7px; color: currentColor; font: 780 11px/14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0.01em; }
    .bubble-status-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 16px; height: 16px; border-radius: 999px; background: #3b82f6; color: #fff; font-size: 10px; line-height: 1; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(59, 130, 246, 0.3); }
    .bubble-status-icon::before { content: attr(data-icon); }
    .bubble-status-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bubble-divider { height: 1px; width: 100%; margin: 8px 0; background: rgba(30, 58, 138, 0.12); }
    .bubble-body { min-width: 0; width: 100%; color: #172033; font: 720 10.5px/13.5px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .bubble-text { display: -webkit-box; min-width: 0; overflow: hidden; -webkit-line-clamp: 4; -webkit-box-orient: vertical; text-wrap: normal; overflow-wrap: break-word; }
    .bubble.is-status-only { max-width: min(156px, calc(100vw - 18px)); padding: 8px 11px; border-radius: 999px; }
    .bubble.is-message-only { border-radius: 14px 14px 3px 14px; }
    .bubble.is-long-message { max-width: min(220px, calc(100vw - 18px)); max-height: 138px; }
    .bubble.is-long-message .bubble-text { -webkit-line-clamp: 6; font-size: 10px; line-height: 13px; }
    .bubble.is-very-long-message { max-width: min(220px, calc(100vw - 18px)); max-height: 156px; }
    .bubble.is-very-long-message .bubble-text { -webkit-line-clamp: 8; font-size: 9.5px; line-height: 12.5px; }
    .bubble.is-busy .bubble-status-icon { background: #3b82f6; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(59, 130, 246, 0.34); }
    .bubble.is-waiting .bubble-status-icon { background: #f59e0b; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(245, 158, 11, 0.34); }
    .bubble.is-success .bubble-status-icon { background: #10b981; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(16, 185, 129, 0.34); }
    .bubble.is-error .bubble-status-icon { background: #ef4444; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(239, 68, 68, 0.34); }
    .bubble.is-info .bubble-status-icon { background: #38bdf8; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(56, 189, 248, 0.34); }
    .bubble.is-busy .bubble-status-icon::before { content: ""; display: block; width: 7px; height: 7px; border-radius: 999px; background: #fff; animation: status-pulse 820ms ease-in-out infinite; }
    @keyframes bubble-in { from { opacity: 0; transform: translateX(-50%) translateY(4px) scale(0.96); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
    @keyframes status-pulse { 0%, 100% { transform: scale(0.72); opacity: 0.58; } 50% { transform: scale(1); opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .sprite, .installed-sprite, .bubble, .bubble-status-icon::before { animation: none !important; } }
  `;
}

function createSpriteStateCss(selector: ".sprite" | ".installed-sprite"): string {
  const reactionRules = Object.keys(defaultPetSprite.states).map((state) => createSpriteRule(`html[data-reaction-state="${state}"] ${selector}`, state as UniversalSpriteState));
  const motionRules = (Object.entries(motionToSpriteState) as Array<[PetMotionState, UniversalSpriteState]>)
    .filter(([motion]) => motion !== "idle")
    .map(([motion, state]) => createSpriteRule(`html[data-motion-state="${motion}"] ${selector}`, state));
  return [...reactionRules, ...motionRules].join("\n");
}

function createSpriteRule(selector: string, state: UniversalSpriteState): string {
  const row = defaultPetSprite.states[state];
  const iterations = "iterations" in row ? row.iterations : "infinite";
  return `${selector} { --sprite-row-y: -${row.row * defaultPetSprite.frameHeight}px; --sprite-frames: ${row.frames}; --sprite-duration: ${row.durationMs}ms; --sprite-iterations: ${iterations}; }`;
}

function getReactionSpriteState(reaction: OpenPetsReaction | undefined): UniversalSpriteState {
  return reaction ? reactionToSpriteState[reaction] : "idle";
}

function createBubbleMarkup(display: PetTransientDisplay | null, paused: boolean, badgeReaction: PetStatusBadgeReaction | null): string {
  const text = display?.message ?? display?.reactionMessage ?? (display?.reaction ? pickReactionMessage(display.reaction) : undefined) ?? (paused ? "Paused" : "");
  const status = !paused && badgeReaction ? getStatusBadge(badgeReaction) : null;
  if (!text && !status) return "";
  const isExplicitMessage = Boolean(display?.message && !display?.reactionMessage);
  const className = getBubbleClassName(text, isExplicitMessage, status?.className);
  const header = status ? `<div class="bubble-header"><span class="bubble-status-icon" data-icon="${escapeHtml(status.icon)}" aria-hidden="true"></span><span class="bubble-status-label">${escapeHtml(status.label)}</span></div>` : "";
  const divider = status && text ? `<div class="bubble-divider" aria-hidden="true"></div>` : "";
  const body = text ? `<div class="bubble-body"><span class="bubble-text">${escapeHtml(text)}</span></div>` : "";
  return `<div class="${className}" role="status" aria-live="polite">${header}${divider}${body}</div>`;
}

function getStatusBadge(reaction: PetStatusBadgeReaction): { readonly className: string; readonly icon: string; readonly label: string } | null {
  if (reaction === "thinking") return { className: "is-busy", icon: "", label: "Thinking" };
  if (reaction === "working" || reaction === "running") return { className: "is-busy", icon: "", label: "Working" };
  if (reaction === "editing") return { className: "is-busy", icon: "", label: "Editing" };
  if (reaction === "testing") return { className: "is-busy", icon: "", label: "Testing" };
  if (reaction === "waiting") return { className: "is-waiting", icon: "◷", label: "Waiting" };
  if (reaction === "success" || reaction === "celebrating") return { className: "is-success", icon: "✓", label: "Done" };
  if (reaction === "error") return { className: "is-error", icon: "!", label: "Oops" };
  if (reaction === "waving") return { className: "is-info", icon: "♪", label: "Hi" };
  return null;
}

function getBubbleClassName(text: string, isExplicitMessage: boolean, statusClassName: string | undefined): string {
  const statusClass = statusClassName ? ` ${statusClassName}` : "";
  if (!text) return `bubble is-status-only${statusClass}`;
  if (!statusClassName) return `bubble is-message-only${isExplicitMessage ? getBubbleLengthClass(text) : ""}`;
  const lengthClass = text.length > 95 ? " is-very-long-message" : text.length > 56 ? " is-long-message" : "";
  return `bubble is-message${statusClass}${lengthClass}`;
}

function getBubbleLengthClass(text: string): string {
  return text.length > 95 ? " is-very-long-message" : text.length > 56 ? " is-long-message" : "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeCssUrl(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "");
}

function installMotionStatePublisher(window: BrowserWindow): void {
  let lastX = window.getPosition()[0];
  let lastSent: PetMotionState = "idle";
  let idleTimer: NodeJS.Timeout | null = null;

  const sendMotionState = (state: PetMotionState): void => {
    if (window.isDestroyed() || lastSent === state) return;
    lastSent = state;
    window.webContents.send("openpets:pet-motion", state);
  };

  const scheduleIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      sendMotionState("idle");
    }, 180);
  };

  const handleMove = (): void => {
    if (window.isDestroyed()) return;
    const [x] = window.getPosition();
    const deltaX = x - lastX;
    lastX = x;

    if (Math.abs(deltaX) >= 3) {
      sendMotionState(deltaX > 0 ? "run-right" : "run-left");
    }
    scheduleIdle();
  };

  window.on("move", handleMove);
  window.on("moved", handleMove);
  window.webContents.on("did-finish-load", () => {
    lastSent = "idle";
    window.webContents.send("openpets:pet-motion", "idle");
  });
  window.on("closed", () => {
    if (idleTimer) clearTimeout(idleTimer);
  });
}

function isAllowedPetDocumentUrl(url: string): boolean {
  return url.startsWith("data:text/html") || url.startsWith("file://");
}

async function loadPetHtmlFile(window: BrowserWindow, html: string, name: string): Promise<void> {
  const dir = join(app.getPath("userData"), "rendered-pets");
  await mkdir(dir, { recursive: true });
  const safeName = name.replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) || "pet";
  const filePath = join(dir, `${safeName}.html`);
  await writeFile(filePath, html, "utf8");
  await window.loadFile(filePath);
}

function debounce(callback: () => void, delayMs: number): () => void {
  let timeout: NodeJS.Timeout | undefined;

  return () => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(callback, delayMs);
  };
}
