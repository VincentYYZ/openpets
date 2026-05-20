const { ipcRenderer, webUtils } = require("electron");

const allowedMotionStates = new Set(["idle", "run-left", "run-right"]);
const allowedReactionStates = new Set(["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"]);
let lastInteractiveHit = null;
let dragging = false;
let folderDraggingOverPet = false;

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

const isFolderDropTarget = (event) => {
  const target = document.elementFromPoint(event.clientX, event.clientY);
  return Boolean(target && target.closest(".pet-shell"));
};

const hasFileDrag = (event) => {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
};

const getDroppedPaths = (event) => {
  return Array.from(event.dataTransfer?.files ?? [])
    .map((file) => {
      if (webUtils && typeof webUtils.getPathForFile === "function") {
        return webUtils.getPathForFile(file);
      }

      return typeof file.path === "string" ? file.path : "";
    })
    .filter((path) => typeof path === "string" && path.length > 0);
};

const setFolderDraggingOverPet = (next) => {
  if (folderDraggingOverPet === next) return;
  folderDraggingOverPet = next;
  reportInteractiveHit(next || dragging || Boolean(lastInteractiveHit), next ? "folder-drag-enter" : "folder-drag-leave", true);
  ipcRenderer.send(next ? "openpets:pet-folder-drag-enter" : "openpets:pet-folder-drag-leave");
};

const reportInteractiveHit = (interactive, source, force = false) => {
  if (!force && lastInteractiveHit === interactive) return;
  lastInteractiveHit = interactive;
  ipcRenderer.send("openpets:pet-hit-test", interactive, source);
};

const setInteractiveHit = (interactive, source = "mouse") => {
  if (lastInteractiveHit === interactive) return;
  reportInteractiveHit(interactive, source);
};

const updateInteractiveHit = (event) => {
  setInteractiveHit(Boolean(getInteractiveTarget(event)) || dragging);
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
  dragging = false;
  folderDraggingOverPet = false;

  document.addEventListener("click", dismissBubble);

  document.addEventListener("dragenter", (event) => {
    if (!hasFileDrag(event) || !isFolderDropTarget(event)) return;
    event.preventDefault();
    setFolderDraggingOverPet(true);
  });

  document.addEventListener("dragover", (event) => {
    if (!hasFileDrag(event) || !isFolderDropTarget(event)) {
      setFolderDraggingOverPet(false);
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setFolderDraggingOverPet(true);
  });

  document.addEventListener("dragleave", (event) => {
    if (isFolderDropTarget(event)) return;
    setFolderDraggingOverPet(false);
  });

  document.addEventListener("drop", (event) => {
    if (!hasFileDrag(event) || !isFolderDropTarget(event)) {
      setFolderDraggingOverPet(false);
      return;
    }

    event.preventDefault();
    const paths = getDroppedPaths(event);
    setFolderDraggingOverPet(false);
    ipcRenderer.send("openpets:pet-folder-dropped", paths);
  });

  document.addEventListener("dragend", () => {
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
