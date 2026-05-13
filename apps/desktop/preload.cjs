const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getState: () => ipcRenderer.invoke("openpets:get-state"),
  getCatalog: () => ipcRenderer.invoke("openpets:get-catalog"),
  getCatalogPage: (page) => ipcRenderer.invoke("openpets:get-catalog-page", page),
  getCatalogSearch: () => ipcRenderer.invoke("openpets:get-catalog-search"),
  getCodexPets: () => ipcRenderer.invoke("openpets:get-codex-pets"),
  updatePreferences: (patch) => ipcRenderer.invoke("openpets:update-preferences", patch),
  getLaunchAtLogin: () => ipcRenderer.invoke("openpets:get-launch-at-login"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("openpets:set-launch-at-login", enabled),
  getUpdateStatus: () => ipcRenderer.invoke("openpets:get-update-status"),
  checkForUpdates: () => ipcRenderer.invoke("openpets:check-for-updates"),
  openUpdateReleasePage: () => ipcRenderer.invoke("openpets:open-update-release-page"),
  setDefaultPet: (petId) => ipcRenderer.invoke("openpets:set-default-pet", petId),
  installPet: (petId) => ipcRenderer.invoke("openpets:install-pet", petId),
  importCodexPet: (petId) => ipcRenderer.invoke("openpets:import-codex-pet", petId),
  removePet: (petId) => ipcRenderer.invoke("openpets:remove-pet", petId),
  resetDefaultPetPosition: () => ipcRenderer.invoke("openpets:reset-default-pet-position"),
};

const agentSetupApi = {
  snapshot: (selectedPetId, commandMode) => ipcRenderer.invoke("openpets:agent-setup-snapshot", selectedPetId, commandMode),
  action: (action, selectedPetId, commandMode) => ipcRenderer.invoke("openpets:agent-setup-action", action, selectedPetId, commandMode),
  updateCommandPaths: (patch) => ipcRenderer.invoke("openpets:agent-setup-command-paths", patch),
};

const onboardingApi = {
  snapshot: () => ipcRenderer.invoke("openpets:onboarding-snapshot"),
  complete: () => ipcRenderer.invoke("openpets:onboarding-complete"),
  openPetManager: () => ipcRenderer.invoke("openpets:onboarding-open-pet-manager"),
  openAgentSetup: () => ipcRenderer.invoke("openpets:onboarding-open-agent-setup"),
};

let activeAgentCommandMode = "published";
let agentSetupControlStates = null;
let activePetManagerSelection = "";
let activePetManagerFilter = "all";
let activePetManagerItems = [];
let activePetManagerDefaultId = "";
let petGalleryInstance = 0;
const remoteCatalogFilters = new Set(["original", "western", "asian"]);

contextBridge.exposeInMainWorld("openPets", api);
contextBridge.exposeInMainWorld("openpetsAgentSetup", agentSetupApi);
contextBridge.exposeInMainWorld("openpetsOnboarding", onboardingApi);

window.addEventListener("DOMContentLoaded", () => {
  const view = document.body.dataset.openpetsView;

  if (view !== "pet-manager" && view !== "settings" && view !== "agent-setup" && view !== "onboarding") {
    return;
  }

  if (view === "onboarding") {
    void renderOnboarding();
    return;
  }

  void renderCurrentState(view);
  window.addEventListener("focus", () => {
    void renderCurrentState(view);
  });
});

async function renderCurrentState(view) {
  const state = await api.getState();

  if (!isStateSnapshot(state)) {
    renderError("OpenPets state is unavailable.");
    return;
  }

  if (view === "pet-manager") {
    await renderPetManager(state);
  } else if (view === "settings") {
    renderSettings(state);
  } else {
    await renderAgentSetup();
  }
}

async function renderOnboarding() {
  const snapshot = await onboardingApi.snapshot();
  if (!isOnboardingSnapshot(snapshot)) {
    renderError("Onboarding state is unavailable.");
    return;
  }

  requireElement("onboarding-default-pet").textContent = snapshot.defaultPetName;
  requireElement("onboarding-pets-default-pet").textContent = snapshot.defaultPetName;
  let currentStep = 0;
  const showStep = (step) => {
    currentStep = step;
    for (const panel of document.querySelectorAll("[data-step-panel]")) {
      panel.hidden = panel.dataset.stepPanel !== String(step);
    }
    for (const indicator of document.querySelectorAll("[data-step-indicator]")) {
      const active = indicator.dataset.stepIndicator === String(step);
      indicator.classList.toggle("active", active);
      if (active) {
        indicator.setAttribute("aria-current", "step");
      } else {
        indicator.removeAttribute("aria-current");
      }
    }
  };

  requireButton("onboarding-welcome-next").onclick = () => showStep(1);
  requireButton("onboarding-pets-next").onclick = () => showStep(2);
  requireButton("onboarding-agents-next").onclick = () => showStep(3);
  requireButton("onboarding-open-pets").onclick = () => { void openOnboardingWindowManually("pets", onboardingApi.openPetManager); };
  requireButton("onboarding-ready-pets").onclick = () => { void onboardingApi.openPetManager().catch(renderCaughtError); };
  requireButton("onboarding-open-agents").onclick = () => { void openOnboardingWindowManually("agents", onboardingApi.openAgentSetup); };
  requireButton("onboarding-ready-agents").onclick = () => { void onboardingApi.openAgentSetup().catch(renderCaughtError); };
  requireButton("onboarding-finish").onclick = () => {
    const button = requireButton("onboarding-finish");
    button.disabled = true;
    button.textContent = "Finishing…";
    void onboardingApi.complete().catch((error) => {
      button.disabled = false;
      button.textContent = "Start using OpenPets";
      renderCaughtError(error);
    });
  };
  showStep(currentStep);
}

async function openOnboardingWindowManually(kind, opener) {
  const label = kind === "pets" ? "Pet Manager" : "Integrations";
  updateOnboardingOpenStatus(kind, `Opening ${label}…`, "");
  try {
    await opener();
    updateOnboardingOpenStatus(kind, `${label} opened — return here to continue.`, "success");
    markOnboardingWindowOpened(kind);
  } catch (error) {
    updateOnboardingOpenStatus(kind, `Couldn’t open ${label}. Try again from the button.`, "error");
    renderCaughtError(error);
  }
}

function markOnboardingWindowOpened(kind) {
  const openButton = document.getElementById(kind === "pets" ? "onboarding-open-pets" : "onboarding-open-agents");
  const continueButton = document.getElementById(kind === "pets" ? "onboarding-pets-next" : "onboarding-agents-next");
  if (openButton instanceof HTMLButtonElement) openButton.hidden = true;
  if (continueButton instanceof HTMLButtonElement) {
    continueButton.className = "onboarding-promoted-continue";
    continueButton.textContent = "Continue";
  }
}

function updateOnboardingOpenStatus(kind, text, state) {
  const id = kind === "pets" ? "onboarding-pets-status" : "onboarding-agents-status";
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = text;
  element.className = `onboarding-status-line${state ? ` ${state}` : ""}`;
}

