import { app, BrowserWindow, ipcMain, Menu, screen, type IpcMainEvent, type MenuItemConstructorOptions, type Rectangle } from "electron";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getAppStateSnapshot, markPetBroken, type PetScaleValue } from "./app-state.js";
import { clampToPrimaryWorkArea, defaultPetWindowSize, getDefaultPetInitialPosition, type Point } from "./display.js";
import { builtInPet } from "./built-in-pet.js";
import { getInstalledPetDir } from "./pet-paths.js";
import type { OpenPetsReaction } from "./local-ipc-protocol.js";
import { pickReactionMessage, type ReactionMessageOverrides } from "./reaction-messages.js";
import { getWindowsRenderMode } from "./render-mode.js";
import { debug, error as logError, info } from "./logger.js";
import { defaultPetSprite, motionToSpriteState, resolveReactionSpriteState, type PetMotionState, type UniversalSpriteState } from "./reaction-animation-mapping.js";

export interface DefaultPetWindowOptions {
  readonly position: Point;
  readonly paused: boolean;
  readonly display: PetTransientDisplay | null;
  readonly badge: PetStatusBadgeReaction | null;
  readonly motionState?: PetMotionState;
  readonly reactionState?: UniversalSpriteState;
  readonly onPositionChanged: (position: Point) => void;
  readonly onMoved?: (position: Point) => void;
  readonly onHideRequested: () => void;
  readonly onHelpRequested?: (anchorBounds: Electron.Rectangle) => void;
  readonly onReminderRequested?: (anchorBounds: Electron.Rectangle) => void;
  readonly onInteractiveChanged?: (interactive: boolean, source?: string) => void;
  readonly onDragStarted?: () => void;
  readonly onDragEnded?: () => void;
  readonly onFolderDragEntered?: () => void;
  readonly onFolderDragLeft?: () => void;
  readonly onFolderDropped?: (paths: readonly string[]) => void;
  readonly onBubbleDismissed?: (dismissToken: string) => void;
  readonly onContextMenuVisibilityChanged?: (visible: boolean) => void;
}

export interface AgentPetWindowOptions {
  readonly petId: string;
  readonly displayName: string;
  readonly scale: PetScaleValue;
  readonly position: Point;
  readonly display: PetTransientDisplay | null;
  readonly badge: PetStatusBadgeReaction | null;
  readonly onCloseRequested: () => void;
  readonly onBubbleDismissed?: (dismissToken: string) => void;
}

export interface PetTransientDisplay {
  readonly reaction?: OpenPetsReaction;
  readonly message?: string;
  readonly reactionMessage?: string;
  readonly passive?: boolean;
  readonly dismissToken?: string;
}

export type PetStatusBadgeReaction = Exclude<OpenPetsReaction, "idle">;

interface PetContentRender {
  readonly html: string;
  readonly bodyHtml: string;
  readonly motionState: PetMotionState;
  readonly reactionState: UniversalSpriteState;
  readonly cacheKey: string;
}

const petWindowRenderCache = new WeakMap<BrowserWindow, string>();
const petWindowMotionStateCache = new WeakMap<BrowserWindow, PetMotionState>();
const petWindowReactionStateCache = new WeakMap<BrowserWindow, UniversalSpriteState>();
const petWindowVisualOffsetXCache = new WeakMap<BrowserWindow, number>();

const windowLoadChains = new WeakMap<BrowserWindow, Promise<void>>();
const windowLoadSequences = new WeakMap<BrowserWindow, number>();
const petDropZonePadding = Object.freeze({ top: 24, right: 24, bottom: 24, left: 24 });
const outerPetWindowSize = Object.freeze({
  width: defaultPetWindowSize.width + petDropZonePadding.left + petDropZonePadding.right,
  height: defaultPetWindowSize.height + petDropZonePadding.top + petDropZonePadding.bottom,
});

export function createDefaultPetWindow(options: DefaultPetWindowOptions, dismissToken?: string): BrowserWindow {
  const window = createBasePetWindow("OpenPets — Default Pet", options.position);
  info("pet.window", "default window create", { windowId: window.id, position: options.position, paused: options.paused, hasDisplay: Boolean(options.display), badge: options.badge });
  installMousePassthroughAndDrag(window, options.onBubbleDismissed, options.onDragStarted, options.onDragEnded, options.onFolderDragEntered, options.onFolderDragLeft, options.onFolderDropped, options.onInteractiveChanged);
  installPetContextMenu(window, [
    { label: "向宠物求助", click: () => options.onHelpRequested?.(window.getBounds()) },
    { label: "宠物提醒你", click: () => options.onReminderRequested?.(window.getBounds()) },
    { type: "separator" },
    { label: "Hide pet", click: options.onHideRequested },
  ], options.onContextMenuVisibilityChanged);

  const savePosition = debounce(() => {
    if (window.isDestroyed()) {
      return;
    }

    options.onPositionChanged(readWindowPosition(window));
  }, 150);

  const handleMove = (): void => {
    if (window.isDestroyed()) {
      return;
    }

    options.onMoved?.(readWindowPosition(window));
    savePosition();
  };

  window.on("move", handleMove);
  window.on("moved", handleMove);
  window.on("close", () => {
    const position = readWindowPosition(window);
    info("pet.window", "default window close", { windowId: window.id, position });
    options.onMoved?.(position);
    options.onPositionChanged(position);
  });

  void loadDefaultPetContent(window, options.paused, options.display, options.badge, dismissToken, options.motionState ?? "idle", options.reactionState);

  return window;
}

export function createAgentPetWindow(options: AgentPetWindowOptions, dismissToken?: string): BrowserWindow {
  const window = createBasePetWindow(`OpenPets — ${options.displayName}`, options.position);
  info("pet.window", "agent window create", { windowId: window.id, petId: options.petId, displayName: options.displayName, position: options.position, hasDisplay: Boolean(options.display), badge: options.badge });
  installMousePassthroughAndDrag(window, options.onBubbleDismissed);
  installMotionStatePublisher(window);
  installPetContextMenu(window, [{ label: "Close pet", click: options.onCloseRequested }]);
  void loadExplicitPetContent(window, options.petId, options.display, options.badge, dismissToken, options.scale);
  return window;
}

