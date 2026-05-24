import { type PetHelpApiStyle, type PetHelpThirdPartyConfig } from "./app-state.js";
import { buildPetMemoryContext } from "./pet-memory-context.js";
import type { PetHelpAskRequest } from "./pet-help-service.js";

interface PetHelpThirdPartyOptions {
  readonly onChunk?: (chunk: string) => void;
  readonly signal?: AbortSignal;
}

const petHelpThirdPartyTimeoutMs = 120_000;
const anthropicVersion = "2023-06-01";

export async function askPetHelpWithThirdParty(request: PetHelpAskRequest, config: PetHelpThirdPartyConfig, options: PetHelpThirdPartyOptions = {}): Promise<{ readonly answer: string }> {
  if (!config.apiKey) {
    throw new Error("请先在设置页填写第三方模型的 API Key。");
  }

  if (options.signal?.aborted) {
    throw createAbortError();
  }

  return config.apiStyle === "anthropic"
    ? askPetHelpWithAnthropic(request, config, options)
    : askPetHelpWithOpenAi(request, config, options);
}

async function askPetHelpWithOpenAi(request: PetHelpAskRequest, config: PetHelpThirdPartyConfig, options: PetHelpThirdPartyOptions): Promise<{ readonly answer: string }> {
  const requestLifecycle = createRequestLifecycle(options.signal);
  try {
    const response = await fetch(joinUrl(config.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        messages: createOpenAiMessages(request),
      }),
      signal: requestLifecycle.signal,
    });

    if (!response.ok) {
      throw new Error(await summarizeErrorResponse(response));
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      const payload = await response.json().catch(() => null);
      const answer = extractOpenAiResponseText(payload);
      return { answer: answer || "第三方模型没有返回内容。" };
    }

    let answer = "";
    await consumeSse(response, (event) => {
      const delta = extractOpenAiStreamDelta(event.data);
      if (!delta) return;
      answer += delta;
      options.onChunk?.(delta);
    }, requestLifecycle);
    return { answer: answer.trim() || "第三方模型没有返回内容。" };
  } catch (error) {
    throw normalizeRequestError(error, requestLifecycle, options.signal);
  } finally {
    requestLifecycle.cleanup();
  }
}

async function askPetHelpWithAnthropic(request: PetHelpAskRequest, config: PetHelpThirdPartyConfig, options: PetHelpThirdPartyOptions): Promise<{ readonly answer: string }> {
  const requestLifecycle = createRequestLifecycle(options.signal);
  try {
    const response = await fetch(joinUrl(config.baseUrl, "/v1/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey || "",
        "anthropic-version": anthropicVersion,
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        max_tokens: 2048,
        system: createThirdPartySystemPrompt(),
        messages: createAnthropicMessages(request),
      }),
      signal: requestLifecycle.signal,
    });

    if (!response.ok) {
      throw new Error(await summarizeErrorResponse(response));
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      const payload = await response.json().catch(() => null);
      const answer = extractAnthropicResponseText(payload);
      return { answer: answer || "第三方模型没有返回内容。" };
    }

    let answer = "";
    await consumeSse(response, (event) => {
      const delta = extractAnthropicStreamDelta(event.data);
      if (!delta) return;
      answer += delta;
      options.onChunk?.(delta);
    }, requestLifecycle);
    return { answer: answer.trim() || "第三方模型没有返回内容。" };
  } catch (error) {
    throw normalizeRequestError(error, requestLifecycle, options.signal);
  } finally {
    requestLifecycle.cleanup();
  }
}

function createRequestLifecycle(signal?: AbortSignal): { readonly signal: AbortSignal; readonly timedOut: () => boolean; cleanup(): void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, petHelpThirdPartyTimeoutMs);
  const handleAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener("abort", handleAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
    },
  };
}

async function consumeSse(response: Response, onEvent: (event: { readonly name: string; readonly data: string }) => void, lifecycle: { readonly signal: AbortSignal }): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("第三方模型没有返回可读取的流。");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (lifecycle.signal.aborted) throw createAbortError();
    buffer += decoder.decode(result.value, { stream: true });
    buffer = flushSseBuffer(buffer, onEvent);
  }
  buffer += decoder.decode();
  flushSseBuffer(`${buffer}\n\n`, onEvent);
}

