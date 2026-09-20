# OpenAI Codex Auth Plugin

Use your ChatGPT Plus/Pro subscription to access OpenAI Codex models directly in Alma.

## Features

- **OAuth Authentication**: Secure OAuth2 PKCE flow to authenticate with your ChatGPT account
- **30+ Model Variants**: Access GPT-5.3, GPT-5.3 Codex, GPT-5.2, GPT-5.2 Codex, GPT-5.1 Codex, and more
- **Reasoning Control**: Different reasoning effort levels (none, low, medium, high, xhigh)
- **Streaming Support**: Real-time streaming responses
- **Multi-Account Failover**: Connect several ChatGPT accounts; when the active one hits its usage limit, requests automatically continue on the next account with quota (the exhausted account is parked until its window resets and shown as rate-limited in settings)

## Supported Models

### GPT-5.3 Series
- `gpt-5.3` - General purpose (6 reasoning variants: none, low, medium, high, xhigh)
- `gpt-5.3-codex` - Most capable agentic coding model (4 reasoning variants)
- `gpt-5.3-codex-spark` - Real-time coding, 1000+ tok/s (2 reasoning variants)

### GPT-5.2 Series
- `gpt-5.2` - General purpose (5 reasoning variants)
- `gpt-5.2-codex` - Optimized for coding (4 reasoning variants)

### GPT-5.1 Series
- `gpt-5.1-codex-max` - Maximum capability (4 reasoning variants)
- `gpt-5.1-codex` - Balanced coding model (3 reasoning variants)
- `gpt-5.1-codex-mini` - Fast and efficient (2 reasoning variants)
- `gpt-5.1` - General purpose (4 reasoning variants)

## Installation

1. Open Alma Settings
2. Go to Plugins
3. Search for "OpenAI Codex Auth"
4. Click Install

Or install manually:
```bash
# Clone to your plugins directory
git clone https://github.com/alma-plugins/openai-codex-auth ~/.config/alma/plugins/openai-codex-auth
```

## Usage

### Authentication

1. After installing the plugin, go to **Settings > Providers**
2. Find "OpenAI Codex (ChatGPT)" and click **Connect**
3. Your browser will open to the ChatGPT login page
4. Log in with your ChatGPT Plus/Pro account
5. Copy the authorization code from the callback page
6. Paste the code into Alma

### Using Models

Once authenticated, Codex models will appear in your model selector:
- Select `openai-codex:gpt-5.2-codex` for GPT-5.2 Codex with medium reasoning
- Select `openai-codex:gpt-5.2-codex-high` for high reasoning effort
- And so on...

## Commands

- **Login to ChatGPT (Codex)**: Start the authentication flow
- **Logout from ChatGPT (Codex)**: Clear stored credentials

## Permissions Required

- `network:fetch` - API calls to ChatGPT backend
- `network:domain:auth.openai.com` - OAuth authentication
- `network:domain:chatgpt.com` - Codex API
- `providers:manage` - Register custom provider
- `notifications` - Show authentication status

## Disclaimer

**This plugin is for personal development use only.**

- Requires an active ChatGPT Plus or Pro subscription
- Not for commercial resale, multi-user services, or API resale
- Not for high-volume automated extraction
- Users are responsible for compliance with OpenAI Terms of Use
- For production use, consider the official OpenAI Platform API

## Technical Details

### OAuth Flow

1. Generate PKCE code verifier and challenge
2. Open browser to OpenAI OAuth endpoint
3. User logs in and authorizes
4. Copy authorization code from callback
5. Exchange code for access/refresh tokens
6. Store tokens securely in plugin storage

### API Integration

- **Endpoint**: `https://chatgpt.com/backend-api/codex/responses`
- **Mode**: Stateless (`store: false`)
- **Features**: Reasoning configuration, prompt caching

## Troubleshooting

### "Token refresh failed"
Your refresh token has expired. Click **Connect** to re-authenticate.

### "Account ID not found"
The OAuth token doesn't contain the expected claims. Try logging out and back in.

### "Codex API error: 429"
You've hit the ChatGPT usage limits. Wait and try again later.

## License

MIT License

## Acknowledgments

This plugin is based on and inspired by [opencode-openai-codex-auth](https://github.com/numman-ali/opencode-openai-codex-auth) by [@numman-ali](https://github.com/numman-ali).

Special thanks to the original author for:
- The OAuth authentication flow implementation
- ChatGPT Codex API reverse engineering
- The overall architecture and approach

Without their pioneering work, this plugin would not have been possible.
