import { getPetMemorySnapshot, markPetMemoryFactsUsed } from "./pet-memory-store.js";

export interface PetMemoryContext {
  readonly text: string;
  readonly factIds: readonly string[];
}

const maxContextFacts = 12;
const maxContextChars = 1600;

export function buildPetMemoryContext(): PetMemoryContext {
  const snapshot = getPetMemorySnapshot();
  if (!snapshot.enabled || snapshot.facts.length === 0) {
    return { text: "", factIds: [] };
  }

  const selectedFacts = [...snapshot.facts]
    .filter((fact) => fact.confidence >= 0.6)
    .sort((a, b) => rankKind(a.kind) - rankKind(b.kind) || b.confidence - a.confidence || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, maxContextFacts);

  const sections = [
    createSection("用户资料", selectedFacts.filter((fact) => fact.kind === "user_profile")),
    createSection("用户偏好", selectedFacts.filter((fact) => fact.kind === "user_preference")),
    createSection("项目知识", selectedFacts.filter((fact) => fact.kind === "project_fact")),
    createSection("宠物性格", selectedFacts.filter((fact) => fact.kind === "pet_persona")),
    createSection("工作方式", selectedFacts.filter((fact) => fact.kind === "workflow")),
    createSection("约束", selectedFacts.filter((fact) => fact.kind === "constraint")),
  ].filter(Boolean);

  const text = clipContext([
    "以下是 OpenPets 保存在本地的长期记忆。请只把它作为背景理解，不要主动逐字复述；如果用户纠正这些记忆，以用户当前说法为准。",
    ...sections,
  ].join("\n\n"));

  const factIds = selectedFacts.map((fact) => fact.id);
  if (factIds.length > 0) {
    markPetMemoryFactsUsedLater(factIds);
  }

  return { text, factIds };
}

function markPetMemoryFactsUsedLater(factIds: readonly string[]): void {
  const timer = setTimeout(() => {
    try {
      markPetMemoryFactsUsed(factIds);
    } catch {
      // Memory usage timestamps are best-effort and must not slow down answers.
    }
  }, 0);
  timer.unref?.();
}

function createSection(title: string, facts: readonly { readonly text: string }[]): string {
  if (facts.length === 0) return "";
  return `${title}：\n${facts.map((fact) => `- ${fact.text}`).join("\n")}`;
}

function rankKind(kind: string): number {
  if (kind === "constraint") return 0;
  if (kind === "user_profile") return 1;
  if (kind === "user_preference") return 2;
  if (kind === "pet_persona") return 3;
  if (kind === "project_fact") return 4;
  return 5;
}

function clipContext(value: string): string {
  return value.length > maxContextChars ? `${value.slice(0, maxContextChars - 1)}…` : value;
}
