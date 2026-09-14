import { app, BrowserWindow, ipcMain, systemPreferences } from "electron";
import { join } from "node:path";
import type { MicrophonePermissionStatus } from "../shared/audio";
import { registerCorrectionIpc } from "./correctionIpc";
import { registerTtsIpc } from "./ttsIpc";

function microphoneStatus(): MicrophonePermissionStatus {
  if (process.platform !== "darwin") return "unsupported";

  return systemPreferences.getMediaAccessStatus(
    "microphone",
  ) as MicrophonePermissionStatus;
}

function registerAudioIpc(): void {
  ipcMain.handle("audio:get-microphone-permission", () => microphoneStatus());

  ipcMain.handle("audio:request-microphone-permission", async () => {
    if (process.platform !== "darwin") return false;
    return systemPreferences.askForMediaAccess("microphone");
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
