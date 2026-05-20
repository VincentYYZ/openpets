import type { OpenPetsReaction } from "./local-ipc-protocol.js";

 export type ReactionMessageOverrides = Partial<Record<OpenPetsReaction, readonly string[]>>;

 export const maxReactionMessageLength = 36;
 export const maxReactionMessagesPerReaction = 24;

export const reactionMessagePools = {
  idle: [
    "Ready",
    "Standing by",
    "Available",
    "On standby",
    "Ready when needed",
    "Keeping watch",
    "All quiet",
    "At rest",
    "Calm and ready",
    "Here if needed",
    "Quiet mode",
    "Watching the queue",
  ],
  thinking: [
    "Reviewing",
    "Checking context",
    "Planning",
    "Considering options",
    "Looking closer",
    "Tracing this",
    "Sorting it out",
    "Reading context",
    "Weighing paths",
    "Scanning details",
    "Building a plan",
    "Following clues",
  ],
  working: [
    "In progress",
    "Handling task",
    "Making progress",
    "Processing",
    "Working through it",
    "Continuing work",
    "On the task",
    "Moving along",
    "Making headway",
    "Steady progress",
    "Task in hand",
    "Keeping momentum",
  ],
  editing: [
    "Updating files",
    "Applying changes",
    "Adjusting code",
    "Refining changes",
    "Cleaning up",
    "Changing files",
    "Updating the diff",
    "Polishing changes",
    "Tweaking details",
    "Shaping the patch",
    "Reworking code",
    "Tidying files",
  ],
  running: [
    "Starting task",
    "Process started",
    "Task underway",
    "In motion",
    "Command underway",
    "Shell is busy",
    "Process active",
    "Awaiting output",
    "Job in progress",
    "Tool is active",
    "Command launched",
    "Watching results",
  ],
  testing: [
    "Running checks",
    "Verifying",
    "Checking results",
    "Looking for failures",
    "Confirming behavior",
    "Checking regressions",
    "Validating fix",
    "Checking output",
    "Reviewing output",
    "Scanning failures",
    "Confirming checks",
    "Probing behavior",
  ],
  waiting: [
    "Approval needed",
    "Paused for review",
    "Need a decision",
    "Ready for approval",
    "Paused",
    "Your call",
    "Input needed",
    "Decision point",
    "Review requested",
    "Holding here",
    "Need direction",
    "Standing aside",
  ],
  waving: [
    "Hello",
    "Checking in",
    "Attention needed",
    "Quick update",
    "Notice",
    "Over here",
    "Ping",
    "Heads up",
    "Small nudge",
    "Status note",
    "New signal",
    "Just a ping",
  ],
  success: [
    "Done",
    "All set",
    "Finished",
    "Complete",
    "Checks passed",
    "Ready",
    "Good to go",
    "Wrapped up",
    "Checks are clean",
    "Task complete",
    "Green light",
    "Result landed",
  ],
  error: [
    "Failed",
    "Needs attention",
    "Issue found",
    "Check failed",
    "Problem detected",
    "Not complete",
    "Review needed",
    "Something broke",
    "Needs a look",
    "Blocked by issue",
    "Red flag raised",
    "Retry needed",
  ],
  celebrating: [
    "Nice work",
    "Win confirmed",
    "Great result",
    "Success moment",
    "That worked",
    "Finished well",
    "Victory",
    "Happy dance",
    "Big finish",
    "Win landed",
    "Result shines",
    "Moment earned",
  ],
} as const satisfies Record<OpenPetsReaction, readonly string[]>;

export function normalizeReactionMessageOverrides(value: unknown): ReactionMessageOverrides | undefined {
  if (!isRecord(value)) return undefined;
  const overrides: Partial<Record<OpenPetsReaction, readonly string[]>> = {};
  for (const [reaction, messages] of Object.entries(value)) {
    if (!isAllowedReaction(reaction)) continue;
    const normalized = normalizeReactionMessages(messages);
    if (normalized && normalized.length > 0) overrides[reaction] = normalized;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function validateReactionMessageOverrides(value: unknown): ReactionMessageOverrides | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid reaction message overrides.");
  for (const [reaction, messages] of Object.entries(value)) {
    if (!isAllowedReaction(reaction)) throw new Error("Invalid reaction message reaction.");
    validateReactionMessages(messages);
  }
  return normalizeReactionMessageOverrides(value);
}

export function pickReactionMessage(reaction: OpenPetsReaction, random?: () => number): string;
export function pickReactionMessage(reaction: OpenPetsReaction, overrides?: ReactionMessageOverrides, random?: () => number): string;
export function pickReactionMessage(reaction: OpenPetsReaction, overridesOrRandom?: ReactionMessageOverrides | (() => number), random: () => number = Math.random): string {
  const overrides = typeof overridesOrRandom === "function" ? undefined : overridesOrRandom;
  const picker = typeof overridesOrRandom === "function" ? overridesOrRandom : random;
  const pool = getReactionMessagePool(reaction, overrides);
  if (pool.length === 0) return reaction;
  const value = picker();
  const index = Math.floor(value * pool.length) % pool.length;
  if (!Number.isFinite(index)) return pool[0] ?? reaction;
  const normalizedIndex = index < 0 ? (index + pool.length) % pool.length : index;
  return pool[normalizedIndex] ?? reaction;
}

function getReactionMessagePool(reaction: OpenPetsReaction, overrides: ReactionMessageOverrides | undefined): readonly string[] {
  const custom = overrides?.[reaction];
  return custom && custom.length > 0 ? custom : reactionMessagePools[reaction];
}

function validateReactionMessages(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) throw new Error("Invalid reaction message list.");
  return normalizeReactionMessages(value);
}

function normalizeReactionMessages(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error("Invalid reaction message entry.");
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxReactionMessageLength || /[\r\n]/.test(trimmed)) throw new Error("Invalid reaction message entry.");
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= maxReactionMessagesPerReaction) break;
  }
  return normalized.length > 0 ? normalized : undefined;
}

function isAllowedReaction(value: string): value is OpenPetsReaction {
  return Object.hasOwn(reactionMessagePools, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
