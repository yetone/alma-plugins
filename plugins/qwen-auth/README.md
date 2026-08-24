# Qwen Auth Plugin for Alma

Use Alibaba Qwen AI models with Alma via OAuth Device Flow authentication.

## Features

- 🔐 **OAuth Device Flow**: Secure authentication using OAuth 2.0 Device Authorization Flow with PKCE
- 🔄 **Automatic Token Refresh**: Tokens are automatically refreshed when expired
- 🤖 **Multiple Models**: Access to Qwen3 Coder, Qwen3 Max, Qwen3 VL, and more
- 📡 **OpenAI-Compatible API**: Uses Qwen's OpenAI-compatible endpoint for seamless integration

## Supported Models

| Model ID | Name | Description |
|----------|------|-------------|
| `qwen3-coder-plus` | Qwen3 Coder Plus | Advanced code generation and understanding |
| `qwen3-coder-flash` | Qwen3 Coder Flash | Fast code generation |
| `qwen3-max` | Qwen3 Max | Flagship model with maximum capabilities |
| `qwen3-max-preview` | Qwen3 Max Preview | Preview build with latest features |
| `qwen3-vl-plus` | Qwen3 VL Plus | Multimodal vision-language model |
| `qwen3-235b-a22b-thinking-2507` | Qwen3 235B Thinking | Reasoning model with thinking capabilities |
| `qwen3-235b-a22b-instruct` | Qwen3 235B Instruct | Large instruction-following model |
| `qwen3-32b` | Qwen3 32B | Efficient 32B parameter model |

## Installation

1. Install the plugin in Alma
2. Run the "Login to Qwen" command
3. Follow the device flow authentication:
   - A browser window will open to the Qwen authorization page
   - Enter the displayed user code
   - Authorize the application
4. Start using Qwen models!

## Authentication Flow

This plugin uses the **OAuth 2.0 Device Authorization Flow** (RFC 8628) with PKCE:

1. **Device Code Request**: Plugin requests a device code from Qwen
2. **User Authorization**: User visits the verification URL and enters the user code
3. **Token Polling**: Plugin polls for the access token
4. **Token Storage**: Tokens are securely stored and automatically refreshed

```
┌─────────────┐                              ┌─────────────┐
│   Plugin    │                              │    Qwen     │
└──────┬──────┘                              └──────┬──────┘
       │                                            │
       │  1. Request Device Code (with PKCE)        │
       │ ─────────────────────────────────────────► │
       │                                            │
       │  2. Device Code + User Code                │
       │ ◄───────────────────────────────────────── │
       │                                            │
       │  3. Display User Code to User              │
       │ ─────► User visits URL & enters code       │
       │                                            │
       │  4. Poll for Token                         │
       │ ─────────────────────────────────────────► │
       │                                            │
       │  5. Access Token + Refresh Token           │
       │ ◄───────────────────────────────────────── │
       │                                            │
```

## Commands

| Command | Description |
|---------|-------------|
| `qwen-auth.login` | Login to Qwen (Alibaba) |
| `qwen-auth.logout` | Logout from Qwen |
| `qwen-auth.status` | Show Qwen account status |

## Configuration

No additional configuration is required. The plugin uses Qwen's public OAuth endpoints.

## Technical Details

### OAuth Endpoints

- **Device Code**: `https://chat.qwen.ai/api/v1/oauth2/device/code`
- **Token**: `https://chat.qwen.ai/api/v1/oauth2/token`

### API Endpoint

- **Base URL**: `https://portal.qwen.ai/v1` (or custom `resource_url` from OAuth)
- **Chat Completions**: `{base_url}/chat/completions`
- **Format**: OpenAI-compatible API

### Token Refresh

Tokens are automatically refreshed when:
- The access token is expired
- The access token will expire within 5 minutes

## Troubleshooting

### "Device code expired"

The device code expires after a few minutes. If you see this error, restart the login process.

### "Authorization denied"

Make sure you authorized the application on the Qwen website. Try logging in again.

### "Token refresh failed"

Your refresh token may have expired. Log out and log in again.

## Privacy & Security

- Tokens are stored securely in Alma's secret storage
- No credentials are transmitted to third parties
- PKCE is used to prevent authorization code interception

## Disclaimer

This plugin is for personal development use only with your own Qwen account. Not for commercial resale or multi-user services.

## Credits

Based on [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)'s Qwen OAuth implementation.

## License

MIT
