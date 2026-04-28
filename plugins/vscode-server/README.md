# @papercupai/vscode-server

Smallest possible Papercusp plugin: a dashboard tab that iframes a code-server
install at the harness's project directory. Reference implementation for
spec §14.7 P5.

## Install

```sh
papercusp install @papercupai/vscode-server --harness <slug>
papercusp plugin enable @papercupai/vscode-server --harness <slug>
```

## What it does

- Adds a `VS Code` tab to the harness dashboard.
- The tab iframes `${codeServerUrl}/?folder=<harness-project-dir>`.
- Default `codeServerUrl` is the substrate's bundled code-server on `:8082`.

## Capabilities

- `ui:dashboard-tab` — claims one dashboard tab.

No actions, no routines, no server runtime, no secrets. The plugin runs in the
harness UI bundle only.

## Config

```json
{
  "codeServerUrl": "http://localhost:8082"
}
```

Override via `papercusp plugin config @papercupai/vscode-server --set codeServerUrl=...`.
