import { app } from "electron";
import { resolve } from "node:path";

import { getAppStateSnapshot, initializeAppState, isOnboardingCompleted, releaseStartupInstallLock } from "./app-state.js";
import { installDefaultPetDisplayHandlers, shouldOpenDefaultPetOnLaunch, showDefaultPet, triggerPetReminderDisplay } from "./default-pet-controller.js";
import { initializePetMemoryStore } from "./pet-memory-store.js";
import { initializePetReminderStore } from "./pet-reminder-store.js";
import { startPetReminderScheduler } from "./pet-reminder-scheduler.js";
import { startRenderMetricsSampler } from "./render-metrics.js";
import { installAppLifecycle } from "./lifecycle.js";
import { error as logError, getLogFilePath, info, initializeLogger } from "./logger.js";
import { startLocalIpcServer } from "./local-ipc.js";
import { getWindowsRenderMode } from "./render-mode.js";
import { createAppTray, refreshTrayMenu } from "./tray.js";
import { checkForGitHubReleaseUpdate } from "./update-checker.js";
import { installInternalUiHandlers, installInternalUiProtocol, openTaskWindow } from "./windows.js";

// OpenPets does not store browser passwords, cookies, or encrypted app secrets.
// Keep Chromium/Electron from prompting for macOS Keychain or Linux keyring access
// during startup/profile initialization.
app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("password-store", "basic");

// Windows transparent, frameless, always-on-top pet windows are fragile under
// Chromium GPU compositing. On some machines Electron repeatedly reports
// cc tile memory exhaustion and may skip drawing content. Keep macOS/Linux on
// their normal accelerated path, but default Windows to software compositing.
const useWindowsSoftwareCompositing = process.platform === "win32" && process.env.OPENPETS_ENABLE_WINDOWS_GPU !== "1";
if (useWindowsSoftwareCompositing) {
  app.disableHardwareAcceleration();
}

// GNOME Wayland does not allow Electron apps to reliably control window
// z-order or absolute position, which breaks the desktop-pet contract: staying
// above normal windows and dragging to a user-chosen screen position. Prefer
// X11/Xwayland on Linux unless the user explicitly chooses another Ozone
// backend at launch.
if (process.platform === "linux" && !app.commandLine.hasSwitch("ozone-platform")) {
  app.commandLine.appendSwitch("ozone-platform", "x11");
}

if (typeof process.env.OPENPETS_USER_DATA === "string" && process.env.OPENPETS_USER_DATA.trim().length > 0) {
  app.setPath("userData", resolve(process.env.OPENPETS_USER_DATA));
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  installAppLifecycle();

  app.whenReady().then(async () => {
    initializeLogger();
    app.setName("OpenPets");
    info("app", "startup begin", { version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, pid: process.pid, ozonePlatform: app.commandLine.getSwitchValue("ozone-platform") || null, windowsSoftwareCompositing: useWindowsSoftwareCompositing, windowsRenderMode: getWindowsRenderMode(), renderMetrics: process.env.OPENPETS_RENDER_METRICS === "1" });

    if (process.platform === "darwin") {
      app.dock?.hide();
    }

    initializeAppState();
    info("app", "state initialized", { windowsRenderMode: getWindowsRenderMode(getAppStateSnapshot().preferences.windowsRenderMode) });
    startRenderMetricsSampler(useWindowsSoftwareCompositing);
    initializePetMemoryStore();
    initializePetReminderStore();
    startPetReminderScheduler((reminder) => triggerPetReminderDisplay(reminder.text));
    installInternalUiProtocol();
    installInternalUiHandlers();
    createAppTray();
    installDefaultPetDisplayHandlers();
    await startLocalIpcServer();
    releaseStartupInstallLock();
    if (shouldOpenDefaultPetOnLaunch()) {
      showDefaultPet();
    }
    if (!isOnboardingCompleted()) {
      try {
        openTaskWindow("onboarding");
      } catch (error) {
        console.error("Failed to open OpenPets onboarding; continuing with tray app.", error);
      }
    }
    refreshTrayMenu();
    void checkForGitHubReleaseUpdate().then(() => refreshTrayMenu());
    info("app", "startup complete", { logFile: getLogFilePath(), openDefaultPetOnLaunch: shouldOpenDefaultPetOnLaunch(), onboardingCompleted: isOnboardingCompleted() });
    console.log("OpenPets desktop shell ready.");
  }).catch((error: unknown) => {
    releaseStartupInstallLock();
    logError("app", "startup failed", error);
    console.error("Failed to start OpenPets desktop shell.", error);
    app.quit();
  });
}
