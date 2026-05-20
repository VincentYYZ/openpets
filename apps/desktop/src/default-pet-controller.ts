import { BrowserWindow, screen } from "electron";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import { getAppStateSnapshot, getDefaultPetPosition, resetDefaultPetPosition, setDefaultPetPosition, updatePreferences } from "./app-state.js";
import { resolvePetAnimationState, type ResolvedPetAnimationState } from "./pet-animation-resolver.js";
import { createInitialPetBehaviorState, reducePetBehavior, type PetBehaviorCommand, type PetBehaviorEvent } from "./pet-behavior-machine.js";
import { defaultPetWindowSize, getDefaultPetInitialPosition } from "./display.js";
import { debug, error as logError, info } from "./logger.js";
import { transientDisplayMs, type OpenPetsReaction } from "./local-ipc-protocol.js";
import { clearTransientReaction, createDefaultPetWindow, getSafeDefaultPetPosition, getTransientDisplayDurationMs, getTransientReactionAnimationMs, loadDefaultPetContent, mergePetTransientDisplay, readWindowPosition, setPetMotionState, setPetReactionState, type PetStatusBadgeReaction, type PetTransientDisplay } from "./pet-window.js";

let defaultPetWindow: BrowserWindow | null = null;
let paused = false;
let transientDisplay: PetTransientDisplay | null = null;
let statusBadge: PetStatusBadgeReaction | null = null;
let transientDisplayTimeout: NodeJS.Timeout | null = null;
let transientAnimationTimeout: NodeJS.Timeout | null = null;
let statusBadgeTimeout: NodeJS.Timeout | null = null;
let autoWalkTimer: NodeJS.Timeout | null = null;
let behaviorState = createInitialPetBehaviorState(Math.random() < 0.5 ? -1 : 1);
let currentAnimationState: ResolvedPetAnimationState = {
  animationPriority: "motion",
  motionState: "idle",
  reactionState: "idle",
};
let displayGeneration = 0;
const busyStatusBadgeMs = 120_000;
const autoWalkFrameMs = 50;
const autoWalkSpeedPx = 2;
const autoWalkEdgePaddingPx = 12;
const autoWalkResumeAfterDragMs = 8_000;
const folderDropPromptMessage = "我现在要吃掉他吗？";

export function showDefaultPet(): void {
  updatePreferences({ openDefaultPetOnLaunch: true });
  const window = getOrCreateDefaultPetWindow();
  info("pet.default", "show requested", { windowId: window.id, visible: window.isVisible(), minimized: window.isMinimized(), paused, petId: getAppStateSnapshot().preferences.defaultPetId });

  if (window.isMinimized()) {
    window.restore();
  }

  window.showInactive();
  startDefaultPetAutoWalk();
}

export function hideDefaultPet(): void {
  updatePreferences({ openDefaultPetOnLaunch: false });

  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    debug("pet.default", "hide skipped", { reason: "no-window" });
    return;
  }

  info("pet.default", "hide requested", { windowId: defaultPetWindow.id, position: readWindowPosition(defaultPetWindow), petId: getAppStateSnapshot().preferences.defaultPetId });
  stopDefaultPetAutoWalk();
  setDefaultPetPosition(readWindowPosition(defaultPetWindow));
  defaultPetWindow.hide();
}

export function isDefaultPetVisible(): boolean {
  return Boolean(defaultPetWindow && !defaultPetWindow.isDestroyed() && defaultPetWindow.isVisible());
}

export function setDefaultPetPaused(nextPaused: boolean): void {
  paused = nextPaused;
  currentAnimationState = resolveCurrentAnimationState();
  info("pet.default", "pause changed", { paused });

  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    return;
  }

  void loadDefaultPetContent(defaultPetWindow, paused, transientDisplay, statusBadge, getCurrentDismissToken(), currentAnimationState.motionState, currentAnimationState.reactionState);
  if (paused) stopDefaultPetAutoWalk();
  else startDefaultPetAutoWalk();
}

export function getDefaultPetPaused(): boolean {
  return paused;
}

export function refreshDefaultPetContent(): void {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    debug("pet.default", "refresh skipped", { reason: "no-window" });
    return;
  }

  currentAnimationState = resolveCurrentAnimationState();
  debug("pet.default", "refresh content", { windowId: defaultPetWindow.id, paused, hasDisplay: Boolean(transientDisplay), badge: statusBadge, petId: getAppStateSnapshot().preferences.defaultPetId });
  void loadDefaultPetContent(defaultPetWindow, paused, transientDisplay, statusBadge, getCurrentDismissToken(), currentAnimationState.motionState, currentAnimationState.reactionState);
}

