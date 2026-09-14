import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BlackHoleSetup } from "./BlackHoleSetup";
import { PalabraSettingsHost } from "./PalabraSettingsHost";
import { PermissionOnboarding } from "./PermissionOnboarding";
import { PushToTalkPanel } from "./stt/PushToTalkPanel";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PermissionOnboarding>
      <BlackHoleSetup>
        <App />
        <PushToTalkPanel />
        <PalabraSettingsHost />
      </BlackHoleSetup>
    </PermissionOnboarding>
  </StrictMode>,
);
