import { createInitialPetBehaviorState, type PetBehaviorCommand, type PetBehaviorEvent, type PetBehaviorMode, type PetBehaviorState, type PetBehaviorTransition } from "./pet-behavior-types.js";

export { createInitialPetBehaviorState } from "./pet-behavior-types.js";
export type { PetBehaviorCommand, PetBehaviorEvent, PetBehaviorMode, PetBehaviorState, PetBehaviorTransition } from "./pet-behavior-types.js";

export function reducePetBehavior(state: PetBehaviorState, event: PetBehaviorEvent): PetBehaviorTransition {
  switch (event.type) {
    case "tick": {
      if (state.mode === "dragged" || state.mode === "hovered" || state.folderDropPromptVisible || event.now < state.autoWalkSuspendedUntil) {
        return { state, commands: [] };
      }

      const nextX = Math.min(Math.max(event.positionX + state.direction * event.speedPx, event.minX), event.maxX);
      const nextDirection = nextX <= event.minX ? 1 : nextX >= event.maxX ? -1 : state.direction;
      const nextState = {
        ...state,
        direction: nextDirection,
        mode: getModeForDirection(nextDirection),
      } satisfies PetBehaviorState;
      const commands: PetBehaviorCommand[] = nextX === event.positionX ? [] : [{ type: "move-window-x", x: nextX }];
      return { state: nextState, commands };
    }
    case "drag-start":
      return {
        state: {
          ...state,
          mode: "dragged",
        },
        commands: [],
      };
    case "drag-end":
      return {
        state: {
          ...state,
          mode: "idle",
          autoWalkSuspendedUntil: event.now + event.resumeAfterMs,
        },
        commands: [],
      };
    case "pointer-enter":
      if (state.mode === "dragged" || state.folderDropPromptVisible) {
        return { state, commands: [] };
      }
      return {
        state: {
          ...state,
          mode: "hovered",
        },
        commands: [],
      };
    case "pointer-leave":
      if (state.mode === "dragged" || state.folderDropPromptVisible) {
        return { state, commands: [] };
      }
      return {
        state: {
          ...state,
          mode: "idle",
        },
        commands: [],
      };
    case "folder-drag-enter":
      if (state.folderDropPromptVisible) {
        return { state, commands: [] };
      }
      return {
        state: {
          ...state,
          mode: "drop-preview",
          folderDropPromptVisible: true,
        },
        commands: [{ type: "show-folder-drop-prompt" }],
      };
    case "folder-drag-leave":
    case "folder-drop":
      if (!state.folderDropPromptVisible) {
        return {
          state: {
            ...state,
            mode: "idle",
          },
          commands: [],
        };
      }
      return {
        state: {
          ...state,
          mode: "idle",
          folderDropPromptVisible: false,
        },
        commands: [{ type: "clear-folder-drop-prompt" }],
      };
    default:
      return { state, commands: [] };
  }
}

function getModeForDirection(direction: -1 | 1): PetBehaviorMode {
  return direction > 0 ? "walk-right" : "walk-left";
}
