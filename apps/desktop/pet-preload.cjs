const { ipcRenderer, webUtils } = require("electron");

const allowedMotionStates = new Set(["idle", "run-left", "run-right"]);
const allowedReactionStates = new Set(["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"]);
let lastInteractiveHit = null;
let dragging = false;
let folderDraggingOverPet = false;
let folderDragLeaveTimer = null;
const dropTargetPaddingPx = 12;
const folderDragLeaveDelayMs = 90;

const dismissBubble = (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

  const target = event.target;
  if (!(target instanceof Element)) return;

  const bubble = target.closest(".bubble");
  if (!bubble) return;

  const dismissToken = bubble.dataset.dismissToken;
  if (!dismissToken) return;

  event.preventDefault();
  event.stopPropagation();

  bubble.remove();

  const newTarget = document.elementFromPoint(event.clientX, event.clientY);
  const stillInteractive = Boolean(newTarget && newTarget.closest(".pet-shell, .bubble")) || dragging;
  reportInteractiveHit(stillInteractive, "bubble-dismiss", true);

  ipcRenderer.send("openpets:bubble-dismissed", dismissToken);
};

ipcRenderer.on("openpets:pet-motion", (_event, state) => {
  if (!allowedMotionStates.has(state)) {
    return;
  }

  const apply = () => {
    document.documentElement.dataset.motionState = state;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
});

ipcRenderer.on("openpets:pet-reaction-state", (_event, state) => {
  if (!allowedReactionStates.has(state)) {
    return;
  }

  const apply = () => {
    document.documentElement.dataset.reactionState = state;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
});

ipcRenderer.on("openpets:pet-content-state", (_event, state) => {
  if (!state || typeof state.bodyHtml !== "string" || state.bodyHtml.length > 64 * 1024 || !allowedMotionStates.has(state.motionState) || !allowedReactionStates.has(state.reactionState)) {
    return;
  }

  const apply = () => {
    document.documentElement.dataset.motionState = state.motionState;
    document.documentElement.dataset.reactionState = state.reactionState;
    document.body.innerHTML = state.bodyHtml;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  } else {
    apply();
  }
});

const getInteractiveTarget = (event) => {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  return target && target.closest(".pet-shell, .bubble");
};

const getDropTargetElement = (event) => {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  return target && target.closest(".pet-shell, .bubble, .drop-zone");
};

const getHoverHitKind = (event) => {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  if (!target) return null;
  if (target.closest(".pet-shell, .bubble")) return "pet";
  if (target.closest(".drop-zone")) return "drop-zone";
  return null;
};

const clearFolderDragLeaveTimer = () => {
  if (folderDragLeaveTimer === null) return;
  clearTimeout(folderDragLeaveTimer);
  folderDragLeaveTimer = null;
};

const scheduleFolderDragLeave = () => {
  clearFolderDragLeaveTimer();
  folderDragLeaveTimer = setTimeout(() => {
    folderDragLeaveTimer = null;
    setFolderDraggingOverPet(false);
  }, folderDragLeaveDelayMs);
};

const getPetDropBounds = () => {
  const dropZone = document.querySelector(".drop-zone");
  if (dropZone instanceof HTMLElement) {
    return dropZone.getBoundingClientRect();
  }
  const petShell = document.querySelector(".pet-shell");
  if (!(petShell instanceof HTMLElement)) return null;
  return petShell.getBoundingClientRect();
};

const isPointInsideRect = (clientX, clientY, rect, padding = 0) => {
  return clientX >= rect.left - padding
    && clientX <= rect.right + padding
    && clientY >= rect.top - padding
    && clientY <= rect.bottom + padding;
};

const isFolderDropTarget = (event) => {
  const clientX = typeof event.clientX === "number" ? event.clientX : NaN;
  const clientY = typeof event.clientY === "number" ? event.clientY : NaN;
  if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
    const petBounds = getPetDropBounds();
    if (petBounds && isPointInsideRect(clientX, clientY, petBounds, dropTargetPaddingPx)) {
      return true;
    }
  }
  return Boolean(getDropTargetElement(event));
};

const hasFileDrag = (event) => {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
};

const getPathForDroppedFile = (file) => {
  if (!file) return "";
  if (webUtils && typeof webUtils.getPathForFile === "function") {
    const path = webUtils.getPathForFile(file);
    if (typeof path === "string" && path.length > 0) return path;
  }
  return typeof file.path === "string" ? file.path : "";
};

const getDroppedDirectoryEntries = (event) => {
  return Array.from(event.dataTransfer?.items ?? [])
    .map((item) => {
      if (!item || typeof item.webkitGetAsEntry !== "function") return null;
      const entry = item.webkitGetAsEntry();
      if (!entry || !entry.isDirectory || typeof entry.name !== "string" || !entry.name) return null;
      return {
        name: entry.name,
        fullPath: typeof entry.fullPath === "string" && entry.fullPath ? entry.fullPath : `/${entry.name}`,
        filePath: getPathForDroppedFile(typeof item.getAsFile === "function" ? item.getAsFile() : null),
      };
    })
    .filter(Boolean);
};

const inferDirectoryPathFromEntry = (entry, droppedPaths) => {
  if (!entry) return "";
  if (typeof entry.filePath === "string" && entry.filePath.length > 0) {
    return entry.filePath;
  }
  const relativeSegments = String(entry.fullPath || "")
    .split(/[\\/]+/)
    .filter(Boolean);
  if (relativeSegments.length === 0) {
    if (typeof entry.name !== "string" || !entry.name) return "";
    relativeSegments.push(entry.name);
  }
  const normalizedRelativePath = relativeSegments.join("/");
  for (const candidate of droppedPaths) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const normalizedCandidate = candidate.replaceAll("\\", "/");
    const marker = `/${normalizedRelativePath}/`;
    const markerIndex = normalizedCandidate.lastIndexOf(marker);
    if (markerIndex >= 0) {
      return candidate.slice(0, markerIndex + marker.length - 1);
    }
    const exactMarker = `/${normalizedRelativePath}`;
    if (normalizedCandidate.endsWith(exactMarker)) {
      return candidate.slice(0, candidate.length - exactMarker.length) + exactMarker.replaceAll("/", candidate.includes("\\") ? "\\" : "/");
    }
    const folderNameMarker = `/${entry.name}/`;
    const folderNameIndex = normalizedCandidate.lastIndexOf(folderNameMarker);
    if (folderNameIndex >= 0) {
      return candidate.slice(0, folderNameIndex + folderNameMarker.length - 1);
    }
  }
  return "";
};