async function renderAgentSetup(selectedPetId, commandMode) {
  const snapshot = await agentSetupApi.snapshot(selectedPetId, commandMode);
  if (!isAgentSetupSnapshot(snapshot)) {
    renderError("Claude setup status is unavailable.");
    return;
  }
  activeAgentCommandMode = snapshot.commandMode;
  agentSetupControlStates = null;

  const selected = snapshot.selectedPetId || "";
  const status = requireElement("claude-status");
  const statusTitle = requireElement("claude-status-title");
  const details = requireElement("claude-details");
  const select = requireSelect("claude-pet-select");
  const commandPreview = requireElement("claude-command-preview");
  const jsonPreview = requireElement("claude-json-preview");
  const warning = requireElement("claude-warning");
  const result = requireElement("claude-action-result");
  const devMode = requireInput("claude-dev-mode");
  const claudeCommandPath = requireInput("claude-command-path");
  const nodeCommandPath = requireInput("node-command-path");
  const hookStatus = requireElement("claude-hooks-status");
  const hookDetails = requireElement("claude-hooks-details");
  const hookPreview = requireElement("claude-hooks-preview");
  const memoryStatus = requireElement("claude-memory-status");
  const memoryDetails = requireElement("claude-memory-details");

  status.textContent = displayClaudeStatusLabel(snapshot);
  status.className = `agent-status-pill ${statusClassFor(snapshot.status.state)}`;
  statusTitle.textContent = statusTitleFor(snapshot);
  details.textContent = snapshot.status.details;
  renderPetSelect(select, snapshot, selected);
  const devModeRow = devMode.closest(".dev-mode-row");
  if (devModeRow instanceof HTMLElement) devModeRow.hidden = !snapshot.localDevAvailable;
  devMode.checked = snapshot.commandMode === "local";
  devMode.disabled = !snapshot.localDevAvailable;
  claudeCommandPath.value = snapshot.commandPaths.claude || "";
  nodeCommandPath.value = snapshot.commandPaths.node || "";
  commandPreview.textContent = snapshot.preview.displayCommand;
  jsonPreview.textContent = JSON.stringify(snapshot.preview.mcpJson, null, 2);
  warning.textContent = createClaudeSetupWarning(snapshot);
  result.textContent = snapshot.lastAction ? snapshot.lastAction.message : "Claude Code may need to be restarted after MCP changes.";
  hookStatus.textContent = formatHookStatus(snapshot.hookStatus.status);
  hookStatus.className = `agent-status-pill ${hookStatusClassFor(snapshot.hookStatus.status)}`;
  hookDetails.textContent = `${snapshot.hookStatus.message} Settings: ${snapshot.hookStatus.settingsPath}`;
  hookPreview.textContent = JSON.stringify(snapshot.hookStatus.preview, null, 2);
  memoryStatus.textContent = formatMemoryStatus(snapshot.memoryStatus.status);
  memoryStatus.className = `agent-status-pill ${memoryStatusClassFor(snapshot.memoryStatus.status)}`;
  memoryDetails.textContent = `${snapshot.memoryStatus.message} Files: ${snapshot.memoryStatus.claudeMdPath}, ${snapshot.memoryStatus.openPetsMemoryPath}`;
  updateClaudeIntegrationCard(snapshot);
  updateClaudeCommandPathHelp(snapshot);
  updateOpenCodeIntegration(snapshot, selected);

  select.onchange = () => { void renderAgentSetup(select.value, getCommandMode()); };
  devMode.onchange = () => { void renderAgentSetup(select.value, getCommandMode()); };
  decorateAgentSetupButtons();
  updateClaudeDetailActions(snapshot);
  bindIntegrationHubButtons(snapshot, select);
  bindAgentSetupButton("claude-refresh", () => renderAgentSetup(select.value, getCommandMode()), snapshot.busy, "Refreshing…");
  bindAgentSetupButton("claude-command-path-save", () => saveAgentCommandPath("claude", claudeCommandPath.value, select.value, getCommandMode()), snapshot.busy, "Saving…");
  bindAgentSetupButton("node-command-path-save", () => saveAgentCommandPath("node", nodeCommandPath.value, select.value, getCommandMode()), snapshot.busy, "Saving…");
  bindAgentSetupButton("claude-copy-command", async () => copyText(snapshot.preview.displayCommand), false);
  bindAgentSetupButton("claude-configure", () => runAgentAction("configure", select.value, getCommandMode()), snapshot.busy || !snapshot.status.canConfigure, "Installing…");
  bindAgentSetupButton("claude-replace", () => runAgentAction("replace", select.value, getCommandMode()), snapshot.busy || !snapshot.status.canReplace, "Replacing…");
  bindAgentSetupButton("claude-remove", () => runAgentAction("remove", select.value, getCommandMode()), snapshot.busy || !snapshot.status.canRemove, "Removing…");
  bindAgentSetupButton("claude-memory-install", () => runAgentAction("install-memory", select.value, getCommandMode()), snapshot.busy, "Updating…");
  bindAgentSetupButton("claude-hooks-doctor", () => runAgentAction("doctor-hooks", select.value, getCommandMode()), snapshot.busy, "Checking…");
  bindAgentSetupButton("claude-hooks-install", () => runAgentAction("install-hooks", select.value, getCommandMode()), snapshot.busy, "Installing…");
  bindAgentSetupButton("claude-hooks-uninstall", () => runAgentAction("uninstall-hooks", select.value, getCommandMode()), snapshot.busy || snapshot.hookStatus.status === "not_installed", "Removing…");
}

function updateOpenCodeIntegration(snapshot, selected) {
  const opencode = snapshot.opencodeStatus;
  const preview = snapshot.opencodePreview;
  if (!opencode || !preview) return;
  const cardStatus = document.getElementById("integration-opencode-status");
  if (cardStatus) {
    cardStatus.textContent = opencode.label;
    cardStatus.className = `agent-status-pill ${cardStatusClassFor(opencode.state)}`;
  }
  const installCard = document.getElementById("integration-opencode-install");
  if (installCard instanceof HTMLButtonElement) {
    delete installCard.dataset.loading;
    setIconButtonContent(installCard, opencode.state === "configured" ? "check" : "download", opencode.state === "configured" ? "Installed" : "Install");
    installCard.disabled = snapshot.busy || !opencode.canInstall || opencode.state === "configured";
  }
  const configureCard = document.getElementById("integration-opencode-configure");
  if (configureCard instanceof HTMLButtonElement) {
    delete configureCard.dataset.loading;
    setIconButtonContent(configureCard, "settings", "Configure");
    configureCard.disabled = false;
  }
  const status = document.getElementById("opencode-status");
  if (status) { status.textContent = opencode.label; status.className = `agent-status-pill ${statusClassFor(opencode.state)}`; }
  const title = document.getElementById("opencode-status-title");
  if (title) title.textContent = opencode.state === "configured" ? "OpenCode global setup installed" : "Global setup available";
  const details = document.getElementById("opencode-details");
  if (details) details.textContent = opencode.details;
  updateOpenCodeCommandPathHelp(opencode);
  const select = document.getElementById("opencode-pet-select");
  if (select instanceof HTMLSelectElement) renderPetSelect(select, snapshot, selected);
  const opencodeCommandPath = document.getElementById("opencode-command-path");
  if (opencodeCommandPath instanceof HTMLInputElement) opencodeCommandPath.value = snapshot.commandPaths.opencode || "";
  const opencodeNodeCommandPath = document.getElementById("opencode-node-command-path");
  if (opencodeNodeCommandPath instanceof HTMLInputElement) opencodeNodeCommandPath.value = snapshot.commandPaths.node || "";
  const paths = document.getElementById("opencode-paths");
  if (paths) {
    const cleanup = Array.isArray(preview.cleanupConfigPaths) && preview.cleanupConfigPaths.length > 0 ? `. Cleanup: ${preview.cleanupConfigPaths.join(", ")}` : "";
    paths.textContent = `Config file: ${preview.configPath || preview.configDir}. Instructions: ${preview.instructionPath}${cleanup}`;
  }
  const json = document.getElementById("opencode-json-preview");
  if (json) json.textContent = JSON.stringify(preview.configPreview && Object.keys(preview.configPreview).length > 0 ? preview.configPreview : { mcp: { openpets: { type: "local", command: preview.mcpCommand, enabled: true } }, instructions: [preview.instructionPath], plugin: preview.plugin ? [preview.plugin] : [] }, null, 2);
  const result = document.getElementById("opencode-action-result");
  if (result) result.textContent = snapshot.lastAction && String(snapshot.lastAction.action).startsWith("opencode-") ? snapshot.lastAction.message : "OpenCode may need to be restarted after global setup changes.";
  bindAgentSetupButton("opencode-install", () => runAgentAction("opencode-install", select instanceof HTMLSelectElement ? select.value : selected, getCommandMode()), snapshot.busy || !opencode.canInstall, "Installing…");
  bindAgentSetupButton("opencode-remove", () => runAgentAction("opencode-remove", select instanceof HTMLSelectElement ? select.value : selected, getCommandMode()), snapshot.busy || !opencode.canRemove, "Removing…");
  bindAgentSetupButton("opencode-refresh", () => renderAgentSetup(select instanceof HTMLSelectElement ? select.value : selected, getCommandMode()), snapshot.busy, "Refreshing…");
  bindAgentSetupButton("opencode-command-path-save", () => saveAgentCommandPath("opencode", opencodeCommandPath instanceof HTMLInputElement ? opencodeCommandPath.value : "", select instanceof HTMLSelectElement ? select.value : selected, getCommandMode()), snapshot.busy, "Saving…");
  bindAgentSetupButton("opencode-node-command-path-save", () => saveAgentCommandPath("node", opencodeNodeCommandPath instanceof HTMLInputElement ? opencodeNodeCommandPath.value : "", select instanceof HTMLSelectElement ? select.value : selected, getCommandMode()), snapshot.busy, "Saving…");
  bindAgentSetupButton("opencode-copy-config", async () => copyText(requireElement("opencode-json-preview").textContent || "", "opencode-action-result", "Copied OpenCode config preview."), false);
  if (select instanceof HTMLSelectElement) select.onchange = () => { void renderAgentSetup(select.value, getCommandMode()); };
}

