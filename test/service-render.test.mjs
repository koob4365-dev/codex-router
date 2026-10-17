import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function serviceEnv(platform, testRoot, target = "codex") {
  return {
    ...process.env,
    CODEX_HOME: path.join(testRoot, "codex home"),
    CODEX_ROUTER_STATE_DIR: path.join(testRoot, "router state"),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, `${target} router state`),
    MODEL_ROUTER_TARGET: target,
    CODEX_ROUTER_SERVICE_PLATFORM: platform,
    XDG_CONFIG_HOME: path.join(testRoot, "xdg config"),
  };
}

function serviceCommand(
  script,
  platform,
  testRoot,
  command = "render",
  target = "codex",
  sourceRoot = root,
  env = {},
) {
  const nodeArgs = sourceRoot === root ? [] : ["--preserve-symlinks", "--preserve-symlinks-main"];
  return execFileSync(
    process.execPath,
    [...nodeArgs, path.join(sourceRoot, "src", script), command],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      env: { ...serviceEnv(platform, testRoot, target), ...env },
    },
  );
}

function render(script, platform, testRoot, target = "codex", sourceRoot = root) {
  return serviceCommand(script, platform, testRoot, "render", target, sourceRoot);
}

// Mirrors src/service-windows.mjs: MODEL_ROUTER_STATE_DIR wins over every other
// state-directory source, and the fixture name deliberately carries a space.
function windowsStateDir(testRoot) {
  return path.join(testRoot, "codex router state");
}

