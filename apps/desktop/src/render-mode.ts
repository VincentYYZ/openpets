export type WindowsRenderMode = "low-power" | "balanced" | "full";

export const windowsRenderModeOptions: readonly WindowsRenderMode[] = ["low-power", "balanced", "full"];

export function normalizeWindowsRenderMode(value: unknown): WindowsRenderMode {
  return value === "low-power" || value === "balanced" || value === "full" ? value : getDefaultWindowsRenderMode();
}

export function getDefaultWindowsRenderMode(): WindowsRenderMode {
  return process.platform === "win32" ? "low-power" : "full";
}

export function getWindowsRenderMode(preference?: unknown): WindowsRenderMode {
  if (process.platform !== "win32") return "full";
  const value = process.env.OPENPETS_WINDOWS_RENDER_MODE;
  if (value === "low-power" || value === "balanced" || value === "full") return value;
  if (process.env.OPENPETS_ENABLE_WINDOWS_AUTO_WALK === "1" || process.env.OPENPETS_ENABLE_WINDOWS_PET_ANIMATION === "1") return "full";
  return normalizeWindowsRenderMode(preference);
}

export function isWindowsLowPowerRenderMode(preference?: unknown): boolean {
  return process.platform === "win32" && getWindowsRenderMode(preference) === "low-power";
}

export function isWindowsFullRenderMode(preference?: unknown): boolean {
  return process.platform !== "win32" || getWindowsRenderMode(preference) === "full";
}
