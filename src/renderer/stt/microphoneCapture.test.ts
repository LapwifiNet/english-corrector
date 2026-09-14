import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMicrophoneConstraints,
  microphoneErrorCode,
} from "./microphoneCapture";

describe("microphone capture helpers", () => {
  it("targets one selected physical microphone with safe processing", () => {
    assert.deepEqual(buildMicrophoneConstraints("device-1"), {
      video: false,
      audio: {
        deviceId: { exact: "device-1" },
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });
  });

  it("maps browser microphone failures to stable codes", () => {
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    const missing = new Error("missing");
    missing.name = "NotFoundError";
    const busy = new Error("busy");
    busy.name = "NotReadableError";

    assert.equal(microphoneErrorCode(denied), "microphone_permission_denied");
    assert.equal(microphoneErrorCode(missing), "microphone_not_found");
    assert.equal(microphoneErrorCode(busy), "microphone_busy");
    assert.equal(
      microphoneErrorCode(new Error("unknown")),
      "microphone_capture_failed",
    );
  });
});
