import { BrowserWindow, screen, type Rectangle } from "electron";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { defaultHoveredAmbientSpeechIntervalMs, defaultMovingAmbientSpeechIntervalMs, getAppStateSnapshot, getDefaultPetPosition, resetDefaultPetPosition, setDefaultPetPosition, updatePreferences } from "./app-state.js";
import { resolvePetAnimationState, type ResolvedPetAnimationState } from "./pet-animation-resolver.js";
import { createInitialPetBehaviorState, reducePetBehavior, type PetBehaviorCommand, type PetBehaviorEvent } from "./pet-behavior-machine.js";
import { defaultPetWindowSize, getDefaultPetInitialPosition, type Point } from "./display.js";
import { debug, error as logError, info } from "./logger.js";
import { transientDisplayMs, type OpenPetsReaction } from "./local-ipc-protocol.js";
import { clearTransientReaction, createDefaultPetWindow, getDefaultPetSpriteBounds, getSafeDefaultPetPosition, getTransientDisplayDurationMs, getTransientReactionAnimationMs, loadDefaultPetContent, mergePetTransientDisplay, readWindowPosition, setPetMotionState, setPetReactionState, setPetWindowPosition, type PetStatusBadgeReaction, type PetTransientDisplay } from "./pet-window.js";
import { openPetHelpWindow, setPetHelpWindowVisibilityChangedHandler, updatePetHelpWindowAnchor } from "./pet-help-window.js";
import { openPetReminderWindow, setPetReminderWindowVisibilityChangedHandler, updatePetReminderWindowAnchor } from "./pet-reminder-window.js";
import { pickReactionMessage } from "./reaction-messages.js";

let defaultPetWindow: BrowserWindow | null = null;
let paused = false;
let transientDisplay: PetTransientDisplay | null = null;
let statusBadge: PetStatusBadgeReaction | null = null;
let transientDisplayTimeout: NodeJS.Timeout | null = null;
let transientAnimationTimeout: NodeJS.Timeout | null = null;
let statusBadgeTimeout: NodeJS.Timeout | null = null;
let autoWalkTimer: NodeJS.Timeout | null = null;
let ambientSpeechTimer: NodeJS.Timeout | null = null;
let folderDragPreviewTimeout: NodeJS.Timeout | null = null;
const helperWindowsOpen = new Set<HelperWindowName>();
let helperWindowsLifecycleBound = false;
let petHelpRequestDepth = 0;
let petHelpBusyReactionGuardUntil = 0;
let behaviorState = createInitialPetBehaviorState(Math.random() < 0.5 ? -1 : 1);
let currentAnimationState: ResolvedPetAnimationState = {
  animationPriority: "motion",
  motionState: "idle",
  reactionState: "idle",
};
let displayGeneration = 0;
let petInteractive = false;
let lastAmbientSpeechAt = 0;
const busyStatusBadgeMs = 120_000;
const waitingStatusBadgeMs = 15_000;
const windowsFullAutoWalk = process.platform !== "win32" || process.env.OPENPETS_WINDOWS_RENDER_MODE === "full" || process.env.OPENPETS_ENABLE_WINDOWS_AUTO_WALK === "1";
const baseAutoWalkTickMs = windowsFullAutoWalk ? 48 : 140;
const baseAutoWalkSpeedPx = windowsFullAutoWalk ? 3 : 8;
const autoWalkResumeAfterDragMs = 1200;
const autoWalkEdgePaddingPx = 12;
const folderDragPromptMessage = "把文件或文件夹交给我，我来叫 Claude Code。";
const folderDragPreviewTimeoutMs = 500;
const petHelpBusyReactionGuardMs = 1500;

type HelperWindowName = "help" | "reminder";

interface ClaudeDropLaunchTarget {
  readonly kind: "file" | "folder";
  readonly targetPath: string;
  readonly workingDirectory: string;
  readonly prompt: string;
}

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
  clearPetInteractiveState();
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

  if (shouldSuppressExternalReaction(reaction)) {
    return { shown: isDefaultPetVisible(), reason: "pet-help-active" };
  }

  setTransientDisplay({ reaction });
  showDefaultPetForExternalEvent();
  return { shown: isDefaultPetVisible() };
}

