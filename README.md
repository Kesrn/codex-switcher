# Codex Switcher

Codex Switcher is a local provider hub for Codex Desktop. It gives Codex one stable local endpoint, then lets you switch between MiMo, FuseCode, OpenAI-compatible providers, and custom providers from a browser panel.

## What It Solves

Newer Codex clients speak the OpenAI Responses API. Many third-party model vendors only expose Chat Completions or vendor-specific compatibility layers, so direct configuration can fail or require fragile per-provider edits.

Codex Switcher solves that by running a local hub:

```text
Codex Desktop
  -> http://127.0.0.1:8789/v1
  -> Codex Provider Hub
      -> MiMo v2.5 Pro
      -> FuseCode
      -> custom OpenAI Chat Completions providers
      -> custom Responses API providers
```

It also avoids repeatedly editing `~/.codex/config.toml`. Start the Hub once and it keeps Codex pointed at one stable local endpoint; later provider switches happen inside the Hub UI and apply on the next Codex request.

## Features

- One stable Codex endpoint: `http://127.0.0.1:8789/v1`
- Browser control panel: `http://127.0.0.1:8790`
- macOS and Windows launch scripts
- MiMo v2.5 Pro support through `mimo2codex`
- FuseCode support through native Responses passthrough
- Custom OpenAI Chat Completions providers
- Custom Responses API providers
- Local web-search enrichment that does not require MiMo's paid Web Search Plugin
- Local provider/key storage under `data/`

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

Start the Hub with the macOS or Windows launcher. The Hub automatically keeps Codex pointed at:

```text
http://127.0.0.1:8789/v1
```

Open the control panel when you want to switch providers:

```text
http://127.0.0.1:8790
```

## Switching Providers

Use the Provider Hub panel at:

```text
http://127.0.0.1:8790
```

Click a provider card to switch. The next Codex request uses the selected provider.

The built-in providers are:

- `mimo`: MiMo v2.5 Pro via `mimo2codex`
- `fusecode`: FuseCode via native Responses passthrough

## Adding a Custom Provider

In the Hub panel, fill out **Add Custom OpenAI-Compatible Provider**.

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