function installPetContextMenu(window: BrowserWindow, template: readonly MenuItemConstructorOptions[], onVisibilityChanged?: (visible: boolean) => void): void {
  const webContents = window.webContents;
  let menuVisible = false;
  const setMenuVisible = (visible: boolean): void => {
    if (menuVisible === visible) return;
    menuVisible = visible;
    onVisibilityChanged?.(visible);
  };
  const handleContextMenu = (event: Electron.Event): void => {
    event.preventDefault();
    if (window.isDestroyed()) return;
    setMenuVisible(true);
    Menu.buildFromTemplate([...template]).popup({ window, callback: () => setMenuVisible(false) });
  };
  webContents.on("context-menu", handleContextMenu);
  window.once("closed", () => {
    setMenuVisible(false);
    if (!webContents.isDestroyed()) webContents.off("context-menu", handleContextMenu);
  });
}

function installMousePassthroughAndDrag(window: BrowserWindow, onBubbleDismissed?: (dismissToken: string) => void, onDragStarted?: () => void, onDragEnded?: () => void, onFolderDragEntered?: () => void, onFolderDragLeft?: () => void, onFolderDropped?: (paths: readonly string[]) => void, onInteractiveChanged?: (interactive: boolean, source?: string) => void): void {
  let dragging: { readonly startScreenX: number; readonly startScreenY: number; readonly startWindowX: number; readonly startWindowY: number } | null = null;
  let rendererReady = false;
  let listenersRemoved = false;
  let lastInteractive = false;
  const rearmTimers = new Set<NodeJS.Timeout>();
  const windowId = window.id;
  const webContents = window.webContents;
  const canForwardMouseEvents = process.platform === "darwin" || process.platform === "win32";

  const isFromWindow = (event: IpcMainEvent): boolean => event.sender === webContents;
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

  const clearRearmTimers = (): void => {
    for (const timer of rearmTimers) clearTimeout(timer);
    rearmTimers.clear();
  };

  const updateInteractiveState = (interactive: boolean, source?: string): void => {
    if (lastInteractive === interactive) return;
    lastInteractive = interactive;
    onInteractiveChanged?.(interactive, source);
  };

  const getCursorProbe = (): { readonly inside: boolean; readonly cursor: Point; readonly bounds: Electron.Rectangle; readonly clientX: number; readonly clientY: number } => {
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getContentBounds();
    const clientX = cursor.x - bounds.x;
    const clientY = cursor.y - bounds.y;
    return {
      cursor,
      bounds,
      clientX,
      clientY,
      inside: clientX >= 0 && clientX < bounds.width && clientY >= 0 && clientY < bounds.height,
    };
  };

  const requestCursorHitTestProbe = (reason: string): void => {
    if (window.isDestroyed() || webContents.isDestroyed()) return;
    const probe = getCursorProbe();
    debug("pet.window", "cursor hit-test probe", { windowId, reason, inside: probe.inside, cursor: probe.cursor, bounds: probe.bounds });
    if (!probe.inside) return;
    webContents.send("openpets:pet-probe-hit-test", { clientX: probe.clientX, clientY: probe.clientY, reason });
  };

  const rearmWindowsMouseForwarding = (reason: string): void => {
    if (window.isDestroyed()) return;
    if (dragging || lastInteractive) {
      debug("pet.window", "windows mouse forwarding rearm skipped", { windowId, reason, dragging: Boolean(dragging), interactive: lastInteractive });
      return;
    }
    debug("pet.window", "windows mouse forwarding rearm", { windowId, reason });
    window.setIgnoreMouseEvents(false);
    window.setIgnoreMouseEvents(true, { forward: true });
    requestCursorHitTestProbe(reason);
  };

  const scheduleWindowsMouseForwardingRearm = (reason: string, delayMs: number): void => {
    const timer = setTimeout(() => {
      rearmTimers.delete(timer);
      rearmWindowsMouseForwarding(reason);
    }, delayMs);
    rearmTimers.add(timer);
  };

  const rearmPassthroughAfterLoad = (): void => {
    if (window.isDestroyed()) return;
    if (process.platform !== "win32") {
      setPassthrough(true);
      return;
    }

    // On Windows, rapid pet HTML reloads can leave Chromium's forwarded mouse
    // tracking stale while the cursor is already over the transparent window.
    // Toggle immediately, probe the current cursor hit target, then repeat the
    // toggle shortly after load because Windows sometimes re-registers mouse
    // forwarding after Chromium finishes late compositing work.
    rearmWindowsMouseForwarding("did-finish-load");
    scheduleWindowsMouseForwardingRearm("did-finish-load+75ms", 75);
    scheduleWindowsMouseForwardingRearm("did-finish-load+175ms", 175);
  };

  const handleHitTest = (event: IpcMainEvent, interactive: unknown, source: unknown): void => {
    if (!isFromWindow(event)) return;
    rendererReady = true;
    updateInteractiveState(Boolean(interactive), typeof source === "string" ? source : undefined);
    debug("pet.window", "hit test", { windowId, interactive: lastInteractive, dragging, source: typeof source === "string" ? source : undefined });
    setPassthrough(!lastInteractive && !dragging);
  };

  const handleReady = (event: IpcMainEvent): void => {
    if (!isFromWindow(event)) return;
    rendererReady = true;
    setPassthrough(true);
  };

  const handleDragStart = (event: IpcMainEvent, point: unknown): void => {
    if (!isFromWindow(event) || !isScreenPoint(point) || window.isDestroyed()) return;
    const [startWindowX, startWindowY] = window.getPosition();
    dragging = { startScreenX: point.screenX, startScreenY: point.screenY, startWindowX, startWindowY };
    debug("pet.window", "drag start", { windowId, point, startWindowX, startWindowY });
    onDragStarted?.();
    setPassthrough(false);
  };

  const handleDragMove = (event: IpcMainEvent, point: unknown): void => {
    if (!isFromWindow(event) || !dragging || !isScreenPoint(point) || window.isDestroyed()) return;
    window.setPosition(dragging.startWindowX + Math.round(point.screenX - dragging.startScreenX), dragging.startWindowY + Math.round(point.screenY - dragging.startScreenY), false);
  };

  const refreshMouseTrackingAfterDrag = (reason: string): void => {
    if (window.isDestroyed()) return;
    // After a drag, Win32 frequently loses the transparent window's mouse
    // tracking because the OS-level mouse capture was redirected during
    // window.setPosition() calls. Without this, the renderer never receives
    // further mousemove/mouseleave events, so `lastInteractive` is stuck at
    // `true` and the auto-walk timer (which is gated on interactive=false)
    // never resumes. Toggling setIgnoreMouseEvents re-registers tracking,
    // and the probe lets the renderer report the current hover state.
    if (process.platform === "win32") {
      window.setIgnoreMouseEvents(true, { forward: true });
      window.setIgnoreMouseEvents(false);
    }
    requestCursorHitTestProbe(reason);
  };

  const handleDragEnd = (event: IpcMainEvent): void => {
    if (!isFromWindow(event)) return;
    dragging = null;
    debug("pet.window", "drag end", { windowId, position: window.isDestroyed() ? null : readWindowPosition(window) });
    resetInteractiveStateIfCursorOutside("drag-end");
    refreshMouseTrackingAfterDrag("drag-end");
    scheduleWindowsMouseForwardingRearm("drag-end+75ms", 75);
    scheduleWindowsMouseForwardingRearm("drag-end+175ms", 175);
    onDragEnded?.();
  };

  const handleBubbleDismissed = (event: IpcMainEvent, dismissToken: unknown): void => {
    if (!isFromWindow(event)) return;
    debug("pet.window", "bubble dismissed", { windowId, dismissToken });
    if (typeof dismissToken === "string") onBubbleDismissed?.(dismissToken);
  };

  const handleFolderDragEnter = (event: IpcMainEvent): void => {
    if (!isFromWindow(event)) return;
    debug("pet.window", "folder drag enter", { windowId });
    onFolderDragEntered?.();
  };

  const handleFolderDragLeave = (event: IpcMainEvent): void => {
    if (!isFromWindow(event)) return;
    debug("pet.window", "folder drag leave", { windowId });
    onFolderDragLeft?.();
  };

  const handleFolderDropped = (event: IpcMainEvent, paths: unknown): void => {
    if (!isFromWindow(event)) return;
    const droppedPaths = Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string" && path.length > 0 && path.length < 2048).slice(0, 8) : [];
    debug("pet.window", "folder dropped", { windowId, count: droppedPaths.length });
    onFolderDropped?.(droppedPaths);
  };

  const resetInteractiveStateIfCursorOutside = (source: string): void => {
    if (window.isDestroyed()) return;
    if (getCursorProbe().inside) return;
    updateInteractiveState(false, source);
  };

  const resetForNavigation = (): void => {
    dragging = null;
    rendererReady = false;
    resetInteractiveStateIfCursorOutside("navigation");
    clearRearmTimers();
    debug("pet.window", "navigation reset passthrough", { windowId });
    setPassthrough(false);
  };

  const rearmAfterLoad = (): void => {
    dragging = null;
    resetInteractiveStateIfCursorOutside("load");
    debug("pet.window", "load rearm passthrough", { windowId });
    rearmPassthroughAfterLoad();
  };

  const handleDomReady = (): void => {
    if (!rendererReady) setPassthrough(true);
  };

  const handleLoadFailure = (): void => {
    dragging = null;
    resetInteractiveStateIfCursorOutside("load-failure");
    debug("pet.window", "load failure rearm passthrough", { windowId });
    setPassthrough(true);
  };

  const removeListeners = (): void => {
    if (listenersRemoved) return;
    listenersRemoved = true;
    ipcMain.off("openpets:pet-ready", handleReady);
    ipcMain.off("openpets:pet-hit-test", handleHitTest);
    ipcMain.off("openpets:pet-drag-start", handleDragStart);
    ipcMain.off("openpets:pet-drag-move", handleDragMove);
    ipcMain.off("openpets:pet-drag-end", handleDragEnd);
    ipcMain.off("openpets:bubble-dismissed", handleBubbleDismissed);
    ipcMain.off("openpets:pet-folder-drag-enter", handleFolderDragEnter);
    ipcMain.off("openpets:pet-folder-drag-leave", handleFolderDragLeave);
    ipcMain.off("openpets:pet-folder-dropped", handleFolderDropped);
    clearRearmTimers();
    if (!webContents.isDestroyed()) {
      webContents.off("did-start-navigation", resetForNavigation);
      webContents.off("did-start-loading", resetForNavigation);
      webContents.off("did-finish-load", rearmAfterLoad);
      webContents.off("dom-ready", handleDomReady);
      webContents.off("did-fail-load", handleLoadFailure);
    }
  };

  ipcMain.on("openpets:pet-ready", handleReady);
  ipcMain.on("openpets:pet-hit-test", handleHitTest);
  ipcMain.on("openpets:pet-drag-start", handleDragStart);
  ipcMain.on("openpets:pet-drag-move", handleDragMove);
  ipcMain.on("openpets:pet-drag-end", handleDragEnd);
  ipcMain.on("openpets:bubble-dismissed", handleBubbleDismissed);
  ipcMain.on("openpets:pet-folder-drag-enter", handleFolderDragEnter);
  ipcMain.on("openpets:pet-folder-drag-leave", handleFolderDragLeave);
  ipcMain.on("openpets:pet-folder-dropped", handleFolderDropped);
  webContents.on("did-start-navigation", resetForNavigation);
  webContents.on("did-start-loading", resetForNavigation);
  webContents.on("did-finish-load", rearmAfterLoad);
  webContents.on("dom-ready", handleDomReady);
  webContents.on("did-fail-load", handleLoadFailure);
  window.on("close", removeListeners);
  window.once("closed", removeListeners);
}

