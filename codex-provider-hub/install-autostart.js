#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

const ROOT = __dirname;
const LABEL = "com.local.codex-provider-hub";
const NODE = process.execPath;
const HUB = path.join(ROOT, "hub.js");
const LOCAL_DATA_DIR = path.join(ROOT, "..", "data");

function appDataDir() {
  if (process.env.CODEX_PROVIDER_HUB_DATA_DIR) return process.env.CODEX_PROVIDER_HUB_DATA_DIR;
  return LOCAL_DATA_DIR;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(command, args) {
  return childProcess.spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function macPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function macPlist() {
  const dataDir = appDataDir();
  ensureDir(dataDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${HUB}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_PROVIDER_HUB_DATA_DIR</key>
    <string>${dataDir}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${path.join(dataDir, "hub.out.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(dataDir, "hub.err.log")}</string>
</dict>
</plist>
`;
}

function macStart() {
  const plist = macPlistPath();
  ensureDir(path.dirname(plist));
  fs.writeFileSync(plist, macPlist());
  run("launchctl", ["bootout", `gui/${os.userInfo().uid}/${LABEL}`]);
  sleep(500);
  const result = run("launchctl", ["bootstrap", `gui/${os.userInfo().uid}`, plist]);
  if (result.status !== 0 && !String(result.stderr || result.stdout).includes("service already loaded")) {
    const loaded = run("launchctl", ["print", `gui/${os.userInfo().uid}/${LABEL}`]);
    if (loaded.status !== 0) {
      throw new Error((result.stderr || result.stdout || "launchctl bootstrap failed").trim());
    }
  }
}

function windowsStartupPath() {
  return path.join(process.env.APPDATA || os.homedir(), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Codex Provider Hub.cmd");
}

function windowsStart() {
  const startup = windowsStartupPath();
  ensureDir(path.dirname(startup));
  fs.writeFileSync(startup, `@echo off\r\nset "CODEX_PROVIDER_HUB_DATA_DIR=${appDataDir()}"\r\ncd /d "${ROOT}"\r\nstart "" /min "${NODE}" "${HUB}"\r\n`);
  childProcess.spawn(NODE, [HUB], {
    cwd: ROOT,
    env: { ...process.env, CODEX_PROVIDER_HUB_DATA_DIR: appDataDir() },
    detached: true,
    stdio: "ignore",
    windowsHide: true
  }).unref();
}

function linuxStart() {
  childProcess.spawn(NODE, [HUB], {
    cwd: ROOT,
    env: { ...process.env, CODEX_PROVIDER_HUB_DATA_DIR: appDataDir() },
    detached: true,
    stdio: "ignore"
  }).unref();
}

function start() {
  if (process.platform === "darwin") macStart();
  else if (process.platform === "win32") windowsStart();
  else linuxStart();
  console.log("Codex Provider Hub start requested.");
}

function stop() {
  if (process.platform === "darwin") {
    run("launchctl", ["bootout", `gui/${os.userInfo().uid}/${LABEL}`]);
  } else if (process.platform === "win32") {
    run("taskkill", ["/IM", "node.exe", "/FI", `WINDOWTITLE eq ${LABEL}`, "/F"]);
  }
  console.log("Codex Provider Hub stop requested.");
}

const cmd = process.argv[2] || "start";
try {
  if (cmd === "start") start();
  else if (cmd === "stop") stop();
  else throw new Error("usage: install-autostart.js start|stop");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
