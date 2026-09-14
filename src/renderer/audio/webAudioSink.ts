import type {
  NormalizedAudioFrame,
  StreamingAudioSink,
} from "../tts/contracts";

type SinkSelectableAudio = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

export const SYSTEM_DEFAULT_OUTPUT_ID = "system-default";

/**
 * Scheduling lead for the first buffer of a sentence. Long enough to survive
 * one late chunk, short enough that the speaker does not hear it.
 */
export const START_LEAD_SECONDS = 0.03;

type OutputRig = {
  outputDeviceId: string;
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  audio: SinkSelectableAudio;
};

/**
 * Opening an AudioContext, selecting the output device and starting playback
 * costs more than the first audio it plays, and the relay builds a sink for
 * every sentence. The rig is kept open between sentences so only the first
 * sentence of a session pays for it. A different output device replaces it.
 */
let warmRig: OutputRig | null = null;

async function closeRig(rig: OutputRig): Promise<void> {
  rig.audio.pause();
  rig.audio.srcObject = null;
  rig.audio.removeAttribute("src");
  rig.destination.stream.getTracks().forEach((track) => track.stop());
  if (rig.context.state !== "closed") await rig.context.close();
}

/** Releases the shared output. The next sentence opens a new one. */
export async function releaseWarmAudioRig(): Promise<void> {
  const rig = warmRig;
  warmRig = null;
  if (rig) await closeRig(rig);
}

function isReusable(outputDeviceId: string): boolean {
  if (!warmRig) return false;
  if (warmRig.outputDeviceId !== outputDeviceId) return false;
  return warmRig.context.state !== "closed";
}

async function openRig(outputDeviceId: string): Promise<OutputRig> {
  const context = new AudioContext({
    latencyHint: "interactive",
    sampleRate: 48_000,
  });
  const destination = context.createMediaStreamDestination();
  const audio = new Audio() as SinkSelectableAudio;

  if (!audio.setSinkId) {
    await context.close();
    throw new Error("Selected output routing is unavailable in this runtime.");
  }

  audio.autoplay = true;
  audio.srcObject = destination.stream;
  const rig: OutputRig = { outputDeviceId, context, destination, audio };

  try {
    await audio.setSinkId(
      outputDeviceId === SYSTEM_DEFAULT_OUTPUT_ID ? "" : outputDeviceId,
    );
    await context.resume();
    await audio.play();
  } catch (error) {
    await closeRig(rig);
    throw error;
  }

  return rig;
}

export class StreamingWebAudioSink implements StreamingAudioSink {
  private rig: OutputRig | null = null;
  private nextStartTime = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly drainWaiters = new Set<() => void>();

  async start(outputDeviceId: string): Promise<void> {
    await this.stop();

    if (warmRig && !isReusable(outputDeviceId)) {
      await releaseWarmAudioRig();
    }

    const rig = warmRig ?? (await openRig(outputDeviceId));
    warmRig = rig;
    this.rig = rig;

    try {
      if (rig.context.state === "suspended") await rig.context.resume();
      this.nextStartTime = rig.context.currentTime + START_LEAD_SECONDS;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async write(frame: NormalizedAudioFrame): Promise<void> {
    const rig = this.rig;

    if (!rig) {
      throw new Error("The streaming audio sink has not started.");
    }

    const context = rig.context;
    const buffer = context.createBuffer(2, frame.frameCount, frame.sampleRate);
    buffer.getChannelData(0).set(frame.channels[0]);
    buffer.getChannelData(1).set(frame.channels[1]);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(rig.destination);
    this.sources.add(source);
    source.addEventListener(
      "ended",
      () => {
        source.disconnect();
        this.sources.delete(source);
        this.resolveDrainIfIdle();
      },
      { once: true },
    );

    const startsAt = Math.max(this.nextStartTime, context.currentTime + 0.02);
    source.start(startsAt);
    this.nextStartTime = startsAt + frame.durationSeconds;
  }

  async drain(): Promise<void> {
    if (this.sources.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  /**
   * Stopping ends this sentence without tearing the output down, so the next
   * sentence starts from a rig that is already playing.
   */
  async stop(): Promise<void> {
    const sources = [...this.sources];

    this.rig = null;
    this.nextStartTime = 0;
    this.sources.clear();

    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // A source that already ended needs no additional cleanup.
      }
      source.disconnect();
    }

    this.resolveDrainIfIdle();
  }

  private resolveDrainIfIdle(): void {
    if (this.sources.size > 0) return;

    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