function updateClaudeIntegrationCard(snapshot) {
  const status = document.getElementById("integration-claude-status");
  if (status) {
    status.textContent = snapshot.status.state === "configured" ? "Installed" : snapshot.status.canConfigure ? "Ready" : snapshot.status.label;
    status.className = `agent-status-pill ${cardStatusClassFor(snapshot.status.state)}`;
  }

  const install = document.getElementById("integration-claude-install");
  if (install instanceof HTMLButtonElement) {
    delete install.dataset.loading;
    if (snapshot.status.state === "configured") {
      setIconButtonContent(install, "check", "Installed");
      install.disabled = true;
      install.className = "agent-action secondary";
    } else if (snapshot.status.canConfigure && !snapshot.busy) {
      setIconButtonContent(install, "download", "Install");
      install.disabled = false;
      install.className = "agent-action primary";
    } else {
      setIconButtonContent(install, "download", "Install");
      install.disabled = true;
      install.className = "agent-action primary";
    }
  }

  const configure = document.getElementById("integration-claude-configure");
  if (configure instanceof HTMLButtonElement) {
    delete configure.dataset.loading;
    setIconButtonContent(configure, "settings", "Configure");
    configure.disabled = false;
    configure.className = "agent-action secondary";
  }
}

function updateClaudeCommandPathHelp(snapshot) {
  const needsNode = snapshot.status.label === "Node required" || /Node\.js is required|set the Node\.js command path/i.test(snapshot.status.details || "");
  const details = document.querySelector("#claude-detail-view .agent-command-paths");
  const card = document.querySelector("#claude-detail-view .connection-card");
  if (details instanceof HTMLElement) {
    details.classList.toggle("needs-command-path", needsNode);
  }
  if (card instanceof HTMLElement) card.classList.toggle("needs-command-path", needsNode);
  if (needsNode) renderError("Node.js was not found. Open Claude configuration → Advanced detection, set the Node.js command path, then retry.");
}

function updateOpenCodeCommandPathHelp(opencode) {
  const needsNode = /Node\.js is required|set the Node\.js command path/i.test(opencode.details || "");
  const paths = document.querySelector("#opencode-detail-view .agent-command-paths");
  const card = document.querySelector("#opencode-detail-view .connection-card");
  if (paths instanceof HTMLElement) paths.classList.toggle("needs-command-path", needsNode);
  if (card instanceof HTMLElement) card.classList.toggle("needs-command-path", needsNode);
}

function cardStatusClassFor(state) {
  if (state === "not_detected" || state === "error") return "error";
  return statusClassFor(state);
}

function bindIntegrationHubButtons(snapshot, select) {
  const install = document.getElementById("integration-claude-install");
  const configure = document.getElementById("integration-claude-configure");
  const opencodeInstall = document.getElementById("integration-opencode-install");
  const opencodeConfigure = document.getElementById("integration-opencode-configure");
  if (install instanceof HTMLButtonElement) {
    install.onclick = async () => {
      if (install.disabled || snapshot.busy) return;
      install.dataset.loading = "true";
      install.disabled = true;
      if (configure instanceof HTMLButtonElement) configure.disabled = true;
      setIconButtonContent(install, "spinner", "Installing…");
      try {
        await runAgentAction("configure", select.value, getCommandMode());
      } catch (error) {
        delete install.dataset.loading;
        install.disabled = false;
        if (configure instanceof HTMLButtonElement) configure.disabled = false;
        setIconButtonContent(install, "download", "Install");
        renderCaughtError(error);
      }
    };
  }
  if (configure instanceof HTMLButtonElement) {
    configure.onclick = () => showClaudeDetailView();
  }
  if (opencodeInstall instanceof HTMLButtonElement) {
    opencodeInstall.onclick = async () => {
      if (opencodeInstall.disabled || snapshot.busy) return;
      opencodeInstall.dataset.loading = "true";
      opencodeInstall.disabled = true;
      if (opencodeConfigure instanceof HTMLButtonElement) opencodeConfigure.disabled = true;
      setIconButtonContent(opencodeInstall, "spinner", "Installing…");
      try {
        await runAgentAction("opencode-install", select.value, getCommandMode());
      } catch (error) {
        delete opencodeInstall.dataset.loading;
        opencodeInstall.disabled = false;
        if (opencodeConfigure instanceof HTMLButtonElement) opencodeConfigure.disabled = false;
        setIconButtonContent(opencodeInstall, "download", "Install");
        renderCaughtError(error);
      }
    };
  }
  if (opencodeConfigure instanceof HTMLButtonElement) opencodeConfigure.onclick = () => showOpenCodeDetailView();
  const back = document.getElementById("integration-back");
  if (back instanceof HTMLButtonElement) back.onclick = showIntegrationsView;
  const openCodeBack = document.getElementById("opencode-integration-back");
  if (openCodeBack instanceof HTMLButtonElement) openCodeBack.onclick = showIntegrationsView;
}

function showClaudeDetailView() {
  const grid = document.getElementById("integrations-view");
  const detail = document.getElementById("claude-detail-view");
  if (grid) grid.hidden = true;
  if (detail) detail.hidden = false;
  document.getElementById("claude-detail-title")?.focus();
}

function showIntegrationsView() {
  const grid = document.getElementById("integrations-view");
  const detail = document.getElementById("claude-detail-view");
  const opencodeDetail = document.getElementById("opencode-detail-view");
  if (detail) detail.hidden = true;
  if (opencodeDetail) opencodeDetail.hidden = true;
  if (grid) grid.hidden = false;
  document.querySelector('[data-integration-card="claude"]')?.focus();
}

function showOpenCodeDetailView() {
  const grid = document.getElementById("integrations-view");
  const detail = document.getElementById("opencode-detail-view");
  const claude = document.getElementById("claude-detail-view");
  if (grid) grid.hidden = true;
  if (claude) claude.hidden = true;
  if (detail) detail.hidden = false;
  document.getElementById("opencode-detail-title")?.focus();
}

function displayClaudeStatusLabel(snapshot) {
  if (snapshot.status.canReplace && snapshot.status.canRemove) return snapshot.status.label;
  if (snapshot.status.state === "configured") return "Installed";
  return snapshot.status.label;
}

function statusTitleFor(snapshot) {
  const state = snapshot.status.state;
  if (state === "configured" && snapshot.status.canReplace) return "Installed with custom settings";
  if (state === "configured") return "OpenPets is connected";
  if (state === "needs_setup") return "Ready to configure";
  if (state === "detected") return "Claude detected";
  if (state === "not_detected") return "Claude not found";
  return "Needs attention";
}

function statusClassFor(state) {
  if (state === "configured") return "success";
  if (state === "needs_setup" || state === "detected") return "info";
  if (state === "not_detected") return "muted";
  return "error";
}

function hookStatusClassFor(status) {
  if (status === "installed") return "success";
  if (status === "needs_update") return "info";
  if (status === "error") return "error";
  return "muted";
}

function formatMemoryStatus(status) {
  if (status === "installed") return "Installed";
  if (status === "error") return "Error";
  return "Not installed";
}

function memoryStatusClassFor(status) {
  if (status === "installed") return "success";
  if (status === "error") return "error";
  return "muted";
}

