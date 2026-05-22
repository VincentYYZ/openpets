import { getDefaultWindowsRenderMode, normalizeWindowsRenderMode, type WindowsRenderMode } from "./render-mode.js";

export interface OnboardingPreferenceLike {
  readonly onboardingCompleted?: unknown;
}

export const petScaleOptions = [
  { label: "Tiny", value: 0.32 },
  { label: "Small", value: 0.44 },
  { label: "Medium", value: 0.56 },
  { label: "Large", value: 0.72 },
] as const;
export type PetScaleValue = typeof petScaleOptions[number]["value"];
export const defaultPetScale: PetScaleValue = 0.56;
export const minPetWalkSpeed = 0.2;
export const maxPetWalkSpeed = 2;
export const petWalkSpeedStep = 0.1;
export const defaultPetWalkSpeed = 1;
export const defaultWindowsRenderMode: WindowsRenderMode = getDefaultWindowsRenderMode();

export function normalizePetScale(value: unknown): PetScaleValue {
  return petScaleOptions.find((option) => option.value === value)?.value ?? defaultPetScale;
}

export function normalizePetWalkSpeed(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultPetWalkSpeed;
  const rounded = Math.round(value / petWalkSpeedStep) * petWalkSpeedStep;
  const clamped = Math.min(Math.max(rounded, minPetWalkSpeed), maxPetWalkSpeed);
  return Number(clamped.toFixed(1));
}

export { normalizeWindowsRenderMode, type WindowsRenderMode };

export function normalizeOnboardingCompleted(value: OnboardingPreferenceLike): boolean {
  return typeof value.onboardingCompleted === "boolean" ? value.onboardingCompleted : false;
}

export function markOnboardingCompleted<T extends { readonly preferences: Record<string, unknown> }>(state: T): T {
  return {
    ...state,
    preferences: {
      ...state.preferences,
      onboardingCompleted: true,
    },
  };
}
