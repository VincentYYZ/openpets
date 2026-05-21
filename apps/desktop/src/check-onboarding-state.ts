import assert from "node:assert/strict";

import { defaultPetScale, defaultPetWalkSpeed, markOnboardingCompleted, maxPetWalkSpeed, minPetWalkSpeed, normalizeOnboardingCompleted, normalizePetScale, normalizePetWalkSpeed, petScaleOptions, petWalkSpeedStep } from "./app-state-core.js";

assert.equal(normalizeOnboardingCompleted({}), false);
assert.equal(normalizeOnboardingCompleted({ onboardingCompleted: true }), true);
assert.equal(normalizeOnboardingCompleted({ onboardingCompleted: false }), false);
assert.equal(normalizeOnboardingCompleted({ onboardingCompleted: "true" }), false);

const state = {
  version: 1,
  preferences: {
    defaultPetId: "built-in",
    openDefaultPetOnLaunch: true,
    speechBubblesEnabled: true,
    petScale: 1,
    petWalkSpeed: 1,
    onboardingCompleted: false,
  },
  pets: {
    installed: [{ id: "built-in", displayName: "Built-in Pet" }],
  },
};

const completed = markOnboardingCompleted(state);
assert.equal(completed.preferences.onboardingCompleted, true);
assert.equal(completed.preferences.defaultPetId, "built-in");
assert.equal(completed.preferences.openDefaultPetOnLaunch, true);
assert.equal(completed.preferences.speechBubblesEnabled, true);
assert.equal(completed.preferences.petScale, 1);
assert.equal(completed.preferences.petWalkSpeed, 1);
assert.deepEqual(completed.pets, state.pets);
assert.equal(state.preferences.onboardingCompleted, false);

const preferencePatch = {
  ...completed.preferences,
  speechBubblesEnabled: true,
};
assert.equal(normalizeOnboardingCompleted(preferencePatch), true);
assert.equal(preferencePatch.defaultPetId, "built-in");
assert.equal(preferencePatch.openDefaultPetOnLaunch, true);
assert.equal(preferencePatch.speechBubblesEnabled, true);

assert.equal(defaultPetScale, 0.56);
assert.deepEqual(petScaleOptions.map((option) => option.value), [0.32, 0.44, 0.56, 0.72]);
assert.equal(normalizePetScale(0.32), 0.32);
assert.equal(normalizePetScale(0.44), 0.44);
assert.equal(normalizePetScale(0.56), 0.56);
assert.equal(normalizePetScale(0.72), 0.72);
assert.equal(normalizePetScale(1), defaultPetScale);
assert.equal(normalizePetScale("0.56"), defaultPetScale);
assert.equal(normalizePetScale(Number.NaN), defaultPetScale);
assert.equal(normalizePetScale(Number.POSITIVE_INFINITY), defaultPetScale);
assert.equal(normalizePetScale(undefined), defaultPetScale);
assert.equal(defaultPetWalkSpeed, 1);
assert.equal(minPetWalkSpeed, 0.2);
assert.equal(maxPetWalkSpeed, 2);
assert.equal(petWalkSpeedStep, 0.1);
assert.equal(normalizePetWalkSpeed(0.2), 0.2);
assert.equal(normalizePetWalkSpeed(0.24), 0.2);
assert.equal(normalizePetWalkSpeed(0.5), 0.5);
assert.equal(normalizePetWalkSpeed(1), 1);
assert.equal(normalizePetWalkSpeed(2), 2);
assert.equal(normalizePetWalkSpeed(0.54), 0.5);
assert.equal(normalizePetWalkSpeed(1.26), 1.3);
assert.equal(normalizePetWalkSpeed(0.1), 0.2);
assert.equal(normalizePetWalkSpeed(3), 2);
assert.equal(normalizePetWalkSpeed("1"), defaultPetWalkSpeed);
assert.equal(normalizePetWalkSpeed(Number.NaN), defaultPetWalkSpeed);

console.error("Onboarding state validation passed.");
