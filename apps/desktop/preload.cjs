const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getState: () => ipcRenderer.invoke("openpets:get-state"),
  getReactionAnimationSettings: () => ipcRenderer.invoke("openpets:get-reaction-animation-settings"),
  getCatalog: () => ipcRenderer.invoke("openpets:get-catalog"),
  getCatalogPage: (page) => ipcRenderer.invoke("openpets:get-catalog-page", page),
  getCatalogSearch: () => ipcRenderer.invoke("openpets:get-catalog-search"),
  getCodexPets: () => ipcRenderer.invoke("openpets:get-codex-pets"),
  updatePreferences: (patch) => ipcRenderer.invoke("openpets:update-preferences", patch),
  updatePetReactionMessages: (petId, overrides, ambientSpeechSettings) => ipcRenderer.invoke("openpets:update-pet-reaction-messages", petId, overrides, ambientSpeechSettings),
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
let reactionAnimationRenderSequence = 0;
let reactionAnimationSaveChain = Promise.resolve();
const remoteCatalogFilters = new Set(["original", "western", "asian"]);
const editablePetReactions = ["idle", "thinking", "working", "editing", "running", "testing", "waiting", "waving", "success", "error", "celebrating"];
const zhCnExactText = Object.freeze({
  "App state is unavailable.": "应用状态不可用。",
  "Onboarding state is unavailable.": "引导状态不可用。",
  "Install a Pet": "安装宠物",
  "Pick a companion for your terminal.": "为你的终端挑选一个伙伴。",
  "Loading…": "加载中…",
  "Search pets…": "搜索宠物…",
  "Pet filters": "宠物筛选",
  "All": "全部",
  "Installed": "已安装",
  "Originals": "官方原创",
  "Western": "西方",
  "Asian": "亚洲",
  "Pets": "宠物",
  "Unavailable": "不可用",
  "Catalog unavailable": "目录不可用",
  "Load more pets": "加载更多宠物",
  "Broken": "已损坏",
  "Default": "默认",
  "Protected": "受保护",
  "Remove": "移除",
  "Import": "导入",
  "Install": "安装",
  "Preview": "预览",
  "Thinking": "思考",
  "Happy": "开心",
  "Wave": "挥手",
  "Set default": "设为默认",
  "A friendly coding companion.": "一个友好的编码伙伴。",
  "A local Codex companion.": "一个本地 Codex 伙伴。",
  "No installed pets match your search.": "没有已安装宠物匹配你的搜索。",
  "No Codex pets match your search.": "没有 Codex 宠物匹配你的搜索。",
  "No originals match your search.": "没有原创宠物匹配你的搜索。",
  "No Western pets match your search.": "没有西方风格宠物匹配你的搜索。",
  "No Asian pets match your search.": "没有亚洲风格宠物匹配你的搜索。",
  "No pets match your search.": "没有宠物匹配你的搜索。",
  "This installed pet is broken and cannot be selected as default.": "这个已安装宠物已损坏，不能设为默认。",
  "Default built-in pet. Protected from removal.": "当前是默认内置宠物，受保护不可移除。",
  "Default pet.": "当前默认宠物。",
  "Imported from your local Codex pets and ready to become your default pet.": "已从本地 Codex 宠物导入，可设为默认宠物。",
  "Installed and ready to become your default pet. Also found in ~/.codex/pets.": "已安装，可设为默认宠物。同时在 ~/.codex/pets 中找到该宠物。",
  "Installed and ready to become your default pet.": "已安装，可设为默认宠物。",
  "Available to import from ~/.codex/pets.": "可从 ~/.codex/pets 导入。",
  "Available in the catalog and also found in ~/.codex/pets. Import uses the local Codex copy.": "目录中可用，并且也在 ~/.codex/pets 中找到。导入时会使用本地 Codex 副本。",
  "Available to install from the catalog.": "可从目录中安装。",
  "Pet speech presets": "宠物预设台词",
  "Set what this pet says in each state. Enter one phrase per line and one will be randomly picked when that reaction appears.": "设置这只宠物在不同状态下会说的话。每行填写一条，会在该状态出现时随机挑选一句。",
  "Ambient speech intervals": "自动说话间隔",
  "Adjust how often this pet talks while moving or while your mouse is hovering over it.": "调整这只宠物在移动时，以及鼠标悬停在它身上时的说话频率。",
  "Moving interval": "移动时间隔",
  "Hovered interval": "悬停时间隔",
  "Seconds between speech bubbles while the pet is walking.": "宠物走动时，两次说话气泡之间的秒数。",
  "Seconds between speech bubbles while the pet is hovered.": "鼠标悬停在宠物上时，两次说话气泡之间的秒数。",
  "One phrase per line. Up to 24 phrases per state, each within 36 characters.": "每行一条台词。每个状态最多 24 条，每条不超过 36 个字符。",
  "Enter a value from 1 to 60 seconds.": "请输入 1 到 60 秒之间的数值。",
  "Built-in defaults are used until you save custom phrases.": "在你保存自定义台词之前，会继续使用内置默认文案。",
  "Install or import this pet to customize what it says.": "请先安装或导入这只宠物，然后才能自定义它说的话。",
  "Save phrases": "保存台词",
  "Reset phrases": "重置台词",
  "Saving custom phrases…": "正在保存自定义台词…",
  "Custom phrases saved.": "自定义台词已保存。",
  "Custom phrases reset to defaults.": "自定义台词已恢复为默认。",
  "Couldn’t save custom phrases. Try again.": "无法保存自定义台词，请重试。",
  "Idle": "空闲",
  "Working": "工作中",
  "Editing": "编辑中",
  "Running": "执行中",
  "Testing": "测试中",
  "Waiting": "等待中",
  "Waving": "打招呼",
  "Success": "成功",
  "Error": "出错",
  "Celebrating": "庆祝中",
  "Setting…": "设置中…",
  "Importing…": "导入中…",
  "Installing…": "安装中…",
  "Removing…": "移除中…",
  "Language": "语言",
  "App language": "应用语言",
  "Display language": "显示语言",
  "Choose the language used by the desktop UI and tray menu.": "选择桌面界面和托盘菜单使用的语言。",
  "General": "常规",
  "Startup and companion behavior": "启动与伙伴行为",
  "Open default pet on app launch": "启动应用时打开默认宠物",
  "When disabled, the app starts in the tray and the default pet can still be shown manually.": "关闭后，应用将仅在托盘启动，你仍可手动显示默认宠物。",
  "Launch at login": "登录时启动",
  "Start automatically when you sign in.": "登录系统时自动启动。",
  "Pet": "宠物",
  "Desktop pet controls": "桌面宠物控制",
  "Pet scale": "宠物大小",
  "Small": "小",
  "Medium": "中",
  "Large": "大",
  "Custom": "自定义",
  "Reset default pet position": "重置默认宠物位置",
  "Moves the default pet back near the bottom-right of the primary display.": "将默认宠物移回主显示器右下角附近。",
  "Reset": "重置",
  "Animations": "动画",
  "Reaction animations": "反应动画",
  "Reset defaults": "恢复默认",
  "Choose which animation your pet plays for each agent reaction. Preview uses your default pet without affecting the live desktop pet.": "为每种代理反应选择宠物播放的动画。预览使用你的默认宠物，不会影响正在桌面上运行的宠物。",
  "Updates": "更新",
  "App updates": "应用更新",
  "Checking for updates": "正在检查更新",
  "The app checks public GitHub releases and opens the release page when an update is available.": "应用会检查 GitHub 公开发布版本，并在有更新时打开发布页面。",
  "Check": "检查",
  "Open release": "打开发布页",
  "Changes save automatically.": "更改会自动保存。",
  "Launch preference saved.": "启动偏好已保存。",
  "Resetting pet position…": "正在重置宠物位置…",
  "Default pet position reset.": "默认宠物位置已重置。",
  "Couldn’t reset pet position. Try again.": "无法重置宠物位置，请重试。",
  "Reaction animation settings are unavailable.": "反应动画设置不可用。",
  "Saving reaction animations…": "正在保存反应动画…",
  "Changed": "已更改",
  "Reaction animations reset to defaults.": "反应动画已恢复默认。",
  "Couldn’t reset reaction animations. Try again.": "无法重置反应动画，请重试。",
  "Checking for updates…": "正在检查更新…",
  "Couldn’t check for updates. Try again.": "无法检查更新，请重试。",
  "App is up to date": "已是最新版本",
  "Looking for the latest public GitHub release…": "正在查找最新的 GitHub 公开版本…",
  "Update check unavailable": "无法检查更新",
  "Couldn’t read the latest public GitHub release.": "无法读取最新的 GitHub 公开版本。",
  "Check for updates": "检查更新",
  "Update check finished.": "更新检查已完成。",
  "Checking login setting…": "正在检查登录启动设置…",
  "Launch at login is not available on this platform.": "当前平台不支持登录启动。",
  "Couldn’t read login setting.": "无法读取登录启动设置。",
  "Enabling launch at login…": "正在启用登录启动…",
  "Disabling launch at login…": "正在关闭登录启动…",
  "Launch at login preference saved.": "登录启动偏好已保存。",
  "Couldn’t update launch at login. Try again.": "无法更新登录启动设置，请重试。",
  "Saving scale…": "正在保存大小…",
  "Saving language…": "正在保存语言…",
  "Language preference saved.": "语言偏好已保存。",
  "Couldn’t save language. Try again.": "无法保存语言，请重试。",
  "Couldn’t save pet scale. Try again.": "无法保存宠物大小，请重试。",
  "Saving…": "保存中…",
  "Refreshing…": "刷新中…",
  "Replacing…": "替换中…",
  "Updating…": "更新中…",
  "Checking…": "检查中…",
  "Couldn’t save setting. Try again.": "无法保存设置，请重试。",
  "Welcome": "欢迎",
  "Integrations": "集成",
  "Ready": "完成",
  "Your AI coding companion": "你的 AI 编码伙伴",
  "Next ›": "下一步 ›",
  "Step 2": "第 2 步",
  "Pick your desktop companion": "选择你的桌面伙伴",
  "Open Pet Manager to browse pets, then return here to continue.": "打开宠物管理浏览宠物，然后回到这里继续。",
  "You can also continue now. The app still works with the bundled pet.": "你也可以现在继续。使用内置宠物也能正常工作。",
  "Open Pet Manager": "打开宠物管理",
  "Continue to next step": "继续下一步",
  "Step 3": "第 3 步",
  "Connect your coding tools": "连接你的编码工具",
  "Open Integrations to connect Claude Code or OpenCode when you are ready. The app shows previews and asks before changing MCP, hook, or OpenCode settings.": "准备好后打开“集成”来连接 Claude Code 或 OpenCode。应用会显示预览，并在修改 MCP、Hook 或 OpenCode 设置前征求确认。",
  "Open Integrations to review agent setup, then return here to continue.": "打开“集成”查看代理设置，然后回到这里继续。",
  "You can also continue now. Configuration is optional and can be done later from the tray.": "你也可以现在继续。配置是可选的，稍后可从托盘完成。",
  "Open Integrations": "打开集成",
  "Setup is ready": "准备就绪",
  "You can manage pets, open integrations, change settings, or quit from the tray at any time.": "你可以随时从托盘管理宠物、打开集成、更改设置或退出。",
  "Nothing else is required. Get started now, or reopen the setup windows below.": "无需其他步骤。现在就开始使用，或重新打开下方设置窗口。",
  "Get started": "开始使用",
  "Closing this window before finishing keeps setup available from the tray.": "如果在完成前关闭此窗口，仍可从托盘继续设置。",
  "Finishing…": "完成中…",
  "Continue": "继续",
  "Pet Manager": "宠物管理",
  "Opening Pet Manager…": "正在打开宠物管理…",
  "Pet Manager opened — return here to continue.": "宠物管理已打开，回到这里继续。",
  "Couldn’t open Pet Manager. Try again from the button.": "无法打开宠物管理，请再试一次。",
  "Opening Integrations…": "正在打开集成…",
  "Integrations opened — return here to continue.": "集成页面已打开，回到这里继续。",
  "Couldn’t open Integrations. Try again from the button.": "无法打开集成页面，请再试一次。",
  "Install Claude or OpenCode integrations now, explore Pi manual setup, or configure the details when you need them.": "现在安装 Claude 或 OpenCode 集成、查看 Pi 的手动设置，或在需要时再配置详细内容。",
  "Available integrations": "可用集成",
  "Connect Claude Code to your OpenPets companion.": "将 Claude Code 连接到你的 OpenPets 伙伴。",
  "Connect OpenCode globally to your OpenPets companion.": "全局连接 OpenCode 到你的 OpenPets 伙伴。",
  "Connect Pi coding-agent activity through the OpenPets Pi extension package.": "通过 OpenPets Pi 扩展包连接 Pi 编码代理活动。",
  "View setup": "查看设置",
  "VS Code": "VS Code",
  "Coming soon.": "即将支持。",
  "Soon": "即将支持",
  "Back to integrations": "返回集成列表",
  "Integration": "集成",
  "Connect Claude to your OpenPets companion. Basic setup is one card; hooks and command details are optional.": "将 Claude 连接到你的 OpenPets 伙伴。基础设置只需一个卡片；Hooks 和命令细节是可选的。",
  "Connection": "连接",
  "Checking setup…": "正在检查设置…",
  "Checking Claude Code…": "正在检查 Claude Code…",
  "Pet routing": "宠物路由",
  "Configuration": "配置",
  "Command paths": "命令路径",
  "If Claude or Node.js is not detected from the app, paste the full executable path. Leave blank for automatic PATH detection.": "如果应用未检测到 Claude 或 Node.js，请粘贴完整可执行文件路径。留空则自动从 PATH 检测。",
  "Claude command": "Claude 命令",
  "Save path": "保存路径",
  "Node.js command": "Node.js 命令",
  "Use local dev commands": "使用本地开发命令",
  "Developer-only: use this checkout instead of published packages.": "仅开发者使用：使用当前源码，而不是已发布包。",
  "Install integration": "安装集成",
  "Replace configuration": "替换配置",
  "Remove integration": "移除集成",
  "Refresh status": "刷新状态",
  "Nothing changes until you choose an action.": "在你选择操作前，不会有任何改动。",
  "Advanced MCP details": "高级 MCP 详情",
  "Command and JSON preview": "命令与 JSON 预览",
  "Inspect the MCP command OpenPets will add to Claude, or copy it for manual setup.": "查看 OpenPets 将添加到 Claude 的 MCP 命令，或复制用于手动设置。",
  "Copy command": "复制命令",
  "MCP JSON": "MCP JSON",
  "Included": "已包含",
  "Claude instructions": "Claude 指令",
  "Checking Claude instructions…": "正在检查 Claude 指令…",
  "Update instructions": "更新指令",
  "Optional": "可选",
  "Claude hooks": "Claude Hooks",
  "Checking hooks…": "正在检查 Hooks…",
  "Hooks let Claude events trigger pet reactions. They modify your global Claude Code settings.": "Hooks 允许 Claude 事件触发宠物反应。它们会修改你的全局 Claude Code 设置。",
  "Install hooks": "安装 Hooks",
  "Check hooks": "检查 Hooks",
  "Remove hooks": "移除 Hooks",
  "Advanced hook details": "高级 Hook 详情",
  "Hooks JSON preview": "Hooks JSON 预览",
  "Preview the OpenPets-managed Claude hook settings before installing or updating hooks.": "在安装或更新 Hooks 前，预览由 OpenPets 管理的 Claude Hook 设置。",
  "Claude Code may need to be restarted after MCP changes.": "MCP 变更后，Claude Code 可能需要重启。",
  "Connect OpenCode to OpenPets. Desktop setup writes global OpenCode config; use the CLI for project-local setup.": "将 OpenCode 连接到 OpenPets。桌面设置会写入全局 OpenCode 配置；项目级设置请使用 CLI。",
  "Global connection": "全局连接",
  "Checking OpenCode…": "正在检查 OpenCode…",
  "If OpenCode or Node.js is not detected from the app, paste the full executable path. Leave blank for automatic PATH detection.": "如果应用未检测到 OpenCode 或 Node.js，请粘贴完整可执行文件路径。留空则自动从 PATH 检测。",
  "OpenCode command": "OpenCode 命令",
  "Install global setup": "安装全局设置",
  "Refresh": "刷新",
  "Global OpenCode config": "全局 OpenCode 配置",
  "Copy config preview": "复制配置预览",
  "OpenCode may need to be restarted after global setup changes.": "全局设置变更后，OpenCode 可能需要重启。",
  "Manual integration": "手动集成",
  "Status": "状态",
  "Manual package setup": "手动包设置",
  "Planned": "计划中",
  "Commands": "命令",
  "Pi package setup": "Pi 包设置",
  "Copy global install": "复制全局安装命令",
  "Copy project install": "复制项目安装命令",
  "Pi setup is manual until real Pi CLI install validation is complete.": "在真正的 Pi CLI 安装校验完成前，Pi 设置仍为手动。",
  "Checking Cursor MCP config…": "正在检查 Cursor MCP 配置…",
  "OpenPets-only MCP config": "仅 OpenPets 的 MCP 配置",
  "Copy preview": "复制预览",
  "Optional project rules": "可选项目规则",
  "Cursor rules preview": "Cursor 规则预览",
  "Copy rules preview": "复制规则预览",
  "Cursor may need to be restarted or reloaded after MCP config changes.": "MCP 配置变更后，Cursor 可能需要重启或重新加载。",
  "Claude setup status is unavailable.": "Claude 设置状态不可用。",
  "Launch-at-login status is unavailable.": "登录启动状态不可用。",
  "Launch-at-login update failed.": "更新登录启动设置失败。",
  "Couldn’t save reaction animation. Try again.": "无法保存反应动画，请重试。",
  "Saved command path. Refreshed detection using the saved path.": "命令路径已保存，并已使用保存的路径重新检测。",
  "Cleared command path. Refreshed automatic detection.": "命令路径已清除，并已重新执行自动检测。",
  "Copied command.": "已复制命令。",
  "Copied OpenCode config preview.": "已复制 OpenCode 配置预览。",
  "Copied Cursor MCP preview.": "已复制 Cursor MCP 预览。",
  "Copied Cursor rules preview.": "已复制 Cursor 规则预览。",
  "OpenPets action failed.": "OpenPets 操作失败。"
});

