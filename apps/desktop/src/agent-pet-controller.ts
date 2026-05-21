import { BrowserWindow } from "electron";

import { getAppStateSnapshot, type PetScaleValue } from "./app-state.js";
import { defaultPetWindowSize, getDefaultPetInitialPosition } from "./display.js";
import { debug, info } from "./logger.js";
import { transientDisplayMs, type OpenPetsReaction } from "./local-ipc-protocol.js";
import { clearTransientReaction, createAgentPetWindow, getTransientDisplayDurationMs, getTransientReactionAnimationMs, loadExplicitPetContent, mergePetTransientDisplay, setPetReactionState, type PetStatusBadgeReaction, type PetTransientDisplay } from "./pet-window.js";

const agentPetWindows = new Map<string, BrowserWindow>();
const transientDisplays = new Map<string, PetTransientDisplay>();
const statusBadges = new Map<string, PetStatusBadgeReaction>();
const transientTimers = new Map<string, NodeJS.Timeout>();
const transientAnimationTimers = new Map<string, NodeJS.Timeout>();
const statusBadgeTimers = new Map<string, NodeJS.Timeout>();
const dismissedAgentPets = new Set<string>();
const displayGenerations = new Map<string, number>();
const busyStatusBadgeMs = 120_000;
const waitingStatusBadgeMs = 15_000;

export function showAgentPet(petId: string): boolean {
  if (dismissedAgentPets.has(petId)) {
    info("pet.agent", "show skipped", { petId, reason: "dismissed", activeWindows: agentPetWindows.size });
    return false;
  }
  const window = getOrCreateAgentPetWindow(petId);
  info("pet.agent", "show requested", { petId, windowId: window.id, visible: window.isVisible(), minimized: window.isMinimized(), activeWindows: agentPetWindows.size });
  if (window.isMinimized()) window.restore();
  window.showInactive();
  return true;
}

export function closeAgentPetIfOpen(petId: string): void {
  const window = agentPetWindows.get(petId);
  if (!window || window.isDestroyed()) {
    debug("pet.agent", "close skipped", { petId, reason: "no-window", activeWindows: agentPetWindows.size });
    return;
  }
  info("pet.agent", "close requested", { petId, windowId: window.id, activeWindows: agentPetWindows.size });
  agentPetWindows.delete(petId);
  clearAgentDisplay(petId);
  window.setIgnoreMouseEvents(false);
  window.destroy();
}

export function dismissAgentPetForActiveLease(petId: string): void {
  info("pet.agent", "dismiss requested", { petId });
  dismissedAgentPets.add(petId);
  closeAgentPetIfOpen(petId);
}

export function clearAgentPetDismissal(petId: string): void {
  debug("pet.agent", "dismissal cleared", { petId, wasDismissed: dismissedAgentPets.has(petId) });
  dismissedAgentPets.delete(petId);
}

export function clearAgentPetLeaseState(petId: string): void {
  info("pet.agent", "lease state cleared", { petId, hadWindow: agentPetWindows.has(petId), wasDismissed: dismissedAgentPets.has(petId) });
  dismissedAgentPets.delete(petId);
  closeAgentPetIfOpen(petId);
  clearAgentDisplay(petId);
}

export function applyAgentPetReaction(petId: string, reaction: OpenPetsReaction): { readonly shown: boolean; readonly reason?: string } {
  debug("pet.agent", "reaction apply", { petId, reaction });
  setAgentDisplay(petId, { reaction });
  const shown = showAgentPet(petId);
  return shown ? { shown } : { shown, reason: "dismissed" };
}

export function applyAgentPetSay(petId: string, message: string, reaction?: OpenPetsReaction): { readonly shown: boolean; readonly reason?: string } {
  debug("pet.agent", "say apply", { petId, reaction, messageLength: message.length });
  if (!reaction) clearStatusBadge(petId);
  setAgentDisplay(petId, { message, reaction });
  const shown = showAgentPet(petId);
  return shown ? { shown } : { shown, reason: "dismissed" };
}

export function closeAllAgentPets(): void {
  info("pet.agent", "close all requested", { activeWindows: agentPetWindows.size });
  for (const petId of [...agentPetWindows.keys()]) {
    closeAgentPetIfOpen(petId);
  }
  clearAllAgentDisplayTimers();
}

