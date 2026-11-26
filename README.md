# Alma Plugins

Official and example plugins for [Alma](https://alma.now).

> [!IMPORTANT]
> **Antigravity Plugin Has Been Removed**
>
> The Antigravity Auth plugin has been removed from this repository. Google Antigravity IDE employs very aggressive anti-reverse-proxy measures that change far too frequently. As a solo maintainer, I simply don't have the bandwidth to keep up with their constant updates — each change requires significant reverse-engineering and debugging effort. Rather than letting the plugin stay broken indefinitely, I've decided to remove it entirely.
>
> I appreciate your understanding. If the situation improves in the future, I may consider bringing it back.

## Plugin Types

Alma supports several types of plugins:

| Type | Description |
|------|-------------|
| `tool` | Registers tools that can be used by the AI assistant |
| `ui` | Adds UI components (status bar, sidebar, settings panels) |
| `theme` | Provides color themes for the application |
| `provider` | Adds new AI model providers |
| `transform` | Transforms messages, prompts, or responses |
| `integration` | Integrates with external services |
| `composite` | Combines multiple plugin types |

## Example Plugins

### Hello World (`plugins/hello-world`)

A simple tool plugin that demonstrates the basic structure of an Alma plugin.

**Features:**
- Registers a greeting tool that can be used by the AI
- Supports multiple languages (English, Chinese, Japanese, Spanish, French)
- Demonstrates command registration

**Type:** `tool`

### Token Counter (`plugins/token-counter`)

A UI plugin that displays token usage and estimated cost in the status bar.

**Features:**
- Real-time token count tracking
- Estimated cost calculation
- Configurable cost per million tokens
- Session-based statistics

**Type:** `ui`

### Catppuccin Theme (`plugins/catppuccin-theme`)

A theme plugin providing the beautiful Catppuccin color palette.

**Features:**
- Four flavors: Mocha, Macchiato, Frappé, and Latte
- Three dark themes and one light theme
- Configurable accent colors
- Based on the popular [Catppuccin](https://github.com/catppuccin/catppuccin) project

**Type:** `theme`

### Prompt Enhancer (`plugins/prompt-enhancer`)

A transform plugin that enhances prompts with additional context and instructions.

**Features:**
- Three enhancement modes: minimal, standard, detailed
- Optional timestamp injection
- Custom instructions support
- Toggle command for quick enable/disable

**Type:** `transform`

## Plugin Structure

Each plugin must have a `manifest.json` file and a main entry point:

```
my-plugin/
├── manifest.json    # Plugin metadata and configuration
├── main.ts          # Plugin entry point (TypeScript)
├── main.js          # Compiled JavaScript (for distribution)
└── README.md        # Plugin documentation (optional)
```

### manifest.json

```json
{
    "id": "my-plugin",
    "name": "My Plugin",
    "version": "1.0.0",
    "description": "A description of what the plugin does",
    "author": {
        "name": "Your Name",
        "email": "your@email.com"
    },
    "main": "main.js",
    "engines": {
        "alma": "^0.1.0"
    },
    "type": "tool",
    "permissions": ["notifications"],
    "activationEvents": ["onStartup"],
    "contributes": {
        "tools": [...],
        "commands": [...],
        "configuration": {...}
    }
}
```

### Plugin Entry Point

```typescript
import { z } from 'zod';
import type { PluginContext, PluginActivation } from 'alma-plugin-api';

export async function activate(context: PluginContext): Promise<PluginActivation> {
    const { logger, tools, commands, events, ui, settings } = context;

    logger.info('Plugin activated!');

    // Register a tool with Zod schema for parameters
    const toolDisposable = tools.register('myTool', {
        description: 'A description of what the tool does',
        parameters: z.object({
            input: z.string().describe('The input parameter'),
        }),
        execute: async (params, toolContext) => {
            logger.info(`Executing with input: ${params.input}`);
            return { result: 'success' };
        },
    });

    // Register a command
    const commandDisposable = commands.register('myCommand', async () => {
        ui.showNotification('Hello from my plugin!', { type: 'info' });
    });

    // Subscribe to events
    const eventDisposable = events.on('chat.message.didReceive', (input, output) => {
        logger.info('Message received:', input.response.content);
    });

    return {
        dispose: () => {
            logger.info('Plugin deactivated');
            toolDisposable.dispose();
            commandDisposable.dispose();
            eventDisposable.dispose();
        },
    };
}
```

## Available APIs

### Context Properties

| Property | Description |
|----------|-------------|
| `id` | Plugin ID |
| `extensionPath` | Path to the plugin directory |
| `storagePath` | Path for plugin-specific storage |
| `globalStoragePath` | Path for global plugin storage |
| `logger` | Logging utilities (info, warn, error, debug) |
| `storage` | Persistent key-value storage (local, workspace, secrets) |
| `tools` | Register AI tools with Zod schemas |
| `commands` | Register command palette commands |
| `events` | Subscribe to lifecycle events |
| `ui` | UI utilities (notifications, status bar, dialogs) |
| `chat` | Access to chat threads and messages |
| `providers` | Access to AI providers |
| `workspace` | File system access (with permissions) |
| `settings` | Read and write plugin settings |
| `i18n` | Internationalization utilities |

### Available Events

| Event | Description |
|-------|-------------|
| `chat.message.willSend` | Before a message is sent |
| `chat.message.didSend` | After a message is sent |
| `chat.message.didReceive` | After a response is received |
| `chat.thread.created` | When a new thread is created |
| `chat.thread.deleted` | When a thread is deleted |
| `tool.willExecute` | Before a tool is executed |
| `tool.didExecute` | After a tool completes |
| `app.ready` | When the application starts |
| `app.willQuit` | Before the application quits |

## Permissions

Plugins must declare required permissions in their manifest:

| Permission | Description |
|------------|-------------|
| `filesystem:read` | Read files from the filesystem |
| `filesystem:write` | Write files to the filesystem |
| `shell:execute` | Execute shell commands |
| `network:fetch` | Make network requests |
| `clipboard:read` | Read from clipboard |
| `clipboard:write` | Write to clipboard |
| `notifications` | Show system notifications |
| `chat:read` | Read chat messages |
| `chat:write` | Send chat messages |
| `settings:read` | Read application settings |
| `settings:write` | Modify application settings |
| `providers:manage` | Register custom providers |
| `tools:register` | Register AI tools |
| `ui:webview` | Create webview panels |

## Installation

### From Directory

1. Copy your plugin folder to the Alma plugins directory:
   - **macOS**: `~/Library/Application Support/Alma/plugins/`
   - **Windows**: `%APPDATA%/Alma/plugins/`
   - **Linux**: Read `globalPath` from the local server’s `GET /api/plugins-path`.
     Alma Server 0.4.1176 defaults to `~/.config/alma/plugins/`.

2. Restart Alma or use the "Refresh" button in Settings > Plugins

### From Marketplace

1. Open Alma Settings > Plugins
2. Switch to the "Marketplace" tab
3. Search for the plugin you want
4. Click "Install"

## Development

1. Create a new directory for your plugin
2. Create a `manifest.json` with your plugin metadata
3. Write your plugin code in TypeScript
4. Compile to JavaScript for distribution
5. Test by copying to the plugins directory

### TypeScript Setup

```bash
npm init -y
npm install -D typescript alma-plugin-api zod
npx tsc --init
```

### Building

```bash
npx tsc
```

## License

MIT