export function beginPetHelpRequest(): { readonly shown: boolean; readonly reason?: string } {
  if (paused) {
    return { shown: false, reason: "paused" };
  }

  petHelpRequestDepth += 1;
  petHelpBusyReactionGuardUntil = 0;
  setTransientDisplay({ reaction: "thinking" });
  showDefaultPetForExternalEvent();
  return { shown: isDefaultPetVisible() };
}

export function finishPetHelpRequest(result: "success" | "error"): { readonly shown: boolean; readonly reason?: string } {
  if (paused) {
    return { shown: false, reason: "paused" };
  }

  petHelpRequestDepth = Math.max(0, petHelpRequestDepth - 1);
  if (petHelpRequestDepth === 0) {
    petHelpBusyReactionGuardUntil = Date.now() + petHelpBusyReactionGuardMs;
  }
  setTransientDisplay({ reaction: result });
  showDefaultPetForExternalEvent();
  return { shown: isDefaultPetVisible() };
}

export function applyExternalPetSay(message: string, reaction?: OpenPetsReaction): { readonly shown: boolean; readonly reason?: string } {
  if (paused) {
    return { shown: false, reason: "paused" };
  }

  if (petHelpRequestDepth > 0 || (reaction && shouldSuppressExternalReaction(reaction))) {
    return { shown: isDefaultPetVisible(), reason: "pet-help-active" };
  }

  if (!reaction) clearStatusBadge();
  setTransientDisplay({ message, reaction });
  showDefaultPetForExternalEvent();
  return { shown: isDefaultPetVisible() };
}

export function destroyDefaultPet(): void {
  clearDefaultPetDisplayTimers();
  stopDefaultPetAutoWalk();
  clearAmbientSpeechTimer();
  clearPetInteractiveState();

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
  scheduleAmbientSpeech();
}

function getOrCreateDefaultPetWindow(): BrowserWindow {
  if (defaultPetWindow && !defaultPetWindow.isDestroyed()) {
    return defaultPetWindow;
  }

  if (!helperWindowsLifecycleBound) {
    setPetHelpWindowVisibilityChangedHandler(handlePetHelpWindowVisibilityChanged);
    setPetReminderWindowVisibilityChangedHandler(handlePetReminderWindowVisibilityChanged);
    helperWindowsLifecycleBound = true;
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
    onPositionChanged: handleDefaultPetPositionChanged,
    onHideRequested: hideDefaultPet,
    onHelpRequested: handlePetHelpRequested,
    onReminderRequested: handlePetReminderRequested,
    onInteractiveChanged: handlePetInteractiveChanged,
    onDragStarted: handlePetDragStarted,
    onDragEnded: handlePetDragEnded,
    onFolderDragEntered: handleFolderDragEntered,
    onFolderDragLeft: handleFolderDragLeft,
    onFolderDropped: (paths) => {
      void handleFolderDroppedOnPet(paths);
    },
    onMoved: handleDefaultPetMoved,
    onBubbleDismissed: handleBubbleDismissed,
  }, getCurrentDismissToken());
  const windowId = defaultPetWindow.id;
  info("pet.default", "created", { windowId, position, paused, petId: getAppStateSnapshot().preferences.defaultPetId });

  defaultPetWindow.on("closed", () => {
    info("pet.default", "closed", { windowId });
    stopDefaultPetAutoWalk();
    clearAmbientSpeechTimer();
    clearFolderDragPreviewTimeout();
    clearPetInteractiveState();
    defaultPetWindow = null;
  });

  return defaultPetWindow;
}

function handleDefaultPetPositionChanged(position: Point): void {
  setDefaultPetPosition(position);
  syncHelperWindowAnchors();
}

function handleDefaultPetMoved(_position: Point): void {
  syncHelperWindowAnchors();
}

function handlePetHelpRequested(anchorBounds: Rectangle): void {
  setHelperWindowOpen("help", true);
  openPetHelpWindow(anchorBounds);
}

function handlePetReminderRequested(anchorBounds: Rectangle): void {
  setHelperWindowOpen("reminder", true);
  openPetReminderWindow(anchorBounds);
}

function handlePetHelpWindowVisibilityChanged(open: boolean): void {
  setHelperWindowOpen("help", open);
}

function handlePetReminderWindowVisibilityChanged(open: boolean): void {
  setHelperWindowOpen("reminder", open);
}

