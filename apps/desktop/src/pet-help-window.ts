import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";

import { getAppStateSnapshot, updatePreferences } from "./app-state.js";
import { beginPetHelpRequest, cancelPetHelpRequest, finishPetHelpRequest } from "./default-pet-controller.js";
import { askPetHelp, PetHelpCancelledError, type PetHelpTurn } from "./pet-help-service.js";
import { error as logError, info } from "./logger.js";
import { extractPetMemoryFacts, summarizePetHelpConversation } from "./pet-memory-extractor.js";
import { recordPetHelpMemory } from "./pet-memory-store.js";

let petHelpWindow: BrowserWindow | null = null;
let petHelpAnchorBounds: Electron.Rectangle | null = null;
let petHelpHandlersInstalled = false;
let petHelpWindowVisibilityChangedHandler: ((open: boolean) => void) | null = null;
let activePetHelpAbortController: AbortController | null = null;
let activePetHelpRequestId: string | null = null;
const petHelpWindowWidth = 560;
const petHelpWindowHeight = 680;

export function setPetHelpWindowVisibilityChangedHandler(handler: ((open: boolean) => void) | null): void {
  petHelpWindowVisibilityChangedHandler = handler;
}

export function updatePetHelpWindowAnchor(anchorBounds: Electron.Rectangle): void {
  petHelpAnchorBounds = anchorBounds;
  if (!petHelpWindow || petHelpWindow.isDestroyed()) {
    return;
  }

  positionPetHelpWindow(petHelpWindow, anchorBounds);
}

export function openPetHelpWindow(anchorBounds: Electron.Rectangle): void {
  installPetHelpHandlers();
  petHelpAnchorBounds = anchorBounds;

  if (petHelpWindow && !petHelpWindow.isDestroyed()) {
    positionPetHelpWindow(petHelpWindow, anchorBounds);
    petHelpWindow.show();
    petHelpWindow.focus();
    petHelpWindowVisibilityChangedHandler?.(true);
    return;
  }

  const window = new BrowserWindow({
    title: "向宠物求助",
    width: petHelpWindowWidth,
    height: petHelpWindowHeight,
    minWidth: 440,
    minHeight: 560,
    frame: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#f8fbff",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(app.getAppPath(), "pet-help-preload.cjs"),
    },
  });

  petHelpWindow = window;
  window.setMenu(null);
  applyPetHelpAlwaysOnTop(window);
  positionPetHelpWindow(window, anchorBounds);

  if (process.platform === "darwin") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => {
    event.preventDefault();
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logError("ui", "pet help renderer process gone", { details });
  });
  window.on("show", () => applyPetHelpAlwaysOnTop(window));
  window.on("closed", () => {
    cancelActivePetHelpRequest();
    if (petHelpWindow === window) petHelpWindow = null;
    petHelpAnchorBounds = null;
    petHelpWindowVisibilityChangedHandler?.(false);
  });
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
    petHelpWindowVisibilityChangedHandler?.(true);
  });
  window.loadURL(createPetHelpDataUrl()).catch((error: unknown) => {
    logError("ui", "pet help window load failed", error);
  });

  info("ui", "pet help window opened", { windowId: window.id, anchorBounds });
}

