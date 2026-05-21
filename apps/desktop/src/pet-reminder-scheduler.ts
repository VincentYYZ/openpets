import { debug, info, error as logError } from "./logger.js";
import { getPetReminders, markPetReminderFired, type PetReminder } from "./pet-reminder-store.js";

export type ReminderFireHandler = (reminder: PetReminder) => void;

const maxTimerDelayMs = 24 * 60 * 60 * 1000;
const immediateBacklogDelayMs = 750;

let scheduledTimers = new Map<string, NodeJS.Timeout>();
let fireHandler: ReminderFireHandler | null = null;
let schedulerStarted = false;

export function startPetReminderScheduler(handler: ReminderFireHandler): void {
  fireHandler = handler;
  schedulerStarted = true;
  rescheduleAllPetReminders();
}

export function rescheduleAllPetReminders(): void {
  if (!schedulerStarted) return;
  clearAllScheduledTimers();
  const now = Date.now();
  for (const reminder of getPetReminders()) {
    if (reminder.fired) continue;
    scheduleReminder(reminder, now);
  }
  debug("pet.reminder", "scheduler rescheduled", { pending: scheduledTimers.size });
}

function scheduleReminder(reminder: PetReminder, now: number): void {
  const delay = Math.max(0, reminder.fireAt - now);
  if (delay === 0) {
    const timer = setTimeout(() => fireReminderById(reminder.id), immediateBacklogDelayMs);
    scheduledTimers.set(reminder.id, timer);
    return;
  }

  if (delay <= maxTimerDelayMs) {
    const timer = setTimeout(() => fireReminderById(reminder.id), delay);
    scheduledTimers.set(reminder.id, timer);
    return;
  }

  const timer = setTimeout(() => {
    scheduledTimers.delete(reminder.id);
    const current = getPetReminders().find((entry) => entry.id === reminder.id);
    if (!current || current.fired) return;
    scheduleReminder(current, Date.now());
  }, maxTimerDelayMs);
  scheduledTimers.set(reminder.id, timer);
}

function fireReminderById(id: string): void {
  scheduledTimers.delete(id);
  const fired = markPetReminderFired(id);
  if (!fired) return;
  info("pet.reminder", "reminder fired", { id: fired.id, fireAt: fired.fireAt });
  try {
    fireHandler?.(fired);
  } catch (error: unknown) {
    logError("pet.reminder", "reminder fire handler failed", error instanceof Error ? error : { error });
  }
}

function clearAllScheduledTimers(): void {
  for (const timer of scheduledTimers.values()) clearTimeout(timer);
  scheduledTimers = new Map();
}