function isScreenPoint(value: unknown): value is { readonly screenX: number; readonly screenY: number } {
  return typeof value === "object" && value !== null && typeof (value as { readonly screenX?: unknown }).screenX === "number" && typeof (value as { readonly screenY?: unknown }).screenY === "number";
}

function toOuterPetWindowPosition(position: Point): Point {
  return {
    x: Math.round(position.x - petDropZonePadding.left),
    y: Math.round(position.y - petDropZonePadding.top),
  };
}

function toInnerPetWindowPosition(position: Point): Point {
  return {
    x: Math.round(position.x + petDropZonePadding.left),
    y: Math.round(position.y + petDropZonePadding.top),
  };
}

function createBasePetWindow(title: string, position: Point): BrowserWindow {
  const outerPosition = toOuterPetWindowPosition(position);
  const window = new BrowserWindow({
    title,
    width: outerPetWindowSize.width,
    height: outerPetWindowSize.height,
    x: outerPosition.x,
    y: outerPosition.y,
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
    logError("pet.window", "renderer load failed", { windowId: window.id, errorCode, errorDescription });
    console.error("Failed to load default pet window.", { errorCode, errorDescription });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logError("pet.window", "renderer process gone", { windowId: window.id, details });
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

export async function loadDefaultPetContent(window: BrowserWindow, paused: boolean, display: PetTransientDisplay | null = null, badge: PetStatusBadgeReaction | null = null, dismissToken?: string, motionState: PetMotionState = "idle", reactionStateOverride?: UniversalSpriteState): Promise<void> {
  const sequence = allocateWindowLoadSequence(window);
  debug("pet.window", "default content render begin", { windowId: window.id, sequence, paused, hasDisplay: Boolean(display), reaction: display?.reaction, hasMessage: Boolean(display?.message), badge, defaultPetId: getAppStateSnapshot().preferences.defaultPetId });
  const render = await createDefaultPetRender(paused, display, badge, dismissToken, motionState, reactionStateOverride);
  if (tryUpdateLoadedPetContent(window, render, "default", sequence)) return;
  await loadPetHtmlFile(window, render.html, "default", sequence).then(() => {
    petWindowRenderCache.set(window, render.cacheKey);
    petWindowMotionStateCache.set(window, render.motionState);
    petWindowReactionStateCache.set(window, render.reactionState);
  }).catch((error: unknown) => {
    logError("pet.window", "default content load failed", error instanceof Error ? error : { error });
    console.error("Failed to load default pet URL.", error);
  });
}

export async function loadExplicitPetContent(window: BrowserWindow, petId: string, display: PetTransientDisplay | null = null, badge: PetStatusBadgeReaction | null = null, dismissToken?: string, scaleOverride?: PetScaleValue): Promise<void> {
  const sequence = allocateWindowLoadSequence(window);
  try {
    const state = getAppStateSnapshot();
    const pet = state.pets.installed.find((candidate) => candidate.id === petId);
    if (!pet || pet.broken || pet.id === builtInPet.id) {
      throw new Error(`Cannot render explicit pet: ${petId}`);
    }
    debug("pet.window", "explicit content render begin", { windowId: window.id, sequence, petId, displayName: pet.displayName, hasDisplay: Boolean(display), reaction: display?.reaction, hasMessage: Boolean(display?.message), badge });
    const scale = scaleOverride ?? state.preferences.petScale as PetScaleValue;
    const render = await createInstalledPetRender(pet.id, pet.displayName, false, display, scale, badge, `explicit:${pet.id}`, dismissToken, "idle", undefined, pet.reactionMessageOverrides);
    if (tryUpdateLoadedPetContent(window, render, `explicit-${pet.id}`, sequence)) return;
    await loadPetHtmlFile(window, render.html, `explicit-${pet.id}`, sequence);
    petWindowRenderCache.set(window, render.cacheKey);
  } catch (error: unknown) {
    logError("pet.window", "explicit content load failed", error instanceof Error ? error : { petId, error });
    console.error(`Failed to load explicit pet ${petId} URL.`, error);
  }
}

export function preparePetTransientDisplay(display: PetTransientDisplay, reactionMessageOverrides?: ReactionMessageOverrides): PetTransientDisplay {
  if (!display.reaction || display.message || display.reactionMessage) return display;
  return { ...display, reactionMessage: pickReactionMessage(display.reaction, reactionMessageOverrides) };
}

export function mergePetTransientDisplay(current: PetTransientDisplay | null, next: PetTransientDisplay, reactionMessageOverrides?: ReactionMessageOverrides): PetTransientDisplay {
  if (next.message || next.reactionMessage || !next.reaction || !current?.message || current.passive) return preparePetTransientDisplay(next, reactionMessageOverrides);
  return { ...current, reaction: next.reaction, dismissToken: next.dismissToken ?? current.dismissToken };
}

export function getTransientReactionAnimationMs(display: PetTransientDisplay): number | null {
  if (!display.reaction) return null;
  const state = getReactionSpriteState(display.reaction);
  const row = defaultPetSprite.states[state];
  const iterations = "iterations" in row ? row.iterations : "infinite";
  return typeof iterations === "number" ? Math.ceil(row.durationMs * iterations * getPetFrameDurationMultiplier(getCurrentWindowsRenderMode())) : null;
}

export function getTransientDisplayDurationMs(display: PetTransientDisplay): number {
  const baseMs = display.reaction === "success" || display.reaction === "error" ? 5_000 : 4_000;
  const message = display.message ?? display.reactionMessage;
  if (!message) return baseMs;
  return Math.min(12_000, Math.max(baseMs, message.length * 70));
}

export function clearTransientReaction(display: PetTransientDisplay): PetTransientDisplay {
  if (!display.reaction) return display;
  return { ...display, reaction: undefined };
}

export function setPetReactionState(window: BrowserWindow, state: UniversalSpriteState): void {
  if (window.isDestroyed()) return;
  if (petWindowReactionStateCache.get(window) === state) return;
  petWindowReactionStateCache.set(window, state);
  window.webContents.send("openpets:pet-reaction-state", state);
}

export function setPetMotionState(window: BrowserWindow, state: PetMotionState): void {
  if (window.isDestroyed()) return;
  if (petWindowMotionStateCache.get(window) === state) return;
  petWindowMotionStateCache.set(window, state);
  window.webContents.send("openpets:pet-motion", state);
}

export function setPetVisualOffsetX(window: BrowserWindow, offsetX: number): void {
  if (window.isDestroyed()) return;
  const nextOffsetX = Math.round(offsetX);
  if (petWindowVisualOffsetXCache.get(window) === nextOffsetX) return;
  petWindowVisualOffsetXCache.set(window, nextOffsetX);
  window.webContents.send("openpets:pet-visual-offset-x", nextOffsetX);
}

function tryUpdateLoadedPetContent(window: BrowserWindow, render: PetContentRender, name: string, sequence: number): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
  if (petWindowRenderCache.get(window) !== render.cacheKey) return false;
  const url = window.webContents.getURL();
  if (!isAllowedPetDocumentUrl(url)) return false;
  const motionState = name === "default" ? render.motionState : petWindowMotionStateCache.get(window) ?? render.motionState;
  debug("pet.window", "content update in place", { windowId: window.id, name, sequence, motionState, reactionState: render.reactionState });
  petWindowMotionStateCache.set(window, motionState);
  petWindowReactionStateCache.set(window, render.reactionState);
  window.webContents.send("openpets:pet-content-state", { bodyHtml: render.bodyHtml, motionState, reactionState: render.reactionState });
  return true;
}

export function getSafeDefaultPetPosition(position: Point | undefined): Point {
  return clampToPrimaryWorkArea(position ?? getDefaultPetInitialPosition(), defaultPetWindowSize);
}

export function setPetWindowPosition(window: BrowserWindow, position: Point, animate = false): void {
  if (window.isDestroyed()) return;
  const outerPosition = toOuterPetWindowPosition(position);
  window.setPosition(outerPosition.x, outerPosition.y, animate);
}

export function readWindowPosition(window: BrowserWindow): Point {
  const [x, y] = window.getPosition();
  return clampToPrimaryWorkArea(toInnerPetWindowPosition({ x, y }), defaultPetWindowSize);
}

export function getDefaultPetSpriteBounds(window: BrowserWindow): Rectangle {
  const position = readWindowPosition(window);
  const scale = getAppStateSnapshot().preferences.petScale as PetScaleValue;
  const scaledWidth = Math.ceil(defaultPetSprite.frameWidth * scale);
  const scaledHeight = Math.ceil(defaultPetSprite.frameHeight * scale);
  const petBottom = 22;
  const x = position.x + Math.round((defaultPetWindowSize.width - scaledWidth) / 2);
  const y = position.y + defaultPetWindowSize.height - petBottom - scaledHeight;
  return { x, y, width: scaledWidth, height: scaledHeight };
}

async function createDefaultPetRender(paused: boolean, display: PetTransientDisplay | null, badge: PetStatusBadgeReaction | null, dismissToken?: string, motionState: PetMotionState = "idle", reactionStateOverride?: UniversalSpriteState): Promise<PetContentRender> {
  const installedPetRender = await tryCreateInstalledPetRender(paused, display, badge, dismissToken, motionState, reactionStateOverride);
  if (installedPetRender) {
    return installedPetRender;
  }

  const spriteUrl = pathToFileURL(join(app.getAppPath(), "assets", defaultPetSprite.fileName)).toString();
  const bodyHtml = createPetBodyMarkup("OpenPets default pet", createBubbleMarkup(display, paused, badge, dismissToken, getBuiltInPetReactionMessageOverrides()), `<div class="sprite" role="img" aria-label="Claude animated default pet"></div>`);
  const reactionState = reactionStateOverride ?? getReactionSpriteState(display?.reaction);
  const stateRows = defaultPetSprite.states;
  const scale = getAppStateSnapshot().preferences.petScale as PetScaleValue;
  const renderMode = getCurrentWindowsRenderMode();
  const scaledFrameWidth = Math.ceil(defaultPetSprite.frameWidth * scale);
  const scaledFrameHeight = Math.ceil(defaultPetSprite.frameHeight * scale);
  const scaledSheetWidth = scaledFrameWidth * defaultPetSprite.columns;
  const scaledSheetHeight = scaledFrameHeight * defaultPetSprite.rows;

  return {
    cacheKey: `default:builtin:${paused}:${scale}:${renderMode}`,
    bodyHtml,
    motionState,
    reactionState,
    html: `<!doctype html>
    <html lang="en" data-reaction-state="${reactionState}" data-motion-state="${motionState}">
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>OpenPets Default Pet</title>
        <style>
          ${createPetWindowCss(paused, scale)}
          .sprite {
            width: ${scaledFrameWidth}px;
            height: ${scaledFrameHeight}px;
            background-image: url("${escapeCssUrl(spriteUrl)}");
            background-size: ${scaledSheetWidth}px ${scaledSheetHeight}px;
            background-repeat: no-repeat;
            --sprite-row-y: 0px;
            --sprite-frames: ${stateRows.idle.frames};
            --sprite-duration: ${stateRows.idle.durationMs}ms;
            --sprite-iterations: ${stateRows.idle.iterations};
            background-position: 0 var(--sprite-row-y);
            animation: ${getPetFrameAnimationCss(renderMode)};
            animation-play-state: var(--play-state);
          }
          ${createSpriteStateCss(".sprite", scaledFrameHeight, renderMode)}
          @keyframes pet-frames {
            from { background-position: 0 var(--sprite-row-y); }
            to { background-position: calc(-${scaledFrameWidth}px * var(--sprite-frames)) var(--sprite-row-y); }
          }
        </style>
      </head>
      <body>
        ${bodyHtml}
      </body>
    </html>`,
  };
}

async function tryCreateInstalledPetRender(paused: boolean, display: PetTransientDisplay | null, badge: PetStatusBadgeReaction | null, dismissToken?: string, motionState: PetMotionState = "idle", reactionStateOverride?: UniversalSpriteState): Promise<PetContentRender | null> {
  const state = getAppStateSnapshot();
  const selected = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);

  if (!selected || selected.id === builtInPet.id || selected.broken) {
    return null;
  }

  try {
    return await createInstalledPetRender(selected.id, selected.displayName, paused, display, state.preferences.petScale as PetScaleValue, badge, `default:${selected.id}`, dismissToken, motionState, reactionStateOverride, selected.reactionMessageOverrides);
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

async function createInstalledPetRender(petId: string, displayName: string, paused: boolean, display: PetTransientDisplay | null, scale: PetScaleValue, badge: PetStatusBadgeReaction | null, cachePrefix: string, dismissToken?: string, motionState: PetMotionState = "idle", reactionStateOverride?: UniversalSpriteState, reactionMessageOverrides?: ReactionMessageOverrides): Promise<PetContentRender> {
  const spritesheetPath = join(getInstalledPetDir(petId), "spritesheet.webp");
  const spritesheet = await stat(spritesheetPath);
  if (!spritesheet.isFile() || spritesheet.size <= 0 || spritesheet.size > 100 * 1024 * 1024) {
    throw new Error(`Missing or invalid spritesheet for pet: ${petId}`);
  }

  const imageUrl = pathToFileURL(spritesheetPath).toString();
  const bodyHtml = createPetBodyMarkup(escapeHtml(displayName), createBubbleMarkup(display, paused, badge, dismissToken, reactionMessageOverrides), `<div class="installed-card" role="img" aria-label="${escapeHtml(displayName)}"><div class="installed-sprite"></div></div>`);
  const reactionState = reactionStateOverride ?? getReactionSpriteState(display?.reaction);
  const stateRows = defaultPetSprite.states;
  const renderMode = getCurrentWindowsRenderMode();
  const scaledFrameWidth = Math.ceil(defaultPetSprite.frameWidth * scale);
  const scaledFrameHeight = Math.ceil(defaultPetSprite.frameHeight * scale);
  const scaledSheetWidth = scaledFrameWidth * defaultPetSprite.columns;
  const scaledSheetHeight = scaledFrameHeight * defaultPetSprite.rows;

  return {
    cacheKey: `${cachePrefix}:${paused}:${scale}:${renderMode}:${spritesheet.mtimeMs}:${spritesheet.size}`,
    bodyHtml,
    motionState,
    reactionState,
    html: `<!doctype html>
      <html lang="en" data-reaction-state="${reactionState}" data-motion-state="${motionState}">
        <head>
          <meta charset="utf-8" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>OpenPets Default Pet</title>
          <style>
            ${createPetWindowCss(paused, scale)}
            .installed-card { width: ${scaledFrameWidth}px; height: ${scaledFrameHeight}px; overflow: visible; position: relative; }
            .installed-sprite {
              position: absolute;
              left: 0;
              top: 0;
              width: ${scaledFrameWidth}px;
              height: ${scaledFrameHeight}px;
              background-image: url("${escapeCssUrl(imageUrl)}");
              background-size: ${scaledSheetWidth}px ${scaledSheetHeight}px;
              background-repeat: no-repeat;
              --sprite-row-y: 0px;
              --sprite-frames: ${stateRows.idle.frames};
              --sprite-duration: ${stateRows.idle.durationMs}ms;
              --sprite-iterations: ${stateRows.idle.iterations};
              background-position: 0 var(--sprite-row-y);
              animation: ${getPetFrameAnimationCss(renderMode)};
              animation-play-state: var(--play-state);
            }
            ${createSpriteStateCss(".installed-sprite", scaledFrameHeight, renderMode)}
            @keyframes pet-frames {
              from { background-position: 0 var(--sprite-row-y); }
              to { background-position: calc(-${scaledFrameWidth}px * var(--sprite-frames)) var(--sprite-row-y); }
            }
          </style>
        </head>
        <body>
          ${bodyHtml}
        </body>
      </html>`,
  };
}

function createPetBodyMarkup(stageLabel: string, bubble: string, spriteMarkup: string): string {
  return `<div class="stage" aria-label="${stageLabel}">
    <div class="drop-zone" aria-hidden="true"></div>
    <div class="pet-frame">
      ${bubble}
      <div class="pet-shell">
        ${spriteMarkup}
      </div>
    </div>
  </div>`;
}

function createPetWindowCss(paused: boolean, scale: PetScaleValue): string {
  const renderMode = getCurrentWindowsRenderMode();
  const windowsLowPowerPetAnimation = isWindowsLowPowerPetAnimation(renderMode);
  const opacity = paused ? "0.62" : "1";
  const playState = paused ? "paused" : "running";
  const idlePlayState = windowsLowPowerPetAnimation ? "paused" : playState;
  const activePlayState = playState;
  const scaledWidth = Math.ceil(defaultPetSprite.frameWidth * scale);
  const scaledHeight = Math.ceil(defaultPetSprite.frameHeight * scale);
  const petBottom = 22;
  const bubbleBottom = Math.ceil(petBottom + scaledHeight + 8);
  const petShellFilter = process.platform === "win32" ? "none" : "drop-shadow(0 10px 12px rgba(15, 23, 42, 0.24)) drop-shadow(0 2px 3px rgba(15, 23, 42, 0.18))";
  const bubbleBackdropFilter = process.platform === "win32" ? "none" : "blur(10px)";
  const bubbleShadow = windowsLowPowerPetAnimation ? "0 6px 14px rgba(15, 23, 42, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.82)" : "0 12px 24px rgba(15, 23, 42, 0.16), 0 2px 5px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.82)";
  const bubbleTailShadow = windowsLowPowerPetAnimation ? "none" : "3px 3px 7px rgba(15, 23, 42, 0.08)";
  const statusPulseAnimation = windowsLowPowerPetAnimation ? "none" : "status-pulse 820ms ease-in-out infinite";
  return `
    :root { color-scheme: dark; --pet-opacity: ${opacity}; --play-state: ${playState}; --idle-play-state: ${idlePlayState}; --active-play-state: ${activePlayState}; --pet-frame-offset-x: 0px; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; user-select: none; -webkit-font-smoothing: antialiased; }
    html { color: #172033; }
    body { -webkit-app-region: no-drag; pointer-events: none; }
    .stage { width: 100%; height: 100%; position: relative; box-sizing: border-box; overflow: visible; }
    .drop-zone { position: absolute; inset: 0; z-index: 0; display: block; background: transparent; pointer-events: auto; -webkit-app-region: no-drag; }
    .pet-frame { position: absolute; left: calc(${petDropZonePadding.left}px + var(--pet-frame-offset-x)); top: ${petDropZonePadding.top}px; width: ${defaultPetWindowSize.width}px; height: ${defaultPetWindowSize.height}px; box-sizing: border-box; overflow: visible; pointer-events: none; }
    .pet-shell { position: absolute; left: 50%; bottom: ${petBottom}px; z-index: 1; width: ${scaledWidth}px; height: ${scaledHeight}px; display: block; opacity: var(--pet-opacity); filter: ${petShellFilter}; transform: translateX(-50%); transition-property: opacity, filter; transition-duration: 180ms; transition-timing-function: cubic-bezier(0.2, 0, 0, 1); pointer-events: auto; -webkit-app-region: no-drag; cursor: grab; }
    .bubble { position: absolute; left: 50%; bottom: ${bubbleBottom}px; z-index: 4; box-sizing: border-box; display: inline-flex; flex-direction: column; width: fit-content; min-width: 92px; max-width: min(220px, calc(100vw - 18px)); max-height: 128px; padding: 10px 12px; background: linear-gradient(135deg, rgba(239, 246, 255, 0.97), rgba(237, 233, 254, 0.96)); color: #172033; font: 760 11px/14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: left; border: 1px solid rgba(255, 255, 255, 0.78); border-radius: 14px; box-shadow: ${bubbleShadow}; white-space: normal; overflow-wrap: break-word; word-break: normal; overflow: visible; pointer-events: auto; -webkit-app-region: no-drag; opacity: 1; backdrop-filter: ${bubbleBackdropFilter}; transform: translateX(-50%); transform-origin: 64% 100%; animation: bubble-in 180ms cubic-bezier(0.2, 0, 0, 1); }
    .bubble[data-dismiss-token] { cursor: pointer; }
    .bubble::after { content: ""; position: absolute; left: 64%; bottom: -7px; width: 12px; height: 12px; background: inherit; border-right: 1px solid rgba(255, 255, 255, 0.56); border-bottom: 1px solid rgba(255, 255, 255, 0.56); border-bottom-right-radius: 3px; transform: translateX(-50%) rotate(45deg); box-shadow: ${bubbleTailShadow}; }
    .bubble-header { display: inline-flex; align-items: center; min-width: 0; gap: 7px; color: currentColor; font: 780 11px/14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing: 0.01em; }
    .bubble-status-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 18px; width: 18px; min-width: 18px; height: 18px; border-radius: 999px; background: #3b82f6; color: #fff; font: 900 12px/18px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: center; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(59, 130, 246, 0.3); }
    .bubble-status-icon::before { content: attr(data-icon); display: block; width: 18px; height: 18px; line-height: 18px; text-align: center; transform: none; }
    .bubble-status-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bubble-divider { height: 1px; width: 100%; margin: 8px 0; background: rgba(30, 58, 138, 0.12); }
    .bubble-body { min-width: 0; width: 100%; color: #172033; font: 720 10.5px/13.5px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .bubble-text { display: -webkit-box; min-width: 0; overflow: hidden; -webkit-line-clamp: 4; -webkit-box-orient: vertical; text-wrap: normal; overflow-wrap: break-word; }
    .bubble.is-status-only { max-width: min(156px, calc(100vw - 18px)); padding: 8px 11px; border-radius: 999px; }
    .bubble.is-status-only .bubble-header { display: grid; grid-template-columns: 18px minmax(0, auto); align-items: center; justify-content: center; }
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
    .bubble.is-busy .bubble-status-icon::before { content: ""; position: absolute; inset: 0; width: 18px; height: 18px; background: radial-gradient(circle at 50% 50%, #fff 0 4px, transparent 4.5px); animation: ${statusPulseAnimation}; }
    .bubble.is-waiting .bubble-status-icon::before { content: ""; position: absolute; left: 3px; top: 3px; box-sizing: border-box; width: 12px; height: 12px; border: 2px solid rgba(255, 255, 255, 0.96); border-top-color: rgba(255, 255, 255, 0.28); border-radius: 999px; }
    @keyframes bubble-in { from { opacity: 0; transform: translateX(-50%) translateY(4px) scale(0.96); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
    @keyframes status-pulse { 0%, 100% { opacity: 0.52; } 50% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .sprite, .installed-sprite, .bubble, .bubble-status-icon::before { animation: none !important; } }
  `;
}

function getPetFrameAnimationCss(renderMode: ReturnType<typeof getCurrentWindowsRenderMode>): string {
  const petFrameDurationMultiplier = getPetFrameDurationMultiplier(renderMode);
  return petFrameDurationMultiplier === 1 ? "pet-frames var(--sprite-duration) steps(var(--sprite-frames)) var(--sprite-iterations)" : `pet-frames calc(var(--sprite-duration) * ${petFrameDurationMultiplier}) steps(var(--sprite-frames)) var(--sprite-iterations)`;
}

function createSpriteStateCss(selector: ".sprite" | ".installed-sprite", frameHeight: number, renderMode: ReturnType<typeof getCurrentWindowsRenderMode>): string {
  const reactionRules = Object.keys(defaultPetSprite.states).map((state) => createSpriteRule(`html[data-reaction-state="${state}"] ${selector}`, state as UniversalSpriteState, frameHeight, renderMode));
  const motionRules = (Object.entries(motionToSpriteState) as Array<[PetMotionState, UniversalSpriteState]>)
    .filter(([motion]) => motion !== "idle")
    .map(([motion, state]) => createSpriteRule(`html[data-motion-state="${motion}"] ${selector}`, state, frameHeight, renderMode));
  return [...reactionRules, ...motionRules].join("\n");
}

function createSpriteRule(selector: string, state: UniversalSpriteState, frameHeight: number, renderMode: ReturnType<typeof getCurrentWindowsRenderMode>): string {
  const row = defaultPetSprite.states[state];
  const iterations = "iterations" in row ? row.iterations : "infinite";
  const playState = isWindowsLowPowerPetAnimation(renderMode) && state === "idle" ? "var(--idle-play-state)" : "var(--active-play-state)";
  return `${selector} { --sprite-row-y: -${row.row * frameHeight}px; --sprite-frames: ${row.frames}; --sprite-duration: ${row.durationMs}ms; --sprite-iterations: ${iterations}; animation-play-state: ${playState}; }`;
}

function getCurrentWindowsRenderMode() {
  return getWindowsRenderMode(getAppStateSnapshot().preferences.windowsRenderMode);
}

function isWindowsLowPowerPetAnimation(renderMode: ReturnType<typeof getCurrentWindowsRenderMode>): boolean {
  return process.platform === "win32" && renderMode === "low-power";
}

function getPetFrameDurationMultiplier(renderMode: ReturnType<typeof getCurrentWindowsRenderMode>): number {
  if (process.platform !== "win32") return 1;
  if (renderMode === "low-power") return 2.4;
  if (renderMode === "full") return 1;
  return 1.8;
}

function getReactionSpriteState(reaction: OpenPetsReaction | undefined): UniversalSpriteState {
  return resolveReactionSpriteState(reaction, getAppStateSnapshot().preferences.reactionAnimationOverrides);
}

function getBuiltInPetReactionMessageOverrides(): ReactionMessageOverrides | undefined {
  return getAppStateSnapshot().pets.installed.find((pet) => pet.id === builtInPet.id)?.reactionMessageOverrides;
}

function createBubbleMarkup(display: PetTransientDisplay | null, paused: boolean, badgeReaction: PetStatusBadgeReaction | null, dismissToken?: string, reactionMessageOverrides?: ReactionMessageOverrides): string {
  const text = display?.message ?? display?.reactionMessage ?? (display?.reaction ? pickReactionMessage(display.reaction, reactionMessageOverrides) : undefined) ?? (paused ? "Paused" : "");
  const status = !paused && badgeReaction ? getStatusBadge(badgeReaction) : null;
  if (!text && !status) return "";
  const isExplicitMessage = Boolean(display?.message && !display?.reactionMessage);
  const className = getBubbleClassName(text, isExplicitMessage, status?.className);
  const header = status ? `<div class="bubble-header"><span class="bubble-status-icon" data-icon="${escapeHtml(status.icon)}" aria-hidden="true"></span><span class="bubble-status-label">${escapeHtml(status.label)}</span></div>` : "";
  const divider = status && text ? `<div class="bubble-divider" aria-hidden="true"></div>` : "";
  const body = text ? `<div class="bubble-body"><span class="bubble-text">${escapeHtml(text)}</span></div>` : "";
  // Use provided dismissToken, fallback to display's dismissToken for transient messages
  const token = dismissToken ?? display?.dismissToken;
  const dismissAttr = token ? ` data-dismiss-token="${escapeHtml(token)}"` : "";
  return `<div class="${className}" role="status" aria-live="polite"${dismissAttr}>${header}${divider}${body}</div>`;
}

function getStatusBadge(reaction: PetStatusBadgeReaction): { readonly className: string; readonly icon: string; readonly label: string } | null {
  if (reaction === "thinking") return { className: "is-busy", icon: "", label: "Thinking" };
  if (reaction === "working" || reaction === "running") return { className: "is-busy", icon: "", label: "Working" };
  if (reaction === "editing") return { className: "is-busy", icon: "", label: "Editing" };
  if (reaction === "testing") return { className: "is-busy", icon: "", label: "Testing" };
  if (reaction === "waiting") return { className: "is-waiting", icon: "", label: "Waiting" };
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
    setPetMotionState(window, state);
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

    if (Math.abs(deltaX) >= 1) {
      sendMotionState(deltaX > 0 ? "run-right" : "run-left");
    }
    scheduleIdle();
  };

  window.on("move", handleMove);
  window.on("moved", handleMove);
  window.webContents.on("did-finish-load", () => {
    lastSent = "idle";
    setPetMotionState(window, "idle");
  });
  window.on("closed", () => {
    if (idleTimer) clearTimeout(idleTimer);
  });
}

function isAllowedPetDocumentUrl(url: string): boolean {
  return url.startsWith("data:text/html") || url.startsWith("file://");
}

function allocateWindowLoadSequence(window: BrowserWindow): number {
  const sequence = (windowLoadSequences.get(window) ?? 0) + 1;
  windowLoadSequences.set(window, sequence);
  return sequence;
}

async function loadPetHtmlFile(window: BrowserWindow, html: string, name: string, sequence: number): Promise<void> {
  const safeName = name.replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) || "pet";

  const previous = windowLoadChains.get(window) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (window.isDestroyed()) {
      debug("pet.window", "load skipped", { windowId: window.id, name: safeName, sequence, reason: "destroyed" });
      return;
    }

    if (windowLoadSequences.get(window) !== sequence) {
      debug("pet.window", "load skipped", { windowId: window.id, name: safeName, sequence, latestSequence: windowLoadSequences.get(window), reason: "superseded" });
      return;
    }

    const dir = join(app.getPath("userData"), "rendered-pets");
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${safeName}.html`);
    await writeFile(filePath, html, "utf8");
    if (window.isDestroyed()) {
      debug("pet.window", "load skipped", { windowId: window.id, name: safeName, sequence, reason: "destroyed-after-write" });
      return;
    }
    debug("pet.window", "load file begin", { windowId: window.id, name: safeName, sequence, filePath });
    window.setIgnoreMouseEvents(false);
    try {
      await window.loadFile(filePath);
      debug("pet.window", "load file complete", { windowId: window.id, name: safeName, sequence, url: window.webContents.getURL() });
    } catch (error) {
      if (!window.isDestroyed()) {
        if (process.platform === "linux") window.setIgnoreMouseEvents(false);
        else window.setIgnoreMouseEvents(true, { forward: true });
      }
      logError("pet.window", "load file rejected", error instanceof Error ? error : { windowId: window.id, name: safeName, sequence, error });
      throw error;
    }
  });

  windowLoadChains.set(window, next);
  void next.catch(() => {}).finally(() => {
    if (windowLoadChains.get(window) === next) windowLoadChains.delete(window);
  });

  return next;
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