function installPetHelpHandlers(): void {
  if (petHelpHandlersInstalled) return;
  petHelpHandlersInstalled = true;

  ipcMain.handle("openpets:pet-help-ask", async (event, payload: unknown) => {
    assertPetHelpSender(event);
    const request = validatePetHelpAskPayload(payload);
    cancelActivePetHelpRequest();
    const abortController = new AbortController();
    activePetHelpAbortController = abortController;
    activePetHelpRequestId = request.requestId;
    beginPetHelpRequest();
    try {
      const response = await askPetHelp(request, {
        onChunk: (chunk) => {
          if (!chunk || !isPetHelpSender(event)) return;
          try {
            event.sender.send("openpets:pet-help-stream", { requestId: request.requestId, chunk });
          } catch {
          }
        },
        signal: abortController.signal,
      });
      finishPetHelpRequest("success");
      recordPetHelpConversationMemoryLater([...request.history, { role: "user", content: request.message }, { role: "assistant", content: response.answer }]);
      return response;
    } catch (error: unknown) {
      if (isPetHelpCancelledError(error)) {
        cancelPetHelpRequest();
      } else {
        finishPetHelpRequest("error");
      }
      throw error;
    } finally {
      if (activePetHelpRequestId === request.requestId) {
        activePetHelpAbortController = null;
        activePetHelpRequestId = null;
      }
    }
  });

  ipcMain.on("openpets:pet-help-close", (event) => {
    if (!isPetHelpSender(event)) return;
    petHelpWindow?.close();
  });

  ipcMain.on("openpets:pet-help-cancel", (event, payload: unknown) => {
    if (!isPetHelpSender(event)) return;
    const requestId = isRecord(payload) ? normalizeRequestId(payload.requestId) : "";
    if (!requestId || requestId !== activePetHelpRequestId) return;
    cancelActivePetHelpRequest();
  });

  ipcMain.handle("openpets:pet-help-provider-snapshot", (event) => {
    assertPetHelpSender(event);
    return getPetHelpProviderSnapshot();
  });

  ipcMain.handle("openpets:pet-help-set-provider-mode", (event, modeInput: unknown) => {
    assertPetHelpSender(event);
    const mode = normalizeProviderMode(modeInput);
    if (!mode) throw new Error("Invalid pet help provider mode.");
    updatePreferences({ petHelpProviderMode: mode });
    return getPetHelpProviderSnapshot();
  });
}

function recordPetHelpConversationMemoryLater(turns: readonly PetHelpTurn[]): void {
  const timer = setTimeout(() => {
    recordPetHelpConversationMemory(turns);
  }, 0);
  timer.unref?.();
}

function recordPetHelpConversationMemory(turns: readonly PetHelpTurn[]): void {
  try {
    const recentTurns = turns.slice(-10);
    const summary = summarizePetHelpConversation(recentTurns);
    const facts = extractPetMemoryFacts(recentTurns);
    if (!summary && facts.length === 0) return;
    recordPetHelpMemory(summary, facts);
  } catch (error) {
    logError("pet.memory", "failed to record pet help memory", error);
  }
}

function assertPetHelpSender(event: IpcMainInvokeEvent): void {
  if (!isPetHelpSender(event)) {
    throw new Error("Pet help request came from an unexpected window.");
  }
}

function isPetHelpSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return Boolean(petHelpWindow && !petHelpWindow.isDestroyed() && event.sender === petHelpWindow.webContents);
}

function validatePetHelpAskPayload(value: unknown): { readonly requestId: string; readonly message: string; readonly history: readonly PetHelpTurn[] } {
  if (!isRecord(value)) throw new Error("Invalid pet help request.");
  const requestId = normalizeRequestId(value.requestId);
  if (!requestId) throw new Error("Invalid pet help request id.");
  const message = normalizeText(value.message, 4000);
  if (!message) throw new Error("Message is required.");
  const history = Array.isArray(value.history) ? value.history.slice(-8).map(validatePetHelpTurn).filter((turn): turn is PetHelpTurn => Boolean(turn)) : [];
  return { requestId, message, history };
}

