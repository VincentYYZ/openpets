const { ipcRenderer } = require("electron");

const pad2 = (value) => String(value).padStart(2, "0");

const toLocalDatetimeInput = (date) => {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const parseLocalDatetimeInput = (value) => {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : null;
};

const formatWhen = (fireAtMs) => {
  const target = new Date(fireAtMs);
  const now = new Date();
  const diffMs = fireAtMs - now.getTime();
  const sameDay = target.getFullYear() === now.getFullYear()
    && target.getMonth() === now.getMonth()
    && target.getDate() === now.getDate();
  const datePart = sameDay
    ? "今天"
    : `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}`;
  const timePart = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  const head = `${datePart} ${timePart}`;
  if (diffMs <= 0) return `${head}（已到点）`;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return `${head}（不到 1 分钟）`;
  if (minutes < 60) return `${head}（约 ${minutes} 分钟后）`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return `${head}（约 ${hours} 小时${remainMin ? ` ${remainMin} 分` : ""}后）`;
  const days = Math.floor(hours / 24);
  return `${head}（约 ${days} 天后）`;
};

const renderList = (listElement, reminders) => {
  listElement.replaceChildren();
  const pending = reminders.filter((reminder) => !reminder.fired).slice().sort((a, b) => a.fireAt - b.fireAt);
  if (pending.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂时没有提醒事项。";
    listElement.appendChild(empty);
    return;
  }

  for (const reminder of pending) {
    const item = document.createElement("article");
    item.className = "item";

    const body = document.createElement("div");
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = reminder.text;
    const when = document.createElement("div");
    when.className = "when";
    when.textContent = formatWhen(reminder.fireAt);
    body.appendChild(text);
    body.appendChild(when);
    item.appendChild(body);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.setAttribute("aria-label", "删除提醒");
    remove.textContent = "×";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        const next = await ipcRenderer.invoke("openpets:pet-reminder-delete", reminder.id);
        renderList(listElement, Array.isArray(next) ? next : []);
      } catch (error) {
        remove.disabled = false;
      }
    });
    item.appendChild(remove);

    listElement.appendChild(item);
  }
};

const setStatus = (status, message, isError = false) => {
  status.textContent = message;
  status.classList.toggle("error", Boolean(isError));
};

window.addEventListener("DOMContentLoaded", async () => {
  const closeBtn = document.querySelector("[data-close]");
  const form = document.querySelector("[data-form]");
  const input = document.querySelector("[data-input]");
  const time = document.querySelector("[data-time]");
  const addBtn = document.querySelector("[data-add]");
  const list = document.querySelector("[data-list]");
  const status = document.querySelector("[data-status]");
  const quick = document.querySelector("[data-quick]");

  if (!(form instanceof HTMLFormElement)
    || !(input instanceof HTMLTextAreaElement)
    || !(time instanceof HTMLInputElement)
    || !(addBtn instanceof HTMLButtonElement)
    || !(list instanceof HTMLElement)
    || !(status instanceof HTMLElement)) return;

  const setBusy = (busy) => {
    addBtn.disabled = busy;
    input.disabled = busy;
    time.disabled = busy;
  };

  const refreshDefaultTime = () => {
    const next = new Date(Date.now() + 5 * 60_000);
    next.setSeconds(0, 0);
    time.value = toLocalDatetimeInput(next);
  };
  refreshDefaultTime();

  closeBtn?.addEventListener("click", () => {
    ipcRenderer.send("openpets:pet-reminder-close");
  });

  quick?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const offsetMinutes = Number(target.dataset.quickOffset);
    if (!Number.isFinite(offsetMinutes) || offsetMinutes <= 0) return;
    const next = new Date(Date.now() + offsetMinutes * 60_000);
    next.setSeconds(0, 0);
    time.value = toLocalDatetimeInput(next);
    setStatus(status, `已设置为 ${offsetMinutes} 分钟后。`);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      setStatus(status, "请先写下要提醒的事项。", true);
      input.focus();
      return;
    }
    const fireAt = parseLocalDatetimeInput(time.value);
    if (fireAt === null) {
      setStatus(status, "请选择一个有效的提醒时间。", true);
      return;
    }
    if (fireAt < Date.now() - 60_000) {
      setStatus(status, "提醒时间已过，请重新选择。", true);
      return;
    }

    setBusy(true);
    setStatus(status, "正在保存…");
    try {
      const next = await ipcRenderer.invoke("openpets:pet-reminder-create", { text, fireAt });
      input.value = "";
      refreshDefaultTime();
      renderList(list, Array.isArray(next) ? next : []);
      setStatus(status, "已添加，到时间宠物会提醒你。");
    } catch (error) {
      setStatus(status, error instanceof Error ? error.message : "添加提醒失败。", true);
    } finally {
      setBusy(false);
      input.focus();
    }
  });

  try {
    const reminders = await ipcRenderer.invoke("openpets:pet-reminder-list");
    renderList(list, Array.isArray(reminders) ? reminders : []);
  } catch (error) {
    setStatus(status, "加载提醒列表失败。", true);
  }

  setTimeout(() => input.focus(), 60);
});
