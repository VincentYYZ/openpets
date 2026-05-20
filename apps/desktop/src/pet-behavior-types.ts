export type PetBehaviorMode = "idle" | "walk-left" | "walk-right" | "dragged" | "drop-preview" | "hovered";

export interface PetBehaviorState {
  readonly mode: PetBehaviorMode;
  readonly direction: -1 | 1;
  readonly autoWalkSuspendedUntil: number;
  readonly folderDropPromptVisible: boolean;
}

export type PetBehaviorCommand =
  | { readonly type: "show-folder-drop-prompt" }
  | { readonly type: "clear-folder-drop-prompt" }
  | { readonly type: "move-window-x"; readonly x: number };

export type PetBehaviorEvent =
  | {
      readonly type: "tick";
      readonly now: number;
      readonly positionX: number;
      readonly minX: number;
      readonly maxX: number;
      readonly speedPx: number;
    }
  | {
      readonly type: "drag-start";
      readonly now: number;
    }
  | {
      readonly type: "drag-end";
      readonly now: number;
      readonly resumeAfterMs: number;
    }
  | {
      readonly type: "folder-drag-enter";
    }
  | {
      readonly type: "pointer-enter";
    }
  | {
      readonly type: "pointer-leave";
    }
  | {
      readonly type: "folder-drag-leave";
    }
  | {
      readonly type: "folder-drop";
    };

export interface PetBehaviorTransition {
  readonly state: PetBehaviorState;
  readonly commands: readonly PetBehaviorCommand[];
}

export function createInitialPetBehaviorState(direction: -1 | 1): PetBehaviorState {
  return {
    mode: "idle",
    direction,
    autoWalkSuspendedUntil: 0,
    folderDropPromptVisible: false,
  };
}