export function refreshAgentPetContent(): void {
  debug("pet.agent", "refresh all content", { activeWindows: agentPetWindows.size, petIds: [...agentPetWindows.keys()] });
  const scale = getPreferredPetScale();
  for (const [petId, window] of agentPetWindows.entries()) {
    if (!window.isDestroyed()) {
      const display = transientDisplays.get(petId) ?? null;
      const badge = statusBadges.get(petId) ?? null;
      void loadExplicitPetContent(window, petId, display, badge, getCurrentDismissToken(petId, display, badge), scale);
    }
  }
}

function handleBubbleDismissed(petId: string, dismissToken: string): void {
  const currentGeneration = displayGenerations.get(petId) ?? 0;
  debug("pet.agent", "bubble dismissed callback", { petId, windowId: agentPetWindows.get(petId)?.id, dismissToken, currentGeneration });
  if (dismissToken !== String(currentGeneration)) {
    debug("pet.agent", "bubble dismissed stale token", { petId, dismissToken, currentGeneration });
    return;
  }
  clearAgentDisplay(petId);
  const window = agentPetWindows.get(petId);
  if (window && !window.isDestroyed()) {
    void loadExplicitPetContent(window, petId, null, null, undefined, getPreferredPetScale());
  }
}

function getOrCreateAgentPetWindow(petId: string): BrowserWindow {
  const existing = agentPetWindows.get(petId);
  if (existing && !existing.isDestroyed()) {
    debug("pet.agent", "reuse existing window", { petId, windowId: existing.id, activeWindows: agentPetWindows.size });
    return existing;
  }

  const state = getAppStateSnapshot();
  const scale = state.preferences.petScale as PetScaleValue;
  const pet = state.pets.installed.find((candidate) => candidate.id === petId);
  if (!pet) throw new Error(`Installed pet is unavailable: ${petId}`);
  const offset = agentPetWindows.size + 1;
  const initial = getDefaultPetInitialPosition(defaultPetWindowSize);
  const display = transientDisplays.get(petId) ?? null;
  const badge = statusBadges.get(petId) ?? null;
  const window = createAgentPetWindow({
    petId,
    displayName: pet.displayName,
    scale,
    position: { x: initial.x - offset * 36, y: initial.y - offset * 24 },
    display,
    badge,
    onCloseRequested: () => dismissAgentPetForActiveLease(petId),
    onBubbleDismissed: (token) => handleBubbleDismissed(petId, token),
  }, getCurrentDismissToken(petId, display, badge));
  const windowId = window.id;

  window.on("closed", () => {
    info("pet.agent", "closed", { petId, windowId, activeWindowsBeforeDelete: agentPetWindows.size });
    agentPetWindows.delete(petId);
    clearAgentDisplay(petId);
  });
  agentPetWindows.set(petId, window);
  info("pet.agent", "created", { petId, windowId: window.id, offset, activeWindows: agentPetWindows.size, position: { x: initial.x - offset * 36, y: initial.y - offset * 24 } });
  return window;
}

function setAgentDisplay(petId: string, display: PetTransientDisplay): void {
  debug("pet.agent", "display set", { petId, reaction: display.reaction, hasMessage: Boolean(display.message), hasReactionMessage: Boolean(display.reactionMessage) });
  const nextGeneration = (displayGenerations.get(petId) ?? 0) + 1;
  displayGenerations.set(petId, nextGeneration);
  const preparedDisplay = mergePetTransientDisplay(transientDisplays.get(petId) ?? null, { ...display, dismissToken: String(nextGeneration) }, getReactionMessageOverridesForPet(petId));
  transientDisplays.set(petId, preparedDisplay);
  if (display.reaction) setStatusBadge(petId, display.reaction);
  const existingTimer = transientTimers.get(petId);
  if (existingTimer) clearTimeout(existingTimer);
  const existingAnimationTimer = transientAnimationTimers.get(petId);
  if (existingAnimationTimer) clearTimeout(existingAnimationTimer);

  const animationMs = getTransientReactionAnimationMs(preparedDisplay);
  const displayDurationMs = getTransientDisplayDurationMs(preparedDisplay);
  if (animationMs !== null && animationMs < displayDurationMs) {
    const animationTimer = setTimeout(() => {
      const current = transientDisplays.get(petId);
      if (!current) return;
      const updated = clearTransientReaction(current);
      transientDisplays.set(petId, updated);
      transientAnimationTimers.delete(petId);
      const window = agentPetWindows.get(petId);
      if (window && !window.isDestroyed()) setPetReactionState(window, "idle");
    }, animationMs);
    transientAnimationTimers.set(petId, animationTimer);
  }

  const timer = setTimeout(() => {
    transientDisplays.delete(petId);
    transientTimers.delete(petId);
    const animationTimer = transientAnimationTimers.get(petId);
    if (animationTimer) clearTimeout(animationTimer);
    transientAnimationTimers.delete(petId);
    const window = agentPetWindows.get(petId);
    if (window && !window.isDestroyed()) {
      const badge = statusBadges.get(petId) ?? null;
      void loadExplicitPetContent(window, petId, null, badge, getCurrentDismissToken(petId, null, badge), getPreferredPetScale());
    }
  }, displayDurationMs);
  transientTimers.set(petId, timer);
  const window = agentPetWindows.get(petId);
  if (window && !window.isDestroyed()) void loadExplicitPetContent(window, petId, preparedDisplay, statusBadges.get(petId) ?? null, preparedDisplay.dismissToken, getPreferredPetScale());
}

