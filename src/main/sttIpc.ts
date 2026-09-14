import { ipcMain, type WebContents } from "electron";
import {
  MAX_STT_CHUNK_BYTES,
  MAX_STT_PHRASE_ID_LENGTH,
  STT_IPC,
  type SttAudioChunk,
  type SttBridgeEvent,
  type SttStartRequest,
} from "../shared/stt";
import {
  readSttProviderStatus,
  readSttRuntimeConfig,
  startAssemblyAiSession,
  type SttSession,
} from "./assemblyAiClient";

type ActiveSession = {
  phraseId: string;
  session: SttSession;
  revision: number;
};

let active: ActiveSession | null = null;

function isPhraseId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.length > 0 && value.length <= MAX_STT_PHRASE_ID_LENGTH;
}

function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    ) as ArrayBuffer;
  }

  return null;
}

function send(sender: WebContents, event: SttBridgeEvent): void {
  if (sender.isDestroyed()) return;
  sender.send(STT_IPC.event, event);
}

function dropActive(): void {
  const current = active;
  active = null;
  current?.session.cancel();
}

/**
 * The renderer streams PCM frames and receives transcript events. The API key
 * stays in this process and nothing here logs transcript text.
 */
export function registerSttIpc(): void {
  ipcMain.handle(STT_IPC.status, () => readSttProviderStatus());

  ipcMain.on(STT_IPC.start, (event, payload: unknown) => {
    const request = payload as Partial<SttStartRequest> | null;
    const phraseId = request?.phraseId;
    if (!isPhraseId(phraseId)) return;

    dropActive();

    const sender = event.sender;
    const config = readSttRuntimeConfig();
    if (!config) {
      send(sender, {
        type: "failed",
        phraseId,
        code: "provider_not_configured",
      });
      return;
    }

    let stopped = false;
    const release = (): void => {
      stopped = true;
      if (active?.phraseId === phraseId) active = null;
    };

    const session = startAssemblyAiSession({
      config,
      events: {
        onPartial: (text) => {
          if (stopped || !active) return;
          active.revision += 1;
          send(sender, {
            type: "partial",
            phraseId,
            revision: active.revision,
            text,
          });
        },
        onFinal: (text, confidence) => {
          if (stopped) return;
          release();
          send(sender, {
            type: "final",
            phraseId,
            text,
            confidence,
            receivedAt: Date.now(),
          });
        },
        onError: (code) => {
          if (stopped) return;
          release();
          send(sender, { type: "failed", phraseId, code });
        },
      },
    });

    active = { phraseId, session, revision: 0 };
  });

  ipcMain.on(STT_IPC.audio, (_event, payload: unknown) => {
    const chunk = payload as Partial<SttAudioChunk> | null;
    if (!active || chunk?.phraseId !== active.phraseId) return;

    const pcm = toArrayBuffer(chunk.pcm);
    if (!pcm || pcm.byteLength === 0) return;
    if (pcm.byteLength > MAX_STT_CHUNK_BYTES) return;

    active.session.write(pcm);
  });

  ipcMain.on(STT_IPC.finish, (_event, payload: unknown) => {
    if (!active || payload !== active.phraseId) return;
    active.session.finish();
  });

  ipcMain.on(STT_IPC.cancel, (_event, payload: unknown) => {
    if (!active || payload !== active.phraseId) return;
    dropActive();
  });
}
