const REQUIRED_SIGNED_BUILD_ENV = Object.freeze([
  "MACOS_BUNDLE_ID",
  "MACOS_MIN_VERSION",
  "APPLE_TEAM_ID",
  "APPLE_SIGNING_IDENTITY",
]);

const DEFAULT_DEVELOPMENT_BUNDLE_ID_BASE = "local.english-corrector";
const BUNDLE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+)+$/;
const MACOS_VERSION_PATTERN = /^\d{1,2}\.\d+(?:\.\d+)?$/;
const PUBLIC_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

function profile(definition) {
  return Object.freeze(definition);
}

export const RELEASE_PROFILES = Object.freeze({
  development: profile({
    name: "development",
    channel: "development",
    bundleIdSuffix: ".dev",
    productName: "English Corrector Dev",
    architecture: "x64",
    signingRequired: false,
    notarizationRequired: false,
    requiredEnvironment: Object.freeze([]),
  }),
  beta: profile({
    name: "beta",
    channel: "beta",
    bundleIdSuffix: ".beta",
    productName: "English Corrector Beta",
    architecture: "x64",
    signingRequired: true,
    notarizationRequired: true,
    requiredEnvironment: REQUIRED_SIGNED_BUILD_ENV,
  }),
  production: profile({
    name: "production",
    channel: "stable",
    bundleIdSuffix: "",
    productName: "English Corrector",
    architecture: "x64",
    signingRequired: true,
    notarizationRequired: true,
    requiredEnvironment: REQUIRED_SIGNED_BUILD_ENV,
  }),
});

export class ReleaseProfileError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ReleaseProfileError";
    this.code = code;
    this.profile = details.profile;
    this.missing = Object.freeze([...(details.missing ?? [])]);
  }
}

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasAll(env, names) {
  return names.every((name) => clean(env[name]));
}

function notarizationCredentialMode(env) {
  if (
    hasAll(env, [
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER_ID",
      "APPLE_API_KEY_PATH",
    ])
  ) {
    return "app-store-connect-api";
  }

  if (hasAll(env, ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD"])) {
    return "apple-id";
  }

  return null;
}

function publicVersion(value) {
  const candidate = clean(value);
  return candidate && PUBLIC_VERSION_PATTERN.test(candidate)
    ? candidate
    : "0.0.0-dev";
}

function publicCommitSha(value) {
  const candidate = clean(value);
  return candidate && COMMIT_SHA_PATTERN.test(candidate)
    ? candidate
    : "unknown";
}

function resolveBundleId(definition, env) {
  const configuredBase = clean(env.MACOS_BUNDLE_ID);
  const base = configuredBase ?? DEFAULT_DEVELOPMENT_BUNDLE_ID_BASE;
  if (!BUNDLE_ID_PATTERN.test(base)) {
    throw new ReleaseProfileError("invalid_macos_bundle_id", {
      profile: definition.name,
    });
  }
  return `${base}${definition.bundleIdSuffix}`;
}

function resolveMinimumMacOS(definition, env) {
  const minimumMacOS = clean(env.MACOS_MIN_VERSION);
  if (minimumMacOS && !MACOS_VERSION_PATTERN.test(minimumMacOS)) {
    throw new ReleaseProfileError("invalid_macos_min_version", {
      profile: definition.name,
    });
  }
  return minimumMacOS;
}

export function resolveReleaseProfile(requestedName = "development", env = {}) {
  const name = clean(requestedName)?.toLowerCase() ?? "development";
  const definition = RELEASE_PROFILES[name];
  if (!definition) {
    throw new ReleaseProfileError("unknown_release_profile", { profile: name });
  }

  const missing = definition.requiredEnvironment.filter(
    (variable) => !clean(env[variable]),
  );
  const notarizationCredentials = definition.notarizationRequired
    ? notarizationCredentialMode(env)
    : "disabled";
  if (definition.notarizationRequired && !notarizationCredentials) {
    missing.push("APPLE_NOTARIZATION_CREDENTIALS");
  }
  if (missing.length) {
    throw new ReleaseProfileError("release_configuration_missing", {
      profile: name,
      missing,
    });
  }

  return Object.freeze({
    name: definition.name,
    channel: definition.channel,
    bundleId: resolveBundleId(definition, env),
    productName: definition.productName,
    architecture: definition.architecture,
    minimumMacOS: resolveMinimumMacOS(definition, env),
    signingRequired: definition.signingRequired,
    notarizationRequired: definition.notarizationRequired,
    notarizationCredentials,
    version: publicVersion(env.npm_package_version),
    commitSha: publicCommitSha(env.GIT_COMMIT_SHA),
  });
}

export function rendererBuildMetadata(resolvedProfile) {
  return Object.freeze({
    profile: resolvedProfile.name,
    channel: resolvedProfile.channel,
    version: resolvedProfile.version,
    commitSha: resolvedProfile.commitSha,
    architecture: resolvedProfile.architecture,
  });
}
