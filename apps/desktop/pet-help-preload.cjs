const { ipcRenderer } = require("electron");

const maxHistoryTurns = 8;
const history = [];
let busy = false;
let requestSequence = 0;
let cancelling = false;
let providerMode = "claude";
let providerSummary = null;

const appendMessage = (messages, role, text, pending = false) => {
  const item = document.createElement("article");
  item.className = `message ${role}${pending ? " pending" : ""}`;
  item.textContent = text;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
  return item;
};

const setBusy = (value, input, send, status) => {
  busy = value;
  if (!value) cancelling = false;
  input.disabled = value;
  send.disabled = value ? cancelling : false;
  send.textContent = value ? (cancelling ? "停止中" : "停止") : "发送";
  const providerLabel = providerMode === "third-party" ? "第三方模型" : "Claude Code";
  status.textContent = value ? (cancelling ? `正在停止 ${providerLabel}…` : `正在问 ${providerLabel}…`) : `由 ${providerLabel} 提供回答。`;
};

const resizeInput = (input) => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 104)}px`;
};

window.addEventListener("DOMContentLoaded", () => {
  const close = document.querySelector("[data-close]");
  const form = document.querySelector("[data-form]");
  const input = document.querySelector("[data-input]");
  const send = document.querySelector("[data-send]");
  const messages = document.querySelector("[data-messages]");
  const status = document.querySelector("[data-status]");
  const providerToggle = document.querySelector("[data-provider-toggle]");
  const providerSummaryNode = document.querySelector("[data-provider-summary]");
  let activeRequestId = null;
  let activeStreamText = "";
  let activePending = null;

  if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLTextAreaElement) || !(send instanceof HTMLButtonElement) || !(messages instanceof HTMLElement) || !(status instanceof HTMLElement) || !(providerToggle instanceof HTMLButtonElement) || !(providerSummaryNode instanceof HTMLElement)) return;

  providerSummary = providerSummaryNode;

  appendMessage(messages, "assistant", "你好，我在这里。你可以问我代码、项目、终端命令，或者任何需要 Claude Code 帮忙的事。");

  const handleStream = (_event, payload) => {
    if (!payload || payload.requestId !== activeRequestId || typeof payload.chunk !== "string" || !activePending) return;
    if (!payload.chunk) return;
    activeStreamText += payload.chunk;
    activePending.className = "message assistant";
    activePending.textContent = activeStreamText;
    status.textContent = `${providerMode === "third-party" ? "第三方模型" : "Claude Code"} 正在输出…`;
    messages.scrollTop = messages.scrollHeight;
  };

  ipcRenderer.on("openpets:pet-help-stream", handleStream);

  const refreshProviderSnapshot = async () => {
    const snapshot = await ipcRenderer.invoke("openpets:pet-help-provider-snapshot");
    applyProviderSnapshot(snapshot, providerToggle, status, input);
  };

  close?.addEventListener("click", () => {
    ipcRenderer.send("openpets:pet-help-close");
  });

  providerToggle.addEventListener("click", () => {
    if (busy) return;
    providerToggle.disabled = true;
    status.textContent = "正在切换对话引擎…";
    ipcRenderer.invoke("openpets:pet-help-set-provider-mode", providerMode === "claude" ? "third-party" : "claude").then((snapshot) => {
      applyProviderSnapshot(snapshot, providerToggle, status, input);
    }).catch((error) => {
      providerToggle.disabled = false;
      renderProviderError(status, error);
    });
  });

  send.addEventListener("click", (event) => {
    if (!busy || !activeRequestId || cancelling) return;
    event.preventDefault();
    cancelling = true;
    send.disabled = true;
    send.textContent = "停止中";
    status.textContent = `正在停止 ${providerMode === "third-party" ? "第三方模型" : "Claude Code"}…`;
    ipcRenderer.send("openpets:pet-help-cancel", { requestId: activeRequestId });
  });

  input.addEventListener("input", () => resizeInput(input));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    const message = input.value.trim();
    if (!message) return;

    const requestHistory = history.slice(-maxHistoryTurns);
    input.value = "";
    resizeInput(input);
    appendMessage(messages, "user", message);
    const pending = appendMessage(messages, "assistant", "正在思考…", true);
    const requestId = createRequestId();
    activeRequestId = requestId;
    activeStreamText = "";
    activePending = pending;
    setBusy(true, input, send, status);

    try {
      const response = await ipcRenderer.invoke("openpets:pet-help-ask", { requestId, message, history: requestHistory });
      const answer = response && typeof response.answer === "string" ? response.answer : "Claude Code 没有返回内容。";
      pending.className = "message assistant";
      pending.textContent = answer;
      history.push({ role: "user", content: message }, { role: "assistant", content: answer });
      while (history.length > maxHistoryTurns) history.shift();
    } catch (error) {
      pending.className = "message assistant";
      pending.textContent = activeStreamText ? `${activeStreamText}\n\n${formatPetHelpError(error)}` : formatPetHelpError(error);
    } finally {
      activeRequestId = null;
      activeStreamText = "";
      activePending = null;
      setBusy(false, input, send, status);
      input.focus();
      messages.scrollTop = messages.scrollHeight;
    }
  });

  window.addEventListener("beforeunload", () => {
    ipcRenderer.off("openpets:pet-help-stream", handleStream);
  }, { once: true });

  void refreshProviderSnapshot().catch((error) => {
    renderProviderError(status, error);
  });
  setTimeout(() => input.focus(), 60);
});

function createRequestId() {
  requestSequence += 1;
  return `pet-help-${Date.now()}-${requestSequence}`;
}

function formatPetHelpError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const clean = message
    .replace(/^Error invoking remote method 'openpets:pet-help-ask':\s*/u, "")
    .replace(/^Error:\s*/u, "")
    .trim();
  return clean || "请求对话引擎失败。";
}

function applyProviderSnapshot(snapshot, toggle, status, input) {
  providerMode = snapshot && snapshot.mode === "third-party" ? "third-party" : "claude";
  const thirdPartyConfigured = Boolean(snapshot && snapshot.thirdPartyConfigured);
  const apiStyle = snapshot && snapshot.thirdPartyApiStyle === "anthropic" ? "Anthropic" : "OpenAI";
  const model = snapshot && typeof snapshot.thirdPartyModel === "string" && snapshot.thirdPartyModel ? snapshot.thirdPartyModel : "deepseek-v4-flash";
  toggle.disabled = false;
  toggle.textContent = providerMode === "claude" ? "Claude Code 开" : "Claude Code 关";
  toggle.classList.toggle("off", providerMode === "third-party");
  if (providerSummary) {
    providerSummary.textContent = providerMode === "claude"
      ? "当前使用 Claude Code。"
      : `当前使用第三方模型：${model} · ${apiStyle}${thirdPartyConfigured ? "" : " · 未配置 API Key"}`;
  }
  if (!busy) {
    status.textContent = `由 ${providerMode === "third-party" ? "第三方模型" : "Claude Code"} 提供回答。`;
  }
  input.placeholder = providerMode === "third-party" ? "问问宠物任何问题…（第三方模型）" : "问问宠物任何问题…";
}

function renderProviderError(status, error) {
  status.textContent = formatPetHelpError(error);
}
