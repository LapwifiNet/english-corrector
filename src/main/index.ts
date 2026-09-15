import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  systemPreferences,
} from "electron";
import { join } from "node:path";
import { AUDIO_IPC, type MicrophonePermissionStatus } from "../shared/audio";
import { registerCorrectionIpc } from "./correctionIpc";
import { createPrivacyLogger, type PrivacyLogOutcome } from "./privacyLogger";
import { registerSttIpc } from "./sttIpc";
import { registerTtsIpc } from "./ttsIpc";

const MICROPHONE_PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
const privacyLogger = createPrivacyLogger();

function permissionOutcome(
  status: MicrophonePermissionStatus,
): PrivacyLogOutcome {
  switch (status) {
    case "granted":
    case "denied":
    case "restricted":
    case "unsupported":
    case "unknown":
      return status;
    case "not-determined":
      return "not_determined";
  }
}

function microphoneStatus(): MicrophonePermissionStatus {
  if (process.platform !== "darwin") {
    privacyLogger.log({
      event: "permission_check",
      component: "audio",
      outcome: "unsupported",
    });
    return "unsupported";
  }

  try {
    const status = systemPreferences.getMediaAccessStatus(
      "microphone",
    ) as MicrophonePermissionStatus;
    privacyLogger.log({
      event: "permission_check",
      component: "audio",
      outcome: permissionOutcome(status),
    });
    return status;
  } catch (error) {
    privacyLogger.log({
      level: "error",
      event: "permission_check",
      component: "audio",
      outcome: "failed",
      code: "permission_check_failed",
      retryable: true,
    });
    throw error;
  }
}

function registerAudioIpc(): void {
  ipcMain.handle(AUDIO_IPC.microphoneStatus, () => microphoneStatus());

  ipcMain.handle(AUDIO_IPC.requestMicrophone, async () => {
    const correlationId = privacyLogger.createCorrelationId();
    const startedAt = Date.now();
    privacyLogger.log({
      event: "permission_request",
      component: "audio",
      outcome: "started",
      correlationId,
    });

    if (process.platform !== "darwin") {
      privacyLogger.log({
        event: "permission_request",
        component: "audio",
        outcome: "unsupported",
        correlationId,
        durationMs: Date.now() - startedAt,
      });
      return false;
    }

    try {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      privacyLogger.log({
        event: "permission_request",
        component: "audio",
        outcome: granted ? "granted" : "denied",
        correlationId,
        durationMs: Date.now() - startedAt,
      });
      return granted;
    } catch (error) {
      privacyLogger.log({
        level: "error",
        event: "permission_request",
        component: "audio",
        outcome: "failed",
        code: "permission_request_failed",
        correlationId,
        durationMs: Date.now() - startedAt,
        retryable: true,
      });
      throw error;
    }
  });

  ipcMain.handle(AUDIO_IPC.openMicrophoneSettings, async () => {
    const correlationId = privacyLogger.createCorrelationId();
    const startedAt = Date.now();
    privacyLogger.log({
      event: "settings_open",
      component: "audio",
      outcome: "started",
      correlationId,
    });

    if (process.platform !== "darwin") {
      privacyLogger.log({
        event: "settings_open",
        component: "audio",
        outcome: "unsupported",
        correlationId,
        durationMs: Date.now() - startedAt,
      });
      return false;
    }

    try {
      await shell.openExternal(MICROPHONE_PRIVACY_SETTINGS_URL);
      privacyLogger.log({
        event: "settings_open",
        component: "audio",
        outcome: "completed",
        correlationId,
        durationMs: Date.now() - startedAt,
      });
      return true;
    } catch {
      privacyLogger.log({
        level: "error",
        event: "settings_open",
        component: "audio",
        outcome: "failed",
        code: "settings_open_failed",
        correlationId,
        durationMs: Date.now() - startedAt,
        retryable: true,
      });
      return false;
    }
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 820,
    minHeight: 640,
    backgroundColor: "#f9f8f7",
    title: "English Corrector",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  const correlationId = privacyLogger.createCorrelationId();
  const startedAt = Date.now();
  privacyLogger.log({
    event: "window_load",
    component: "app",
    outcome: "started",
    correlationId,
  });

  void window
    .loadFile(join(__dirname, "../../dist/renderer/index.html"))
    .then(() => {
      privacyLogger.log({
        event: "window_load",
        component: "app",
        outcome: "completed",
        correlationId,
        durationMs: Date.now() - startedAt,
      });
    })
    .catch(() => {
      privacyLogger.log({
        level: "error",
        event: "window_load",
        component: "app",
        outcome: "failed",
        code: "window_load_failed",
        correlationId,
        durationMs: Date.now() - startedAt,
        retryable: true,
      });
    });

  return window;
}

app.whenReady().then(() => {
  privacyLogger.log({
    event: "app_lifecycle",
    component: "app",
    outcome: "ready",
    code: "app_ready",
  });
  registerAudioIpc();
  registerSttIpc();
  registerTtsIpc();
  registerCorrectionIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
