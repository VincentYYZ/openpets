import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";

import { error as logError, info } from "./logger.js";
import { addPetReminder, getPetReminders, removePetReminder, type PetReminder } from "./pet-reminder-store.js";
import { rescheduleAllPetReminders } from "./pet-reminder-scheduler.js";

let petReminderWindow: BrowserWindow | null = null;
let petReminderAnchorBounds: Electron.Rectangle | null = null;
let petReminderHandlersInstalled = false;
let petReminderWindowVisibilityChangedHandler: ((open: boolean) => void) | null = null;
const petReminderWindowWidth = 420;
const petReminderWindowHeight = 520;

export function setPetReminderWindowVisibilityChangedHandler(handler: ((open: boolean) => void) | null): void {
  petReminderWindowVisibilityChangedHandler = handler;
}

export function updatePetReminderWindowAnchor(anchorBounds: Electron.Rectangle): void {
  petReminderAnchorBounds = anchorBounds;
  if (!petReminderWindow || petReminderWindow.isDestroyed()) {
    return;
  }

  positionPetReminderWindow(petReminderWindow, anchorBounds);
}

export function isPetReminderWindowOpen(): boolean {
  return Boolean(petReminderWindow && !petReminderWindow.isDestroyed() && petReminderWindow.isVisible());
}

export function openPetReminderWindow(anchorBounds: Electron.Rectangle): void {
  installPetReminderHandlers();
  petReminderAnchorBounds = anchorBounds;

  if (petReminderWindow && !petReminderWindow.isDestroyed()) {
    positionPetReminderWindow(petReminderWindow, anchorBounds);
    petReminderWindow.show();
    petReminderWindow.focus();
    petReminderWindowVisibilityChangedHandler?.(true);
    return;
  }

  const window = new BrowserWindow({
    title: "宠物提醒你",
    width: petReminderWindowWidth,
    height: petReminderWindowHeight,
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
    backgroundColor: "#fff8f1",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(app.getAppPath(), "pet-reminder-preload.cjs"),
    },
  });

  petReminderWindow = window;
  window.setMenu(null);
  applyPetReminderAlwaysOnTop(window);
  positionPetReminderWindow(window, anchorBounds);

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
    logError("ui", "pet reminder renderer process gone", { details });
  });
  window.on("show", () => applyPetReminderAlwaysOnTop(window));
  window.on("closed", () => {
    if (petReminderWindow === window) petReminderWindow = null;
    petReminderAnchorBounds = null;
    petReminderWindowVisibilityChangedHandler?.(false);
  });
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
    petReminderWindowVisibilityChangedHandler?.(true);
  });
  window.loadURL(createPetReminderDataUrl()).catch((error: unknown) => {
    logError("ui", "pet reminder window load failed", error);
  });

  info("ui", "pet reminder window opened", { windowId: window.id, anchorBounds });
}

function installPetReminderHandlers(): void {
  if (petReminderHandlersInstalled) return;
  petReminderHandlersInstalled = true;

  ipcMain.handle("openpets:pet-reminder-list", (event) => {
    assertPetReminderSender(event);
    return serializeReminders(getPetReminders());
  });

  ipcMain.handle("openpets:pet-reminder-create", (event, payload: unknown) => {
    assertPetReminderSender(event);
    const request = validateReminderCreatePayload(payload);
    addPetReminder(request);
    rescheduleAllPetReminders();
    return serializeReminders(getPetReminders());
  });

  ipcMain.handle("openpets:pet-reminder-delete", (event, payload: unknown) => {
    assertPetReminderSender(event);
    const id = validateReminderId(payload);
    removePetReminder(id);
    rescheduleAllPetReminders();
    return serializeReminders(getPetReminders());
  });

  ipcMain.on("openpets:pet-reminder-close", (event) => {
    if (!isPetReminderSender(event)) return;
    petReminderWindow?.close();
  });
}

function assertPetReminderSender(event: IpcMainInvokeEvent): void {
  if (!isPetReminderSender(event)) {
    throw new Error("Pet reminder request came from an unexpected window.");
  }
}

function isPetReminderSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return Boolean(petReminderWindow && !petReminderWindow.isDestroyed() && event.sender === petReminderWindow.webContents);
}

function validateReminderCreatePayload(value: unknown): { readonly text: string; readonly fireAt: number } {
  if (!isRecord(value)) throw new Error("Invalid reminder request.");
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text) throw new Error("提醒内容不能为空。");
  const fireAt = typeof value.fireAt === "number" && Number.isFinite(value.fireAt) ? Math.round(value.fireAt) : NaN;
  if (!Number.isFinite(fireAt)) throw new Error("请选择一个有效的提醒时间。");
  if (fireAt < Date.now() - 60_000) throw new Error("提醒时间已过，请重新选择。");
  return { text, fireAt };
}

function validateReminderId(value: unknown): string {
  if (typeof value === "string" && /^[a-z0-9-]{1,64}$/i.test(value)) {
    return value;
  }
  if (isRecord(value) && typeof value.id === "string" && /^[a-z0-9-]{1,64}$/i.test(value.id)) {
    return value.id;
  }
  throw new Error("Invalid reminder id.");
}

function serializeReminders(list: readonly PetReminder[]): readonly PetReminder[] {
  return list.map((reminder) => ({
    id: reminder.id,
    text: reminder.text,
    fireAt: reminder.fireAt,
    createdAt: reminder.createdAt,
    fired: reminder.fired,
  }));
}

