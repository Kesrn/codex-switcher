const { app, BrowserWindow, Menu, Tray, shell } = require("electron");
const http = require("http");
const path = require("path");
const childProcess = require("child_process");

const ROOT = __dirname;
const API_HOST = "127.0.0.1";
const UI_PORT = Number(process.env.CODEX_PROVIDER_HUB_UI_PORT || 8790);
const DATA_DIR = process.env.CODEX_PROVIDER_HUB_DATA_DIR || path.join(ROOT, "..", "data");
const NODE = process.env.CODEX_PROVIDER_HUB_NODE || process.env.npm_node_execpath || "node";

let mainWindow = null;
let tray = null;
let hubProcess = null;
let isQuitting = false;

function canConnect(timeoutMs = 400) {
  return new Promise((resolve) => {
    const req = http.get({ host: API_HOST, port: UI_PORT, path: "/", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForHub(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect()) return true;
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  return false;
}

async function ensureHub() {
  if (await canConnect()) return;
  hubProcess = childProcess.spawn(NODE, [path.join(ROOT, "hub.js")], {
    cwd: ROOT,
    env: { ...process.env, CODEX_PROVIDER_HUB_DATA_DIR: DATA_DIR },
    stdio: "ignore",
    windowsHide: true
  });
  hubProcess.on("exit", () => {
    hubProcess = null;
  });
  if (!await waitForHub()) throw new Error(`Codex Provider Hub did not start on ${UI_PORT}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: "Codex Switcher",
    backgroundColor: "#6e6e6e",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(`http://${API_HOST}:${UI_PORT}`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("close", (event) => {
    if (process.platform === "darwin" && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  if (tray || process.platform === "linux") return;
  const icon = process.platform === "darwin" ? undefined : undefined;
  try {
    tray = new Tray(icon || process.execPath);
  } catch {
    return;
  }
  tray.setToolTip("Codex Switcher");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Codex Switcher", click: () => { mainWindow?.show(); } },
    { label: "打开 Web 控制台", click: () => shell.openExternal(`http://${API_HOST}:${UI_PORT}`) },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } }
  ]));
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await ensureHub();
  createWindow();
  createTray();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
