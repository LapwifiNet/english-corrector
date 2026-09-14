import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectBlackHoleAvailability,
  isBlackHoleLabel,
  rememberBlackHoleOutput,
  restoreRememberedBlackHoleOutput,
  serializeRememberedBlackHoleOutput,
  type VirtualOutputDescriptor,
} from "./blackHoleAvailability";

function output(
  deviceId: string,
  label: string,
  available = true,
): VirtualOutputDescriptor {
  return { deviceId, kind: "audiooutput", label, available };
}

function scan(...devices: VirtualOutputDescriptor[]) {
  return { ok: true as const, devices };
}

describe("BlackHole availability", () => {
  it("recognizes compact and spaced BlackHole labels", () => {
    assert.equal(isBlackHoleLabel("BlackHole 2ch"), true);
    assert.equal(isBlackHoleLabel("Black Hole 16ch"), true);
    assert.equal(isBlackHoleLabel("Built-in Output"), false);
  });

  it("reports an available BlackHole output", () => {
    assert.deepEqual(
      detectBlackHoleAvailability(scan(output("bh-2", "BlackHole 2ch"))),
      {
        status: "available",
        output: { deviceId: "bh-2", label: "BlackHole 2ch" },
      },
    );
  });

  it("prefers the two-channel output without changing selection", () => {
    const result = detectBlackHoleAvailability(
      scan(
        output("bh-64", "BlackHole 64ch"),
        output("bh-2", "BlackHole 2ch"),
        output("bh-16", "BlackHole 16ch"),
      ),
    );
    assert.equal(result.status, "available");
    assert.equal(
      result.status === "available" && result.output.deviceId,
      "bh-2",
    );
  });

  it("ignores input devices with a BlackHole label", () => {
    assert.deepEqual(
      detectBlackHoleAvailability(
        scan({
          deviceId: "bh-input",
          kind: "audioinput",
          label: "BlackHole 2ch",
        }),
      ),
      { status: "missing" },
    );
  });

  it("reports missing when no recognized output was remembered", () => {
    assert.deepEqual(
      detectBlackHoleAvailability(scan(output("speaker", "Mac Speakers"))),
      { status: "missing" },
    );
  });

  it("does not treat an ordinary saved output as renamed", () => {
    assert.deepEqual(
      detectBlackHoleAvailability(scan(output("speaker", "Mac Speakers"))),
      { status: "missing" },
    );
  });

  it("recognizes a renamed output only by its remembered device id", () => {
    const remembered = { version: 1 as const, deviceId: "bh-2" };
    assert.deepEqual(
      detectBlackHoleAvailability(
        scan(output("bh-2", "English Corrector Virtual Mic")),
        remembered,
      ),
      {
        status: "renamed",
        output: {
          deviceId: "bh-2",
          label: "English Corrector Virtual Mic",
        },
      },
    );
  });

  it("reports a remembered output that disappeared as unavailable", () => {
    assert.deepEqual(
      detectBlackHoleAvailability(scan(), {
        version: 1,
        deviceId: "bh-2",
      }),
      { status: "unavailable", reason: "remembered_device_missing" },
    );
  });

  it("uses a newly detected BlackHole when the remembered one disappeared", () => {
    assert.deepEqual(
      detectBlackHoleAvailability(scan(output("bh-new", "BlackHole 2ch")), {
        version: 1,
        deviceId: "bh-old",
      }),
      {
        status: "available",
        output: { deviceId: "bh-new", label: "BlackHole 2ch" },
      },
    );
  });

  it("reports a recognized but unusable output", () => {
    assert.deepEqual(
      detectBlackHoleAvailability(scan(output("bh-2", "BlackHole 2ch", false))),
      {
        status: "unavailable",
        reason: "candidate_unusable",
        output: { deviceId: "bh-2", label: "BlackHole 2ch" },
      },
    );
  });

  it("keeps enumeration failures explicit", () => {
    assert.deepEqual(
      detectBlackHoleAvailability({
        ok: false,
        reason: "enumeration_unavailable",
      }),
      { status: "unavailable", reason: "enumeration_unavailable" },
    );
    assert.deepEqual(
      detectBlackHoleAvailability({ ok: false, reason: "enumeration_failed" }),
      { status: "unavailable", reason: "enumeration_failed" },
    );
  });

  it("round trips only the versioned BlackHole device id", () => {
    const remembered = rememberBlackHoleOutput({
      deviceId: "bh-2",
      label: "BlackHole 2ch",
    });
    const raw = serializeRememberedBlackHoleOutput(remembered);
    assert.equal(raw, '{"version":1,"deviceId":"bh-2"}');
    assert.deepEqual(restoreRememberedBlackHoleOutput(raw), remembered);
  });

  it("rejects malformed, stale, and empty remembered values", () => {
    assert.equal(restoreRememberedBlackHoleOutput("not-json"), null);
    assert.equal(
      restoreRememberedBlackHoleOutput('{"version":0,"deviceId":"bh-2"}'),
      null,
    );
    assert.equal(
      restoreRememberedBlackHoleOutput('{"version":1,"deviceId":""}'),
      null,
    );
  });
});