// Mirrors the quoting in src/service-linux.mjs. Fixture paths are host-shaped,
// so on Windows they carry backslashes that the unit file has to escape; the
// expectation has to escape them too or the test only passes on POSIX hosts.
function systemdQuoted(value) {
  return `"${value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}

function launchdXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

test("background service definitions render for macOS, Linux, and Windows", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-services-"));
  try {
    const launchd = render("service-macos.mjs", "darwin", testRoot);
    assert.match(launchd, /<string>io\.github\.codex-router<\/string>/);
    assert.match(launchd, /<key>PATH<\/key>/);
    assert.match(launchd, /CODEX_ROUTER_STATE_DIR/);

    const systemd = render("service-linux.mjs", "linux", testRoot);
    assert.match(systemd, /\[Service\]/);
    assert.match(systemd, /ExecStart=/);
    assert.match(systemd, /Environment="PATH=/);
    assert.match(systemd, /Environment="CODEX_ROUTER_STATE_DIR=/);

    const windows = render("service-windows.mjs", "win32", testRoot);
    assert.match(windows, /@echo off\r?\n/);
    assert.match(windows, /set "CODEX_ROUTER_STATE_DIR=/);
    assert.match(windows, /litellm|start\.mjs/);
    // The Python gateway must run with UTF-8 output even when the host
    // console code page is not UTF-8 (see service-windows.mjs).
    assert.match(windows, /set "PYTHONIOENCODING=utf-8"/);
    assert.match(windows, /set "PYTHONUTF8=1"/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("packaged services preserve wrapper and PATH values with service-safe quoting", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-packaged-service-"));
  const stableRoot = path.join(testRoot, "opt % router", "libexec");
  const stableNode = path.join(testRoot, 'runtime "bin" %', "node wrapper");
  const servicePath = `${path.dirname(stableNode)}:${path.join(testRoot, "support & tools")}`;
  const env = {
    CODEX_ROUTER_SOURCE_ROOT: stableRoot,
    CODEX_ROUTER_NODE_BIN: stableNode,
    CODEX_ROUTER_PACKAGE_MANAGER: "homebrew",
    PATH: servicePath,
  };
  try {
    const launchd = serviceCommand(
      "service-macos.mjs",
      "darwin",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.ok(launchd.includes(`<string>${launchdXml(stableNode)}</string>`));
    assert.ok(
      launchd.includes(
        `<key>PATH</key>\n    <string>${launchdXml(servicePath)}</string>`,
      ),
    );
    assert.match(launchd, /<key>CODEX_ROUTER_SOURCE_ROOT<\/key>/);
    assert.match(launchd, /<key>CODEX_ROUTER_NODE_BIN<\/key>/);
    assert.match(launchd, /<string>homebrew<\/string>/);

    const systemd = serviceCommand(
      "service-linux.mjs",
      "linux",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.ok(systemd.includes(`WorkingDirectory=${stableRoot.replaceAll("%", "%%")}`));
    assert.ok(systemd.includes(`ExecStart=${systemdQuoted(stableNode)}`));
    assert.ok(systemd.includes(`Environment=${systemdQuoted(`PATH=${servicePath}`)}`));
    assert.ok(systemd.includes(`Environment="CODEX_ROUTER_PACKAGE_MANAGER=homebrew"`));
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Windows launcher starts the wrapper hidden and propagates its exit code", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-hidden-launcher-"));
  try {
    const stateDir = windowsStateDir(testRoot);
    assert.ok(stateDir.includes(" "), "the fixture state directory must contain a space");
    const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
    const script = serviceCommand("service-windows.mjs", "win32", testRoot, "render-launcher");

    assert.match(script, /^Option Explicit\r\n/);
    assert.match(script, /\r\nSet shell = CreateObject\("WScript\.Shell"\)\r\n/);
    // Window style 0 hides the wrapper's console; True waits for it so that
    // Run returns the wrapper's exit code instead of returning immediately.
    assert.ok(
      script.includes(
        `status = shell.Run("cmd.exe /D /C " & quote & quote & "${wrapperPath}" & quote & quote, 0, True)\r\n`,
      ),
      `launcher did not embed the wrapper path correctly:\n${script}`,
    );
    // Without this line Task Scheduler reads every crash as a clean exit and
    // the RestartCount/RestartInterval settings never fire again.
    assert.match(script, /\r\nWScript\.Quit status\r\n$/);
    // A failure to even start the wrapper must also surface as a failure.
    assert.match(script, /\r\nIf Err\.Number <> 0 Then\r\n {2}WScript\.Quit 1\r\nEnd If\r\n/);

    // Every generated line must be a valid VBScript statement: string literals
    // escape a double quote by doubling it, so quotes always come in pairs.
    for (const line of script.split("\r\n")) {
      assert.equal(
        (line.match(/"/g) || []).length % 2,
        0,
        `unbalanced quotes in generated line: ${line}`,
      );
    }
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Windows scheduled task runs the VBS launcher through wscript.exe", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-task-action-"));
  try {
    const launcherPath = path.join(windowsStateDir(testRoot), "start-codex-router-hidden.vbs");
    const action = JSON.parse(
      serviceCommand("service-windows.mjs", "win32", testRoot, "render-task"),
    );

    assert.equal(action.execute, "wscript.exe");
    // //B and //NoLogo keep the windowless host quiet; the launcher path takes a
    // single quote pair because wscript.exe uses the standard argument parser.
    assert.equal(action.argument, `//B //NoLogo "${launcherPath}"`);
    // The console-visible cmd.exe action is what issue #98 reported.
    assert.doesNotMatch(`${action.execute} ${action.argument}`, /cmd\.exe/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

// The scheduled task's restart policy is the reason the exit code matters:
// Task Scheduler only re-triggers RestartCount/RestartInterval when the action
// reports a failure, so a launcher that swallowed the wrapper's exit code would
// trade a console window for a router that stays dead after its first crash.
// Nothing off Windows can execute a .vbs, so -- exactly like
// `install.ps1 parses under powershell.exe` in test/installer-scripts.test.mjs --
// this is the only place that link is executed rather than reasoned about.
//
// wscript.exe with //B //NoLogo is the host the scheduled task actually uses
// (see taskAction in src/service-windows.mjs). cscript.exe is the console host
// over the same script engine, and it runs without //B so that a broken
// launcher reports the parse or runtime error on stderr instead of arriving as
// an unexplained exit code.
const WINDOWS_SCRIPT_HOSTS = [
  { name: "cscript.exe", args: ["//NoLogo"] },
  { name: "wscript.exe", args: ["//B", "//NoLogo"] },
];

// Resolved absolutely: these live in the system directory, and naming them
// outright keeps the test independent of whatever PATH the runner supplies.
function scriptHost(name) {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
}

test(
  "the generated Windows launcher returns the wrapper's exit code to its script host",
  { skip: process.platform !== "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-vbs-exit-"));
    try {
      const stateDir = windowsStateDir(testRoot);
      mkdirSync(stateDir, { recursive: true });
      const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
      const launcherPath = path.join(stateDir, "start-codex-router-hidden.vbs");

      // The shipped generator produces the source. Only the encoding is
      // repeated here: `install` is the code path that writes the file, and
      // running it would register a real scheduled task on this machine.
      // `the Windows installer writes both launchers idempotently` asserts that
      // the shipped writer emits exactly these bytes.
      const source = serviceCommand(
        "service-windows.mjs",
        "win32",
        testRoot,
        "render-launcher",
      );
      const encoded = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(source, "utf16le"),
      ]);
      writeFileSync(launcherPath, encoded);

      const report = (host, result, expectation, note) =>
        [
          `host: ${host.name} ${host.args.join(" ")} "${launcherPath}"`,
          `expected exit code: ${expectation}`,
          `actual exit code: ${result.status}`,
          `terminating signal: ${result.signal ?? "none"}`,
          `spawn error: ${result.error ? result.error.message : "none"}`,
          `stdout: ${(result.stdout || "").trim() || "(empty)"}`,
          `stderr: ${(result.stderr || "").trim() || "(empty)"}`,
          note,
          "generated launcher source:",
          source,
        ].join("\n");

      const runLauncher = (host) => {
        const result = spawnSync(scriptHost(host.name), [...host.args, launcherPath], {
          encoding: "utf8",
          timeout: 60_000,
          windowsHide: true,
        });
        // A spawn failure or a timeout leaves status null, which would satisfy
        // the "not zero" assertion below without the launcher having run at all.
        assert.equal(
          typeof result.status,
          "number",
          report(host, result, "any number", "the script host did not run to completion"),
        );
        return result;
      };

      for (const host of WINDOWS_SCRIPT_HOSTS) {
        // A crashed router has to reach Task Scheduler as a failed run. 42 is
        // arbitrary and distinctive: it is neither the 1 a WSH script error
        // produces nor the 0 a silent success would.
        writeFileSync(wrapperPath, "@echo off\r\nexit /b 42\r\n");
        let result = runLauncher(host);
        assert.equal(
          result.status,
          42,
          report(host, result, 42, "the wrapper's exit code must reach the host unchanged"),
        );

        // ...and the reverse: a clean stop must not be reported as a failure,
        // or the task restarts a router that was deliberately shut down.
        writeFileSync(wrapperPath, "@echo off\r\nexit /b 0\r\n");
        result = runLauncher(host);
        assert.equal(
          result.status,
          0,
          report(host, result, 0, "a clean wrapper exit must not be reported as a failure"),
        );

        // A wrapper that cannot start at all must still fail. `On Error Resume
        // Next` without the Err.Number guard leaves `status` unset, and
        // `WScript.Quit` on an unset value exits 0 -- which is the shape that
        // silently disables the restart policy. cmd.exe itself reports this
        // particular failure; the Err.Number branch covers a cmd.exe that will
        // not start, which no ordinary host can reproduce because CreateProcess
        // resolves it from the system directory whatever PATH says.
        rmSync(wrapperPath);
        result = runLauncher(host);
        assert.notEqual(
          result.status,
          0,
          report(host, result, "anything but 0", "a wrapper that never ran must not report success"),
        );
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "the Windows auto-start installer is disabled by default",
  { skip: process.platform === "win32" },
  () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "codex-router-native-default-"));
    try {
      const result = spawnSync(process.execPath, [path.join(root, "src", "service-windows.mjs"), "install"], {
        cwd: root,
        encoding: "utf8",
        env: { ...serviceEnv("win32", temp), CODEX_ROUTER_ENABLE_LEGACY_TASK: "" },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /disabled/i);
      assert.equal(existsSync(windowsStateDir(temp)), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

// Legacy tests below are isolated with an explicit opt-in. This does not
// authorize router installation or scheduling in the user's Windows.
function schedulerStubs(directory, options = {}) {
  const { schtasksFail = "", powershellFail = "", runningQueries = 0 } = options;
  mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, "calls.log");
  const counterPath = path.join(directory, "state-queries");
  const preamble = (fail) =>
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${logPath}"`,
      `for pattern in ${fail}; do`,
      '  case "$*" in *"$pattern"*) exit 1 ;; esac',
      "done",
    ].join("\n");

  writeFileSync(path.join(directory, "schtasks.exe"), `${preamble(schtasksFail)}\nexit 0\n`);
  // taskState() reads the task state off this process's stdout. The counter is
  // what lets a test say "report Running for the first N queries", so the stop
  // wait can be observed polling and then finishing.
  writeFileSync(
    path.join(directory, "powershell.exe"),
    [
      preamble(powershellFail),
      'case "$*" in',
      "  *Get-ScheduledTask*)",
      "    count=0",
      `    if [ -f "${counterPath}" ]; then count=$(cat "${counterPath}"); fi`,
      "    count=$((count + 1))",
      `    printf '%s' "$count" > "${counterPath}"`,
      `    if [ "$count" -le ${runningQueries} ]; then printf 'Running'; else printf 'Ready'; fi`,
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );

  for (const name of ["schtasks.exe", "powershell.exe"]) {
    chmodSync(path.join(directory, name), 0o755);
  }
  return {
    path: `${directory}${path.delimiter}${process.env.PATH}`,
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").filter(Boolean)
        : [],
  };
}

function runWindowsService(testRoot, command, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [path.join(root, "src", "service-windows.mjs"), command],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...serviceEnv("win32", testRoot), ...extraEnv },
    },
  );
}