function clearAgentDisplay(petId: string): void {
  debug("pet.agent", "display cleared", { petId, hadDisplay: transientDisplays.has(petId), hadBadge: statusBadges.has(petId) });
  const timer = transientTimers.get(petId);
  if (timer) clearTimeout(timer);
  const animationTimer = transientAnimationTimers.get(petId);
  if (animationTimer) clearTimeout(animationTimer);
  transientTimers.delete(petId);
  transientAnimationTimers.delete(petId);
  const badgeTimer = statusBadgeTimers.get(petId);
  if (badgeTimer) clearTimeout(badgeTimer);
  statusBadgeTimers.delete(petId);
  transientDisplays.delete(petId);
  statusBadges.delete(petId);
}

function clearAllAgentDisplayTimers(): void {
  for (const timer of transientTimers.values()) clearTimeout(timer);
  for (const timer of transientAnimationTimers.values()) clearTimeout(timer);
  for (const timer of statusBadgeTimers.values()) clearTimeout(timer);
  transientTimers.clear();
  transientAnimationTimers.clear();
  statusBadgeTimers.clear();
  transientDisplays.clear();
  statusBadges.clear();
}

function setStatusBadge(petId: string, reaction: OpenPetsReaction): void {
  if (reaction === "idle") {
    clearStatusBadge(petId);
    return;
  }

  statusBadges.set(petId, reaction);
  const durationMs = getStatusBadgeDurationMs(reaction);
  debug("pet.agent", "status badge set", { petId, reaction, durationMs });
  const existingTimer = statusBadgeTimers.get(petId);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    clearStatusBadge(petId);
    const window = agentPetWindows.get(petId);
    if (window && !window.isDestroyed()) {
      const display = transientDisplays.get(petId) ?? null;
      void loadExplicitPetContent(window, petId, display, null, getCurrentDismissToken(petId, display, null), getPreferredPetScale());
    }
  }, durationMs);
  statusBadgeTimers.set(petId, timer);
}

function clearStatusBadge(petId: string): void {
  if (statusBadges.has(petId)) debug("pet.agent", "status badge cleared", { petId, reaction: statusBadges.get(petId) });
  statusBadges.delete(petId);
  const timer = statusBadgeTimers.get(petId);
  if (timer) clearTimeout(timer);
  statusBadgeTimers.delete(petId);
}

function isBusyStatusBadgeReaction(reaction: OpenPetsReaction): boolean {
  return reaction === "thinking" || reaction === "working" || reaction === "editing" || reaction === "running" || reaction === "testing" || reaction === "waiting";
}

function getStatusBadgeDurationMs(reaction: OpenPetsReaction): number {
  if (reaction === "waiting") return waitingStatusBadgeMs;
  return isBusyStatusBadgeReaction(reaction) ? busyStatusBadgeMs : transientDisplayMs;
}

function getCurrentDismissToken(petId: string, display: PetTransientDisplay | null, badge: PetStatusBadgeReaction | null): string | undefined {
  return display?.dismissToken ?? (badge ? String(displayGenerations.get(petId) ?? 0) : undefined);
}

function getPreferredPetScale(): PetScaleValue {
  return getAppStateSnapshot().preferences.petScale as PetScaleValue;
}

function getReactionMessageOverridesForPet(petId: string) {
  return getAppStateSnapshot().pets.installed.find((pet) => pet.id === petId)?.reactionMessageOverrides;
}