function decorateAgentSetupButtons() {
  for (const id of ["claude-configure", "claude-refresh", "claude-command-path-save", "node-command-path-save", "claude-copy-command", "claude-replace", "claude-remove", "claude-memory-install", "claude-hooks-doctor", "claude-hooks-install", "claude-hooks-uninstall", "opencode-install", "opencode-remove", "opencode-refresh", "opencode-command-path-save", "opencode-node-command-path-save", "opencode-copy-config"]) {
    delete requireButton(id).dataset.loading;
  }
  setIconButtonContent(requireButton("claude-configure"), "plug", "Install integration");
  setIconButtonContent(requireButton("claude-refresh"), "refresh", "Refresh");
  setIconButtonContent(requireButton("claude-command-path-save"), "check", "Save path");
  setIconButtonContent(requireButton("node-command-path-save"), "check", "Save path");
  setIconButtonContent(requireButton("claude-copy-command"), "copy", "Copy command");
  setIconButtonContent(requireButton("claude-replace"), "repeat", "Replace configuration");
  requireButton("claude-replace").className = "agent-action primary";
  setIconButtonContent(requireButton("claude-remove"), "trash", "Remove integration");
  setIconButtonContent(requireButton("claude-memory-install"), "book", "Update instructions");
  setIconButtonContent(requireButton("claude-hooks-doctor"), "stethoscope", "Check hooks");
  setIconButtonContent(requireButton("claude-hooks-install"), "download", "Install hooks");
  setIconButtonContent(requireButton("claude-hooks-uninstall"), "trash", "Remove hooks");
  setIconButtonContent(requireButton("opencode-install"), "download", "Install global setup");
  setIconButtonContent(requireButton("opencode-remove"), "trash", "Remove global setup");
  setIconButtonContent(requireButton("opencode-refresh"), "refresh", "Refresh");
  setIconButtonContent(requireButton("opencode-command-path-save"), "check", "Save path");
  setIconButtonContent(requireButton("opencode-node-command-path-save"), "check", "Save path");
  setIconButtonContent(requireButton("opencode-copy-config"), "copy", "Copy config preview");
}

function updateClaudeDetailActions(snapshot) {
  const configure = requireButton("claude-configure");
  const replace = requireButton("claude-replace");
  const remove = requireButton("claude-remove");
  configure.hidden = !snapshot.status.canConfigure;
  replace.hidden = !snapshot.status.canReplace;
  remove.hidden = !snapshot.status.canRemove;
}

function getCommandMode() {
  if (activeAgentCommandMode === "bundled") return "bundled";
  const checkbox = requireInput("claude-dev-mode");
  return checkbox.checked ? "local" : "published";
}

function formatHookStatus(status) {
  if (status === "installed") return "Installed";
  if (status === "needs_update") return "Needs update";
  if (status === "error") return "Error";
  return "Not installed";
}

function renderPetSelect(select, snapshot, selected) {
  const previous = select.value || selected;
  select.textContent = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Default pet";
  select.append(defaultOption);
  for (const pet of snapshot.petOptions) {
    const option = document.createElement("option");
    option.value = pet.id;
    option.textContent = pet.default ? `${pet.displayName} (${pet.id}, current default)` : `${pet.displayName} (${pet.id})`;
    select.append(option);
  }
  select.value = snapshot.petOptions.some((pet) => pet.id === previous) ? previous : "";
}

function createClaudeSetupWarning(snapshot) {
  const removeWarning = "Remove deletes the Claude MCP server named openpets and removes OpenPets-managed Claude instructions.";
  if (snapshot.commandMode === "bundled") {
    const note = "Packaged mode uses bundled OpenPets commands inside this app. Moving or deleting OpenPets may require Replace/Install again.";
    if (!snapshot.status.canRemove && !snapshot.status.canReplace) return note;
    if (snapshot.status.canReplace) return `${note} This existing Claude entry is treated as installed and will be kept unless you choose Replace. ${removeWarning}`;
    return `${note} ${removeWarning}`;
  }
  if (!snapshot.status.canRemove && !snapshot.status.canReplace) return "";
  if (snapshot.status.canReplace) {
    return `This existing Claude entry is treated as installed and will be kept unless you choose Replace. ${removeWarning}`;
  }
  return removeWarning;
}

function bindAgentSetupButton(id, handler, disabled, loadingText) {
  const button = requireButton(id);
  button.disabled = Boolean(disabled);
  button.onclick = () => {
    if (button.disabled) return;
    if (!loadingText) {
      void Promise.resolve(handler()).catch(renderCaughtError);
      return;
    }
    void runAgentSetupButtonAction(id, handler, loadingText).catch(renderCaughtError);
  };
}

async function runAgentSetupButtonAction(id, handler, loadingText) {
  const button = requireButton(id);
  const previous = button.textContent || "Working…";
  setAgentSetupControlsBusy(true);
  if (loadingText) {
    button.dataset.loading = "true";
    setIconButtonContent(button, "spinner", loadingText);
    const result = document.getElementById(id.startsWith("opencode-") ? "opencode-action-result" : "claude-action-result");
    if (result) result.textContent = loadingText;
  }
  try {
    await Promise.resolve(handler());
  } catch (error) {
    delete button.dataset.loading;
    restoreAgentSetupControls();
    decorateAgentSetupButtons();
    throw error;
  }
}

function setAgentSetupControlsBusy(busy) {
  const ids = [
    "claude-configure",
    "claude-replace",
    "claude-remove",
    "claude-memory-install",
    "claude-refresh",
    "claude-command-path-save",
    "node-command-path-save",
    "claude-copy-command",
    "claude-hooks-doctor",
    "claude-hooks-install",
    "claude-hooks-uninstall",
    "opencode-install",
    "opencode-remove",
    "opencode-refresh",
    "opencode-command-path-save",
    "opencode-node-command-path-save",
    "opencode-copy-config",
  ];
  if (busy) {
    agentSetupControlStates = new Map();
    for (const id of ids) {
      const button = document.getElementById(id);
      if (button instanceof HTMLButtonElement) agentSetupControlStates.set(id, button.disabled);
    }
    const select = document.getElementById("claude-pet-select");
    if (select instanceof HTMLSelectElement) agentSetupControlStates.set("claude-pet-select", select.disabled);
    const devMode = document.getElementById("claude-dev-mode");
    if (devMode instanceof HTMLInputElement) agentSetupControlStates.set("claude-dev-mode", devMode.disabled);
  }
  for (const id of ids) {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement) button.disabled = busy;
  }
  const select = document.getElementById("claude-pet-select");
  if (select instanceof HTMLSelectElement) select.disabled = busy;
  const devMode = document.getElementById("claude-dev-mode");
  if (devMode instanceof HTMLInputElement) devMode.disabled = busy || activeAgentCommandMode === "bundled";
}

function restoreAgentSetupControls() {
  if (!agentSetupControlStates) return;
  for (const [id, disabled] of agentSetupControlStates) {
    const control = document.getElementById(id);
    if (control instanceof HTMLButtonElement || control instanceof HTMLSelectElement || control instanceof HTMLInputElement) {
      control.disabled = Boolean(disabled);
    }
  }
  agentSetupControlStates = null;
}

async function runAgentAction(action, selectedPetId, commandMode) {
  const snapshot = await agentSetupApi.action(action, selectedPetId || undefined, commandMode);
  if (!isAgentSetupSnapshot(snapshot)) throw new Error("Claude setup action returned an invalid response.");
  await renderAgentSetup(snapshot.selectedPetId || "", snapshot.commandMode);
}

async function saveAgentCommandPath(kind, path, selectedPetId, commandMode) {
  const patch = kind === "claude" ? { claude: path } : kind === "node" ? { node: path } : { opencode: path };
  await agentSetupApi.updateCommandPaths(patch);
  await renderAgentSetup(selectedPetId || "", commandMode);
  const result = document.getElementById(kind === "opencode" ? "opencode-action-result" : "claude-action-result");
  if (result) result.textContent = path.trim() ? "Saved command path. Refreshed detection using the saved path." : "Cleared command path. Refreshed automatic detection.";
}

