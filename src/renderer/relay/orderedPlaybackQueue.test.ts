import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrderedPlaybackQueue } from "./orderedPlaybackQueue";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = () => resolve();
  });

  return { promise, resolve: () => settle() };
}

describe("createOrderedPlaybackQueue", () => {
  it("plays by index even when a later phrase is ready first", async () => {
    const order: string[] = [];
    const queue = createOrderedPlaybackQueue();

    queue.enqueue({
      phraseId: "b",
      phraseIndex: 1,
      play: async () => {
        order.push("b");
      },
    });
    await queue.settled();
    // A bare [] narrows order to never[] through the assert type predicate.
    assert.equal(order.length, 0);

    queue.enqueue({
      phraseId: "a",
      phraseIndex: 0,
      play: async () => {
        order.push("a");
      },
    });
    await queue.settled();

    assert.deepEqual(order, ["a", "b"]);
    assert.equal(queue.snapshot().nextIndex, 2);
  });

  it("never lets two phrases speak at once", async () => {
    let active = 0;
    let overlapped = false;
    const queue = createOrderedPlaybackQueue();
    const gate = deferred();

    const play = async () => {
      active += 1;
      if (active > 1) overlapped = true;
      await gate.promise;
      active -= 1;
    };

    queue.enqueue({ phraseId: "a", phraseIndex: 0, play });
    queue.enqueue({ phraseId: "b", phraseIndex: 1, play });
    gate.resolve();
    await queue.settled();

    assert.equal(overlapped, false);
    assert.equal(queue.snapshot().playing, null);
  });

  it("ignores a phrase that was already queued", async () => {
    let plays = 0;
    const queue = createOrderedPlaybackQueue();
    const play = async () => {
      plays += 1;
    };

    assert.equal(queue.enqueue({ phraseId: "a", phraseIndex: 0, play }), true);
    assert.equal(queue.enqueue({ phraseId: "a", phraseIndex: 0, play }), false);
    await queue.settled();

    assert.equal(plays, 1);
  });

  it("keeps going when a cancelled phrase leaves a gap", async () => {
    const order: string[] = [];
    const queue = createOrderedPlaybackQueue();

    queue.enqueue({
      phraseId: "c",
      phraseIndex: 2,
      play: async () => {
        order.push("c");
      },
    });
    queue.enqueue({
      phraseId: "a",
      phraseIndex: 0,
      play: async () => {
        order.push("a");
      },
    });
    await queue.settled();
    assert.deepEqual(order, ["a"]);

    queue.discard(1);
    await queue.settled();

    assert.deepEqual(order, ["a", "c"]);
  });

  it("aborts the voice and drops the backlog on panic mute", async () => {
    const queue = createOrderedPlaybackQueue();
    const gate = deferred();
    let aborted = false;
    let laterPlayed = false;

    queue.enqueue({
      phraseId: "a",
      phraseIndex: 0,
      play: async (signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          gate.resolve();
        });
        await gate.promise;
      },
    });
    queue.enqueue({
      phraseId: "b",
      phraseIndex: 1,
      play: async () => {
        laterPlayed = true;
      },
    });

    queue.panicMute();
    await queue.settled();

    assert.equal(aborted, true);
    assert.equal(laterPlayed, false);
    assert.equal(queue.snapshot().muted, true);
    assert.equal(
      queue.enqueue({ phraseId: "c", phraseIndex: 2, play: async () => {} }),
      false,
    );

    queue.reset();
    assert.equal(queue.snapshot().muted, false);
    assert.equal(queue.snapshot().nextIndex, 0);
  });

  it("reports congestion while phrases pile up", async () => {
    const signals: boolean[] = [];
    const queue = createOrderedPlaybackQueue({
      maxPending: 2,
      onCongestion: (congested) => signals.push(congested),
    });
    const gate = deferred();

    queue.enqueue({
      phraseId: "a",
      phraseIndex: 0,
      play: async () => {
        await gate.promise;
      },
    });
    queue.enqueue({ phraseId: "b", phraseIndex: 1, play: async () => {} });
    queue.enqueue({ phraseId: "c", phraseIndex: 2, play: async () => {} });

    assert.deepEqual(signals, [true]);
    assert.equal(queue.snapshot().congested, true);

    gate.resolve();
    await queue.settled();

    assert.deepEqual(signals, [true, false]);
    assert.equal(queue.snapshot().pending, 0);
  });
});
