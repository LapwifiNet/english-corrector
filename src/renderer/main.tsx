import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PalabraSettingsHost } from "./PalabraSettingsHost";
import { PushToTalkPanel } from "./stt/PushToTalkPanel";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <PushToTalkPanel />
    <PalabraSettingsHost />
  </StrictMode>,
);
