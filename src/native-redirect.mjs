// Native model redirection is retired in this fork.
// Keep the API shape so historical callers can report a clear disabled state.
// Existing on-disk redirect settings are deliberately ignored and never restored.
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./paths.mjs";

export const NATIVE_REDIRECT_PATH =
  process.env.MODEL_ROUTER_NATIVE_REDIRECT_STATE ||
  path.join(STATE_DIR, "native-redirect.json");

export function readNativeRedirect() {
  // Ignore all historical native-redirect.json settings, including a model
  // selected in a previous installation. Native Codex owns its model choice.
  return undefined;
}

export function nativeRedirectSnapshot() {
  return { model: null, path: NATIVE_REDIRECT_PATH };
}

export function setNativeRedirect(_slug) {
  throw new Error(
    "Native model redirection is retired. Select the model in the official Codex client.",
  );
}

export function clearNativeRedirect() {
  // Explicit cleanup remains available. No caller is allowed to recreate state.
  if (existsSync(NATIVE_REDIRECT_PATH)) unlinkSync(NATIVE_REDIRECT_PATH);
  return nativeRedirectSnapshot();
}