function setHelperWindowOpen(name: HelperWindowName, open: boolean): void {
  const wasOpen = helperWindowsOpen.size > 0;
  const alreadyOpen = helperWindowsOpen.has(name);
  if (open && alreadyOpen) {
    syncHelperWindowAnchors();
    return;
  }
  if (!open && !alreadyOpen) return;

  if (open) helperWindowsOpen.add(name);
  else helperWindowsOpen.delete(name);

  const isOpen = helperWindowsOpen.size > 0;
  if (isOpen && !wasOpen) {
    dispatchPetBehaviorEvent({ type: "pointer-leave" });
    stopDefaultPetAutoWalk();
    clearAmbientSpeechTimer();
    syncHelperWindowAnchors();
    return;
  }
  if (!isOpen && wasOpen) {
    startDefaultPetAutoWalk();
    return;
  }
  if (isOpen) syncHelperWindowAnchors();
}

function isAnyHelperWindowOpen(): boolean {
  return helperWindowsOpen.size > 0;
}

function syncHelperWindowAnchors(): void {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) return;
  if (helperWindowsOpen.size === 0) return;
  const bounds = getDefaultPetSpriteBounds(defaultPetWindow);
  if (helperWindowsOpen.has("help")) updatePetHelpWindowAnchor(bounds);
  if (helperWindowsOpen.has("reminder")) updatePetReminderWindowAnchor(bounds);
}