async function copyText(text, resultId = "claude-action-result", successMessage = "Copied command.") {
  try {
    await navigator.clipboard.writeText(text);
    requireElement(resultId).textContent = successMessage;
  } catch {
    requireElement(resultId).textContent = text;
  }
}

async function renderPetManager(state) {
  const defaultPetId = state.preferences.defaultPetId;
  const [catalogState, codexState] = await Promise.all([api.getCatalog(), api.getCodexPets()]);
  renderPetGallery(catalogState, codexState, state, defaultPetId);
}

function renderPetGallery(catalogState, codexState, state, defaultPetId) {
  const instance = ++petGalleryInstance;
  const status = requireElement("catalog-status");
  const search = requireInput("catalog-search");
  const grid = requireElement("catalog-pets");
  const detail = requireElement("pm-detail");
  const defaultThumbnailSrc = document.body.dataset.defaultPetThumbnailSrc || "";

  if (!isCatalogUiState(catalogState) || !isCodexPetsUiState(codexState)) {
    status.textContent = "Unavailable";
    status.className = "pm-status-pill error";
    grid.textContent = "";
    detail.textContent = "";
    return;
  }

  status.textContent = catalogState.error ? "Catalog unavailable" : `${catalogState.total || catalogState.pets.length} pets`;
  if (catalogState.error) status.title = catalogState.error;
  status.className = `pm-status-pill ${catalogState.error || codexState.error ? "error" : "success"}`;
  let catalogPets = [...catalogState.pets];
  const loadedCatalogPages = new Set(Number.isInteger(catalogState.page) ? [catalogState.page] : []);
  const catalogPageCount = catalogState.pageCount || 1;
  let catalogSearchState = null;
  let remoteResultLimit = 100;
  let renderGeneration = 0;
  let pets = createPetManagerItems({ ...catalogState, pets: catalogPets }, codexState, state, defaultPetId, defaultThumbnailSrc);
  activePetManagerItems = pets;
  activePetManagerDefaultId = defaultPetId;
  if (!activePetManagerSelection || !pets.some((pet) => pet.id === activePetManagerSelection)) {
    activePetManagerSelection = defaultPetId || pets[0]?.id || "";
  }

  const resetPetGalleryViewport = () => {
    grid.scrollTop = 0;
    document.querySelector(".pm-gallery-pane")?.scrollTo?.({ top: 0, behavior: "instant" });
  };

  const isSupportedFilter = (filterName) => {
    if ((filterName === "western" || filterName === "asian") && !catalogState.supportsCategories) return false;
    if (filterName === "original" && typeof catalogState.originalsCount !== "number") return false;
    return true;
  };

  for (const filter of document.querySelectorAll("[data-pet-filter]")) {
    const filterName = filter.dataset.petFilter || "all";
    if (!isSupportedFilter(filterName)) {
      filter.hidden = true;
      if (activePetManagerFilter === filterName) activePetManagerFilter = "all";
    } else {
      filter.hidden = false;
    }
    filter.classList.toggle("active", filter.dataset.petFilter === activePetManagerFilter);
    filter.setAttribute("aria-pressed", filter.dataset.petFilter === activePetManagerFilter ? "true" : "false");
    filter.onclick = () => {
      const nextFilter = filter.dataset.petFilter || "all";
      if (nextFilter === activePetManagerFilter) return;
      activePetManagerFilter = nextFilter;
      remoteResultLimit = 100;
      resetPetGalleryViewport();
      void render();
    };
  }

  const loadCatalogPage = async (page) => {
    if (loadedCatalogPages.has(page)) return;
    const pageState = await api.getCatalogPage(page);
    if (!isCatalogUiState(pageState) || pageState.source === "error") throw new Error(pageState?.error || "Catalog page unavailable.");
    loadedCatalogPages.add(page);
    const known = new Set(catalogPets.map((pet) => pet.id));
    catalogPets = [...catalogPets, ...pageState.pets.filter((pet) => !known.has(pet.id))];
    pets = createPetManagerItems({ ...catalogState, pets: catalogPets }, codexState, state, defaultPetId, defaultThumbnailSrc);
    activePetManagerItems = pets;
  };

  const loadNextCatalogPage = async () => {
    for (let page = 0; page < catalogPageCount; page += 1) {
      if (!loadedCatalogPages.has(page)) {
        await loadCatalogPage(page);
        return true;
      }
    }
    return false;
  };

  const shouldUseRemoteResults = (filterName, query) => catalogState.version === 3 && ((filterName === "all" && Boolean(query)) || remoteCatalogFilters.has(filterName));

  const getRemoteResults = async (filterName, query) => {
    if (!shouldUseRemoteResults(filterName, query)) return { ids: null, hasMore: false };
    catalogSearchState ||= await api.getCatalogSearch();
    if (!isCatalogSearchUiState(catalogSearchState) || catalogSearchState.source === "error") throw new Error(catalogSearchState?.error || "Catalog search unavailable.");
    const matches = catalogSearchState.pets.filter((pet) => {
      if (filterName === "western" || filterName === "asian") {
        if (pet.category !== filterName) return false;
      } else if (filterName === "original" && !pet.original) {
        return false;
      }
      return !query || pet.searchText.includes(query);
    });
    const visibleMatches = matches.slice(0, remoteResultLimit);
    const pages = new Set(visibleMatches.map((pet) => pet.catalogPage));
    await Promise.all([...pages].map((page) => loadCatalogPage(page)));
    return { ids: new Set(visibleMatches.map((pet) => pet.id)), hasMore: matches.length > visibleMatches.length };
  };

  const render = async () => {
    const generation = ++renderGeneration;
    const filterName = activePetManagerFilter;
    const query = search.value.trim().toLowerCase();
    const isStale = () => instance !== petGalleryInstance || generation !== renderGeneration || filterName !== activePetManagerFilter || query !== search.value.trim().toLowerCase();
    for (const filter of document.querySelectorAll("[data-pet-filter]")) {
      filter.classList.toggle("active", filter.dataset.petFilter === filterName);
      filter.setAttribute("aria-pressed", filter.dataset.petFilter === filterName ? "true" : "false");
    }

    let remoteResults = { ids: null, hasMore: false };
    let remoteError = null;
    try {
      remoteResults = await getRemoteResults(filterName, query);
    } catch (error) {
      remoteError = error;
    }
    if (isStale()) {
      return;
    }
    if (remoteError) renderCaughtError(remoteError);

    const visiblePets = pets.filter((pet) => {
      if (filterName === "installed" && !pet.installed) return false;
      if (filterName === "codex" && !pet.codexPet && !pet.codexImported) return false;
      if (filterName === "original" && !pet.original) return false;
      if ((filterName === "western" || filterName === "asian") && pet.category !== filterName) return false;
      const haystack = `${pet.id} ${pet.displayName} ${pet.description}`.toLowerCase();
      if (remoteResults.ids) {
        const remoteMatch = Boolean(pet.catalogPet && remoteResults.ids.has(pet.id));
        return query ? remoteMatch || haystack.includes(query) : remoteMatch;
      }
      return haystack.includes(query);
    });

    grid.textContent = "";

    for (const pet of visiblePets) {
      grid.append(createPetGalleryCard(pet, defaultPetId, () => selectPetManagerPet(pet.id, detail)));
    }

    if (visiblePets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pm-empty-state";
      empty.textContent = createEmptyPetGalleryMessage(filterName);
      grid.append(empty);
    }

    const hasMoreCatalogPages = filterName === "all" && catalogState.version === 3 && !query && loadedCatalogPages.size < catalogPageCount;
    const hasMoreRemoteResults = remoteResults.hasMore;
    if (hasMoreCatalogPages || hasMoreRemoteResults) {
      const loadMore = document.createElement("button");
      loadMore.className = "pm-load-more";
      loadMore.type = "button";
      loadMore.textContent = "Load more pets";
      loadMore.onclick = async () => {
        loadMore.disabled = true;
        loadMore.textContent = "Loading…";
        try {
          if (hasMoreRemoteResults) {
            remoteResultLimit += 100;
          } else {
            await loadNextCatalogPage();
          }
          await render();
        } catch (error) {
          renderCaughtError(error);
          loadMore.disabled = false;
          loadMore.textContent = "Load more pets";
        }
      };
      const wrapper = document.createElement("div");
      wrapper.className = "pm-load-more-wrap";
      wrapper.append(loadMore);
      grid.append(wrapper);
    }

    const selected = visiblePets.find((pet) => pet.id === activePetManagerSelection) || visiblePets[0] || pets.find((pet) => pet.id === activePetManagerSelection) || pets[0];
    if (selected) {
      renderPetDetail(detail, selected, defaultPetId);
    }
  };

  search.oninput = () => {
    remoteResultLimit = 100;
    resetPetGalleryViewport();
    void render();
  };
  void render();
}

