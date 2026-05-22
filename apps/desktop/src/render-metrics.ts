import { app } from "electron";
import { BrowserWindow } from "electron";
import { memoryUsage } from "node:process";

import { getAppStateSnapshot } from "./app-state.js";
import { info, warn } from "./logger.js";
import { getWindowsRenderMode } from "./render-mode.js";

const renderMetricsIntervalMs = 30_000;

let renderMetricsTimer: NodeJS.Timeout | null = null;

export function startRenderMetricsSampler(windowsSoftwareCompositing: boolean): void {
  if (process.env.OPENPETS_RENDER_METRICS !== "1" || renderMetricsTimer) return;

  const sample = async (): Promise<void> => {
    try {
      const mainMemory = await process.getProcessMemoryInfo();
      const heap = memoryUsage();
      const appMetrics = app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        cpuPercent: Number(metric.cpu.percentCPUUsage.toFixed(2)),
        workingSetKb: metric.memory.workingSetSize,
        peakWorkingSetKb: metric.memory.peakWorkingSetSize,
        privateKb: metric.memory.privateBytes,
      }));

      info("render.metrics", "sample", {
        platform: process.platform,
        windowsRenderMode: getWindowsRenderMode(getAppStateSnapshot().preferences.windowsRenderMode),
        windowsSoftwareCompositing,
        windows: BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          title: window.getTitle(),
          visible: window.isVisible(),
          destroyed: window.isDestroyed(),
          bounds: window.isDestroyed() ? null : window.getBounds(),
        })),
        mainProcess: mainMemory,
        heap: {
          rss: heap.rss,
          heapUsed: heap.heapUsed,
          heapTotal: heap.heapTotal,
          external: heap.external,
          arrayBuffers: heap.arrayBuffers,
        },
        appMetrics,
      });
    } catch (error) {
      warn("render.metrics", "sample failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  void sample();
  renderMetricsTimer = setInterval(() => {
    void sample();
  }, renderMetricsIntervalMs);
  renderMetricsTimer.unref?.();
}
