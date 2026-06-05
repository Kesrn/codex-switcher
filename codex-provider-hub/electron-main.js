const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const ROOT = __dirname;
const APP_ID = "cc.codex-switcher.app";
const API_HOST = "127.0.0.1";
const UI_PORT = Number(process.env.CODEX_PROVIDER_HUB_UI_PORT || 8790);
const DATA_DIR = process.env.CODEX_PROVIDER_HUB_DATA_DIR || path.join(app.getPath("userData"), "data");
const AUTH_TOKEN_PATH = path.join(DATA_DIR, "auth-token");

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

function packagedResourcePath(...parts) {
  return path.join(process.resourcesPath, ...parts);
}

function hubRoot() {
  if (app.isPackaged) {
    const unpacked = packagedResourcePath("app.asar.unpacked");
    if (fs.existsSync(path.join(unpacked, "hub.js"))) return unpacked;
  }
  return ROOT;
}

function hubScriptPath() {
  return path.join(hubRoot(), "hub.js");
}

function iconPath(file) {
  if (app.isPackaged) return packagedResourcePath("build", file);
  return path.join(ROOT, "build", file);
}

function existingIcon(file) {
  const candidate = iconPath(file);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function readAuthToken() {
  try {
    return fs.readFileSync(AUTH_TOKEN_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

function requestStatus(timeoutMs = 700) {
  const token = readAuthToken();
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get({
      host: API_HOST,
      port: UI_PORT,
      path: "/api/status",
      timeout: timeoutMs,
      headers: { authorization: `Bearer ${token}` }
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

function isOwnedHub(status) {
  return status?.appId === APP_ID && path.normalize(status.dataDir || "") === path.normalize(DATA_DIR);
}

async function waitForHub(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isOwnedHub(await requestStatus())) return true;
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  return false;
}

async function ensureHub() {
  if (isOwnedHub(await requestStatus())) return;
  if (await canConnect()) {
    throw new Error(`Port ${UI_PORT} is already used by another Hub. Stop the old Hub first, then reopen Codex Switcher.`);
  }
  const hubScript = hubScriptPath();
  hubProcess = childProcess.spawn(process.execPath, [hubScript], {
    cwd: path.dirname(hubScript),
    env: {
      ...process.env,
      CODEX_PROVIDER_HUB_DATA_DIR: DATA_DIR,
      ELECTRON_RUN_AS_NODE: "1"
    },
    stdio: "ignore",
    windowsHide: true
  });
  hubProcess.on("exit", () => {
    hubProcess = null;
  });
  if (!await waitForHub()) throw new Error(`Codex Provider Hub did not start on ${UI_PORT}`);
}

function createWindow() {
  const macWindowChrome = process.platform === "darwin" ? {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 }
  } : {};

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: "Codex Switcher",
    icon: existingIcon("icon.png"),
    backgroundColor: "#f3f4f6",
    ...macWindowChrome,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(`http://${API_HOST}:${UI_PORT}/?desktop=1&platform=${encodeURIComponent(process.platform)}`);
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
  const icon = process.platform === "darwin" ? existingIcon("trayTemplate.png") : existingIcon("icon.png");
  try {
    if (!icon) return;
    if (process.platform === "darwin") {
      const image = nativeImage.createFromPath(icon).resize({ width: 18, height: 18 });
      image.setTemplateImage(true);
      tray = new Tray(image);
    } else {
      tray = new Tray(icon);
    }
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