function getCurrentDocumentLanguage() {
  return document.body?.dataset.openpetsLanguage === "zh-CN" ? "zh-CN" : "en";
}

function translateUiText(value, language = getCurrentDocumentLanguage()) {
  if (language !== "zh-CN" || typeof value !== "string" || value.length === 0) {
    return value;
  }

  const exact = zhCnExactText[value];
  if (exact) {
    return exact;
  }

  let match = value.match(/^(\d+) pets$/u);
  if (match) return `${match[1]} 只宠物`;
  match = value.match(/^Preview (.+)$/u);
  if (match) return `预览 ${match[1]}`;
  match = value.match(/^Update available: (.+)$/u);
  if (match) return `发现更新：${match[1]}`;
  match = value.match(/^Update (.+) is available\.$/u);
  if (match) return `可更新到 ${match[1]}。`;
  match = value.match(/^Installed: (.+)\. Open the GitHub release page to download the update\.$/u);
  if (match) return `当前已安装：${match[1]}。打开 GitHub 发布页下载更新。`;
  match = value.match(/^Installed: (.+)\. Latest public release: (.+)\.$/u);
  if (match) return `当前已安装：${match[1]}。最新公开版本：${match[2]}。`;
  match = value.match(/^(.+) animation saved\.$/u);
  if (match) return `${translateUiText(match[1], language)} 动画已保存。`;
  match = value.match(/^(Small|Medium|Large|Custom) \(([^)]+)\)$/u);
  if (match) return `${translateUiText(match[1], language)}（${match[2]}）`;
  match = value.match(/^(Small|Medium|Large|Custom) pet scale saved\.$/u);
  if (match) return `${translateUiText(match[1], language)}尺寸已保存。`;
  return value;
}

