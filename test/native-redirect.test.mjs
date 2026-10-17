import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "native-redirect-retired-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  NATIVE_REDIRECT_PATH,
  clearNativeRedirect,
  nativeRedirectSnapshot,
  readNativeRedirect,
  setNativeRedirect,
} = await import("../src/native-redirect.mjs");

test("native redirect never activates from an old saved configuration", () => {
  writeFileSync(NATIVE_REDIRECT_PATH, JSON.stringify({
    version: 1, model: "grok-oauth/grok-4.5",
  }));
  assert.equal(readNativeRedirect(), undefined);
  assert.deepEqual(nativeRedirectSnapshot(), {
    model: null,
    path: NATIVE_REDIRECT_PATH,
  });
  assert.equal(existsSync(NATIVE_REDIRECT_PATH), true);
});

test("native redirect cannot be re-enabled by a router command", () => {
  assert.throws(
    () => setNativeRedirect("grok-oauth/grok-4.5"),
    /redirection is retired/,
  );
  assert.equal(readNativeRedirect(), undefined);
});

test("explicit cleanup removes retired redirect state", () => {
  assert.deepEqual(clearNativeRedirect(), {
    model: null,
    path: NATIVE_REDIRECT_PATH,
  });
  assert.equal(existsSync(NATIVE_REDIRECT_PATH), false);
  assert.equal(readNativeRedirect(), undefined);
});
