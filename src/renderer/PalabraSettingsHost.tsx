import { useEffect, useState } from "react";
import {
  PALABRA_DEFAULT_VOICE_ID,
  PALABRA_PIPELINE_STORAGE_KEY,
  parseStoredPalabraPipelineConfig,
  type PalabraPipelineConfig,
} from "../shared/palabraPipeline";
import { PalabraSettingsPanel } from "./PalabraSettingsPanel";
import type { TtsVoice } from "./tts/contracts";

const CONFIGURED_VOICES: readonly TtsVoice[] = [
  {
    id: PALABRA_DEFAULT_VOICE_ID,
    name: "Default configured voice",
    locale: "en-GB",
    category: "configured",
  },
  {
    id: "default_low",
    name: "Palabra default low",
    locale: "en-US",
    category: "builtin",
  },
  {
    id: "default_high",
    name: "Palabra default high",
    locale: "en-US",
    category: "builtin",
  },
];

function loadConfig(): PalabraPipelineConfig {
  return parseStoredPalabraPipelineConfig(
    window.localStorage.getItem(PALABRA_PIPELINE_STORAGE_KEY),
  );
}

export function PalabraSettingsHost() {
  const [config, setConfig] = useState(loadConfig);

  useEffect(() => {
    window.localStorage.setItem(
      PALABRA_PIPELINE_STORAGE_KEY,
      JSON.stringify(config),
    );
  }, [config]);

  return (
    <div className="standalone-palabra-settings">
      <PalabraSettingsPanel
        config={config}
        voices={CONFIGURED_VOICES}
        disabled={false}
        onChange={setConfig}
      />
    </div>
  );
}
