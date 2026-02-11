# Antigravity Auth Plugin

Use your Google Antigravity IDE subscription to access Claude and Gemini models directly in Alma.

## Features

- **OAuth Authentication**: Secure Google OAuth2 PKCE flow to authenticate with your Antigravity account
- **Claude Models**: Access Claude Sonnet 4.5 and Opus 4.6 with extended thinking support
- **Gemini Models**: Access Gemini 2.0, 2.5, and 3.0 series
- **Thinking Support**: Multiple thinking budget levels for Claude thinking models
- **Streaming Support**: Real-time streaming responses
- **Endpoint Fallback**: Automatic retry across multiple Antigravity endpoints

## Supported Models

### Claude Series

- `claude-sonnet-4-5` - Claude Sonnet 4.5 without thinking
- `claude-sonnet-4-5-thinking` - With medium thinking (default, 16K tokens)
- `claude-sonnet-4-5-thinking-high` - With high thinking budget (32K tokens)
- `claude-sonnet-4-5-thinking-low` - With low thinking budget (8K tokens)
- `claude-opus-4-6-thinking` - Claude Opus 4.6 with extended thinking (16K tokens)
- `claude-opus-4-6-thinking-high` - With high thinking budget (32K tokens)
- `claude-opus-4-6-thinking-low` - With low thinking budget (8K tokens)

> **Note**: Claude Opus 4.6 without thinking is not available via Antigravity API.

### Gemini Series

- `gemini-2.5-pro` - Gemini 2.5 Pro (advanced reasoning)
- `gemini-2.5-flash` - Gemini 2.5 Flash (fast and efficient)
- `gemini-3-pro` - Gemini 3 Pro (latest generation)
- `gemini-3-flash` - Gemini 3 Flash (fast and efficient)

## Installation

1. Open Alma Settings
2. Go to Plugins
3. Search for "Antigravity Auth"
4. Click Install

Or install manually:
```bash
# Clone to your plugins directory
git clone https://github.com/alma-plugins/antigravity-auth ~/.config/alma/plugins/antigravity-auth
```

## Usage

### Authentication

1. After installing the plugin, go to **Settings > Providers**
2. Find "Antigravity (Google)" and click **Connect**
3. Your browser will open to the Google login page
4. Log in with your Google account that has Antigravity access
5. Authorize the application
6. The callback will be handled automatically

### Using Models

Once authenticated, Antigravity models will appear in your model selector:
- Select `antigravity:claude-sonnet-4-5-thinking` for Claude with medium thinking
- Select `antigravity:gemini-2.5-pro` for Gemini 2.5 Pro
- And so on...

## Commands

- **Login to Antigravity (Google)**: Start the authentication flow
- **Logout from Antigravity**: Clear stored credentials

## Permissions Required

- `network:fetch` - API calls to Antigravity backend
- `network:domain:accounts.google.com` - Google OAuth authentication
- `network:domain:oauth2.googleapis.com` - Token exchange
- `network:domain:googleapis.com` - API calls
- `network:domain:*.sandbox.googleapis.com` - Antigravity sandbox endpoints
- `providers:manage` - Register custom provider
- `notifications` - Show authentication status

## Disclaimer

**This plugin is for personal development use only.**

- Requires access to Google's Antigravity IDE service
- Not for commercial resale, multi-user services, or API resale
- Not for high-volume automated extraction
- Users are responsible for compliance with Google Terms of Service
- For production use, consider the official Google AI Platform APIs

## Technical Details

### OAuth Flow

1. Generate PKCE code verifier and challenge
2. Open browser to Google OAuth endpoint
3. User logs in and authorizes required scopes
4. Callback handled by local server on port 51121
5. Exchange code for access/refresh tokens
6. Fetch project ID from Antigravity loadCodeAssist API
7. Store tokens securely in plugin storage

### API Integration

- **Endpoints**: Daily, Autopush, and Production Antigravity endpoints (with fallback)
- **Format**: Gemini API format (contents/parts structure)
- **Features**: Thinking configuration, function calling, streaming

### Request Transformation

The plugin transforms OpenAI-style requests to Gemini format:
- Messages → Contents with parts
- Tools → Function declarations
- System messages → System instruction

## Troubleshooting

### "Token refresh failed"
Your refresh token has expired or been revoked. Click **Connect** to re-authenticate.

### "Project ID not found"
The plugin couldn't resolve your Antigravity project. Try logging out and back in.

### "Rate limited by Antigravity API"
You've hit the usage limits. Wait and try again later.

### "All Antigravity endpoints failed"
All fallback endpoints are unavailable. Check your network connection or try again later.

## License

MIT License

## Acknowledgments

This plugin is based on and inspired by:

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) by [@NoeFabris](https://github.com/NoeFabris)
- [Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager) by [@lbjlaq](https://github.com/lbjlaq)

Special thanks to the original authors for:
- The Google OAuth authentication flow implementation
- Antigravity API integration patterns
- Multi-endpoint fallback architecture
- Thinking block signature management
- Multi-account rotation and scheduling logic (SchedulingMode, session stickiness, tier-based priority)
- The overall architecture and approach

Without their pioneering work, this plugin would not have been possible.