function localizeDocument(language = getCurrentDocumentLanguage()) {
  if (!document.body) {
    return;
  }

  document.body.dataset.openpetsLanguage = language;
  document.documentElement.lang = language === "zh-CN" ? "zh-CN" : "en";
  if (language !== "zh-CN") {
    return;
  }

  localizeTextNodes(document.body, language);
  localizeAttributes(document.body, "placeholder", language);
  localizeAttributes(document.body, "aria-label", language);
  document.title = translateUiText(document.title, language);
}

function localizeTextNodes(root, language) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }
      if (["SCRIPT", "STYLE", "PRE", "CODE"].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current);
    current = walker.nextNode();
  }

  for (const node of nodes) {
    const original = node.nodeValue;
    const leading = original.match(/^\s*/u)?.[0] || "";
    const trailing = original.match(/\s*$/u)?.[0] || "";
    const translated = translateUiText(original.trim(), language);
    if (translated !== original.trim()) {
      node.nodeValue = `${leading}${translated}${trailing}`;
    }
  }
}

function localizeAttributes(root, attributeName, language) {
  for (const element of root.querySelectorAll(`[${attributeName}]`)) {
    const value = element.getAttribute(attributeName);
    if (!value) {
      continue;
    }
    const translated = translateUiText(value, language);
    if (translated !== value) {
      element.setAttribute(attributeName, translated);
    }
  }
}

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
    renderError("App state is unavailable.");
    return;
  }

  if (view === "pet-manager") {
    await renderPetManager(state);
  } else if (view === "settings") {
    renderSettings(state);
  } else {
    await renderAgentSetup();
  }

  localizeDocument(state.preferences.language);
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
    localizeDocument();
    void onboardingApi.complete().catch((error) => {
      button.disabled = false;
      button.textContent = "Start using OpenPets";
      localizeDocument();
      renderCaughtError(error);
    });
  };
  showStep(currentStep);
  localizeDocument();
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
  localizeDocument();
}

