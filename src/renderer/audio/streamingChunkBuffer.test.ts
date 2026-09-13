import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BufferOverflowError,
  ChunkSequenceGapError,
  StreamingChunkBuffer,
} from "./streamingChunkBuffer";

describe("StreamingChunkBuffer", () => {
  it("reorders chunks by sequence", () => {
    const buffer = new StreamingChunkBuffer(32);
    assert.equal(buffer.push(1, Uint8Array.of(2)).outOfOrder, true);
    assert.deepEqual(buffer.drainContiguous(), []);

    buffer.push(0, Uint8Array.of(1));
    assert.deepEqual(
      buffer.drainContiguous().map((chunk) => [...chunk]),
      [[1], [2]],
    );
  });

  it("deduplicates pending and already drained chunks", () => {
    const buffer = new StreamingChunkBuffer(32);
    buffer.push(0, Uint8Array.of(1));
    assert.equal(buffer.push(0, Uint8Array.of(2)).duplicate, true);
    buffer.drainContiguous();
    assert.equal(buffer.push(0, Uint8Array.of(3)).duplicate, true);
  });

  it("enforces the high-water mark", () => {
    const buffer = new StreamingChunkBuffer(2);
    buffer.push(1, Uint8Array.of(1, 2));
    assert.throws(() => buffer.push(2, Uint8Array.of(3)), BufferOverflowError);
  });

  it("reports a missing sequence at completion", () => {
    const buffer = new StreamingChunkBuffer(32);
    buffer.push(2, Uint8Array.of(3));
    assert.throws(() => buffer.assertComplete(), ChunkSequenceGapError);
  });

  it("clears buffered state", () => {
    const buffer = new StreamingChunkBuffer(32);
    buffer.push(1, Uint8Array.of(2));
    buffer.clear();
    assert.equal(buffer.pendingBytes, 0);
    assert.equal(buffer.pendingChunks, 0);
    assert.equal(buffer.expectedSequence, 0);
  });
});
