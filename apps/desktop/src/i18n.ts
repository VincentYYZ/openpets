export type AppLanguage = "en" | "zh-CN";

interface TaskWindowDefinition {
  readonly title: string;
  readonly heading: string;
  readonly description: string;
}

interface TrayCopy {
  readonly toolTip: string;
  readonly continueSetup: string;
  readonly defaultPet: (petName: string) => string;
  readonly showDefaultPet: string;
  readonly hideDefaultPet: string;
  readonly pauseAllPets: string;
  readonly resumeAllPets: string;
  readonly managePets: string;
  readonly integrations: string;
  readonly settings: string;
  readonly openLogsFolder: string;
  readonly quitOpenPets: string;
  readonly updateAvailable: (version: string) => string;
  readonly builtInPetName: string;
}

const taskWindowDefinitionsByLanguage: Record<AppLanguage, Record<"pet-manager" | "agent-setup" | "settings" | "onboarding", TaskWindowDefinition>> = {
  en: {
    "pet-manager": {
      title: "OpenPets — Pet Manager",
      heading: "Manage Pets",
      description: "Install pets from the validated catalog, switch your active companion, and manage local pets.",
    },
    "agent-setup": {
      title: "OpenPets — Integrations",
      heading: "Integrations",
      description: "Connect OpenPets to coding tools with explicit confirmation.",
    },
    settings: {
      title: "OpenPets — Settings",
      heading: "Settings",
      description: "Tune how OpenPets starts and resets your desktop companion.",
    },
    onboarding: {
      title: "OpenPets — Welcome",
      heading: "Welcome to OpenPets",
      description: "Set up your pets and coding-agent integrations, or skip anything and come back later from the tray.",
    },
  },
  "zh-CN": {
    "pet-manager": {
      title: "OpenPets — 宠物管理",
      heading: "管理宠物",
      description: "从已验证的目录安装宠物，切换当前伙伴，并管理本地宠物。",
    },
    "agent-setup": {
      title: "OpenPets — 集成",
      heading: "集成",
      description: "将 OpenPets 与编码工具连接，并在变更前进行明确确认。",
    },
    settings: {
      title: "OpenPets — 设置",
      heading: "设置",
      description: "调整 OpenPets 的启动方式和桌面伙伴行为。",
    },
    onboarding: {
      title: "OpenPets — 欢迎",
      heading: "欢迎使用 OpenPets",
      description: "设置你的宠物和编码代理集成，也可以先跳过，稍后从托盘继续。",
    },
  },
};

const trayCopyByLanguage: Record<AppLanguage, TrayCopy> = {
  en: {
    toolTip: "OpenPets",
    continueSetup: "Continue Setup...",
    defaultPet: (petName) => `Default Pet: ${petName}`,
    showDefaultPet: "Show Default Pet",
    hideDefaultPet: "Hide Default Pet",
    pauseAllPets: "Pause All Pets",
    resumeAllPets: "Resume All Pets",
    managePets: "Manage Pets...",
    integrations: "Integrations...",
    settings: "Settings...",
    openLogsFolder: "Open Logs Folder...",
    quitOpenPets: "Quit OpenPets",
    updateAvailable: (version) => `Update available: ${version}...`,
    builtInPetName: "Built-in Pet",
  },
  "zh-CN": {
    toolTip: "OpenPets",
    continueSetup: "继续设置...",
    defaultPet: (petName) => `默认宠物：${petName}`,
    showDefaultPet: "显示默认宠物",
    hideDefaultPet: "隐藏默认宠物",
    pauseAllPets: "暂停全部宠物",
    resumeAllPets: "恢复全部宠物",
    managePets: "管理宠物...",
    integrations: "集成设置...",
    settings: "设置...",
    openLogsFolder: "打开日志文件夹...",
    quitOpenPets: "退出 OpenPets",
    updateAvailable: (version) => `发现更新：${version}...`,
    builtInPetName: "内置宠物",
  },
};

export function normalizeAppLanguage(value: unknown): AppLanguage {
  return value === "zh-CN" ? "zh-CN" : "en";
}

export function getHtmlLanguage(language: AppLanguage): string {
  return language;
}

export function getTaskWindowDefinitions(language: AppLanguage): Record<"pet-manager" | "agent-setup" | "settings" | "onboarding", TaskWindowDefinition> {
  return taskWindowDefinitionsByLanguage[language];
}

export function getTrayCopy(language: AppLanguage): TrayCopy {
  return trayCopyByLanguage[language];
}
