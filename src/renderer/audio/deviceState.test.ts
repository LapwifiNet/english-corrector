import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  restoreDeviceId,
  routingWarning,
  toDeviceChoices,
  type AudioDeviceDescriptor,
} from "./deviceState";

const devices: AudioDeviceDescriptor[] = [
  {
    deviceId: "mic-1",
    groupId: "physical",
    kind: "audioinput",
    label: "Built-in Microphone",
  },
  {
    deviceId: "blackhole-out",
    groupId: "blackhole",
    kind: "audiooutput",
    label: "BlackHole 2ch",
  },
];

describe("toDeviceChoices", () => {
  it("returns only the requested device kind", () => {
    assert.deepEqual(
      toDeviceChoices(devices, "audioinput").map((device) => device.deviceId),
      ["mic-1"],
    );
  });

  it("creates a readable fallback label", () => {
    const unlabeled = [{ ...devices[0], label: "" }];
    assert.equal(
      toDeviceChoices(unlabeled, "audioinput")[0]?.displayName,
      "Microphone 1",
    );
  });
});

describe("restoreDeviceId", () => {
  const inputs = toDeviceChoices(devices, "audioinput");

  it("restores a device that still exists", () => {
    assert.equal(restoreDeviceId(inputs, "mic-1"), "mic-1");
  });

  it("does not silently fall back when a device disappears", () => {
    assert.equal(restoreDeviceId(inputs, "missing"), "");
  });
});

describe("routingWarning", () => {
  it("warns when input and output share a group", () => {
    const input = {
      ...toDeviceChoices(devices, "audioinput")[0]!,
      groupId: "same",
    };
    const output = {
      ...toDeviceChoices(devices, "audiooutput")[0]!,
      groupId: "same",
    };

    assert.match(routingWarning(input, output) ?? "", /feedback loop/);
  });

  it("allows distinct physical and virtual devices", () => {
    assert.equal(
      routingWarning(
        toDeviceChoices(devices, "audioinput")[0],
        toDeviceChoices(devices, "audiooutput")[0],
      ),
      null,
    );
  });
});
