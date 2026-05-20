const { ipcRenderer } = require("electron");

const maxHistoryTurns = 8;
const history = [];
let busy = false;

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
  input.disabled = value;
  send.disabled = value;
  status.textContent = value ? "正在问 Claude Code…" : "由 Claude Code 提供回答。";
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

  if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLTextAreaElement) || !(send instanceof HTMLButtonElement) || !(messages instanceof HTMLElement) || !(status instanceof HTMLElement)) return;

  appendMessage(messages, "assistant", "你好，我在这里。你可以问我代码、项目、终端命令，或者任何需要 Claude Code 帮忙的事。");

  close?.addEventListener("click", () => {
    ipcRenderer.send("openpets:pet-help-close");
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
    setBusy(true, input, send, status);

    try {
      const response = await ipcRenderer.invoke("openpets:pet-help-ask", { message, history: requestHistory });
      const answer = response && typeof response.answer === "string" ? response.answer : "Claude Code 没有返回内容。";
      pending.className = "message assistant";
      pending.textContent = answer;
      history.push({ role: "user", content: message }, { role: "assistant", content: answer });
      while (history.length > maxHistoryTurns) history.shift();
    } catch (error) {
      pending.className = "message assistant";
      pending.textContent = error instanceof Error ? error.message : "请求 Claude Code 失败。";
    } finally {
      setBusy(false, input, send, status);
      input.focus();
      messages.scrollTop = messages.scrollHeight;
    }
  });

  setTimeout(() => input.focus(), 60);
});