function updateOnboardingOpenStatus(kind, text, state) {
  const id = kind === "pets" ? "onboarding-pets-status" : "onboarding-agents-status";
  const element = document.getElementById(id);
  if (!element) return;
  element.textContent = text;
  element.className = `onboarding-status-line${state ? ` ${state}` : ""}`;
  localizeDocument();
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
  updateCursorIntegration(snapshot, selected);
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
  localizeDocument();
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
  bindAgentSetupButton("opencode-node-command-path-save", () => saveAgentCommandPath("node", opencodeNodeCommandPath instanceof HTMLInputElement ? opencodeNodeCommandPath.value : "", select instanceof HTMLSelectElement ? select.value : selected, getCommandMode(), "opencode-action-result"), snapshot.busy, "Saving…");
  bindAgentSetupButton("opencode-copy-config", async () => copyText(requireElement("opencode-json-preview").textContent || "", "opencode-action-result", "Copied OpenCode config preview."), false);
  if (select instanceof HTMLSelectElement) select.onchange = () => { void renderAgentSetup(select.value, getCommandMode()); };
}

function updateCursorIntegration(snapshot, selected) {
  const cursor = snapshot.cursorStatus;
  const preview = snapshot.cursorPreview;
  if (!cursor || !preview) return;
  const cardStatus = document.getElementById("integration-cursor-status");
  if (cardStatus) {
    cardStatus.textContent = cursor.label;
    cardStatus.className = `agent-status-pill ${cardStatusClassFor(cursor.state)}`;
  }
  const installCard = document.getElementById("integration-cursor-install");
  if (installCard instanceof HTMLButtonElement) {
    delete installCard.dataset.loading;
    setIconButtonContent(installCard, cursor.state === "configured" ? "check" : "download", cursor.state === "configured" ? "Installed" : "Install");
    installCard.disabled = snapshot.busy || !cursor.canInstall || cursor.state === "configured";
  }
  const configureCard = document.getElementById("integration-cursor-configure");
  if (configureCard instanceof HTMLButtonElement) {
    delete configureCard.dataset.loading;
    setIconButtonContent(configureCard, "settings", "Configure");
    configureCard.disabled = false;
  }
  const status = document.getElementById("cursor-status");
  if (status) { status.textContent = cursor.label; status.className = `agent-status-pill ${statusClassFor(cursor.state)}`; }
  const title = document.getElementById("cursor-status-title");
  if (title) title.textContent = cursor.state === "configured" ? "Cursor global setup installed" : "Global setup available";
  const details = document.getElementById("cursor-details");
  if (details) details.textContent = cursor.details;
  updateCursorCommandPathHelp(cursor);
  const select = document.getElementById("cursor-pet-select");
  if (select instanceof HTMLSelectElement) renderPetSelect(select, snapshot, selected);
  const cursorNodeCommandPath = document.getElementById("cursor-node-command-path");
  if (cursorNodeCommandPath instanceof HTMLInputElement) cursorNodeCommandPath.value = snapshot.commandPaths.node || "";
  const paths = document.getElementById("cursor-paths");
  if (paths) {
    paths.textContent = `Config file: ${cursor.configPath}`;
  }
  const json = document.getElementById("cursor-json-preview");
  if (json) json.textContent = JSON.stringify(preview.mcpEntry && preview.mcpEntry.openpets ? { mcpServers: preview.mcpEntry } : { mcpServers: {} }, null, 2);
  const rulesPath = document.getElementById("cursor-rules-path");
  if (rulesPath) rulesPath.textContent = `Project rules file: ${preview.rulesPath || ".cursor/rules/openpets.mdc"}. CLI: openpets configure --agent cursor --rules-only`;
  const rulesPreview = document.getElementById("cursor-rules-preview");
  if (rulesPreview) rulesPreview.textContent = preview.rulesContent || "";
  const result = document.getElementById("cursor-action-result");
  if (result) result.textContent = snapshot.lastAction && String(snapshot.lastAction.action).startsWith("cursor-") ? snapshot.lastAction.message : "Cursor may need to be restarted or reloaded after MCP config changes.";
  bindAgentSetupButton("cursor-install", () => runAgentAction("cursor-install", select instanceof HTMLSelectElement ? select.value : selected, getCommandMode()), snapshot.busy || !cursor.canInstall, "Installing…");
  bindAgentSetupButton("cursor-replace", () => runAgentAction("cursor-replace", select instanceof HTMLSelectElement ? select.value : selected, getCommandMode()), snapshot.busy || !cursor.canReplace, "Replacing…");
  bindAgentSetupButton("cursor-remove", () => runAgentAction("cursor-remove", select instanceof HTMLSelectElement ? select.value : selected, getCommandMode()), snapshot.busy || !cursor.canRemove, "Removing…");
  bindAgentSetupButton("cursor-refresh", () => renderAgentSetup(select instanceof HTMLSelectElement ? select.value : selected, getCommandMode()), snapshot.busy, "Refreshing…");
  bindAgentSetupButton("cursor-node-command-path-save", () => saveAgentCommandPath("node", cursorNodeCommandPath instanceof HTMLInputElement ? cursorNodeCommandPath.value : "", select instanceof HTMLSelectElement ? select.value : selected, getCommandMode(), "cursor-action-result"), snapshot.busy, "Saving…");
  bindAgentSetupButton("cursor-copy-preview", async () => copyText(requireElement("cursor-json-preview").textContent || "", "cursor-action-result", "Copied Cursor MCP preview."), false);
  bindAgentSetupButton("cursor-copy-rules", async () => copyText(requireElement("cursor-rules-preview").textContent || "", "cursor-action-result", "Copied Cursor rules preview."), false);
  if (select instanceof HTMLSelectElement) select.onchange = () => { void renderAgentSetup(select.value, getCommandMode()); };
}