test(
  "explicit legacy task registration does not start a router automatically",
  { skip: process.platform === "win32" },
  () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "codex-router-opt-in-"));
    try {
      const stubs = schedulerStubs(path.join(temp, "stubs"));
      const result = runWindowsService(temp, "install", {
        PATH: stubs.path,
        CODEX_ROUTER_ENABLE_LEGACY_TASK: "1",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).installed, true);
      const calls = stubs.calls();
      const registration = calls.find((call) => call.includes("Register-ScheduledTask"));
      assert.ok(registration);
      // This preference belongs to the isolated registration process, before
      // any task cmdlet, so non-terminating PowerShell errors fail the install.
      assert.match(registration, /-Command \$ErrorActionPreference = 'Stop'; \$action = New-ScheduledTaskAction/);
      assert.ok(!calls.some((call) => call.includes("/Run")));
      assert.ok(!calls.some((call) => call.includes("ONLOGON")));
      assert.ok(!calls.some((call) => call.includes("-RestartCount")));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "registration failures do not create fallback tasks or relaunch the router",
  { skip: process.platform === "win32" },
  () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "codex-router-no-fallback-"));
    try {
      const stubs = schedulerStubs(path.join(temp, "stubs"), {
        powershellFail: "Register-ScheduledTask",
      });
      const result = runWindowsService(temp, "install", {
        PATH: stubs.path,
        CODEX_ROUTER_ENABLE_LEGACY_TASK: "1",
      });
      assert.equal(typeof result.status, "number", result.error?.message);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Scheduled task registration failed without fallback/);
      assert.equal(result.stdout, "");
      const calls = stubs.calls();
      assert.ok(calls.some((call) => call.includes("Register-ScheduledTask")));
      assert.ok(!calls.some((call) => call.includes("/Create")));
      assert.ok(!calls.some((call) => call.includes("/Run")));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "launcher write failures do not report installation success or touch tasks",
  { skip: process.platform === "win32" },
  () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "codex-router-write-failure-"));
    try {
      const stubs = schedulerStubs(path.join(temp, "stubs"));
      // A file in place of the state directory deterministically blocks writes.
      writeFileSync(windowsStateDir(temp), "blocked");
      const result = runWindowsService(temp, "install", {
        PATH: stubs.path,
        CODEX_ROUTER_ENABLE_LEGACY_TASK: "1",
      });
      assert.equal(typeof result.status, "number", result.error?.message);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.deepEqual(stubs.calls(), []);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "stopping a service that was never installed is not an error",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-stop-"));
    try {
      // No stubs on PATH, so schtasks.exe is missing exactly as it is when the
      // task does not exist. stop used to throw that straight at the caller
      // while uninstall and restart tolerated it.
      const result = runWindowsService(testRoot, "stop");
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { state: "stopped" });
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "systemd WorkingDirectory is unquoted and escapes literal specifiers",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-systemd-path-"));
    const linkedRoot = path.join(testRoot, "router %u");
    symlinkSync(root, linkedRoot, "dir");
    try {
      const systemd = render("service-linux.mjs", "linux", testRoot, "codex", linkedRoot);
      const workingDirectory = systemd
        .split(/\r?\n/)
        .find((line) => line.startsWith("WorkingDirectory="));
      assert.equal(
        workingDirectory,
        `WorkingDirectory=${linkedRoot.replaceAll("%", "%%")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