export function applyExternalPetReaction(reaction: OpenPetsReaction): { readonly shown: boolean; readonly reason?: string } {
  if (paused) {
    return { shown: false, reason: "paused" };
  }

  setTransientDisplay({ reaction });
  showDefaultPetForExternalEvent();
  return { shown: isDefaultPetVisible() };
}

export function applyExternalPetSay(message: string, reaction?: OpenPetsReaction): { readonly shown: boolean; readonly reason?: string } {
  if (paused) {
    return { shown: false, reason: "paused" };
  }

  if (!reaction) clearStatusBadge();
  setTransientDisplay({ message, reaction });
  showDefaultPetForExternalEvent();
  return { shown: isDefaultPetVisible() };
}

export function destroyDefaultPet(): void {
  clearDefaultPetDisplayTimers();
  stopDefaultPetAutoWalk();

  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    debug("pet.default", "destroy skipped", { reason: "no-window" });
    defaultPetWindow = null;
    return;
  }

  info("pet.default", "destroy requested", { windowId: defaultPetWindow.id, position: readWindowPosition(defaultPetWindow), petId: getAppStateSnapshot().preferences.defaultPetId });
  setDefaultPetPosition(readWindowPosition(defaultPetWindow));
  const window = defaultPetWindow;
  defaultPetWindow = null;
  window.setIgnoreMouseEvents(false);
  window.destroy();
}

export function installDefaultPetDisplayHandlers(): void {
  screen.on("display-added", reclampDefaultPetWindow);
  screen.on("display-removed", reclampDefaultPetWindow);
  screen.on("display-metrics-changed", reclampDefaultPetWindow);
}

function handleBubbleDismissed(dismissToken: string): void {
  debug("pet.default", "bubble dismissed callback", { windowId: defaultPetWindow?.id, dismissToken, currentGeneration: displayGeneration });
  if (dismissToken !== String(displayGeneration)) {
    debug("pet.default", "bubble dismissed stale token", { dismissToken, currentGeneration: displayGeneration });
    return;
  }
  clearDefaultPetDisplayTimers();
  currentAnimationState = resolveCurrentAnimationState();
  if (defaultPetWindow && !defaultPetWindow.isDestroyed()) {
    void loadDefaultPetContent(defaultPetWindow, paused, null, null, undefined, currentAnimationState.motionState, currentAnimationState.reactionState);
  }
}

function getOrCreateDefaultPetWindow(): BrowserWindow {
  if (defaultPetWindow && !defaultPetWindow.isDestroyed()) {
    return defaultPetWindow;
  }

  currentAnimationState = resolveCurrentAnimationState();
  const position = getSafeDefaultPetPosition(getDefaultPetPosition());

  defaultPetWindow = createDefaultPetWindow({
    position,
    paused,
    display: transientDisplay,
    badge: statusBadge,
    motionState: currentAnimationState.motionState,
    reactionState: currentAnimationState.reactionState,
    onPositionChanged: setDefaultPetPosition,
    onHideRequested: hideDefaultPet,
    onDragStarted: handlePetDragStarted,
    onDragEnded: handlePetDragEnded,
    onFolderDragEntered: handleFolderDragEntered,
    onFolderDragLeft: handleFolderDragLeft,
    onFolderDropped: (paths) => {
      void handleFolderDroppedOnPet(paths);
    },
    onBubbleDismissed: handleBubbleDismissed,
  }, getCurrentDismissToken());
  const windowId = defaultPetWindow.id;
  info("pet.default", "created", { windowId, position, paused, petId: getAppStateSnapshot().preferences.defaultPetId });

  defaultPetWindow.on("closed", () => {
    info("pet.default", "closed", { windowId });
    stopDefaultPetAutoWalk();
    defaultPetWindow = null;
  });

  return defaultPetWindow;
}

function setTransientDisplay(display: PetTransientDisplay): void {
  debug("pet.default", "transient display set", { reaction: display.reaction, hasMessage: Boolean(display.message), hasReactionMessage: Boolean(display.reactionMessage) });
  displayGeneration++;
  transientDisplay = mergePetTransientDisplay(transientDisplay, { ...display, dismissToken: String(displayGeneration) });
  currentAnimationState = resolveCurrentAnimationState();
  if (display.reaction) setStatusBadge(display.reaction);

  if (transientDisplayTimeout) {
    clearTimeout(transientDisplayTimeout);
  }
  if (transientAnimationTimeout) {
    clearTimeout(transientAnimationTimeout);
    transientAnimationTimeout = null;
  }

  const animationMs = getTransientReactionAnimationMs(transientDisplay);
  const displayDurationMs = getTransientDisplayDurationMs(transientDisplay);
  if (animationMs !== null && animationMs < displayDurationMs) {
    transientAnimationTimeout = setTimeout(() => {
      if (!transientDisplay) return;
      transientDisplay = clearTransientReaction(transientDisplay);
      currentAnimationState = resolveCurrentAnimationState();
      transientAnimationTimeout = null;
      syncDefaultPetAnimationState();
    }, animationMs);
  }

  transientDisplayTimeout = setTimeout(() => {
    transientDisplay = null;
    currentAnimationState = resolveCurrentAnimationState();
    transientDisplayTimeout = null;
    if (transientAnimationTimeout) {
      clearTimeout(transientAnimationTimeout);
      transientAnimationTimeout = null;
    }
    refreshDefaultPetContent();
  }, displayDurationMs);

  refreshDefaultPetContent();
}