function updateCursorCommandPathHelp(cursor) {
  const needsNode = /Node\.js is required|set the Node\.js command path/i.test(cursor.details || "");
  const paths = document.querySelector("#cursor-detail-view .agent-command-paths");
  const card = document.querySelector("#cursor-detail-view .connection-card");
  if (paths instanceof HTMLElement) paths.classList.toggle("needs-command-path", needsNode);
  if (card instanceof HTMLElement) card.classList.toggle("needs-command-path", needsNode);
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
  const piConfigure = document.getElementById("integration-pi-configure");
  const cursorInstall = document.getElementById("integration-cursor-install");
  const cursorConfigure = document.getElementById("integration-cursor-configure");
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
  if (piConfigure instanceof HTMLButtonElement) piConfigure.onclick = () => showPiDetailView();
  if (cursorInstall instanceof HTMLButtonElement) {
    cursorInstall.onclick = async () => {
      if (cursorInstall.disabled || snapshot.busy) return;
      cursorInstall.dataset.loading = "true";
      cursorInstall.disabled = true;
      if (cursorConfigure instanceof HTMLButtonElement) cursorConfigure.disabled = true;
      setIconButtonContent(cursorInstall, "spinner", "Installing…");
      try {
        await runAgentAction("cursor-install", select.value, getCommandMode());
      } catch (error) {
        delete cursorInstall.dataset.loading;
        cursorInstall.disabled = false;
        if (cursorConfigure instanceof HTMLButtonElement) cursorConfigure.disabled = false;
        setIconButtonContent(cursorInstall, "download", "Install");
        renderCaughtError(error);
      }
    };
  }
  if (cursorConfigure instanceof HTMLButtonElement) cursorConfigure.onclick = () => showCursorDetailView();
  const back = document.getElementById("integration-back");
  if (back instanceof HTMLButtonElement) back.onclick = () => showIntegrationsView("claude");
  const openCodeBack = document.getElementById("opencode-integration-back");
  if (openCodeBack instanceof HTMLButtonElement) openCodeBack.onclick = () => showIntegrationsView("opencode");
  const piBack = document.getElementById("pi-integration-back");
  if (piBack instanceof HTMLButtonElement) piBack.onclick = () => showIntegrationsView("pi");
  const cursorBack = document.getElementById("cursor-integration-back");
  if (cursorBack instanceof HTMLButtonElement) cursorBack.onclick = () => showIntegrationsView("cursor");
  bindAgentSetupButton("pi-copy-global-install", async () => copyText("pi install npm:@open-pets/pi", "pi-action-result", "Copied Pi global install command."), false);
  bindAgentSetupButton("pi-copy-project-install", async () => copyText("pi install -l npm:@open-pets/pi", "pi-action-result", "Copied Pi project install command."), false);
}

function showClaudeDetailView() {
  const grid = document.getElementById("integrations-view");
  const detail = document.getElementById("claude-detail-view");
  if (grid) grid.hidden = true;
  if (detail) detail.hidden = false;
  document.getElementById("claude-detail-title")?.focus();
}

function showIntegrationsView(focusCard = "claude") {
  const grid = document.getElementById("integrations-view");
  const detail = document.getElementById("claude-detail-view");
  const opencodeDetail = document.getElementById("opencode-detail-view");
  const piDetail = document.getElementById("pi-detail-view");
  const cursorDetail = document.getElementById("cursor-detail-view");
  if (detail) detail.hidden = true;
  if (opencodeDetail) opencodeDetail.hidden = true;
  if (piDetail) piDetail.hidden = true;
  if (cursorDetail) cursorDetail.hidden = true;
  if (grid) grid.hidden = false;
  document.querySelector(`[data-integration-card="${focusCard}"]`)?.focus();
}

function showOpenCodeDetailView() {
  const grid = document.getElementById("integrations-view");
  const detail = document.getElementById("opencode-detail-view");
  const claude = document.getElementById("claude-detail-view");
  const pi = document.getElementById("pi-detail-view");
  if (grid) grid.hidden = true;
  if (claude) claude.hidden = true;
  if (pi) pi.hidden = true;
  if (detail) detail.hidden = false;
  document.getElementById("opencode-detail-title")?.focus();
}

function showPiDetailView() {
  const grid = document.getElementById("integrations-view");
  const detail = document.getElementById("pi-detail-view");
  const claude = document.getElementById("claude-detail-view");
  const opencode = document.getElementById("opencode-detail-view");
  const cursor = document.getElementById("cursor-detail-view");
  if (grid) grid.hidden = true;
  if (claude) claude.hidden = true;
  if (opencode) opencode.hidden = true;
  if (cursor) cursor.hidden = true;
  if (detail) detail.hidden = false;
  document.getElementById("pi-detail-title")?.focus();
}

function showCursorDetailView() {
  const grid = document.getElementById("integrations-view");
  const detail = document.getElementById("cursor-detail-view");
  const claude = document.getElementById("claude-detail-view");
  const opencode = document.getElementById("opencode-detail-view");
  const pi = document.getElementById("pi-detail-view");
  if (grid) grid.hidden = true;
  if (claude) claude.hidden = true;
  if (opencode) opencode.hidden = true;
  if (pi) pi.hidden = true;
  if (detail) detail.hidden = false;
  document.getElementById("cursor-detail-title")?.focus();
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
  for (const id of ["claude-configure", "claude-refresh", "claude-command-path-save", "node-command-path-save", "claude-copy-command", "claude-replace", "claude-remove", "claude-memory-install", "claude-hooks-doctor", "claude-hooks-install", "claude-hooks-uninstall", "opencode-install", "opencode-remove", "opencode-refresh", "opencode-command-path-save", "opencode-node-command-path-save", "opencode-copy-config", "pi-copy-global-install", "pi-copy-project-install", "cursor-install", "cursor-replace", "cursor-remove", "cursor-refresh", "cursor-node-command-path-save", "cursor-copy-preview", "cursor-copy-rules"]) {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement) delete button.dataset.loading;
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
  setIconButtonContent(requireButton("cursor-install"), "download", "Install global setup");
  setIconButtonContent(requireButton("cursor-replace"), "repeat", "Replace configuration");
  setIconButtonContent(requireButton("cursor-remove"), "trash", "Remove global setup");
  setIconButtonContent(requireButton("cursor-refresh"), "refresh", "Refresh");
  setIconButtonContent(requireButton("cursor-node-command-path-save"), "check", "Save path");
  setIconButtonContent(requireButton("cursor-copy-preview"), "copy", "Copy preview");
  setIconButtonContent(requireButton("cursor-copy-rules"), "copy", "Copy rules preview");
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
    const result = document.getElementById(id.startsWith("opencode-") ? "opencode-action-result" : id.startsWith("cursor-") ? "cursor-action-result" : "claude-action-result");
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
    "cursor-install",
    "cursor-replace",
    "cursor-remove",
    "cursor-refresh",
    "cursor-node-command-path-save",
    "cursor-copy-preview",
    "cursor-copy-rules",
  ];
  if (busy) {
    agentSetupControlStates = new Map();
    for (const id of ids) {
      const button = document.getElementById(id);
      if (button instanceof HTMLButtonElement) agentSetupControlStates.set(id, button.disabled);
    }
    const select = document.getElementById("claude-pet-select");
    if (select instanceof HTMLSelectElement) agentSetupControlStates.set("claude-pet-select", select.disabled);
    const opencodeSelect = document.getElementById("opencode-pet-select");
    if (opencodeSelect instanceof HTMLSelectElement) agentSetupControlStates.set("opencode-pet-select", opencodeSelect.disabled);
    const cursorSelect = document.getElementById("cursor-pet-select");
    if (cursorSelect instanceof HTMLSelectElement) agentSetupControlStates.set("cursor-pet-select", cursorSelect.disabled);
    const devMode = document.getElementById("claude-dev-mode");
    if (devMode instanceof HTMLInputElement) agentSetupControlStates.set("claude-dev-mode", devMode.disabled);
  }
  for (const id of ids) {
    const button = document.getElementById(id);
    if (button instanceof HTMLButtonElement) button.disabled = busy;
  }
  const select = document.getElementById("claude-pet-select");
  if (select instanceof HTMLSelectElement) select.disabled = busy;
  const opencodeSelect = document.getElementById("opencode-pet-select");
  if (opencodeSelect instanceof HTMLSelectElement) opencodeSelect.disabled = busy;
  const cursorSelect = document.getElementById("cursor-pet-select");
  if (cursorSelect instanceof HTMLSelectElement) cursorSelect.disabled = busy;
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

