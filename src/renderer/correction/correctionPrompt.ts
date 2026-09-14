/**
 * The prompt moved to shared so the main process can send the same instruction
 * to the provider. Renderer modules keep importing it from here.
 */
export {
  buildUserTurn,
  CORRECTION_PROMPT_VERSION,
  CORRECTION_SYSTEM_INSTRUCTION,
  DEFAULT_PROMPT_CONFIG,
  type PromptConfig,
} from "../../shared/correctionPrompt";
