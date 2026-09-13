import type {
  NormalizedAudioFrame,
  StreamingAudioSink,
} from "../tts/contracts";

type SinkSelectableAudio = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

export class StreamingWebAudioSink implements StreamingAudioSink {
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private audio: SinkSelectableAudio | null = null;
  private nextStartTime = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly drainWaiters = new Set<() => void>();

  async start(outputDeviceId: string): Promise<void> {
    await this.stop();

    const context = new AudioContext({
      latencyHint: "interactive",
      sampleRate: 48_000,
    });
    const destination = context.createMediaStreamDestination();
    const audio = new Audio() as SinkSelectableAudio;

    if (!audio.setSinkId) {
      await context.close();
      throw new Error(
        "Selected output routing is unavailable in this runtime.",
      );
    }

    audio.autoplay = true;
    audio.srcObject = destination.stream;
    this.context = context;
    this.destination = destination;
    this.audio = audio;

    try {
      await audio.setSinkId(outputDeviceId);
      await context.resume();
      await audio.play();
      this.nextStartTime = context.currentTime + 0.1;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async write(frame: NormalizedAudioFrame): Promise<void> {
    const context = this.context;
    const destination = this.destination;

    if (!context || !destination) {
      throw new Error("The streaming audio sink has not started.");
    }

    const buffer = context.createBuffer(2, frame.frameCount, frame.sampleRate);
    buffer.getChannelData(0).set(frame.channels[0]);
    buffer.getChannelData(1).set(frame.channels[1]);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
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

  async stop(): Promise<void> {
    const context = this.context;
    const destination = this.destination;
    const audio = this.audio;
    const sources = [...this.sources];

    this.context = null;
    this.destination = null;
    this.audio = null;
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

    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.removeAttribute("src");
    }

    destination?.stream.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") await context.close();
    this.resolveDrainIfIdle();
  }

  private resolveDrainIfIdle(): void {
    if (this.sources.size > 0) return;

    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
