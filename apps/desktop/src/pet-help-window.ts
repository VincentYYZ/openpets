import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";

import { beginPetHelpRequest, finishPetHelpRequest } from "./default-pet-controller.js";
import { askPetHelpWithClaude, type PetHelpTurn } from "./pet-help-service.js";
import { error as logError, info } from "./logger.js";
import { extractPetMemoryFacts, summarizePetHelpConversation } from "./pet-memory-extractor.js";
import { recordPetHelpMemory } from "./pet-memory-store.js";

let petHelpWindow: BrowserWindow | null = null;
let petHelpAnchorBounds: Electron.Rectangle | null = null;
let petHelpHandlersInstalled = false;
let petHelpWindowVisibilityChangedHandler: ((open: boolean) => void) | null = null;
const petHelpWindowWidth = 420;
const petHelpWindowHeight = 520;

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
    minWidth: 360,
    minHeight: 420,
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
    beginPetHelpRequest();
    try {
      const response = await askPetHelpWithClaude(request);
      finishPetHelpRequest("success");
      recordPetHelpConversationMemoryLater([...request.history, { role: "user", content: request.message }, { role: "assistant", content: response.answer }]);
      return response;
    } catch (error: unknown) {
      finishPetHelpRequest("error");
      throw error;
    }
  });

  ipcMain.on("openpets:pet-help-close", (event) => {
    if (!isPetHelpSender(event)) return;
    petHelpWindow?.close();
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

function validatePetHelpAskPayload(value: unknown): { readonly message: string; readonly history: readonly PetHelpTurn[] } {
  if (!isRecord(value)) throw new Error("Invalid pet help request.");
  const message = normalizeText(value.message, 4000);
  if (!message) throw new Error("Message is required.");
  const history = Array.isArray(value.history) ? value.history.slice(-8).map(validatePetHelpTurn).filter((turn): turn is PetHelpTurn => Boolean(turn)) : [];
  return { message, history };
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
      body { padding: 10px; }
      .shell { width: 100%; height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; overflow: hidden; border: 1px solid rgba(126, 161, 210, 0.46); border-radius: 22px; background: radial-gradient(circle at 82% 8%, rgba(191, 219, 254, 0.72), transparent 26%), linear-gradient(180deg, rgba(255,255,255,0.96), rgba(239,247,255,0.94)); box-shadow: 0 24px 70px rgba(19, 42, 85, 0.24), inset 0 1px 0 rgba(255,255,255,0.9); }
      header { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 16px 16px 12px 18px; -webkit-app-region: drag; }
      .eyebrow { margin: 0 0 3px; color: #2f7df4; font-size: 11px; font-weight: 900; letter-spacing: 0.08em; }
      h1 { margin: 0; font-size: 18px; line-height: 1.15; letter-spacing: -0.02em; }
      button { border: 0; font: inherit; cursor: pointer; -webkit-app-region: no-drag; }
      .close { width: 34px; height: 34px; border-radius: 12px; background: rgba(255,255,255,0.78); color: #64748b; font-weight: 950; box-shadow: inset 0 1px 0 rgba(255,255,255,0.92), 0 8px 18px rgba(61,99,160,0.08); }
      .close:hover { color: #dc2626; background: #fff; }
      .messages { min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 8px 16px 12px; }
      .message { width: fit-content; max-width: 88%; padding: 10px 12px; border-radius: 15px; color: #172033; font-size: 13px; line-height: 1.48; white-space: pre-wrap; overflow-wrap: anywhere; }
      .message.assistant { align-self: flex-start; border-bottom-left-radius: 5px; background: rgba(255,255,255,0.82); border: 1px solid rgba(147,197,253,0.38); box-shadow: 0 10px 22px rgba(61,99,160,0.09); }
      .message.user { align-self: flex-end; border-bottom-right-radius: 5px; background: linear-gradient(180deg, #3294ff, #176cf0); color: #fff; box-shadow: 0 12px 22px rgba(47,125,244,0.22); }
      .message.pending { color: #64748b; }
      form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; padding: 12px 14px 8px; border-top: 1px solid rgba(126,161,210,0.22); background: rgba(248,251,255,0.62); }
      textarea { width: 100%; max-height: 104px; min-height: 46px; resize: none; padding: 12px 13px; border-radius: 14px; border: 1px solid rgba(126,161,210,0.48); outline: none; background: rgba(255,255,255,0.94); color: #102149; font: 700 13px/1.42 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: inset 0 1px 2px rgba(148,163,184,0.14); }
      textarea:focus { border-color: rgba(37,99,235,0.72); box-shadow: 0 0 0 3px rgba(37,99,235,0.12), inset 0 1px 2px rgba(148,163,184,0.14); }
      .send { align-self: end; min-width: 70px; height: 46px; padding: 0 16px; border-radius: 14px; background: linear-gradient(180deg, #3294ff, #176cf0); color: white; font-weight: 950; box-shadow: 0 12px 24px rgba(47,125,244,0.22), inset 0 1px 0 rgba(255,255,255,0.42); }
      .send:disabled { background: #dbeafe; color: #2f7df4; box-shadow: inset 0 1px 0 rgba(255,255,255,0.9); cursor: default; }
      .status { min-height: 24px; margin: 0; padding: 0 16px 12px; color: #607492; font-size: 12px; font-weight: 750; }
    </style>
  </head>
  <body>
    <main class="shell">
      <header>
        <div>
          <p class="eyebrow">CLAUDE CODE</p>
          <h1>向宠物求助</h1>
        </div>
        <button class="close" type="button" data-close aria-label="关闭">关闭</button>
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