function createPetManagerItems(catalogState, codexState, state, defaultPetId, defaultThumbnailSrc) {
  const installedById = new Map(state.pets.installed.map((pet) => [pet.id, pet]));
  const catalogById = new Map(catalogState.pets.map((pet) => [pet.id, pet]));
  const codexById = new Map(codexState.pets.map((pet) => [pet.id, pet]));
  const items = [];

  for (const installed of state.pets.installed) {
    const catalogPet = catalogById.get(installed.id) || null;
    const codexPet = codexById.get(installed.id) || null;
    const codexImported = installed.source?.kind === "codex";
    items.push(createPetManagerItem(installed.id, installed.displayName, installed.description || catalogPet?.description || codexPet?.description || "A friendly coding companion.", installed, catalogPet, codexPet, codexImported, defaultPetId, defaultThumbnailSrc));
  }

  for (const catalogPet of catalogState.pets) {
    if (installedById.has(catalogPet.id)) continue;
    const codexPet = codexById.get(catalogPet.id) || null;
    items.push(createPetManagerItem(catalogPet.id, codexPet?.displayName || catalogPet.displayName, codexPet?.description || catalogPet.description || "A friendly coding companion.", null, catalogPet, codexPet, false, defaultPetId, defaultThumbnailSrc));
  }

  for (const codexPet of codexState.pets) {
    if (installedById.has(codexPet.id) || catalogById.has(codexPet.id)) continue;
    items.push(createPetManagerItem(codexPet.id, codexPet.displayName, codexPet.description || "A local Codex companion.", null, null, codexPet, false, defaultPetId, defaultThumbnailSrc));
  }

  return items;
}

function createPetManagerItem(id, displayName, description, installed, catalogPet, codexPet, codexImported, defaultPetId, defaultThumbnailSrc) {
  const catalogThumbnail = catalogPet && isAllowedCatalogPreview(catalogPet.preview) ? catalogPet.preview : "";
  const catalogSpritesheet = catalogPet && isAllowedCatalogPreview(catalogPet.spritesheet) ? catalogPet.spritesheet : "";
  const preview = codexPet?.preview || catalogThumbnail;
  const detailPreview = codexPet?.preview || catalogSpritesheet || catalogThumbnail;
  const usesThumbnail = Boolean(installed?.builtIn && defaultThumbnailSrc);
  const cardUsesThumbnail = usesThumbnail || Boolean(catalogSpritesheet && catalogThumbnail && preview === catalogThumbnail && !codexPet);
  return {
    id,
    displayName,
    description,
    category: catalogPet?.category || "",
    original: Boolean(catalogPet?.original),
    featured: Boolean(catalogPet?.featured),
    installed,
    catalogPet,
    codexPet,
    codexImported,
    previewSrc: usesThumbnail ? defaultThumbnailSrc : preview,
    detailPreviewSrc: usesThumbnail ? defaultThumbnailSrc : detailPreview,
    previewIsSpriteSheet: !cardUsesThumbnail,
    detailPreviewIsSpriteSheet: !usesThumbnail,
    isDefault: id === defaultPetId,
    protected: Boolean(installed?.protected),
    broken: Boolean(installed?.broken),
    brokenReason: installed?.brokenReason || "",
  };
}

function createEmptyPetGalleryMessage(filterName) {
  if (filterName === "installed") return "No installed pets match your search.";
  if (filterName === "codex") return "No Codex pets match your search.";
  if (filterName === "original") return "No OpenPets originals match your search.";
  if (filterName === "western") return "No Western pets match your search.";
  if (filterName === "asian") return "No Asian pets match your search.";
  return "No pets match your search.";
}

function createPetGalleryCard(pet, defaultPetId, onSelect) {
  const card = document.createElement("article");
  card.className = pet.id === activePetManagerSelection ? "pm-pet-card active" : "pm-pet-card";
  card.dataset.petId = pet.id;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-pressed", pet.id === activePetManagerSelection ? "true" : "false");
  card.setAttribute("aria-label", `Preview ${pet.displayName}`);
  card.addEventListener("click", onSelect);
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  });

  card.append(createSpriteFrame("pm-thumb", pet.previewSrc, pet.displayName, { isSpriteSheet: pet.previewIsSpriteSheet }));

  const name = document.createElement("div");
  name.className = "pm-pet-name";
  name.textContent = pet.displayName;
  card.append(name);

  const action = document.createElement("button");
  action.className = createCardActionClass(pet);
  action.textContent = createCardActionLabel(pet);
  action.disabled = pet.isDefault || pet.broken || pet.protected;
  action.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!pet.installed) {
      runPetPrimaryAction(pet, card);
    } else {
      runPetRemoveAction(pet, card, defaultPetId);
    }
  });
  card.append(action);

  return card;
}

function createCardActionClass(pet) {
  if (pet.isDefault || pet.broken || pet.protected) return "pm-card-action status";
  if (pet.installed) return "pm-card-action danger";
  return "pm-card-action";
}

function createCardActionLabel(pet) {
  if (pet.broken) return "Broken";
  if (pet.isDefault) return "Default";
  if (pet.protected) return "Protected";
  if (pet.installed) return "Remove";
  if (pet.codexPet) return "Import";
  return "Install";
}

function selectPetManagerPet(petId, detailContainer) {
  activePetManagerSelection = petId;
  for (const card of document.querySelectorAll(".pm-pet-card[data-pet-id]")) {
    const active = card.dataset.petId === petId;
    card.classList.toggle("active", active);
    card.setAttribute("aria-pressed", active ? "true" : "false");
  }

  const pet = activePetManagerItems.find((item) => item.id === petId);
  if (pet && detailContainer) renderPetDetail(detailContainer, pet, activePetManagerDefaultId);
}

function renderPetDetail(container, pet, defaultPetId) {
  container.textContent = "";

  const title = document.createElement("h2");
  title.className = "pm-detail-title";
  title.textContent = pet.displayName;
  container.append(title);

  const description = document.createElement("p");
  description.className = "pm-detail-description";
  description.textContent = pet.description || "A friendly coding companion.";
  container.append(description);

  const stage = document.createElement("div");
  stage.className = "pm-hero-stage";
  stage.append(createSpriteFrame("pm-preview-sprite", pet.detailPreviewSrc || pet.previewSrc, pet.displayName, { animated: true, isSpriteSheet: pet.detailPreviewIsSpriteSheet, state: "idle" }));
  container.append(stage);

  const status = document.createElement("p");
  status.className = "pm-status-line";
  status.textContent = createPetStatusText(pet);
  container.append(status);

  if (pet.brokenReason) {
    const broken = document.createElement("p");
    broken.className = "error";
    broken.textContent = pet.brokenReason;
    container.append(broken);
  }

  const previewTitle = document.createElement("h3");
  previewTitle.className = "pm-preview-title";
  previewTitle.textContent = "Preview";
  container.append(previewTitle);

  const miniGrid = document.createElement("div");
  miniGrid.className = "pm-mini-grid";
  for (const preview of [{ label: "Thinking", state: "thinking" }, { label: "Happy", state: "happy" }, { label: "Wave", state: "wave" }]) {
    const mini = document.createElement("div");
    mini.className = "pm-mini";
    mini.append(createSpriteFrame("pm-mini-sprite", pet.detailPreviewSrc || pet.previewSrc, pet.displayName, { animated: true, isSpriteSheet: pet.detailPreviewIsSpriteSheet, state: preview.state }));
    const text = document.createElement("span");
    text.textContent = preview.label;
    mini.append(text);
    miniGrid.append(mini);
  }
  container.append(miniGrid);

  const actions = document.createElement("div");
  actions.className = "pm-detail-actions";
  const primary = document.createElement("button");
  primary.className = pet.isDefault || pet.broken ? "status" : "";
  setIconButtonContent(primary, pet.broken ? "alert" : pet.isDefault ? "check" : pet.installed ? "star" : "download", pet.broken ? "Broken" : pet.isDefault ? "Default" : pet.installed ? "Set default" : pet.codexPet ? "Import" : "Install");
  primary.disabled = pet.broken || pet.isDefault;
  primary.addEventListener("click", () => runPetPrimaryAction(pet, actions));
  actions.append(primary);

  if (pet.installed) {
    const remove = document.createElement("button");
    remove.className = "secondary";
    setIconButtonContent(remove, pet.protected ? "shield" : "trash", pet.protected ? "Protected" : "Remove");
    remove.disabled = pet.protected;
    remove.addEventListener("click", () => runPetRemoveAction(pet, actions, defaultPetId));
    actions.append(remove);
  }
  container.append(actions);
}