function positionPetReminderWindow(window: BrowserWindow, anchorBounds: Electron.Rectangle): void {
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

function applyPetReminderAlwaysOnTop(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  window.setAlwaysOnTop(true, process.platform === "linux" ? "screen-saver" : "floating");
}

function createPetReminderDataUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(createPetReminderHtml())}`;
}

function createPetReminderHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>宠物提醒你</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; color: #4a2b14; }
      body { padding: 12px; background: linear-gradient(180deg, rgba(255, 244, 232, 0.62), rgba(255, 250, 244, 0.26)); }
      .shell { width: 100%; height: 100%; display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; overflow: hidden; border: 1px solid rgba(212, 153, 91, 0.34); border-radius: 26px; background: radial-gradient(circle at 82% 6%, rgba(254, 215, 170, 0.78), transparent 28%), linear-gradient(180deg, rgba(255,255,255,0.98), rgba(255,248,240,0.95)); box-shadow: 0 26px 72px rgba(120, 53, 15, 0.16), inset 0 1px 0 rgba(255,255,255,0.94); backdrop-filter: blur(12px); }
      header { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 14px; padding: 18px 18px 14px 18px; -webkit-app-region: drag; }
      .header-main { min-width: 0; display: grid; gap: 8px; }
      .eyebrow { margin: 0; color: #d97706; font-size: 11px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; }
      h1 { margin: 0; font-size: 24px; line-height: 1.08; letter-spacing: -0.03em; }
      .header-note { margin: 0; padding: 10px 12px; border-radius: 16px; background: rgba(255,255,255,0.7); border: 1px solid rgba(253, 186, 116, 0.34); color: #9a5c17; font-size: 12px; line-height: 1.45; font-weight: 800; box-shadow: inset 0 1px 0 rgba(255,255,255,0.92); }
      button { border: 0; font: inherit; cursor: pointer; -webkit-app-region: no-drag; }
      .close { width: 42px; height: 42px; display: inline-flex; align-items: center; justify-content: center; border-radius: 14px; background: rgba(255,255,255,0.82); color: #8a5a2b; font-size: 24px; line-height: 1; font-weight: 700; box-shadow: inset 0 1px 0 rgba(255,255,255,0.92), 0 8px 18px rgba(170,98,30,0.08); }
      .close:hover { color: #dc2626; background: #fff; }
      form { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; margin: 0 14px 12px; padding: 14px; border-radius: 20px; border: 1px solid rgba(253, 186, 116, 0.36); background: linear-gradient(180deg, rgba(255,255,255,0.78), rgba(255,248,240,0.74)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.9); }
      textarea, input[type="datetime-local"] { width: 100%; padding: 12px 13px; border-radius: 16px; border: 1px solid rgba(212, 153, 91, 0.34); outline: none; background: rgba(255,255,255,0.96); color: #4a2b14; font: 700 14px/1.46 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: inset 0 1px 2px rgba(180,140,100,0.10), 0 8px 18px rgba(170,98,30,0.05); }
      textarea { max-height: 104px; min-height: 62px; resize: none; }
      textarea:focus, input[type="datetime-local"]:focus { border-color: rgba(217,119,6,0.72); box-shadow: 0 0 0 3px rgba(217,119,6,0.12), inset 0 1px 2px rgba(180,140,100,0.14); }
      .quick { display: flex; flex-wrap: wrap; gap: 8px; }
      .quick button { min-height: 34px; padding: 0 12px; border-radius: 999px; background: rgba(255,255,255,0.86); color: #b45309; font-size: 12px; font-weight: 850; white-space: nowrap; box-shadow: inset 0 1px 0 rgba(255,255,255,0.92), 0 6px 14px rgba(170,98,30,0.08); }
      .quick button:hover { background: #fff; }
      .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; }
      .add { min-width: 88px; height: 48px; padding: 0 18px; border-radius: 16px; background: linear-gradient(180deg, #f59e0b, #d97706); color: white; font-size: 14px; font-weight: 950; white-space: nowrap; box-shadow: 0 12px 24px rgba(217,119,6,0.22), inset 0 1px 0 rgba(255,255,255,0.42); }
      .add:disabled { background: #fde68a; color: #92400e; box-shadow: inset 0 1px 0 rgba(255,255,255,0.9); cursor: default; }
      .list { min-height: 0; overflow: auto; margin: 0 14px 12px; padding: 2px; display: flex; flex-direction: column; gap: 10px; }
      .item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 12px 14px; border-radius: 18px; background: rgba(255,255,255,0.9); border: 1px solid rgba(253, 186, 116, 0.28); box-shadow: 0 10px 20px rgba(170,98,30,0.07); }
      .item .text { font-size: 14px; line-height: 1.5; color: #3f2412; word-break: break-word; white-space: pre-wrap; }
      .item .when { margin-top: 6px; font-size: 11px; color: #92400e; font-weight: 850; letter-spacing: 0.02em; }
      .item .delete { width: 34px; height: 34px; align-self: start; border-radius: 12px; background: rgba(255,247,237,0.94); color: #b45309; font-size: 18px; line-height: 1; font-weight: 900; }
      .item .delete:hover { color: #dc2626; background: #fff; }
      .empty { padding: 18px 16px; text-align: center; color: #92400e; font-size: 12px; font-weight: 800; opacity: 0.9; border-radius: 16px; background: rgba(255,255,255,0.56); border: 1px dashed rgba(217,119,6,0.22); }
      .status { min-height: 22px; margin: 0 14px 14px; padding: 0 4px; color: #92400e; font-size: 12px; line-height: 1.4; font-weight: 800; }
      .status.error { color: #b91c1c; }
      @media (max-width: 430px) {
        .row { grid-template-columns: minmax(0, 1fr); }
        .add { width: 100%; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header>
        <div class="header-main">
          <p class="eyebrow">REMINDER</p>
          <h1>宠物提醒你</h1>
          <p class="header-note">到时间时，宠物会从桌面右下角蹦出来提醒你，不用担心错过待办。</p>
        </div>
        <button class="close" type="button" data-close aria-label="关闭">×</button>
      </header>
      <form data-form>
        <textarea data-input maxlength="200" rows="2" placeholder="要提醒你什么呢？例如：1 点开会"></textarea>
        <div class="row">
          <input data-time type="datetime-local" />
          <button class="add" data-add type="submit">添加</button>
        </div>
        <div class="quick" data-quick>
          <button type="button" data-quick-offset="5">+5 分钟</button>
          <button type="button" data-quick-offset="15">+15 分钟</button>
          <button type="button" data-quick-offset="30">+30 分钟</button>
          <button type="button" data-quick-offset="60">+1 小时</button>
        </div>
      </form>
      <section class="list" data-list aria-live="polite"></section>
      <p class="status" data-status>到时间宠物会从右下角蹦出来提醒你。</p>
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
