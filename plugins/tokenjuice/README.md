# Tokenjuice

Reduce successful Bash output before it reaches the model using the local
[Tokenjuice CLI](https://github.com/vincentkoc/tokenjuice). Alma still approves
and executes the tool call. Failed commands retain their output and exit status
through `tokenjuice wrap --keep-failures`.

## Setup

1. Install Tokenjuice v0.11.0 or later using its installation instructions.
2. Install this plugin from Alma's marketplace, or copy this directory into
   Alma's plugins directory and refresh Settings > Plugins.
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
Real Alma loading, permissions, model-visible output and UI consistency remain
unverified. Before relying on a particular Alma version, check a successful
noisy command, exact raw output, a failing command and plugin disablement in a
disposable session.

Contracts: [hooks](https://alma.now/docs/plugins/hooks-events),
[plugin SDK](../../packages/plugin-api/src/index.ts).
