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
import { registerSttIpc } from "./sttIpc";
import { registerTtsIpc } from "./ttsIpc";

const MICROPHONE_PRIVACY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

function microphoneStatus(): MicrophonePermissionStatus {
  if (process.platform !== "darwin") return "unsupported";

  return systemPreferences.getMediaAccessStatus(
    "microphone",
  ) as MicrophonePermissionStatus;
}

function registerAudioIpc(): void {
  ipcMain.handle(AUDIO_IPC.microphoneStatus, () => microphoneStatus());

  ipcMain.handle(AUDIO_IPC.requestMicrophone, async () => {
    if (process.platform !== "darwin") return false;
    return systemPreferences.askForMediaAccess("microphone");
  });

  ipcMain.handle(AUDIO_IPC.openMicrophoneSettings, async () => {
    if (process.platform !== "darwin") return false;
    try {
      await shell.openExternal(MICROPHONE_PRIVACY_SETTINGS_URL);
      return true;
    } catch {
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
  void window.loadFile(join(__dirname, "../../dist/renderer/index.html"));

  return window;
}

app.whenReady().then(() => {
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
