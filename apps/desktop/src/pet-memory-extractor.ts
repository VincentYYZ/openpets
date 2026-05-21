import type { PetHelpTurn } from "./pet-help-service.js";

export type PetMemoryKind = "user_profile" | "user_preference" | "project_fact" | "pet_persona" | "workflow" | "constraint";

export interface ExtractedPetMemoryFact {
  readonly kind: PetMemoryKind;
  readonly text: string;
  readonly confidence: number;
}

const maxFactTextLength = 240;
const maxSummaryLength = 700;
const sensitivePattern = /api[_-]?key|secret|password|passwd|token|private key|ssh-rsa|-----BEGIN/i;

export function summarizePetHelpConversation(turns: readonly PetHelpTurn[]): string {
  const userTurns = turns.filter((turn) => turn.role === "user").map((turn) => turn.content.trim()).filter(Boolean);
  const assistantTurns = turns.filter((turn) => turn.role === "assistant").map((turn) => turn.content.trim()).filter(Boolean);
  const latestUser = userTurns.at(-1) ?? "";
  const latestAssistant = assistantTurns.at(-1) ?? "";
  const parts = [
    latestUser ? `用户问题：${clipText(latestUser, 260)}` : "",
    latestAssistant ? `宠物回答要点：${clipText(latestAssistant, 360)}` : "",
  ].filter(Boolean);
  return clipText(parts.join("\n"), maxSummaryLength);
}

export function extractPetMemoryFacts(turns: readonly PetHelpTurn[]): readonly ExtractedPetMemoryFact[] {
  const facts: ExtractedPetMemoryFact[] = [];
  const seen = new Set<string>();

  for (const turn of turns) {
    if (turn.role !== "user") continue;
    if (sensitivePattern.test(turn.content)) continue;
    for (const sentence of splitCandidateSentences(turn.content)) {
      const fact = extractSentenceFact(sentence);
      if (!fact) continue;
      const key = normalizeFactKey(fact.kind, fact.text);
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
      if (facts.length >= 12) return facts;
    }
  }

  return facts;
}

function extractSentenceFact(sentence: string): ExtractedPetMemoryFact | null {
  const text = sanitizeFactText(sentence);
  if (!text || sensitivePattern.test(text)) return null;

  const userName = extractUserName(text);
  if (userName) {
    return { kind: "user_profile", text: `用户的名字是 ${userName}。`, confidence: 0.96 };
  }

  if (/宠物|性格|语气|说话|口吻|陪伴|助手/.test(text) && /(希望|喜欢|不要|需要|偏好|以后|下次|记住|像)/.test(text)) {
    return { kind: "pet_persona", text: normalizeFactSentence(text), confidence: 0.82 };
  }

  if (/(不要|不能|禁止|避免|隐私|本地|不要上传|不要联网|必须|需要保证|兼容)/.test(text)) {
    return { kind: "constraint", text: normalizeFactSentence(text), confidence: 0.86 };
  }

  if (/(项目|OpenPets|Electron|Windows|macOS|Mac|跨平台|打包|安装包|设置界面|本地记忆)/i.test(text)) {
    return { kind: "project_fact", text: normalizeFactSentence(text), confidence: 0.78 };
  }

  if (/(我希望|我想|我建议|我需要|我喜欢|我不喜欢|偏好|以后|下次|记住)/.test(text)) {
    return { kind: "user_preference", text: normalizeFactSentence(text), confidence: 0.8 };
  }

  if (/(落地|实现|方案|步骤|流程|工作流|检查|验证|测试)/.test(text) && /(希望|需要|建议|要求|应该)/.test(text)) {
    return { kind: "workflow", text: normalizeFactSentence(text), confidence: 0.72 };
  }

  return null;
}

function extractUserName(text: string): string | null {
  const patterns = [
    /(?:我的名字叫|我的名字是|我名字叫|我名字是|我叫|我是)\s*([A-Za-z0-9_\-\u4e00-\u9fff·]{1,32})/u,
    /(?:你可以叫我|以后叫我|请叫我)\s*([A-Za-z0-9_\-\u4e00-\u9fff·]{1,32})/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const name = match?.[1]?.trim();
    if (!name || isInvalidNameCandidate(name)) continue;
    return name;
  }
  return null;
}

function isInvalidNameCandidate(value: string): boolean {
  return /^(谁|什么|啥|吗|呢|一个|这个|那个|用户|名字|什么名字)$/u.test(value);
}

function splitCandidateSentences(value: string): readonly string[] {
  return value
    .replace(/\s+/g, " ")
    .split(/[。！？!?；;，,\n]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && part.length <= 500);
}

function sanitizeFactText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeFactSentence(value: string): string {
  const clipped = clipText(value, maxFactTextLength).replace(/[。.!?！？]+$/u, "");
  if (/^用户/.test(clipped)) return `${clipped}。`;
  return `用户${clipped.startsWith("希望") || clipped.startsWith("需要") || clipped.startsWith("喜欢") || clipped.startsWith("不喜欢") ? "" : "提到："}${clipped}。`;
}

function normalizeFactKey(kind: PetMemoryKind, text: string): string {
  return `${kind}:${text.toLowerCase().replace(/\s+/g, "")}`;
}

function clipText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}