const getDroppedPaths = (event) => {
  const filePaths = Array.from(event.dataTransfer?.files ?? [])
    .map(getPathForDroppedFile)
    .filter((path) => typeof path === "string" && path.length > 0);
  const itemPaths = Array.from(event.dataTransfer?.items ?? [])
    .map((item) => getPathForDroppedFile(typeof item?.getAsFile === "function" ? item.getAsFile() : null))
    .filter((path) => typeof path === "string" && path.length > 0);
  const combinedPaths = Array.from(new Set([...filePaths, ...itemPaths]));
  const directoryPaths = getDroppedDirectoryEntries(event)
    .map((entry) => inferDirectoryPathFromEntry(entry, combinedPaths))
    .filter((path) => typeof path === "string" && path.length > 0);
  return Array.from(new Set([...directoryPaths, ...combinedPaths]));
};

const setFolderDraggingOverPet = (next) => {
  if (next) clearFolderDragLeaveTimer();
  if (folderDraggingOverPet === next) return;
  folderDraggingOverPet = next;
  reportInteractiveHit(next || dragging || Boolean(lastInteractiveHit), next ? "folder-drag-enter" : "folder-drag-leave", true);
  ipcRenderer.send(next ? "openpets:pet-folder-drag-enter" : "openpets:pet-folder-drag-leave");
};

const heartbeatFolderDraggingOverPet = () => {
  clearFolderDragLeaveTimer();
  if (!folderDraggingOverPet) return;
  ipcRenderer.send("openpets:pet-folder-drag-enter");
};