function setIconButtonContent(button, icon, label) {
  button.textContent = "";
  button.append(createSvgIcon(icon), document.createTextNode(label));
}

function createSvgIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("pm-button-icon");

  for (const d of getIconPaths(name)) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }

  return svg;
}

function getIconPaths(name) {
  if (name === "download") return ["M12 15V3", "M7 10l5 5 5-5", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"];
  if (name === "star") return ["M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.12 2.12 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.12 2.12 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.12 2.12 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16z"];
  if (name === "check") return ["M20 6 9 17l-5-5"];
  if (name === "trash") return ["M10 11v6", "M14 11v6", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"];
  if (name === "shield") return ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"];
  if (name === "plug") return ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a6 6 0 0 1-12 0V8z"];
  if (name === "refresh") return ["M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16", "M16 16h5v5"];
  if (name === "copy") return ["M8 8h8v8H8z", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2", "M10 22h10c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2"];
  if (name === "repeat") return ["m17 2 4 4-4 4", "M3 11V9a4 4 0 0 1 4-4h14", "m7 22-4-4 4-4", "M21 13v2a4 4 0 0 1-4 4H3"];
  if (name === "book") return ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20", "M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"];
  if (name === "stethoscope") return ["M11 2v2", "M5 2v2", "M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1", "M8 15a6 6 0 0 0 12 0v-3", "M20 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4"];
  if (name === "spinner") return ["M12 3a9 9 0 1 0 9 9"];
  if (name === "settings") return ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"];
  return ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"];
}

function createPetStatusText(pet) {
  if (pet.broken) return "This installed pet is broken and cannot be selected as default.";
  if (pet.isDefault) return pet.protected ? "Default built-in pet. Protected from removal." : "Default pet.";
  if (pet.installed && pet.codexImported) return "Imported from your local Codex pets and ready to become your default pet.";
  if (pet.installed && pet.codexPet) return "Installed and ready to become your default pet. Also found in ~/.codex/pets.";
  if (pet.installed) return "Installed and ready to become your default pet.";
  if (pet.codexPet && !pet.catalogPet) return "Available to import from ~/.codex/pets.";
  if (pet.codexPet) return "Available in the catalog and also found in ~/.codex/pets. Import uses the local Codex copy.";
  return "Available to install from the catalog.";
}

function runPetPrimaryAction(pet, busyContainer) {
  if (pet.broken || pet.isDefault) return;
  const importing = Boolean(!pet.installed && pet.codexPet);
  setCardBusy(busyContainer, true, pet.installed ? "Setting…" : importing ? "Importing…" : "Installing…");
  const action = pet.installed ? api.setDefaultPet(pet.id) : importing ? api.importCodexPet(pet.id) : api.installPet(pet.id);
  void action.then(() => {
    activePetManagerSelection = pet.id;
    return renderCurrentState("pet-manager");
  }).catch(renderCaughtError).finally(() => setCardBusy(busyContainer, false));
}

function runPetRemoveAction(pet, busyContainer, defaultPetId) {
  if (!pet.installed || pet.protected) return;
  setCardBusy(busyContainer, true, "Removing…");
  void api.removePet(pet.id).then(() => {
    if (activePetManagerSelection === pet.id) activePetManagerSelection = defaultPetId;
    return renderCurrentState("pet-manager");
  }).catch(renderCaughtError).finally(() => setCardBusy(busyContainer, false));
}

function createSpriteFrame(className, src, alt, options = {}) {
  const animated = Boolean(options.animated);
  const isSpriteSheet = options.isSpriteSheet !== false;
  const state = options.state || "idle";
  const frame = document.createElement("div");
  frame.className = `pm-sprite-frame ${className}`;
  frame.setAttribute("role", "img");
  frame.setAttribute("aria-label", alt);
  if (!isSpriteSheet) frame.classList.add("pm-thumbnail-frame");
  if (!src) {
    frame.classList.add("pm-empty-sprite");
    return frame;
  }

  const image = new Image();
  image.referrerPolicy = "no-referrer";
  image.decoding = "async";
  image.addEventListener("load", () => {
    frame.style.backgroundImage = `url(${JSON.stringify(src)})`;
    if (!isSpriteSheet) return;
    frame.classList.add(`pm-sprite-state-${state}`);
    if (animated) frame.classList.add("pm-animate-sprite");
  });
  image.addEventListener("error", () => {
    frame.style.backgroundImage = "";
    frame.classList.remove("pm-animate-sprite");
    frame.classList.add("pm-empty-sprite");
  });
  image.src = src;
  return frame;
}

function isAllowedCatalogPreview(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "openpets.dev"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.pathname.startsWith("/pets/")
      && url.pathname.endsWith(".webp");
  } catch {
    return false;
  }
}

function setCardBusy(card, busy, label) {
  for (const button of card.querySelectorAll("button")) {
    if (busy) {
      button.dataset.previousDisabled = button.disabled ? "true" : "false";
      if (label) button.dataset.previousText = button.textContent || "";
      button.disabled = true;
      if (label) button.textContent = label;
    } else {
      button.disabled = button.dataset.previousDisabled === "true";
      if (button.dataset.previousText) button.textContent = button.dataset.previousText;
      delete button.dataset.previousDisabled;
      delete button.dataset.previousText;
    }
  }
}

function renderSettings(state) {
  const openOnLaunch = requireInput("open-default-pet-on-launch");
  const launchAtLogin = requireInput("launch-at-login");
  const launchAtLoginDetail = requireElement("launch-at-login-detail");
  const scaleSelect = requireSelect("pet-scale");
  const scale = requireElement("pet-scale-value");
  const status = requireElement("settings-status");

  openOnLaunch.checked = state.preferences.openDefaultPetOnLaunch;
  scaleSelect.value = String(state.preferences.petScale);
  openOnLaunch.disabled = false;
  scaleSelect.disabled = false;
  scale.textContent = `${scaleLabelFor(state.preferences.petScale)} (${state.preferences.petScale}x)`;

  bindCheckbox(openOnLaunch, "openDefaultPetOnLaunch", "Launch preference saved.");
  bindScaleSelect(scaleSelect, String(state.preferences.petScale));
  bindLaunchAtLogin(launchAtLogin, launchAtLoginDetail);
  bindUpdateControls();

  const resetButton = requireButton("reset-default-pet-position");
  resetButton.disabled = false;
  resetButton.onclick = () => {
    status.textContent = "Resetting pet position…";
    resetButton.disabled = true;
    void api.resetDefaultPetPosition().then(async () => {
      await renderCurrentState("settings");
      requireElement("settings-status").textContent = "Default pet position reset.";
    }).catch((error) => {
      resetButton.disabled = false;
      status.textContent = "Couldn’t reset pet position. Try again.";
      renderCaughtError(error);
    });
  };
}

function bindUpdateControls() {
  const checkButton = requireButton("check-for-updates");
  const openButton = requireButton("open-update-release");
  checkButton.onclick = () => {
    checkButton.disabled = true;
    requireElement("settings-status").textContent = "Checking for updates…";
    renderUpdateStatus({ state: "checking" });
    void api.checkForUpdates().then((status) => {
      renderUpdateStatus(status);
      requireElement("settings-status").textContent = updateStatusMessage(status);
    }).catch((error) => {
      checkButton.disabled = false;
      requireElement("settings-status").textContent = "Couldn’t check for updates. Try again.";
      renderCaughtError(error);
    });
  };
  openButton.onclick = () => {
    void api.openUpdateReleasePage().catch(renderCaughtError);
  };
  void api.getUpdateStatus().then((status) => {
    renderUpdateStatus(status);
    if (status.state === "checking") {
      void api.checkForUpdates().then(renderUpdateStatus).catch(renderCaughtError);
    }
  }).catch(renderCaughtError);
}

function renderUpdateStatus(status) {
  const title = requireElement("update-status-title");
  const detail = requireElement("update-status-detail");
  const checkButton = requireButton("check-for-updates");
  const openButton = requireButton("open-update-release");
  checkButton.disabled = status.state === "checking";
  openButton.hidden = status.state !== "available";
  if (status.state === "available") {
    title.textContent = `Update available: ${status.latestVersion || "latest"}`;
    detail.textContent = `Installed: ${status.currentVersion || "unknown"}. Open the GitHub release page to download the update.`;
  } else if (status.state === "current") {
    title.textContent = "OpenPets is up to date";
    detail.textContent = `Installed: ${status.currentVersion || "unknown"}. Latest public release: ${status.latestVersion || "unknown"}.`;
  } else if (status.state === "checking") {
    title.textContent = "Checking for updates";
    detail.textContent = "Looking for the latest public GitHub release…";
  } else if (status.state === "error") {
    title.textContent = "Update check unavailable";
    detail.textContent = status.error || "Couldn’t read the latest public GitHub release.";
  } else {
    title.textContent = "Check for updates";
    detail.textContent = "OpenPets checks public GitHub releases and opens the release page when an update is available.";
  }
}

function updateStatusMessage(status) {
  if (status.state === "available") return `Update ${status.latestVersion || "latest"} is available.`;
  if (status.state === "current") return "OpenPets is up to date.";
  if (status.state === "error") return "Couldn’t check for updates.";
  return "Update check finished.";
}

function bindLaunchAtLogin(input, detail) {
  input.disabled = true;
  detail.textContent = "Checking login setting…";
  void api.getLaunchAtLogin().then((state) => {
    if (!isLaunchAtLoginState(state)) throw new Error("Launch-at-login status is unavailable.");
    input.checked = state.enabled;
    input.disabled = !state.supported;
    detail.textContent = state.supported ? "Start OpenPets automatically when you sign in." : "Launch at login is not available on this platform.";
  }).catch((error) => {
    input.disabled = true;
    detail.textContent = "Couldn’t read login setting.";
    renderCaughtError(error);
  });
  input.onchange = () => {
    const previous = !input.checked;
    input.disabled = true;
    const status = requireElement("settings-status");
    status.textContent = input.checked ? "Enabling launch at login…" : "Disabling launch at login…";
    void api.setLaunchAtLogin(input.checked).then((state) => {
      if (!isLaunchAtLoginState(state)) throw new Error("Launch-at-login update failed.");
      input.checked = state.enabled;
      input.disabled = !state.supported;
      status.textContent = state.supported ? "Launch at login preference saved." : "Launch at login is not available on this platform.";
    }).catch((error) => {
      input.checked = previous;
      input.disabled = false;
      status.textContent = "Couldn’t update launch at login. Try again.";
      renderCaughtError(error);
    });
  };
}

function bindScaleSelect(select, currentValue) {
  select.onchange = () => {
    const previous = currentValue;
    const value = Number(select.value);
    select.disabled = true;
    const status = requireElement("settings-status");
    status.textContent = "Saving scale…";
    void api.updatePreferences({ petScale: value }).then(async () => {
      await renderCurrentState("settings");
      requireElement("settings-status").textContent = `${scaleLabelFor(value)} pet scale saved.`;
    }).catch((error) => {
      select.value = previous;
      select.disabled = false;
      status.textContent = "Couldn’t save pet scale. Try again.";
      renderCaughtError(error);
    });
  };
}

function scaleLabelFor(value) {
  if (value === 0.44) return "Small";
  if (value === 0.56) return "Medium";
  if (value === 0.72) return "Large";
  return "Custom";
}

function bindCheckbox(input, key, message) {
  input.onchange = () => {
    const previous = !input.checked;
    input.disabled = true;
    const status = requireElement("settings-status");
    status.textContent = "Saving…";
    void api.updatePreferences({ [key]: input.checked }).then(async () => {
      await renderCurrentState("settings");
      requireElement("settings-status").textContent = message;
    }).catch((error) => {
      input.checked = previous;
      input.disabled = false;
      status.textContent = "Couldn’t save setting. Try again.";
      renderCaughtError(error);
    });
  };
}

function createBadge(label, className) {
  const badge = document.createElement("span");
  badge.className = className ? `badge ${className}` : "badge";
  badge.textContent = label;
  return badge;
}

function renderCaughtError(error) {
  renderError(error instanceof Error ? error.message : "OpenPets action failed.");
}

function renderError(message) {
  const error = document.querySelector("[data-error]");
  if (error) {
    error.textContent = message;
    error.title = message;
  }
}

function requireElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element;
}

function requireInput(id) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`);
  return element;
}

function requireSelect(id) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLSelectElement)) throw new Error(`Missing select: ${id}`);
  return element;
}

function requireButton(id) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${id}`);
  return element;
}