async function saveAgentCommandPath(kind, path, selectedPetId, commandMode, resultId) {
  const patch = kind === "claude" ? { claude: path } : kind === "node" ? { node: path } : { opencode: path };
  await agentSetupApi.updateCommandPaths(patch);
  await renderAgentSetup(selectedPetId || "", commandMode);
  const result = document.getElementById(resultId || (kind === "opencode" ? "opencode-action-result" : "claude-action-result"));
  if (result) result.textContent = path.trim() ? "Saved command path. Refreshed detection using the saved path." : "Cleared command path. Refreshed automatic detection.";
  localizeDocument();
}

async function copyText(text, resultId = "claude-action-result", successMessage = "Copied command.") {
  try {
    await navigator.clipboard.writeText(text);
    requireElement(resultId).textContent = successMessage;
  } catch {
    requireElement(resultId).textContent = text;
  }
  localizeDocument();
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
    localizeDocument();
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

    localizeDocument();
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
  const codexSpritesheet = codexPet && isAllowedCodexPreview(codexPet.spritesheet) ? codexPet.spritesheet : "";
  const preview = codexPet?.preview || catalogThumbnail;
  const detailPreview = codexSpritesheet || codexPet?.preview || catalogSpritesheet || catalogThumbnail;
  const usesThumbnail = Boolean(installed?.builtIn && defaultThumbnailSrc);
  const cardUsesThumbnail = usesThumbnail || Boolean(preview && preview !== catalogSpritesheet);
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
    reactionMessageOverrides: installed?.reactionMessageOverrides || undefined,
    ambientSpeechSettings: installed?.ambientSpeechSettings || undefined,
    previewSrc: usesThumbnail ? defaultThumbnailSrc : preview,
    detailPreviewSrc: usesThumbnail ? defaultThumbnailSrc : detailPreview,
    previewIsSpriteSheet: !cardUsesThumbnail,
    detailPreviewIsSpriteSheet: !usesThumbnail && (detailPreview === catalogSpritesheet || detailPreview === codexSpritesheet),
    isDefault: id === defaultPetId,
    protected: Boolean(installed?.protected),
    broken: Boolean(installed?.broken),
    brokenReason: installed?.brokenReason || "",
  };
}