export function triggerPetReminderDisplay(text: string): void {
  if (paused) {
    info("pet.reminder", "reminder skipped due to pause", { text });
    return;
  }
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return;
  const limited = trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 80)}…`;
  const message = `提醒：${limited}`;
  setTransientDisplay({ message, reaction: "waving" });
  showDefaultPetForExternalEvent();
  info("pet.reminder", "reminder displayed", { message });
}

function setTransientDisplay(display: PetTransientDisplay): void {
  debug("pet.default", "transient display set", { reaction: display.reaction, hasMessage: Boolean(display.message), hasReactionMessage: Boolean(display.reactionMessage) });
  displayGeneration++;
  transientDisplay = mergePetTransientDisplay(transientDisplay, { ...display, dismissToken: String(displayGeneration) }, getSelectedPetReactionMessageOverrides());
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
    scheduleAmbientSpeech();
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
  const durationMs = getStatusBadgeDurationMs(reaction);
  debug("pet.default", "status badge set", { reaction, durationMs });
  if (statusBadgeTimeout) clearTimeout(statusBadgeTimeout);
  statusBadgeTimeout = setTimeout(() => {
    clearStatusBadge();
    refreshDefaultPetContent();
  }, durationMs);
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
  const previousMode = behaviorState.mode;
  const previousFolderDropPromptVisible = behaviorState.folderDropPromptVisible;
  const transition = reducePetBehavior(behaviorState, event);
  behaviorState = transition.state;
  currentAnimationState = resolveCurrentAnimationState();
  executePetBehaviorCommands(transition.commands);
  syncDefaultPetAnimationState();
  if (previousMode !== behaviorState.mode || previousFolderDropPromptVisible !== behaviorState.folderDropPromptVisible) {
    scheduleAmbientSpeech();
  }
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
        setPetWindowPosition(defaultPetWindow, { x: command.x, y: position.y }, false);
        break;
      }
      default:
        break;
    }
  }
}

function handlePetInteractiveChanged(interactive: boolean, source?: string): void {
  // Both the pet body (source="mouse") and the surrounding drop-zone padding
  // (source="drop-zone") count as "the cursor is on the pet" for the purpose
  // of stopping the auto-walk. The drop-zone hit additionally lets the window
  // stop ignoring mouse events so native drag-and-drop reaches the renderer.
  if (petInteractive === interactive) {
    return;
  }

  petInteractive = interactive;
  debug("pet.default", "interactive changed", { interactive, source, mode: behaviorState.mode });
  dispatchPetBehaviorEvent({ type: interactive ? "pointer-enter" : "pointer-leave" });

  if (interactive) {
    stopDefaultPetAutoWalk();
    showAmbientSpeech(true);
    return;
  }

  startDefaultPetAutoWalk();
}

function clearPetInteractiveState(): void {
  petInteractive = false;
  if (behaviorState.mode !== "hovered") {
    scheduleAmbientSpeech();
    return;
  }

  dispatchPetBehaviorEvent({ type: "pointer-leave" });
}

function handlePetDragStarted(): void {
  dispatchPetBehaviorEvent({ type: "drag-start", now: Date.now() });
  stopDefaultPetAutoWalk();
  clearAmbientSpeechTimer();
}

function handlePetDragEnded(): void {
  dispatchPetBehaviorEvent({ type: "drag-end", now: Date.now(), resumeAfterMs: autoWalkResumeAfterDragMs });
  startDefaultPetAutoWalk();
}

function handleFolderDragEntered(): void {
  scheduleFolderDragPreviewTimeout();
  dispatchPetBehaviorEvent({ type: "folder-drag-enter" });
  stopDefaultPetAutoWalk();
  clearAmbientSpeechTimer();
}

function handleFolderDragLeft(): void {
  clearFolderDragPreviewTimeout();
  dispatchPetBehaviorEvent({ type: "folder-drag-leave" });
  startDefaultPetAutoWalk();
}

function showFolderDropPrompt(): void {
  if (paused) {
    return;
  }

  setTransientDisplay({ message: folderDragPromptMessage });
}

function clearFolderDropPrompt(): void {
  if (transientDisplay?.message !== folderDragPromptMessage) {
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
  scheduleAmbientSpeech();
}

async function handleFolderDroppedOnPet(paths: readonly string[]): Promise<void> {
  clearFolderDragPreviewTimeout();
  dispatchPetBehaviorEvent({ type: "folder-drop" });
  startDefaultPetAutoWalk();
  const launchTarget = await resolveDroppedClaudeLaunchTarget(paths);

  if (!launchTarget) {
    setTransientDisplay({ message: "请投喂一个文件夹或文件。", reaction: "error" });
    return;
  }

  try {
    launchClaudeCodeTerminal(launchTarget);
    info("pet.default", "claude terminal launched from pet drop", { kind: launchTarget.kind, targetPath: launchTarget.targetPath, workingDirectory: launchTarget.workingDirectory });
    setTransientDisplay({
      message: launchTarget.kind === "folder"
        ? "我吃掉它啦，Claude Code 已在这个文件夹里启动。"
        : "我吃掉它啦，Claude Code 已准备介绍这个文件。",
      reaction: "success",
    });
  } catch (error: unknown) {
    logError("pet.default", "claude terminal launch failed", error instanceof Error ? error : { error });
    setTransientDisplay({ message: "启动 Claude Code 失败，请确认 claude 命令已安装。", reaction: "error" });
  }
}

async function resolveDroppedClaudeLaunchTarget(paths: readonly string[]): Promise<ClaudeDropLaunchTarget | null> {
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0 || path.length > 2048) {
      continue;
    }

    try {
      const pathStat = await stat(path);
      if (pathStat.isDirectory()) {
        return {
          kind: "folder",
          targetPath: path,
          workingDirectory: path,
          prompt: `请先介绍当前文件夹“${basename(path)}”的内容结构、重点文件，以及我接下来最适合从哪里开始。路径：${path}`,
        };
      }
      if (pathStat.isFile()) {
        return {
          kind: "file",
          targetPath: path,
          workingDirectory: dirname(path),
          prompt: `请先介绍这个文件“${basename(path)}”的主要内容、用途、关键信息，以及我下一步可以怎么处理它。路径：${path}`,
        };
      }
    } catch {
    }
  }

  return null;
}

function launchClaudeCodeTerminal(target: ClaudeDropLaunchTarget): void {
  const claudeCommand = getAppStateSnapshot().preferences.claudeCommandPath || "claude";
  const commandArgs = [target.prompt];

  if (process.platform === "darwin") {
    const terminalCommand = `cd ${quotePosixShellArg(target.workingDirectory)} && ${buildPosixCommandLine(claudeCommand, commandArgs)}`;
    const child = spawn("osascript", [
      "-e",
      `tell application \"Terminal\" to do script \"${escapeAppleScriptString(terminalCommand)}\"`,
      "-e",
      'tell application "Terminal" to activate',
    ], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      logError("pet.default", "mac claude terminal process error", error);
    });
    child.unref();
    return;
  }

  if (process.platform !== "win32") {
    const child = spawn(claudeCommand, commandArgs, { cwd: target.workingDirectory, detached: true, stdio: "ignore" });
    child.once("error", (error) => {
      logError("pet.default", "claude terminal process error", error);
    });
    child.unref();
    return;
  }

  const windowsCommand = buildWindowsCommandLine(claudeCommand, commandArgs);
  const child = spawn("cmd.exe", ["/d", "/k", windowsCommand], {
    cwd: target.workingDirectory,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.once("error", (error) => {
    logError("pet.default", "windows claude terminal process error", error);
  });
  child.unref();
}

function buildPosixCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quotePosixShellArg).join(" ");
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function escapeAppleScriptString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function buildWindowsCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteWindowsCmdArg).join(" ");
}

