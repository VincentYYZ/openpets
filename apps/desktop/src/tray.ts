import { Menu, Tray, type MenuItemConstructorOptions } from "electron";

import { getAppStateSnapshot, isOnboardingCompleted } from "./app-state.js";
import { createTrayIcon } from "./assets.js";
import { hideDefaultPet, isDefaultPetVisible, setDefaultPetPaused, showDefaultPet } from "./default-pet-controller.js";
import { getTrayCopy } from "./i18n.js";
import { quitOpenPets } from "./lifecycle.js";
import { info, openLogsFolder } from "./logger.js";
import { shellState, togglePaused } from "./state.js";
import { getUpdateStatus, openUpdateReleasePage } from "./update-checker.js";
import { openTaskWindow } from "./windows.js";

let tray: Tray | null = null;

export function createAppTray(): Tray {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  refreshTrayMenu();
  info("tray", "created");
  console.log("OpenPets tray created.");

  return tray;
}

export function refreshTrayMenu(): void {
  if (!tray) {
    return;
  }

  const state = getAppStateSnapshot();
  const copy = getTrayCopy(state.preferences.language);
  const defaultPet = state.pets.installed.find((pet) => pet.id === state.preferences.defaultPetId && !pet.broken) ?? state.pets.installed[0];
  const defaultPetName = defaultPet?.displayName ?? copy.builtInPetName;

  tray.setToolTip(copy.toolTip);

  const continueSetupItems = isOnboardingCompleted()
    ? []
    : [
      {
        label: copy.continueSetup,
        click: () => openTaskWindow("onboarding"),
      },
      { type: "separator" as const },
    ];

  const menu = Menu.buildFromTemplate([
    {
      label: copy.toolTip,
      enabled: false,
    },
    ...createUpdateMenuItems(),
    { type: "separator" },
    ...continueSetupItems,
    {
      label: copy.defaultPet(defaultPetName),
      click: () => openTaskWindow("pet-manager"),
    },
    {
      label: isDefaultPetVisible() ? copy.hideDefaultPet : copy.showDefaultPet,
      click: () => {
        if (isDefaultPetVisible()) {
          hideDefaultPet();
        } else {
          showDefaultPet();
        }

        refreshTrayMenu();
      },
    },
    {
      label: shellState.paused ? copy.resumeAllPets : copy.pauseAllPets,
      click: () => {
        const paused = togglePaused();
        setDefaultPetPaused(paused);
        info("tray", "pause toggled", { paused });
        console.log(paused ? "OpenPets paused." : "OpenPets resumed.");
        refreshTrayMenu();
      },
    },
    { type: "separator" },
    {
      label: copy.managePets,
      click: () => openTaskWindow("pet-manager"),
    },
    {
      label: copy.integrations,
      click: () => openTaskWindow("agent-setup"),
    },
    {
      label: copy.settings,
      click: () => openTaskWindow("settings"),
    },
    {
      label: copy.openLogsFolder,
      click: () => { void openLogsFolder(); },
    },
    { type: "separator" },
    {
      label: copy.quitOpenPets,
      click: () => quitOpenPets(),
    },
  ]);

  tray.setContextMenu(menu);
}

function createUpdateMenuItems(): MenuItemConstructorOptions[] {
  const state = getAppStateSnapshot();
  const copy = getTrayCopy(state.preferences.language);
  const status = getUpdateStatus();
  if (status.state !== "available") return [];
  return [
    {
      label: copy.updateAvailable(status.latestVersion ?? "latest"),
      click: () => { void openUpdateReleasePage(); },
    },
  ];
}
