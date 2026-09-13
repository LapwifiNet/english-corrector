export type ChunkPushResult = {
  accepted: boolean;
  duplicate: boolean;
  outOfOrder: boolean;
};

export class BufferOverflowError extends Error {
  readonly code = "buffer_overflow";

  constructor(readonly highWaterBytes: number) {
    super(`Streaming audio buffer exceeded ${highWaterBytes} bytes.`);
    this.name = "BufferOverflowError";
  }
}

export class ChunkSequenceGapError extends Error {
  readonly code = "chunk_sequence_gap";

  constructor(readonly expectedSequence: number) {
    super(`Streaming audio ended before chunk ${expectedSequence} arrived.`);
    this.name = "ChunkSequenceGapError";
  }
}

export class StreamingChunkBuffer {
  private readonly pending = new Map<number, Uint8Array>();
  private nextSequence = 0;
  private byteCount = 0;

  constructor(readonly highWaterBytes: number) {
    if (!Number.isInteger(highWaterBytes) || highWaterBytes <= 0) {
      throw new RangeError("highWaterBytes must be a positive integer.");
    }
  }

  get expectedSequence(): number {
    return this.nextSequence;
  }

  get pendingBytes(): number {
    return this.byteCount;
  }

  get pendingChunks(): number {
    return this.pending.size;
  }

  push(sequence: number, bytes: Uint8Array): ChunkPushResult {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new RangeError("Chunk sequence must be a non-negative integer.");
    }

    if (sequence < this.nextSequence || this.pending.has(sequence)) {
      return { accepted: false, duplicate: true, outOfOrder: false };
    }

    if (this.byteCount + bytes.byteLength > this.highWaterBytes) {
      throw new BufferOverflowError(this.highWaterBytes);
    }

    const outOfOrder = sequence > this.nextSequence;
    const copy = bytes.slice();
    this.pending.set(sequence, copy);
    this.byteCount += copy.byteLength;

    return { accepted: true, duplicate: false, outOfOrder };
  }

  drainContiguous(): Uint8Array[] {
    const chunks: Uint8Array[] = [];

    while (this.pending.has(this.nextSequence)) {
      const chunk = this.pending.get(this.nextSequence)!;
      this.pending.delete(this.nextSequence);
      this.byteCount -= chunk.byteLength;
      chunks.push(chunk);
      this.nextSequence += 1;
    }

    return chunks;
  }

  assertComplete(): void {
    if (this.pending.size > 0) {
      throw new ChunkSequenceGapError(this.nextSequence);
    }
  }

  clear(): void {
    this.pending.clear();
    this.byteCount = 0;
    this.nextSequence = 0;
  }
}
