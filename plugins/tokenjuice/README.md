# Tokenjuice

Reduce successful Bash output before it reaches the model using the local
[Tokenjuice CLI](https://github.com/vincentkoc/tokenjuice). Alma still approves
and executes the tool call. Failed commands retain their output and exit status
through `tokenjuice wrap --keep-failures`.

## Setup

1. Install Tokenjuice v0.11.0 or later using its installation instructions.
2. Install this plugin from Alma's marketplace, or copy the contents of this
   directory to `tokenjuice/` under Alma's plugins directory and refresh
   Settings > Plugins. On Linux Alma Server 0.4.1176, `GET /api/plugins-path`
   reports the active directory (`~/.config/alma/plugins/` by default).
3. Set **Tokenjuice: Executable Path** to the absolute executable path reported
   by `command -v tokenjuice`. Leave it empty to disable wrapping.
4. Set **Tokenjuice: Shell Path** if Bash is somewhere other than `/bin/bash`.
5. Enable the plugin and start a fresh session.

This plugin ships its JavaScript entry point; it needs no npm install or build.
It supports macOS and Linux. Windows, background calls, malformed calls and
missing executables pass through unchanged. Commands mentioning `tokenjuice`,
explicit raw wrappers, and wrappers using the configured executable also pass
through conservatively. Use `tokenjuice wrap --raw -- <command>` for exact output.

The plugin preserves other plugins' effective arguments and cancellation.
Disable it in Alma to stop wrapping; unloading disposes its hook subscription.

## Verification

Run `node --test plugins/tokenjuice/main.test.js` from the repository root.
Tests cover the hook payload, argument composition, quoting and fail-open cases.
On Linux arm64, [Alma Server 0.4.1176](https://github.com/yetone/alma-releases/releases/tag/v0.4.1176)
loaded this directory in a fresh profile. With the plugin enabled and its
executable setting empty, a 160-line Bash command returned 3,360 bytes of stdout
to the next model request. Setting the executable path to the released
[Tokenjuice v0.11.0](https://github.com/vincentkoc/tokenjuice/releases/tag/v0.11.0)
launcher reduced that output to 698 bytes. An exact file read and an explicit
raw command preserved their bytes. The failing command preserved both output
messages and exit code 7. Disabling the plugin restored all 3,360 bytes.

The check used a loopback model fixture and headless automatic approval.
Marketplace installation, desktop UI and interactive approval dialogs remain
unverified.

Contracts: [hooks](https://alma.now/docs/plugins/hooks-events),
[plugin SDK](../../packages/plugin-api/src/index.ts).