function normalizeRequestError(error: unknown, lifecycle: { readonly signal: AbortSignal; readonly timedOut: () => boolean }, originalSignal?: AbortSignal): Error {
  if (lifecycle.signal.aborted) {
    if (lifecycle.timedOut()) return new Error("第三方模型响应超时，请稍后再试。");
    if (originalSignal?.aborted) return createAbortError();
  }
  return error instanceof Error ? error : new Error(String(error || "第三方模型请求失败。"));
}

function flushSseBuffer(buffer: string, onEvent: (event: { readonly name: string; readonly data: string }) => void): string {
  let separatorIndex = findSseSeparator(buffer);
  while (separatorIndex >= 0) {
    const rawEvent = buffer.slice(0, separatorIndex);
    buffer = buffer.slice(separatorIndex + (buffer.slice(separatorIndex, separatorIndex + 4) === "\r\n\r\n" ? 4 : 2));
    emitSseEvent(rawEvent, onEvent);
    separatorIndex = findSseSeparator(buffer);
  }
  return buffer;
}

function findSseSeparator(value: string): number {
  const windowsIndex = value.indexOf("\r\n\r\n");
  const unixIndex = value.indexOf("\n\n");
  if (windowsIndex < 0) return unixIndex;
  if (unixIndex < 0) return windowsIndex;
  return Math.min(windowsIndex, unixIndex);
}

function emitSseEvent(rawEvent: string, onEvent: (event: { readonly name: string; readonly data: string }) => void): void {
  if (!rawEvent.trim()) return;
  let name = "message";
  const dataLines: string[] = [];
  for (const line of rawEvent.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      name = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return;
  onEvent({ name, data: dataLines.join("\n") });
}

function createThirdPartySystemPrompt(): string {
  const memoryContext = buildPetMemoryContext().text;
  return [
    "你是用户桌面宠物背后的 AI 助手。请用简洁、友好、可执行的中文回答。",
    "当前窗口是一个轻量聊天气泡，你只能用文字回答，不能直接打开终端、执行命令、读写文件或调用本机工具。",
    "如果问题与代码、终端、文件或项目有关，请优先给出具体步骤。",
    memoryContext ? `本地长期记忆：\n${memoryContext}` : "",
  ].filter(Boolean).join("\n\n");
}

function createOpenAiMessages(request: PetHelpAskRequest): readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[] {
  return [
    { role: "system", content: createThirdPartySystemPrompt() },
    ...request.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: request.message },
  ];
}

function createAnthropicMessages(request: PetHelpAskRequest): readonly { readonly role: "user" | "assistant"; readonly content: string }[] {
  return [
    ...request.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user", content: request.message },
  ];
}

function extractOpenAiStreamDelta(data: string): string {
  if (!data || data === "[DONE]") return "";
  const payload = parseJson(data);
  if (!payload || typeof payload !== "object") return "";
  const choices = Array.isArray((payload as { choices?: unknown }).choices) ? (payload as { choices: unknown[] }).choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  return extractOpenAiDeltaContent((first as { delta?: unknown }).delta);
}

function extractOpenAiResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = Array.isArray((payload as { choices?: unknown }).choices) ? (payload as { choices: unknown[] }).choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const record = part as { type?: unknown; text?: unknown };
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("");
  return "";
}

function extractOpenAiDeltaContent(delta: unknown): string {
  if (!delta || typeof delta !== "object") return "";
  const content = (delta as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const record = part as { type?: unknown; text?: unknown };
    return typeof record.text === "string" ? [record.text] : [];
  }).join("");
  return "";
}

function extractAnthropicStreamDelta(data: string): string {
  const payload = parseJson(data);
  if (!payload || typeof payload !== "object") return "";
  const typed = payload as { type?: unknown; delta?: unknown };
  if (typed.type !== "content_block_delta" || !typed.delta || typeof typed.delta !== "object") return "";
  const delta = typed.delta as { type?: unknown; text?: unknown };
  return delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
}

function extractAnthropicResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const content = Array.isArray((payload as { content?: unknown }).content) ? (payload as { content: unknown[] }).content : [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const typed = block as { type?: unknown; text?: unknown };
    return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
  }).join("");
}

async function summarizeErrorResponse(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const payload = parseJson(text);
  const message = extractErrorMessage(payload) || text.trim();
  return message || `第三方模型请求失败（HTTP ${response.status}）。`;
}

function extractErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function createAbortError(): Error {
  const error = new Error("请求已取消。");
  error.name = "AbortError";
  return error;
}