function showDefaultPetForExternalEvent(): void {
  const state = getAppStateSnapshot();
  if (isDefaultPetVisible() || state.preferences.openDefaultPetOnLaunch) {
    showDefaultPet();
  }
}

function setStatusBadge(reaction: OpenPetsReaction): void {
  if (reaction === "idle") {
    clearStatusBadge();
    return;
  }

  statusBadge = reaction;
  currentAnimationState = resolveCurrentAnimationState();
  debug("pet.default", "status badge set", { reaction, durationMs: isBusyStatusBadgeReaction(reaction) ? busyStatusBadgeMs : transientDisplayMs });
  if (statusBadgeTimeout) clearTimeout(statusBadgeTimeout);
  statusBadgeTimeout = setTimeout(() => {
    clearStatusBadge();
    refreshDefaultPetContent();
  }, isBusyStatusBadgeReaction(reaction) ? busyStatusBadgeMs : transientDisplayMs);
}

function clearStatusBadge(): void {
  if (statusBadge) debug("pet.default", "status badge cleared", { reaction: statusBadge });
  statusBadge = null;
  currentAnimationState = resolveCurrentAnimationState();
  if (statusBadgeTimeout) clearTimeout(statusBadgeTimeout);
  statusBadgeTimeout = null;
}

function clearDefaultPetDisplayTimers(): void {
  if (transientDisplayTimeout) clearTimeout(transientDisplayTimeout);
  if (transientAnimationTimeout) clearTimeout(transientAnimationTimeout);
  if (statusBadgeTimeout) clearTimeout(statusBadgeTimeout);
  transientDisplayTimeout = null;
  transientAnimationTimeout = null;
  statusBadgeTimeout = null;
  transientDisplay = null;
  statusBadge = null;
  currentAnimationState = resolveCurrentAnimationState();
}

function dispatchPetBehaviorEvent(event: PetBehaviorEvent): void {
  const transition = reducePetBehavior(behaviorState, event);
  behaviorState = transition.state;
  currentAnimationState = resolveCurrentAnimationState();
  executePetBehaviorCommands(transition.commands);
  syncDefaultPetAnimationState();
}

function executePetBehaviorCommands(commands: readonly PetBehaviorCommand[]): void {
  for (const command of commands) {
    switch (command.type) {
      case "show-folder-drop-prompt":
        showFolderDropPrompt();
        break;
      case "clear-folder-drop-prompt":
        clearFolderDropPrompt();
        break;
      case "move-window-x": {
        if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
          break;
        }

        const position = readWindowPosition(defaultPetWindow);
        defaultPetWindow.setPosition(command.x, position.y, false);
        break;
      }
      default:
        break;
    }
  }
}

function handlePetDragStarted(): void {
  dispatchPetBehaviorEvent({ type: "drag-start", now: Date.now() });
  stopDefaultPetAutoWalk();
}

function handlePetDragEnded(): void {
  dispatchPetBehaviorEvent({ type: "drag-end", now: Date.now(), resumeAfterMs: autoWalkResumeAfterDragMs });
  startDefaultPetAutoWalk();
}

function handleFolderDragEntered(): void {
  dispatchPetBehaviorEvent({ type: "folder-drag-enter" });
  stopDefaultPetAutoWalk();
}

function handleFolderDragLeft(): void {
  dispatchPetBehaviorEvent({ type: "folder-drag-leave" });
  startDefaultPetAutoWalk();
}

function showFolderDropPrompt(): void {
  if (paused) {
    return;
  }

  setTransientDisplay({ message: folderDropPromptMessage });
}

function clearFolderDropPrompt(): void {
  if (transientDisplay?.message !== folderDropPromptMessage) {
    return;
  }

  if (transientDisplayTimeout) {
    clearTimeout(transientDisplayTimeout);
    transientDisplayTimeout = null;
  }
  if (transientAnimationTimeout) {
    clearTimeout(transientAnimationTimeout);
    transientAnimationTimeout = null;
  }

  transientDisplay = null;
  refreshDefaultPetContent();
  startDefaultPetAutoWalk();
}