const reportInteractiveHit = (interactive, source, force = false) => {
  if (!force && lastInteractiveHit === interactive) return;
  lastInteractiveHit = interactive;
  ipcRenderer.send("openpets:pet-hit-test", interactive, source);
};

let lastInteractiveSource = "mouse";

const setInteractiveHit = (interactive, source = "mouse") => {
  if (lastInteractiveHit === interactive && lastInteractiveSource === source) return;
  const sourceChanged = lastInteractiveSource !== source;
  lastInteractiveSource = source;
  reportInteractiveHit(interactive, source, sourceChanged);
};

const updateInteractiveHit = (event) => {
  if (dragging) {
    setInteractiveHit(true, "mouse");
    return;
  }
  const kind = getHoverHitKind(event);
  if (kind === "pet") setInteractiveHit(true, "mouse");
  else if (kind === "drop-zone") setInteractiveHit(true, "drop-zone");
  else setInteractiveHit(false, "mouse");
};

ipcRenderer.on("openpets:pet-probe-hit-test", (_event, point) => {
  if (!point || typeof point.clientX !== "number" || typeof point.clientY !== "number" || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return;
  const clientX = point.clientX;
  const clientY = point.clientY;
  const target = document.elementFromPoint(clientX, clientY);
  reportInteractiveHit(Boolean(target && target.closest(".pet-shell, .bubble")) || dragging, typeof point.reason === "string" ? point.reason.slice(0, 80) : "probe", true);
});

const installMouseInterop = () => {
  lastInteractiveHit = null;
  lastInteractiveSource = "mouse";
  dragging = false;
  folderDraggingOverPet = false;
  clearFolderDragLeaveTimer();

  document.addEventListener("click", dismissBubble);

  document.addEventListener("dragenter", (event) => {
    if (!hasFileDrag(event) || !isFolderDropTarget(event)) return;
    event.preventDefault();
    setFolderDraggingOverPet(true);
  });

  document.addEventListener("dragover", (event) => {
    if (!hasFileDrag(event) || !isFolderDropTarget(event)) {
      scheduleFolderDragLeave();
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (folderDraggingOverPet) heartbeatFolderDraggingOverPet();
    else setFolderDraggingOverPet(true);
  });

  document.addEventListener("dragleave", (event) => {
    if (isFolderDropTarget(event)) return;
    scheduleFolderDragLeave();
  });

  document.addEventListener("drop", (event) => {
    if (!hasFileDrag(event) || !isFolderDropTarget(event)) {
      clearFolderDragLeaveTimer();
      setFolderDraggingOverPet(false);
      return;
    }

    event.preventDefault();
    const paths = getDroppedPaths(event);
    clearFolderDragLeaveTimer();
    setFolderDraggingOverPet(false);
    ipcRenderer.send("openpets:pet-folder-dropped", paths);
  });

  document.addEventListener("dragend", () => {
    clearFolderDragLeaveTimer();
    setFolderDraggingOverPet(false);
  });

  document.addEventListener("mousemove", (event) => {
    updateInteractiveHit(event);
    if (dragging) ipcRenderer.send("openpets:pet-drag-move", { screenX: event.screenX, screenY: event.screenY });
  }, { passive: true });

  document.addEventListener("mousedown", (event) => {
    const target = getInteractiveTarget(event);
    setInteractiveHit(Boolean(target));
    if (event.button !== 0 || !target?.closest(".pet-shell")) return;
    event.preventDefault();
    dragging = true;
    setInteractiveHit(true);
    ipcRenderer.send("openpets:pet-drag-start", { screenX: event.screenX, screenY: event.screenY });
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    ipcRenderer.send("openpets:pet-drag-end");
  });

  document.addEventListener("mouseleave", () => {
    if (!dragging && !folderDraggingOverPet) setInteractiveHit(false);
  }, { passive: true });

  setInteractiveHit(false, "ready");
  ipcRenderer.send("openpets:pet-ready");
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installMouseInterop, { once: true });
} else {
  installMouseInterop();
}
