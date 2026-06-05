# Codex Provider Hub

Cross-platform local provider hub for Codex Desktop.

## Start

macOS:

```bash
./open-mac.command
```

Windows:

```bat
open-windows.cmd
```

The UI opens at:

```text
http://127.0.0.1:8790
```

Desktop app mode:

```bash
npm run app
```

The Electron app starts or reuses the local Hub and displays the control panel in an app window.

## Package

```bash
npm install
npm run dist:mac   # .dmg
npm run dist:win   # .exe installer, best on Windows
```

Build artifacts are written to `dist/`.

Codex should point to:

```text
http://127.0.0.1:8789/v1
```

Add providers manually in the Hub UI. Click **Start Proxy** to route Codex through this local endpoint, and click **Stop Proxy** to restore the official OpenAI configuration.

Runtime data is stored next to this folder:

```text
../data
```

The launch scripts also register a lightweight autostart entry:

- macOS: `~/Library/LaunchAgents/com.local.codex-provider-hub.plist`
- Windows: `%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Codex Provider Hub.cmd`

## Provider Types

- `responses`: upstream natively supports `/v1/responses`.
- `openai-chat`: upstream supports OpenAI Chat Completions; Hub runs `mimo2codex` as the adapter.
- `mimo`: MiMo-compatible adapter type with local web-search enrichment and no paid MiMo Web Search Plugin forwarding.

No provider configs are bundled by default. Every provider entry, including MiMo-compatible and Responses providers, must be added by the user.