function quoteWindowsCmdArg(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (!/[\s"&()<>^|]/.test(value)) {
    return value;
  }
  return `"${value
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1")}"`;
}

function getCurrentDismissToken(): string | undefined {
  return transientDisplay?.dismissToken ?? (statusBadge ? String(displayGeneration) : undefined);
}

function getSelectedPetReactionMessageOverrides() {
  const state = getAppStateSnapshot();
  const selected = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);
  return selected?.reactionMessageOverrides;
}

function scheduleAmbientSpeech(delayMs?: number): void {
  clearAmbientSpeechTimer();
  if (!shouldAllowAmbientSpeech()) {
    return;
  }
  const reaction = getAmbientSpeechReaction();
  if (!reaction) {
    return;
  }
  const mode = getAmbientSpeechMode(reaction);
  const nextDelayMs = delayMs ?? getAmbientSpeechIntervalMs(mode);
  ambientSpeechTimer = setTimeout(() => {
    ambientSpeechTimer = null;
    showAmbientSpeech();
  }, nextDelayMs);
}

function clearAmbientSpeechTimer(): void {
  if (ambientSpeechTimer) {
    clearTimeout(ambientSpeechTimer);
    ambientSpeechTimer = null;
  }
}

function clearFolderDragPreviewTimeout(): void {
  if (!folderDragPreviewTimeout) {
    return;
  }
  clearTimeout(folderDragPreviewTimeout);
  folderDragPreviewTimeout = null;
}

function scheduleFolderDragPreviewTimeout(): void {
  clearFolderDragPreviewTimeout();
  folderDragPreviewTimeout = setTimeout(() => {
    folderDragPreviewTimeout = null;
    handleFolderDragLeft();
  }, folderDragPreviewTimeoutMs);
}

function showAmbientSpeech(immediate = false): void {
  if (!shouldAllowAmbientSpeech()) {
    clearAmbientSpeechTimer();
    return;
  }

  const reaction = getAmbientSpeechReaction();
  if (!reaction) {
    clearAmbientSpeechTimer();
    return;
  }
  const mode = getAmbientSpeechMode(reaction);
  const intervalMs = getAmbientSpeechIntervalMs(mode);
  const elapsedMs = Date.now() - lastAmbientSpeechAt;
  if (elapsedMs < intervalMs) {
    scheduleAmbientSpeech(intervalMs - elapsedMs);
    return;
  }
  if (!immediate && transientDisplay && !transientDisplay.passive) {
    scheduleAmbientSpeech(intervalMs);
    return;
  }

  lastAmbientSpeechAt = Date.now();
  setTransientDisplay({
    reactionMessage: pickReactionMessage(reaction, getSelectedPetReactionMessageOverrides()),
    passive: true,
  });
  scheduleAmbientSpeech(intervalMs);
}

function shouldAllowAmbientSpeech(): boolean {
  return Boolean(
    defaultPetWindow
      && !defaultPetWindow.isDestroyed()
      && defaultPetWindow.isVisible()
      && !paused
      && !isAnyHelperWindowOpen()
      && getAppStateSnapshot().preferences.speechBubblesEnabled
      && !statusBadge
      && behaviorState.mode !== "dragged"
      && behaviorState.mode !== "drop-preview"
      && !behaviorState.folderDropPromptVisible,
  );
}

function getAmbientSpeechReaction(): OpenPetsReaction | null {
  if (behaviorState.mode === "hovered") {
    return "waving";
  }
  if (behaviorState.mode === "walk-left" || behaviorState.mode === "walk-right") {
    return "idle";
  }
  return null;
}

