import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PalabraSettingsHost } from "./PalabraSettingsHost";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <PalabraSettingsHost />
  </StrictMode>,
);
