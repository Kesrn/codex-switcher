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

Codex should point to:

```text
http://127.0.0.1:8789/v1
```

The Hub automatically keeps Codex pointed at this local endpoint while it is running. Switch providers in the Hub UI; the next Codex request uses the selected provider.

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
- `mimo`: MiMo preset with local web-search enrichment and no paid MiMo Web Search Plugin forwarding.