function createEmptyPetGalleryMessage(filterName) {
  if (filterName === "installed") return "No installed pets match your search.";
  if (filterName === "codex") return "No Codex pets match your search.";
  if (filterName === "original") return "No originals match your search.";
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

  container.append(createPetSpeechEditor(pet));

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

function createPetSpeechEditor(pet) {
  const card = document.createElement("section");
  card.className = "pm-script-card";

  const title = document.createElement("h3");
  title.className = "pm-script-title";
  title.textContent = "Pet speech presets";
  card.append(title);

  const description = document.createElement("p");
  description.className = "pm-script-description";
  description.textContent = pet.installed
    ? "Set what this pet says in each state. Enter one phrase per line and OpenPets will randomly pick one when that reaction appears."
    : "Install or import this pet to customize what it says.";
  card.append(description);

  if (!pet.installed) {
    return card;
  }

  const note = document.createElement("p");
  note.className = "pm-script-note";
  note.textContent = "One phrase per line. Up to 24 phrases per state, each within 36 characters.";
  card.append(note);

  const intervalSection = document.createElement("div");
  intervalSection.className = "pm-script-intervals";

  const intervalTitle = document.createElement("p");
  intervalTitle.className = "pm-script-note";
  intervalTitle.textContent = "Ambient speech intervals";
  intervalSection.append(intervalTitle);

  const intervalDescription = document.createElement("p");
  intervalDescription.className = "pm-script-note subdued";
  intervalDescription.textContent = "Adjust how often this pet talks while moving or while your mouse is hovering over it.";
  intervalSection.append(intervalDescription);

  const intervalGrid = document.createElement("div");
  intervalGrid.className = "pm-script-interval-grid";
  const ambientSpeechSettings = pet.ambientSpeechSettings || {};
  for (const config of [
    { key: "movingIntervalMs", label: "Moving interval", hint: "Seconds between speech bubbles while the pet is walking." },
    { key: "hoveredIntervalMs", label: "Hovered interval", hint: "Seconds between speech bubbles while the pet is hovered." },
  ]) {
    const field = document.createElement("label");
    field.className = "pm-script-interval-field";

    const label = document.createElement("span");
    label.textContent = config.label;
    field.append(label);

    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "60";
    input.step = "1";
    input.className = "pm-script-interval-input";
    input.dataset.intervalKey = config.key;
    input.placeholder = "Enter a value from 1 to 60 seconds.";
    input.value = typeof ambientSpeechSettings[config.key] === "number" ? String(Math.round(ambientSpeechSettings[config.key] / 1000)) : "";
    field.append(input);

    const hint = document.createElement("small");
    hint.className = "pm-script-interval-hint";
    hint.textContent = config.hint;
    field.append(hint);

    intervalGrid.append(field);
  }
  intervalSection.append(intervalGrid);
  card.append(intervalSection);

  const grid = document.createElement("div");
  grid.className = "pm-script-grid";
  const overrides = pet.reactionMessageOverrides || {};
  for (const reaction of editablePetReactions) {
    const field = document.createElement("label");
    field.className = "pm-script-field";
    field.setAttribute("for", `pm-script-${reaction}`);

    const label = document.createElement("span");
    label.textContent = formatReactionLabel(reaction);
    field.append(label);

    const textarea = document.createElement("textarea");
    textarea.id = `pm-script-${reaction}`;
    textarea.className = "pm-script-input";
    textarea.rows = 4;
    textarea.dataset.reaction = reaction;
    textarea.placeholder = formatReactionPlaceholder(reaction);
    textarea.value = Array.isArray(overrides[reaction]) ? overrides[reaction].join("\n") : "";
    field.append(textarea);

    grid.append(field);
  }
  card.append(grid);

  const defaultNote = document.createElement("p");
  defaultNote.className = "pm-script-note subdued";
  defaultNote.textContent = "Built-in defaults are used until you save custom phrases.";
  card.append(defaultNote);

  const actions = document.createElement("div");
  actions.className = "pm-script-actions";

  const save = document.createElement("button");
  save.id = "pm-script-save";
  save.type = "button";
  setIconButtonContent(save, "check", "Save phrases");
  save.addEventListener("click", () => {
    void savePetReactionMessages(pet.id);
  });
  actions.append(save);

  const reset = document.createElement("button");
  reset.id = "pm-script-reset";
  reset.type = "button";
  reset.className = "secondary";
  setIconButtonContent(reset, "repeat", "Reset phrases");
  reset.addEventListener("click", () => {
    for (const input of card.querySelectorAll(".pm-script-input")) {
      if (input instanceof HTMLTextAreaElement) input.value = "";
    }
    for (const input of card.querySelectorAll(".pm-script-interval-input")) {
      if (input instanceof HTMLInputElement) input.value = "";
    }
    void savePetReactionMessages(pet.id, true);
  });
  actions.append(reset);

  card.append(actions);

  const status = document.createElement("p");
  status.id = "pm-script-status";
  status.className = "pm-script-status";
  card.append(status);

  return card;
}

async function savePetReactionMessages(petId, resetting = false) {
  const saveButton = document.getElementById("pm-script-save");
  const resetButton = document.getElementById("pm-script-reset");
  const status = document.getElementById("pm-script-status");
  if (saveButton instanceof HTMLButtonElement) saveButton.disabled = true;
  if (resetButton instanceof HTMLButtonElement) resetButton.disabled = true;
  if (status) status.textContent = "Saving custom phrases…";
  localizeDocument();

  try {
    const overrides = resetting ? undefined : collectPetReactionMessageOverrides();
    const ambientSpeechSettings = resetting ? undefined : collectPetAmbientSpeechSettings();
    const state = await api.updatePetReactionMessages(petId, overrides, ambientSpeechSettings);
    activePetManagerSelection = petId;
    await renderPetManager(state);
    const nextStatus = document.getElementById("pm-script-status");
    if (nextStatus) nextStatus.textContent = resetting || !overrides ? "Custom phrases reset to defaults." : "Custom phrases saved.";
    localizeDocument(state.preferences.language);
  } catch (error) {
    if (saveButton instanceof HTMLButtonElement) saveButton.disabled = false;
    if (resetButton instanceof HTMLButtonElement) resetButton.disabled = false;
    if (status) status.textContent = "Couldn’t save custom phrases. Try again.";
    localizeDocument();
    renderCaughtError(error);
  }
}

function collectPetReactionMessageOverrides() {
  const overrides = {};
  for (const input of document.querySelectorAll(".pm-script-input[data-reaction]")) {
    if (!(input instanceof HTMLTextAreaElement)) continue;
    const reaction = input.dataset.reaction;
    if (!reaction) continue;
    const phrases = input.value
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
    if (phrases.length > 0) overrides[reaction] = phrases;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function collectPetAmbientSpeechSettings() {
  const settings = {};
  for (const input of document.querySelectorAll(".pm-script-interval-input[data-interval-key]")) {
    if (!(input instanceof HTMLInputElement)) continue;
    const key = input.dataset.intervalKey;
    if (!key) continue;
    const trimmed = input.value.trim();
    if (!trimmed) continue;
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) continue;
    settings[key] = Math.round(seconds * 1000);
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function formatReactionLabel(reaction) {
  if (reaction === "idle") return "Idle";
  if (reaction === "thinking") return "Thinking";
  if (reaction === "working") return "Working";
  if (reaction === "editing") return "Editing";
  if (reaction === "running") return "Running";
  if (reaction === "testing") return "Testing";
  if (reaction === "waiting") return "Waiting";
  if (reaction === "waving") return "Waving";
  if (reaction === "success") return "Success";
  if (reaction === "error") return "Error";
  if (reaction === "celebrating") return "Celebrating";
  return reaction;
}

function formatReactionPlaceholder(reaction) {
  return `${formatReactionLabel(reaction)} phrases, one per line`;
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

function isAllowedCodexPreview(value) {
  return typeof value === "string" && /^openpets-codex:\/\/spritesheet\/[a-z0-9][a-z0-9_-]{0,63}$/u.test(value);
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
  localizeDocument();
}

function renderSettings(state) {
  const languageSelect = requireSelect("app-language");
  const openOnLaunch = requireInput("open-default-pet-on-launch");
  const launchAtLogin = requireInput("launch-at-login");
  const launchAtLoginDetail = requireElement("launch-at-login-detail");
  const scaleSelect = requireSelect("pet-scale");
  const scale = requireElement("pet-scale-value");
  const status = requireElement("settings-status");

  languageSelect.value = state.preferences.language;
  openOnLaunch.checked = state.preferences.openDefaultPetOnLaunch;
  scaleSelect.value = String(state.preferences.petScale);
  languageSelect.disabled = false;
  openOnLaunch.disabled = false;
  scaleSelect.disabled = false;
  scale.textContent = `${scaleLabelFor(state.preferences.petScale)} (${state.preferences.petScale}x)`;

  bindLanguageSelect(languageSelect, state.preferences.language);
  bindCheckbox(openOnLaunch, "openDefaultPetOnLaunch", "Launch preference saved.");
  bindScaleSelect(scaleSelect, String(state.preferences.petScale));
  bindLaunchAtLogin(launchAtLogin, launchAtLoginDetail);
  bindUpdateControls();
  void renderReactionAnimationSettings().catch(renderCaughtError);

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
      localizeDocument(state.preferences.language);
      renderCaughtError(error);
    });
  };

  localizeDocument(state.preferences.language);
}

async function renderReactionAnimationSettings() {
  const sequence = ++reactionAnimationRenderSequence;
  const snapshot = await api.getReactionAnimationSettings();
  if (sequence !== reactionAnimationRenderSequence) return;
  if (!isReactionAnimationSettingsSnapshot(snapshot)) {
    throw new Error("Reaction animation settings are unavailable.");
  }

  const table = requireElement("reaction-animation-table");
  const resetButton = requireButton("reset-reaction-animations");
  const overrides = { ...snapshot.overrides };
  const animationById = new Map(snapshot.animations.map((animation) => [animation.id, animation]));
  table.textContent = "";

  const saveOverrides = async (nextOverrides, message) => {
    requireElement("settings-status").textContent = "Saving reaction animations…";
    setReactionAnimationControlsDisabled(true);
    await api.updatePreferences({ reactionAnimationOverrides: nextOverrides });
    await renderReactionAnimationSettings();
    requireElement("settings-status").textContent = message;
    localizeDocument();
  };

  for (const reaction of snapshot.reactions) {
    const selectedAnimation = resolvedAnimationFor(reaction, overrides);
    const row = document.createElement("div");
    row.className = "reaction-animation-row";
    row.setAttribute("role", "row");

    const name = document.createElement("div");
    name.className = "reaction-animation-name";
    const title = document.createElement("strong");
    title.textContent = reaction.label;
    const description = document.createElement("small");
    description.textContent = reaction.description;
    name.append(title, description);

    const select = document.createElement("select");
    select.className = "settings-select";
    select.setAttribute("aria-label", `${reaction.label} animation`);
    for (const animation of snapshot.animations) {
      const option = document.createElement("option");
      option.value = animation.id;
      option.textContent = animation.label;
      select.append(option);
    }
    select.value = selectedAnimation;
    select.onchange = () => {
      const nextValue = select.value;
      if (!animationById.has(nextValue)) return;
      updateReactionPreviewSprite(miniSprite, snapshot, nextValue, true);
      setReactionAnimationControlsDisabled(true);
      reactionAnimationSaveChain = reactionAnimationSaveChain.catch(() => {}).then(async () => {
        const latest = await api.getReactionAnimationSettings();
        if (!isReactionAnimationSettingsSnapshot(latest)) throw new Error("Reaction animation settings are unavailable.");
        const latestReaction = latest.reactions.find((candidate) => candidate.id === reaction.id) || reaction;
        const nextOverrides = { ...latest.overrides };
        if (nextValue === latestReaction.defaultAnimation) delete nextOverrides[reaction.id];
        else nextOverrides[reaction.id] = nextValue;
        await saveOverrides(nextOverrides, `${reaction.label} animation saved.`);
      });
      void reactionAnimationSaveChain.catch((error) => {
        select.disabled = false;
        select.value = selectedAnimation;
        updateReactionPreviewSprite(miniSprite, snapshot, selectedAnimation, true);
        setReactionAnimationControlsDisabled(false);
        requireElement("settings-status").textContent = "Couldn’t save reaction animation. Try again.";
        localizeDocument();
        renderCaughtError(error);
      });
    };

    const miniStage = document.createElement("div");
    miniStage.className = "reaction-row-mini-stage";
    miniStage.setAttribute("aria-hidden", "true");
    const miniFrame = document.createElement("div");
    miniFrame.className = "reaction-row-mini-frame";
    const miniSprite = document.createElement("div");
    miniSprite.className = "reaction-row-mini-sprite";
    miniFrame.append(miniSprite);
    miniStage.append(miniFrame);
    updateReactionPreviewSprite(miniSprite, snapshot, selectedAnimation, false);

    const actions = document.createElement("div");
    actions.className = "reaction-row-actions";
    const state = document.createElement("span");
    const changed = selectedAnimation !== reaction.defaultAnimation;
    state.className = `reaction-row-state${changed ? " changed" : ""}`;
    state.textContent = changed ? "Changed" : "Default";
    actions.append(state);

    row.append(name, select, miniStage, actions);
    table.append(row);
  }

  resetButton.disabled = Object.keys(overrides).length === 0;
  resetButton.onclick = () => {
    setReactionAnimationControlsDisabled(true);
    reactionAnimationSaveChain = reactionAnimationSaveChain.catch(() => {}).then(() => saveOverrides({}, "Reaction animations reset to defaults."));
    void reactionAnimationSaveChain.catch((error) => {
      resetButton.disabled = false;
      setReactionAnimationControlsDisabled(false);
      requireElement("settings-status").textContent = "Couldn’t reset reaction animations. Try again.";
      localizeDocument();
      renderCaughtError(error);
    });
  };

  localizeDocument();
}

function setReactionAnimationControlsDisabled(disabled) {
  const table = document.getElementById("reaction-animation-table");
  if (table) {
    for (const control of table.querySelectorAll("select, button")) {
      control.disabled = disabled;
    }
  }
  const resetButton = document.getElementById("reset-reaction-animations");
  if (resetButton instanceof HTMLButtonElement) resetButton.disabled = disabled || !document.querySelector(".reaction-row-state.changed");
}

function resolvedAnimationFor(reaction, overrides) {
  return overrides[reaction.id] || reaction.defaultAnimation;
}

function updateReactionPreviewSprite(sprite, snapshot, animationId, restart) {
  const row = snapshot.sprite.states[animationId] || snapshot.sprite.states.idle;
  sprite.style.backgroundImage = `url("${snapshot.previewSpriteUrl}")`;
  sprite.style.backgroundSize = `${snapshot.sprite.frameWidth * snapshot.sprite.columns}px ${snapshot.sprite.frameHeight * snapshot.sprite.rows}px`;
  sprite.style.setProperty("--preview-row-y", `-${row.row * snapshot.sprite.frameHeight}px`);
  sprite.style.setProperty("--preview-frames", String(row.frames));
  sprite.style.setProperty("--preview-duration", `${row.durationMs}ms`);
  sprite.style.setProperty("--preview-iterations", "infinite");
  if (restart) {
    sprite.style.animation = "none";
    void sprite.offsetWidth;
    sprite.style.animation = "";
  }
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
      localizeDocument();
    }).catch((error) => {
      checkButton.disabled = false;
      requireElement("settings-status").textContent = "Couldn’t check for updates. Try again.";
      localizeDocument();
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

  localizeDocument();
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
  localizeDocument();
  void api.getLaunchAtLogin().then((state) => {
    if (!isLaunchAtLoginState(state)) throw new Error("Launch-at-login status is unavailable.");
    input.checked = state.enabled;
    input.disabled = !state.supported;
    detail.textContent = state.supported ? "Start OpenPets automatically when you sign in." : "Launch at login is not available on this platform.";
    localizeDocument();
  }).catch((error) => {
    input.disabled = true;
    detail.textContent = "Couldn’t read login setting.";
    localizeDocument();
    renderCaughtError(error);
  });
  input.onchange = () => {
    const previous = !input.checked;
    input.disabled = true;
    const status = requireElement("settings-status");
    status.textContent = input.checked ? "Enabling launch at login…" : "Disabling launch at login…";
    localizeDocument();
    void api.setLaunchAtLogin(input.checked).then((state) => {
      if (!isLaunchAtLoginState(state)) throw new Error("Launch-at-login update failed.");
      input.checked = state.enabled;
      input.disabled = !state.supported;
      status.textContent = state.supported ? "Launch at login preference saved." : "Launch at login is not available on this platform.";
      localizeDocument();
    }).catch((error) => {
      input.checked = previous;
      input.disabled = false;
      status.textContent = "Couldn’t update launch at login. Try again.";
      localizeDocument();
      renderCaughtError(error);
    });
  };
}

function bindLanguageSelect(select, currentValue) {
  select.onchange = () => {
    const previous = currentValue;
    const value = select.value;
    select.disabled = true;
    const status = requireElement("settings-status");
    status.textContent = "Saving language…";
    localizeDocument();
    void api.updatePreferences({ language: value }).then(() => {
      requireElement("settings-status").textContent = "Language preference saved.";
      localizeDocument(value === "zh-CN" ? "zh-CN" : "en");
    }).catch((error) => {
      select.value = previous;
      select.disabled = false;
      status.textContent = "Couldn’t save language. Try again.";
      localizeDocument();
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
    localizeDocument();
    void api.updatePreferences({ petScale: value }).then(async () => {
      await renderCurrentState("settings");
      requireElement("settings-status").textContent = `${scaleLabelFor(value)} pet scale saved.`;
      localizeDocument();
    }).catch((error) => {
      select.value = previous;
      select.disabled = false;
      status.textContent = "Couldn’t save pet scale. Try again.";
      localizeDocument();
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
    localizeDocument();
    void api.updatePreferences({ [key]: input.checked }).then(async () => {
      await renderCurrentState("settings");
      requireElement("settings-status").textContent = message;
      localizeDocument();
    }).catch((error) => {
      input.checked = previous;
      input.disabled = false;
      status.textContent = "Couldn’t save setting. Try again.";
      localizeDocument();
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
    error.textContent = translateUiText(message);
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

  return (value.preferences.language === "en" || value.preferences.language === "zh-CN")
    && typeof value.preferences.defaultPetId === "string"
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

function isReactionAnimationSettingsSnapshot(value) {
  return isRecord(value)
    && Array.isArray(value.reactions)
    && Array.isArray(value.animations)
    && isRecord(value.sprite)
    && isRecord(value.sprite.states)
    && isRecord(value.overrides)
    && typeof value.previewSpriteUrl === "string"
    && typeof value.sprite.frameWidth === "number"
    && typeof value.sprite.frameHeight === "number"
    && typeof value.sprite.columns === "number"
    && typeof value.sprite.rows === "number";
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
    && isRecord(value.cursorStatus)
    && isRecord(value.cursorPreview)
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
    && typeof value.commandPaths.opencode === "string"
    && typeof value.cursorStatus.state === "string"
    && typeof value.cursorStatus.label === "string"
    && typeof value.cursorStatus.details === "string"
    && typeof value.cursorStatus.configPath === "string"
    && typeof value.cursorPreview.rulesPath === "string"
    && typeof value.cursorPreview.rulesContent === "string"
    && typeof value.cursorStatus.canInstall === "boolean"
    && typeof value.cursorStatus.canReplace === "boolean"
    && typeof value.cursorStatus.canRemove === "boolean";
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
