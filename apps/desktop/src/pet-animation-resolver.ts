import type { OpenPetsReaction } from "./local-ipc-protocol.js";
import { resolveReactionSpriteState, type PetMotionState, type ReactionAnimationOverrides, type UniversalSpriteState } from "./reaction-animation-mapping.js";
import type { PetBehaviorMode } from "./pet-behavior-types.js";

export type PetAnimationPriority = "motion" | "reaction";

export interface PetAnimationResolverInput {
  readonly paused: boolean;
  readonly behaviorMode: PetBehaviorMode;
  readonly displayReaction?: OpenPetsReaction;
  readonly statusBadge?: Exclude<OpenPetsReaction, "idle"> | null;
  readonly reactionAnimationOverrides?: ReactionAnimationOverrides;
}

export interface ResolvedPetAnimationState {
  readonly animationPriority: PetAnimationPriority;
  readonly motionState: PetMotionState;
  readonly reactionState: UniversalSpriteState;
}

export function resolvePetAnimationState(input: PetAnimationResolverInput): ResolvedPetAnimationState {
  const dominantReaction = getDominantReaction(input);
  const animationPriority = shouldUseReactionPriority(input, dominantReaction) ? "reaction" : "motion";
  return {
    animationPriority,
    motionState: animationPriority === "motion" ? getMotionStateForBehaviorMode(input.behaviorMode) : "idle",
    reactionState: resolveReactionSpriteState(dominantReaction, input.reactionAnimationOverrides),
  };
}

function getDominantReaction(input: PetAnimationResolverInput): OpenPetsReaction | undefined {
  if (input.displayReaction && input.displayReaction !== "idle") {
    return input.displayReaction;
  }

  return undefined;
}

function shouldUseReactionPriority(input: PetAnimationResolverInput, dominantReaction: OpenPetsReaction | undefined): boolean {
  if (input.paused) {
    return true;
  }

  if (dominantReaction) {
    return true;
  }

  return input.behaviorMode !== "walk-left" && input.behaviorMode !== "walk-right";
}

function getMotionStateForBehaviorMode(mode: PetBehaviorMode): PetMotionState {
  if (mode === "walk-left") {
    return "run-left";
  }

  if (mode === "walk-right") {
    return "run-right";
  }

  return "idle";
}
