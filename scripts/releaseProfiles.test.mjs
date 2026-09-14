import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RELEASE_PROFILES,
  ReleaseProfileError,
  rendererBuildMetadata,
  resolveReleaseProfile,
} from "./releaseProfiles.mjs";

const signedEnvironment = {
  MACOS_BUNDLE_ID: "com.example.english-corrector",
  MACOS_MIN_VERSION: "13.0",
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example",
  APPLE_ID: "release@example.com",
  APPLE_APP_SPECIFIC_PASSWORD: "private-app-password",
  npm_package_version: "0.2.0",
  GIT_COMMIT_SHA: "abcdef123456",
};

describe("release profiles", () => {
  it("defaults to an unsigned Intel development profile", () => {
    const resolved = resolveReleaseProfile();

    assert.equal(resolved.name, "development");
    assert.equal(resolved.bundleId, "local.english-corrector.dev");
    assert.equal(resolved.architecture, "x64");
    assert.equal(resolved.signingRequired, false);
    assert.equal(resolved.notarizationRequired, false);
    assert.equal(resolved.minimumMacOS, null);
  });

  it("rejects an unknown profile", () => {
    assert.throws(
      () => resolveReleaseProfile("nightly"),
      (error) =>
        error instanceof ReleaseProfileError &&
        error.code === "unknown_release_profile" &&
        error.profile === "nightly",
    );
  });

  it("lists every missing requirement for a signed beta", () => {
    assert.throws(
      () => resolveReleaseProfile("beta", {}),
      (error) => {
        assert.ok(error instanceof ReleaseProfileError);
        assert.equal(error.code, "release_configuration_missing");
        assert.equal(error.profile, "beta");
        assert.deepEqual(error.missing, [
          "MACOS_BUNDLE_ID",
          "MACOS_MIN_VERSION",
          "APPLE_TEAM_ID",
          "APPLE_SIGNING_IDENTITY",
          "APPLE_NOTARIZATION_CREDENTIALS",
        ]);
        return true;
      },
    );
  });

  it("resolves a signed beta with Apple ID notarization", () => {
    const resolved = resolveReleaseProfile("beta", signedEnvironment);

    assert.equal(resolved.bundleId, "com.example.english-corrector.beta");
    assert.equal(resolved.minimumMacOS, "13.0");
    assert.equal(resolved.notarizationCredentials, "apple-id");
    assert.equal(resolved.version, "0.2.0");
    assert.equal(resolved.commitSha, "abcdef123456");
  });

  it("supports App Store Connect API notarization", () => {
    const resolved = resolveReleaseProfile("production", {
      ...signedEnvironment,
      APPLE_ID: "",
      APPLE_APP_SPECIFIC_PASSWORD: "",
      APPLE_API_KEY_ID: "KEY123",
      APPLE_API_ISSUER_ID: "issuer-123",
      APPLE_API_KEY_PATH: "/secure/AuthKey.p8",
    });

    assert.equal(resolved.bundleId, "com.example.english-corrector");
    assert.equal(resolved.notarizationCredentials, "app-store-connect-api");
  });

  it("rejects malformed bundle and macOS version values", () => {
    assert.throws(
      () =>
        resolveReleaseProfile("beta", {
          ...signedEnvironment,
          MACOS_BUNDLE_ID: "not a bundle id",
        }),
      (error) =>
        error instanceof ReleaseProfileError &&
        error.code === "invalid_macos_bundle_id",
    );
    assert.throws(
      () =>
        resolveReleaseProfile("beta", {
          ...signedEnvironment,
          MACOS_MIN_VERSION: "latest",
        }),
      (error) =>
        error instanceof ReleaseProfileError &&
        error.code === "invalid_macos_min_version",
    );
  });

  it("never exposes production credential values", () => {
    const resolved = resolveReleaseProfile("production", {
      ...signedEnvironment,
      APPLE_ID: "",
      APPLE_APP_SPECIFIC_PASSWORD: "",
      APPLE_API_KEY_ID: "private-key-id",
      APPLE_API_ISSUER_ID: "private-issuer-id",
      APPLE_API_KEY_PATH: "/private/AuthKey.p8",
    });
    const serialized = JSON.stringify(resolved);

    assert.doesNotMatch(serialized, /private-key-id/);
    assert.doesNotMatch(serialized, /private-issuer-id/);
    assert.doesNotMatch(serialized, /AuthKey\.p8/);
    assert.doesNotMatch(serialized, /Developer ID Application/);
    assert.doesNotMatch(serialized, /TEAM123456/);
  });

  it("sanitizes user-controlled public metadata", () => {
    const resolved = resolveReleaseProfile("beta", {
      ...signedEnvironment,
      npm_package_version: "secret value with spaces",
      GIT_COMMIT_SHA: "not-a-commit-secret",
    });

    assert.equal(resolved.version, "0.0.0-dev");
    assert.equal(resolved.commitSha, "unknown");
  });

  it("allows only public build metadata into the renderer", () => {
    const metadata = rendererBuildMetadata(
      resolveReleaseProfile("beta", signedEnvironment),
    );

    assert.deepEqual(Object.keys(metadata), [
      "profile",
      "channel",
      "version",
      "commitSha",
      "architecture",
    ]);
    assert.equal(metadata.profile, "beta");
    assert.equal(metadata.architecture, "x64");
  });

  it("keeps configured bundle identifiers deterministic and unique", () => {
    const baseEnvironment = {
      MACOS_BUNDLE_ID: signedEnvironment.MACOS_BUNDLE_ID,
    };
    const identifiers = [
      resolveReleaseProfile("development", baseEnvironment).bundleId,
      resolveReleaseProfile("beta", signedEnvironment).bundleId,
      resolveReleaseProfile("production", signedEnvironment).bundleId,
    ];

    assert.deepEqual(identifiers, [
      "com.example.english-corrector.dev",
      "com.example.english-corrector.beta",
      "com.example.english-corrector",
    ]);
    assert.equal(
      new Set(identifiers).size,
      Object.keys(RELEASE_PROFILES).length,
    );
  });
});