async function handleFolderDroppedOnPet(paths: readonly string[]): Promise<void> {
  dispatchPetBehaviorEvent({ type: "folder-drop" });
  startDefaultPetAutoWalk();
  const folderPath = await findFirstDroppedDirectory(paths);

  if (!folderPath) {
    setTransientDisplay({ message: "请投喂一个文件夹。", reaction: "error" });
    return;
  }

  try {
    launchClaudeCodeTerminal(folderPath);
    info("pet.default", "claude terminal launched from folder drop", { folderPath });
    setTransientDisplay({ message: "我吃掉它啦，Claude Code 已启动。", reaction: "success" });
  } catch (error: unknown) {
    logError("pet.default", "claude terminal launch failed", error instanceof Error ? error : { error });
    setTransientDisplay({ message: "启动 Claude Code 失败，请确认 claude 命令已安装。", reaction: "error" });
  }
}

async function findFirstDroppedDirectory(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0 || path.length > 2048) {
      continue;
    }

    try {
      const pathStat = await stat(path);
      if (pathStat.isDirectory()) {
        return path;
      }
    } catch {
    }
  }

  return null;
}

function launchClaudeCodeTerminal(folderPath: string): void {
  if (process.platform !== "win32") {
    const child = spawn("sh", ["-lc", "claude"], { cwd: folderPath, detached: true, stdio: "ignore" });
    child.unref();
    return;
  }

  const child = spawn("cmd.exe", ["/d", "/s", "/c", "start", "Claude Code", "cmd.exe", "/k", "claude"], {
    cwd: folderPath,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    shell: false,
  });
  child.once("error", (error) => {
    logError("pet.default", "claude terminal process error", error);
  });
  child.unref();
}

function getCurrentDismissToken(): string | undefined {
  return transientDisplay?.dismissToken ?? (statusBadge ? String(displayGeneration) : undefined);
}

function resolveCurrentAnimationState(): ResolvedPetAnimationState {
  return resolvePetAnimationState({
    paused,
    behaviorMode: behaviorState.mode,
    displayReaction: transientDisplay?.reaction,
    statusBadge,
    reactionAnimationOverrides: getAppStateSnapshot().preferences.reactionAnimationOverrides,
  });
}

function syncDefaultPetAnimationState(): void {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    return;
  }

  setPetMotionState(defaultPetWindow, currentAnimationState.motionState);
  setPetReactionState(defaultPetWindow, currentAnimationState.reactionState);
}

function isBusyStatusBadgeReaction(reaction: OpenPetsReaction): boolean {
  return reaction === "thinking" || reaction === "working" || reaction === "editing" || reaction === "running" || reaction === "testing" || reaction === "waiting";
}

function reclampDefaultPetWindow(): void {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    return;
  }

  const safePosition = readWindowPosition(defaultPetWindow);
  info("pet.default", "reclamp position", { windowId: defaultPetWindow.id, position: safePosition });
  defaultPetWindow.setPosition(safePosition.x, safePosition.y, false);
  setDefaultPetPosition(safePosition);
}

function startDefaultPetAutoWalk(): void {
  if (autoWalkTimer || paused || !defaultPetWindow || defaultPetWindow.isDestroyed() || !defaultPetWindow.isVisible()) {
    return;
  }

  autoWalkTimer = setInterval(stepDefaultPetAutoWalk, autoWalkFrameMs);
}

function stopDefaultPetAutoWalk(): void {
  if (!autoWalkTimer) {
    return;
  }

  clearInterval(autoWalkTimer);
  autoWalkTimer = null;
}

function stepDefaultPetAutoWalk(): void {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed() || !defaultPetWindow.isVisible()) {
    stopDefaultPetAutoWalk();
    return;
  }

  if (paused || transientDisplay || statusBadge) {
    return;
  }

  const position = readWindowPosition(defaultPetWindow);
  const { workArea } = screen.getPrimaryDisplay();
  dispatchPetBehaviorEvent({
    type: "tick",
    now: Date.now(),
    positionX: position.x,
    minX: workArea.x + autoWalkEdgePaddingPx,
    maxX: workArea.x + workArea.width - defaultPetWindowSize.width - autoWalkEdgePaddingPx,
    speedPx: autoWalkSpeedPx,
  });
}

export function shouldOpenDefaultPetOnLaunch(): boolean {
  return getAppStateSnapshot().preferences.openDefaultPetOnLaunch;
}

export function resetDefaultPetToInitialPosition(): void {
  const safePosition = getSafeDefaultPetPosition(getDefaultPetInitialPosition(defaultPetWindowSize));
  resetDefaultPetPosition(safePosition);

  if (defaultPetWindow && !defaultPetWindow.isDestroyed()) {
    defaultPetWindow.setPosition(safePosition.x, safePosition.y, false);
  }
}
