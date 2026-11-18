# Draft Assistant

Draft Assistant predicts a possible follow-up to the current chat and rewrites a draft you provide. Both commands show a preview. Choose **Use draft** to open an editable copy, then select and copy the text and paste it into the chat composer. Press OK in the copy dialog to keep the edited draft available to the rewrite command for this session. You decide when to send.

## Install and configure

Copy this directory into the [Alma plugins directory](../../README.md#from-directory), then refresh Settings → Plugins or restart Alma. `manifest.json` and `main.js` are sufficient for local installation. There are no build steps or runtime dependencies.

Set the full URL for a trusted, independent OpenAI-compatible `/v1/chat/completions` endpoint and enter its model ID in Draft Assistant settings. The endpoint must accept requests without an `Authorization` header, as with a local inference server. Use HTTPS, or HTTP on `localhost`, `127.0.0.1`, or `::1`. Enable data sharing after configuring the endpoint. Data sharing and automatic predictions are both off by default.

- **Draft Assistant: Predict next message** uses the latest user message and assistant reply from the active chat, up to 2,000 characters each. It excludes non-text message parts and other chats.
- **Draft Assistant: Rewrite draft** uses only the text you type or paste into the dialog. If you kept a prediction in this chat, the dialog starts with that draft. The preview shows the original and the rewrite. Drafts can contain up to 4,000 characters.
- **Automatic prediction** generates a suggestion when a reply arrives in the active chat and shows a notification when it is ready. Use the prediction command to review it. Turn off automatic prediction to keep using both commands on demand.

The plugin holds drafts in memory. It clears them on thread activation, when the chat sends a message, when plugin settings change, or when the plugin unloads. The endpoint may retain the text it receives. The plugin uses only its own endpoint and model settings.

## Public SDK and composer behavior

The [public SDK](../../packages/plugin-api/src/index.ts) exposes `ChatAPI.getActiveThread`, `ChatAPI.getMessages`, `chat.message.didReceive`, `thread.activated`, `UIAPI.showConfirmDialog`, and `UIAPI.showInputBox`. `ProvidersAPI` exposes provider metadata and provider registration. `ProviderDefinition.createChatCompletion` is a registration callback. The SDK has no method for running a configured Alma model from a UI plugin and no composer draft read, write, or inline extension API. The plugin therefore uses command dialogs and manual copy and paste. The existing [Prompt Enhancer](../prompt-enhancer/main.ts) still applies its send-time template separately.

## Verification

Run from the repository root:

```sh
node --test plugins/draft-assistant/tests/*.test.cjs
node scripts/lint-versions.mjs
```

The tests exercise the installable JavaScript entry through simulated SDK calls and a real loopback HTTP endpoint. For a desktop smoke test, install the directory, enable it, and use a dedicated test chat and a loopback endpoint. Confirm both commands appear, the rewrite input and preview can be canceled, the copy dialog preserves the result, and manual paste leaves sending up to you. Toggle automatic prediction and check that switching threads during inference prevents a result from appearing in the new chat.
