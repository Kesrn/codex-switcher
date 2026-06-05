# Codex Switcher

Codex Switcher is a local provider hub for Codex Desktop. It gives Codex one stable local proxy endpoint, then lets you switch between manually added providers from a browser panel.

## What It Solves

Newer Codex clients speak the OpenAI Responses API. Many third-party model vendors only expose Chat Completions or vendor-specific compatibility layers, so direct configuration can fail or require fragile per-provider edits.

Codex Switcher solves that by running a local hub:

```text
Codex Desktop
  -> http://127.0.0.1:8789/v1
  -> Codex Provider Hub
      -> manually added OpenAI Chat Completions providers
      -> manually added Responses API providers
      -> manually added MiMo-compatible providers
```

It also avoids repeatedly editing `~/.codex/config.toml`. Add each provider manually in the Hub UI, then click **Start Proxy** to route Codex through the local endpoint. Click **Stop Proxy** to restore Codex to the official OpenAI configuration.

## Features

- One stable Codex endpoint: `http://127.0.0.1:8789/v1`
- Browser control panel: `http://127.0.0.1:8790`
- macOS and Windows launch scripts
- MiMo-compatible support through `mimo2codex`
- Native Responses API passthrough
- Custom OpenAI Chat Completions providers
- Custom Responses API providers
- Local web-search enrichment that does not require MiMo's paid Web Search Plugin
- Local provider/key storage under `data/`
- No bundled default provider configs; every provider must be added by the user

## Folder Layout

```text
codex-switcher/
  README.md
  codex-provider-hub/
    hub.js
    install-autostart.js
    open-mac.command
    open-windows.cmd
    package.json
  data/                 # created locally, ignored by git
```

The `data/` directory contains local provider settings, keys, logs, and adapter state. Do not commit it.

## Requirements

- Node.js 18 or newer
- Codex Desktop
- A provider API key for whichever provider you want to use

## macOS Usage

Open:

```text
codex-provider-hub/open-mac.command
```

This will:

1. Install npm dependencies if needed.
2. Register a LaunchAgent for the Hub.
3. Open the control panel at `http://127.0.0.1:8790`.

## Desktop App

The Hub can also run as an Electron desktop app, so you do not need to use an external browser:

```bash
cd codex-provider-hub
npm install
npm run app
```

The desktop app starts or reuses the local Hub and opens the same control panel inside an app window.

## Packaging

Build distributable desktop installers from `codex-provider-hub`:

```bash
cd codex-provider-hub
npm install
npm run dist:mac   # macOS .dmg
npm run dist:win   # Windows .exe installer, best run on Windows
npm run dist       # both targets when the host supports them
```

Artifacts are written to `codex-provider-hub/dist/`:

- macOS: `Codex Switcher-<version>-<arch>.dmg`
- Windows: `Codex Switcher-Setup-<version>-x64.exe`

For release builds, package on each target OS when possible. Cross-building the Windows installer from macOS may require Wine and Electron Builder's Windows helper downloads.

## Windows Usage

Open:

```text
codex-provider-hub/open-windows.cmd
```

This will:

1. Install npm dependencies if needed.
2. Register a Startup shortcut for the Hub.
3. Open the control panel at `http://127.0.0.1:8790`.

## Setup

Start the Hub with the macOS or Windows launcher. Add a provider in the control panel, then click **Start Proxy** to point Codex at:

```text
http://127.0.0.1:8789/v1
```

Open the control panel when you want to add, test, switch, start, or stop the proxy:

```text
http://127.0.0.1:8790
```

## Switching Providers

Use the Provider Hub panel at:

```text
http://127.0.0.1:8790
```

There are no built-in provider entries. Add every provider manually, including API key, base URL, and model. Click a provider card to switch; when the proxy is running, the next Codex request uses the selected provider.

## Adding a Provider

In the Hub panel, fill out **Add Provider**.

For Chat Completions compatible providers, use:

```text
Type: OpenAI Chat Completions
Base URL: https://example.com/v1
Model: your-model-name
API Key: your-key
```

For providers that natively support Responses API, use:

```text
Type: Responses API
Base URL: https://example.com
Model: your-model-name
API Key: your-key
```

The Hub stores keys locally in `data/keys.json`.

## Local Web Search

MiMo's official Web Search Plugin is separately billed. Codex Switcher avoids sending Codex `web_search` tools to MiMo directly. Instead, when a prompt looks like it needs current information, the Hub performs a local web search and injects the results into the request context.

This is a lightweight helper, not the same as the vendor's official plugin. Accuracy depends on public search results.

## Development

Run the Hub manually:

```bash
cd codex-provider-hub
npm install
npm start
```

Run the desktop app during development:

```bash
npm run app
```

Useful URLs:

```text
Hub UI:  http://127.0.0.1:8790
Codex:   http://127.0.0.1:8789/v1
Models:  http://127.0.0.1:8789/v1/models
```

## Safety

The repository intentionally ignores:

- `data/`
- `node_modules/`
- logs
- local databases
- API keys

Never commit `data/keys.json`.