function getAmbientSpeechMode(reaction: OpenPetsReaction): "moving" | "hovered" {
  return reaction === "waving" ? "hovered" : "moving";
}

function getAmbientSpeechIntervalMs(mode: "moving" | "hovered"): number {
  const settings = getSelectedPetAmbientSpeechSettings();
  return mode === "hovered"
    ? settings?.hoveredIntervalMs ?? defaultHoveredAmbientSpeechIntervalMs
    : settings?.movingIntervalMs ?? defaultMovingAmbientSpeechIntervalMs;
}

function getSelectedPetAmbientSpeechSettings() {
  const state = getAppStateSnapshot();
  const selected = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId);
  return selected?.ambientSpeechSettings;
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

function getStatusBadgeDurationMs(reaction: OpenPetsReaction): number {
  if (reaction === "waiting") return waitingStatusBadgeMs;
  return isBusyStatusBadgeReaction(reaction) ? busyStatusBadgeMs : transientDisplayMs;
}

function shouldSuppressExternalReaction(reaction: OpenPetsReaction): boolean {
  if (reaction === "success" || reaction === "error") return false;
  if (petHelpRequestDepth > 0) {
    return true;
  }
  if (Date.now() < petHelpBusyReactionGuardUntil && isBusyStatusBadgeReaction(reaction)) {
    return true;
  }
  return false;
}

function reclampDefaultPetWindow(): void {
  if (!defaultPetWindow || defaultPetWindow.isDestroyed()) {
    return;
  }

  const safePosition = readWindowPosition(defaultPetWindow);
  info("pet.default", "reclamp position", { windowId: defaultPetWindow.id, position: safePosition });
  setPetWindowPosition(defaultPetWindow, safePosition, false);
  setDefaultPetPosition(safePosition);
  syncHelperWindowAnchors();
}

function startDefaultPetAutoWalk(): void {
  if (autoWalkTimer || paused || petInteractive || isAnyHelperWindowOpen() || !defaultPetWindow || defaultPetWindow.isDestroyed() || !defaultPetWindow.isVisible()) {
    return;
  }

  autoWalkTimer = setTimeout(stepDefaultPetAutoWalk, getAutoWalkTickMs());
  scheduleAmbientSpeech();
}

function stopDefaultPetAutoWalk(): void {
  if (!autoWalkTimer) {
    if (!petInteractive) clearAmbientSpeechTimer();
    return;
  }

  clearTimeout(autoWalkTimer);
  autoWalkTimer = null;
  if (!petInteractive) clearAmbientSpeechTimer();
}

function stepDefaultPetAutoWalk(): void {
  autoWalkTimer = null;
  if (!defaultPetWindow || defaultPetWindow.isDestroyed() || !defaultPetWindow.isVisible()) {
    stopDefaultPetAutoWalk();
    return;
  }

  if (paused) {
    return;
  }

  if (statusBadge || (transientDisplay && !transientDisplay.passive)) {
    startDefaultPetAutoWalk();
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
    speedPx: getAutoWalkSpeedPx(),
  });
  startDefaultPetAutoWalk();
}

function getAutoWalkTickMs(): number {
  const speed = getAppStateSnapshot().preferences.petWalkSpeed;
  if (speed < 1) {
    return Math.round(baseAutoWalkTickMs / Math.max(speed, 0.2));
  }
  return baseAutoWalkTickMs;
}

function getAutoWalkSpeedPx(): number {
  return Math.max(1, Math.round(baseAutoWalkSpeedPx * getAppStateSnapshot().preferences.petWalkSpeed));
}

export function shouldOpenDefaultPetOnLaunch(): boolean {
  return getAppStateSnapshot().preferences.openDefaultPetOnLaunch;
}

export function resetDefaultPetToInitialPosition(): void {
  const safePosition = getSafeDefaultPetPosition(getDefaultPetInitialPosition(defaultPetWindowSize));
  resetDefaultPetPosition(safePosition);

  if (defaultPetWindow && !defaultPetWindow.isDestroyed()) {
    setPetWindowPosition(defaultPetWindow, safePosition, false);
    syncHelperWindowAnchors();
  }
}
