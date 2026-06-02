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

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cmdEscape(value) {
  return String(value).replace(/%/g, "%%").replace(/[\r\n]/g, "");
}

function pidFilePath() {
  return path.join(appDataDir(), "hub.pid");
}

function readPid() {
  try {
    const content = fs.readFileSync(pidFilePath(), "utf8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function writePid(pid) {
  ensureDir(appDataDir());
  fs.writeFileSync(pidFilePath(), String(pid));
}

function removePid() {
  try { fs.unlinkSync(pidFilePath()); } catch {}
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    // kill -0 checks if process exists without sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  <string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(NODE)}</string>
    <string>${xmlEscape(HUB)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_PROVIDER_HUB_DATA_DIR</key>
    <string>${xmlEscape(dataDir)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(dataDir, "hub.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(dataDir, "hub.err.log"))}</string>
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

function windowsStart() {
  const dataDir = appDataDir();
  ensureDir(dataDir);
  
  // Check if already running
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Hub is already running (PID: ${existingPid})`);
    return;
  }
  
  // Start the hub process
  const child = childProcess.spawn(NODE, [HUB], {
    cwd: ROOT,
    env: { ...process.env, CODEX_PROVIDER_HUB_DATA_DIR: dataDir },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  });
  
  child.unref();
  writePid(child.pid);
  console.log(`Hub started (PID: ${child.pid})`);
}

function windowsStop() {
  const pid = readPid();
  if (!pid) {
    console.log("No PID file found. Hub may not be running.");
    removePid();
    return;
  }
  
  if (!isProcessRunning(pid)) {
    console.log(`Process ${pid} is not running. Cleaning up PID file.`);
    removePid();
    return;
  }
  
  try {
    // Use taskkill with specific PID instead of killing all node.exe
    const result = run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (result.status === 0) {
      console.log(`Hub stopped (PID: ${pid})`);
    } else {
      console.error(`Failed to stop hub: ${result.stderr || result.stdout}`);
    }
  } catch (err) {
    console.error(`Error stopping hub: ${err.message}`);
  } finally {
    removePid();
  }
}

function windowsStartupPath() {
  return path.join(process.env.APPDATA || os.homedir(), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Codex Provider Hub.cmd");
}

function windowsInstallStartup() {
  const startup = windowsStartupPath();
  const dataDir = appDataDir();
  ensureDir(path.dirname(startup));
  
  const cmdContent = [
    "@echo off",
    `set "CODEX_PROVIDER_HUB_DATA_DIR=${cmdEscape(dataDir)}"`,
    `cd /d "${cmdEscape(ROOT)}"`,
    `if not exist "${cmdEscape(pidFilePath())}" (`,
    `  start "" /min "${cmdEscape(NODE)}" "${cmdEscape(HUB)}"`,
    ")",
    ""
  ].join("\r\n");
  
  fs.writeFileSync(startup, cmdContent);
  console.log("Startup script installed:", startup);
}

function linuxStart() {
  const dataDir = appDataDir();
  ensureDir(dataDir);
  
  // Check if already running
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Hub is already running (PID: ${existingPid})`);
    return;
  }
  
  const child = childProcess.spawn(NODE, [HUB], {
    cwd: ROOT,
    env: { ...process.env, CODEX_PROVIDER_HUB_DATA_DIR: dataDir },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  });
  
  child.unref();
  writePid(child.pid);
  console.log(`Hub started (PID: ${child.pid})`);
}

function linuxStop() {
  const pid = readPid();
  if (!pid) {
    console.log("No PID file found. Hub may not be running.");
    removePid();
    return;
  }
  
  if (!isProcessRunning(pid)) {
    console.log(`Process ${pid} is not running. Cleaning up PID file.`);
    removePid();
    return;
  }
  
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Hub stopped (PID: ${pid})`);
  } catch (err) {
    console.error(`Error stopping hub: ${err.message}`);
  } finally {
    removePid();
  }
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
    windowsStop();
  } else {
    linuxStop();
  }
  console.log("Codex Provider Hub stop requested.");
}

function status() {
  const pid = readPid();
  if (!pid) {
    console.log("Hub is not running (no PID file)");
    return;
  }
  
  if (isProcessRunning(pid)) {
    console.log(`Hub is running (PID: ${pid})`);
  } else {
    console.log(`Hub is not running (stale PID file: ${pid})`);
    removePid();
  }
}

const cmd = process.argv[2] || "start";
try {
  if (cmd === "start") start();
  else if (cmd === "stop") stop();
  else if (cmd === "status") status();
  else if (cmd === "install-startup") {
    if (process.platform === "win32") windowsInstallStartup();
    else console.log("Startup installation is only supported on Windows.");
  }
  else throw new Error("usage: install-autostart.js [start|stop|status|install-startup]");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
