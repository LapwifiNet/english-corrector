import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PalabraSettingsHost } from "./PalabraSettingsHost";
import { PermissionOnboarding } from "./PermissionOnboarding";
import { PushToTalkPanel } from "./stt/PushToTalkPanel";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PermissionOnboarding>
      <App />
      <PushToTalkPanel />
      <PalabraSettingsHost />
    </PermissionOnboarding>
  </StrictMode>,
);
