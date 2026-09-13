import type { DesktopApi } from "../shared/audio";

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}

export {};