function validatePetHelpTurn(value: unknown): PetHelpTurn | null {
  if (!isRecord(value)) return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  const content = normalizeText(value.content, 4000);
  if (!content) return null;
  return { role: value.role, content };
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeRequestId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function normalizeProviderMode(value: unknown): "claude" | "third-party" | null {
  return value === "claude" || value === "third-party" ? value : null;
}

function isPetHelpCancelledError(error: unknown): boolean {
  return error instanceof PetHelpCancelledError || (error instanceof Error && error.name === "AbortError");
}

function getPetHelpProviderSnapshot(): {
  readonly mode: "claude" | "third-party";
  readonly thirdPartyConfigured: boolean;
  readonly thirdPartyModel: string;
  readonly thirdPartyApiStyle: "openai" | "anthropic";
} {
  const preferences = getAppStateSnapshot().preferences;
  return {
    mode: preferences.petHelpProviderMode,
    thirdPartyConfigured: Boolean(preferences.petHelpThirdPartyConfig.apiKey),
    thirdPartyModel: preferences.petHelpThirdPartyConfig.model,
    thirdPartyApiStyle: preferences.petHelpThirdPartyConfig.apiStyle,
  };
}

function cancelActivePetHelpRequest(): void {
  activePetHelpAbortController?.abort();
}

function positionPetHelpWindow(window: BrowserWindow, anchorBounds: Electron.Rectangle): void {
  if (window.isDestroyed()) return;
  const display = screen.getDisplayMatching(anchorBounds);
  const workArea = display.workArea;
  const [width, height] = window.getSize();
  const preferredX = anchorBounds.x + anchorBounds.width;
  const preferredY = anchorBounds.y + anchorBounds.height;
  const x = clamp(Math.round(preferredX), workArea.x, workArea.x + workArea.width - width);
  const y = clamp(Math.round(preferredY), workArea.y, workArea.y + workArea.height - height);
  window.setPosition(x, y, false);
}

function applyPetHelpAlwaysOnTop(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  window.setAlwaysOnTop(true, process.platform === "linux" ? "screen-saver" : "floating");
}

function createPetHelpDataUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(createPetHelpHtml())}`;
}

function createPetHelpHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>向宠物求助</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; color: #132a55; }
      body { padding: 12px; background: linear-gradient(180deg, rgba(232, 241, 255, 0.58), rgba(245, 249, 255, 0.26)); }
      .shell { width: 100%; height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; overflow: hidden; border: 1px solid rgba(126, 161, 210, 0.42); border-radius: 26px; background: radial-gradient(circle at 82% 6%, rgba(191, 219, 254, 0.86), transparent 28%), linear-gradient(180deg, rgba(255,255,255,0.98), rgba(240,247,255,0.95)); box-shadow: 0 26px 72px rgba(19, 42, 85, 0.20), inset 0 1px 0 rgba(255,255,255,0.94); backdrop-filter: blur(12px); }
      header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 14px; padding: 18px 18px 14px 18px; -webkit-app-region: drag; }
      .header-main { min-width: 0; display: grid; gap: 8px; }
      .header-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-shrink: 0; -webkit-app-region: no-drag; }
      .eyebrow { margin: 0; color: #2f7df4; font-size: 11px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; }
      h1 { margin: 0; font-size: 24px; line-height: 1.08; letter-spacing: -0.03em; }
      .provider-summary { margin: 0; padding: 10px 12px; border-radius: 16px; background: rgba(255,255,255,0.68); border: 1px solid rgba(147,197,253,0.34); color: #587191; font-size: 12px; line-height: 1.45; font-weight: 800; box-shadow: inset 0 1px 0 rgba(255,255,255,0.92); }
      button { border: 0; font: inherit; cursor: pointer; -webkit-app-region: no-drag; }
      .close { width: 42px; height: 42px; display: inline-flex; align-items: center; justify-content: center; border-radius: 14px; background: rgba(255,255,255,0.82); color: #64748b; font-size: 24px; line-height: 1; font-weight: 700; box-shadow: inset 0 1px 0 rgba(255,255,255,0.92), 0 8px 18px rgba(61,99,160,0.08); }
      .close:hover { color: #dc2626; background: #fff; }
      .provider-toggle { min-height: 42px; min-width: 132px; padding: 0 16px; display: inline-flex; align-items: center; justify-content: center; border-radius: 999px; background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(235,244,255,0.92)); border: 1px solid rgba(96, 165, 250, 0.24); color: #176df2; font-size: 13px; font-weight: 900; white-space: nowrap; box-shadow: inset 0 1px 0 rgba(255,255,255,0.94), 0 10px 20px rgba(61,99,160,0.10); }
      .provider-toggle.off { color: #7c3aed; border-color: rgba(167,139,250,0.24); background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(245,240,255,0.94)); }
      .messages { min-height: 0; margin: 0 14px 12px; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 20px; border: 1px solid rgba(191,219,254,0.42); background: linear-gradient(180deg, rgba(255,255,255,0.78), rgba(247,251,255,0.74)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.86); }
      .message { width: fit-content; max-width: min(88%, 580px); padding: 12px 14px; border-radius: 18px; color: #172033; font-size: 14px; line-height: 1.58; white-space: pre-wrap; overflow-wrap: anywhere; }
      .message.assistant { align-self: flex-start; border-bottom-left-radius: 7px; background: rgba(255,255,255,0.94); border: 1px solid rgba(147,197,253,0.34); box-shadow: 0 12px 24px rgba(61,99,160,0.08); }
      .message.user { align-self: flex-end; border-bottom-right-radius: 7px; background: linear-gradient(180deg, #3294ff, #176cf0); color: #fff; box-shadow: 0 14px 26px rgba(47,125,244,0.24); }
      .message.pending { color: #64748b; }
      form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 0 14px 10px; }
      textarea { width: 100%; max-height: 112px; min-height: 54px; resize: none; padding: 14px 15px; border-radius: 18px; border: 1px solid rgba(126,161,210,0.40); outline: none; background: rgba(255,255,255,0.96); color: #102149; font: 700 14px/1.48 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: inset 0 1px 2px rgba(148,163,184,0.12), 0 8px 18px rgba(90,130,190,0.06); }
      textarea:focus { border-color: rgba(37,99,235,0.72); box-shadow: 0 0 0 3px rgba(37,99,235,0.12), inset 0 1px 2px rgba(148,163,184,0.14); }
      .send { align-self: end; min-width: 96px; height: 54px; padding: 0 20px; border-radius: 18px; background: linear-gradient(180deg, #3294ff, #176cf0); color: white; font-size: 14px; font-weight: 950; white-space: nowrap; box-shadow: 0 14px 26px rgba(47,125,244,0.24), inset 0 1px 0 rgba(255,255,255,0.42); }
      .send:disabled { background: #dbeafe; color: #2f7df4; box-shadow: inset 0 1px 0 rgba(255,255,255,0.9); cursor: default; }
      .status { min-height: 24px; margin: 0 14px 14px; padding: 0 4px; color: #607492; font-size: 12px; line-height: 1.4; font-weight: 800; }
      @media (max-width: 430px) {
        header { grid-template-columns: minmax(0, 1fr); }
        .header-actions { justify-content: flex-start; flex-wrap: wrap; }
        form { grid-template-columns: minmax(0, 1fr); }
        .send { width: 100%; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header>
        <div class="header-main">
          <p class="eyebrow">Pet Help</p>
          <h1>向宠物求助</h1>
          <p class="provider-summary" data-provider-summary>当前使用 Claude Code。</p>
        </div>
        <div class="header-actions">
          <button class="provider-toggle" type="button" data-provider-toggle>Claude Code 开</button>
          <button class="close" type="button" data-close aria-label="关闭">×</button>
        </div>
      </header>
      <section class="messages" data-messages aria-live="polite"></section>
      <form data-form>
        <textarea data-input maxlength="4000" rows="1" placeholder="问问宠物任何问题…"></textarea>
        <button class="send" data-send type="submit">发送</button>
      </form>
      <p class="status" data-status>由 Claude Code 提供回答。</p>
    </main>
  </body>
</html>`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
