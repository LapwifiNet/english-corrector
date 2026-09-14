import type { TtsProviderStatus } from "../shared/tts";
import {
  readElevenLabsProviderStatus,
  readElevenLabsRuntimeConfig,
  type ElevenLabsRuntimeConfig,
} from "./elevenLabsClient";
import {
  readPalabraProviderStatus,
  readPalabraRuntimeConfig,
  type PalabraRuntimeConfig,
} from "./palabraClient";

export type PreferredTtsRuntimeConfig =
  | { provider: "palabra"; config: PalabraRuntimeConfig }
  | { provider: "elevenlabs"; config: ElevenLabsRuntimeConfig };

export function readPreferredTtsProviderStatus(
  environment: NodeJS.ProcessEnv = process.env,
): TtsProviderStatus {
  const palabra = readPalabraProviderStatus(environment);
  if (palabra.configured) return palabra;

  const elevenLabs = readElevenLabsProviderStatus(environment);
  if (elevenLabs.configured) return elevenLabs;

  return palabra;
}

export function readPreferredTtsRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PreferredTtsRuntimeConfig | null {
  const palabra = readPalabraRuntimeConfig(environment);
  if (palabra) return { provider: "palabra", config: palabra };

  const elevenLabs = readElevenLabsRuntimeConfig(environment);
  if (elevenLabs) return { provider: "elevenlabs", config: elevenLabs };

  return null;
}