function isStateSnapshot(value) {
  if (!isRecord(value) || !isRecord(value.preferences) || !isRecord(value.pets) || !Array.isArray(value.pets.installed)) {
    return false;
  }

  return typeof value.preferences.defaultPetId === "string"
    && typeof value.preferences.openDefaultPetOnLaunch === "boolean"
    && typeof value.preferences.speechBubblesEnabled === "boolean"
    && typeof value.preferences.petScale === "number"
    && typeof value.preferences.onboardingCompleted === "boolean";
}

function isOnboardingSnapshot(value) {
  return isRecord(value)
    && typeof value.defaultPetName === "string"
    && typeof value.onboardingCompleted === "boolean";
}

function isLaunchAtLoginState(value) {
  return isRecord(value)
    && typeof value.supported === "boolean"
    && typeof value.enabled === "boolean";
}

function isCatalogUiState(value) {
  return isRecord(value)
    && (value.source === "remote" || value.source === "fixture" || value.source === "error")
    && Array.isArray(value.pets);
}

function isCatalogSearchUiState(value) {
  return isRecord(value)
    && (value.source === "remote" || value.source === "error")
    && Array.isArray(value.pets);
}

function isCodexPetsUiState(value) {
  return isRecord(value)
    && value.source === "codex"
    && Array.isArray(value.pets);
}

function isAgentSetupSnapshot(value) {
  return isRecord(value)
    && isRecord(value.status)
    && isRecord(value.hookStatus)
    && isRecord(value.memoryStatus)
    && isRecord(value.opencodeStatus)
    && isRecord(value.opencodePreview)
    && isRecord(value.commandPaths)
    && isRecord(value.preview)
    && Array.isArray(value.petOptions)
    && typeof value.busy === "boolean"
    && (value.commandMode === "published" || value.commandMode === "local" || value.commandMode === "bundled")
    && typeof value.localDevAvailable === "boolean"
    && typeof value.preview.displayCommand === "string"
    && isRecord(value.preview.mcpJson)
    && isRecord(value.hookStatus.preview)
    && typeof value.status.label === "string"
    && typeof value.status.details === "string"
    && typeof value.hookStatus.status === "string"
    && typeof value.hookStatus.message === "string"
    && typeof value.hookStatus.settingsPath === "string"
    && typeof value.memoryStatus.status === "string"
    && typeof value.memoryStatus.message === "string"
    && typeof value.memoryStatus.claudeMdPath === "string"
    && typeof value.memoryStatus.openPetsMemoryPath === "string"
    && typeof value.commandPaths.claude === "string"
    && typeof value.commandPaths.node === "string"
    && typeof value.commandPaths.opencode === "string";
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
