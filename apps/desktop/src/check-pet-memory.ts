import assert from "node:assert/strict";

import { extractPetMemoryFacts, summarizePetHelpConversation } from "./pet-memory-extractor.js";

const turns = [
  { role: "user" as const, content: "我希望宠物以后用中文回答，语气直接一点。" },
  { role: "assistant" as const, content: "好的，我会记住这个偏好。" },
  { role: "user" as const, content: "我的名字叫小明。" },
  { role: "assistant" as const, content: "好的，小明。" },
  { role: "user" as const, content: "这个项目是 OpenPets，需要同时兼容 Windows 和 macOS。" },
  { role: "assistant" as const, content: "明白，后续改动会考虑跨平台兼容。" },
];

const summary = summarizePetHelpConversation(turns);
assert.match(summary, /OpenPets/);
assert.match(summary, /Windows/);

const facts = extractPetMemoryFacts(turns);
assert.ok(facts.some((fact) => fact.kind === "user_profile" && fact.text.includes("小明")));
assert.ok(facts.some((fact) => (fact.kind === "user_preference" || fact.kind === "pet_persona") && fact.text.includes("中文")));
assert.ok(facts.some((fact) => fact.kind === "project_fact" && fact.text.includes("OpenPets")));
assert.ok(facts.some((fact) => fact.kind === "constraint" && fact.text.includes("兼容")));
assert.ok(facts.every((fact) => fact.text.length <= 241));

const sensitiveFacts = extractPetMemoryFacts([{ role: "user", content: "我的 API token 是 abcdefghijklmnopqrstuvwxyz123456，希望你记住。" }]);
assert.equal(sensitiveFacts.length, 0);

const questionFacts = extractPetMemoryFacts([{ role: "user", content: "我的名字叫什么？" }]);
assert.equal(questionFacts.length, 0);

console.error("Pet memory validation passed.");
