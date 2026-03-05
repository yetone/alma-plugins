/**
 * Alma Plugin API
 *
 * TypeScript type definitions for developing Alma plugins.
 * These types match the runtime API provided by Alma.
 *
 * @packageDocumentation
 */

import type { z } from 'zod';

// ============================================================================
// Core Types
// ============================================================================

/**
 * A disposable resource that can be cleaned up.
 */
export interface Disposable {
    dispose(): void;
}

/**
 * Result returned from plugin activation.
 */
export interface PluginActivation {
    dispose(): void;
}

/**
 * Event callback type.
 */
export type EventCallback<T> = (data: T) => void;

/**
 * Event subscription function.
 */
export interface Event<T> {
    (listener: EventCallback<T>): Disposable;
}

// ============================================================================
// Logger API
// ============================================================================

/**
 * Logging utilities for plugins.
 */
export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

// ============================================================================
// Storage API
// ============================================================================

/**
 * Persistent key-value storage for plugins.
 */
export interface Storage {
    get<T>(key: string): Promise<T | undefined>;
    get<T>(key: string, defaultValue: T): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
    clear(): Promise<void>;
}

/**
 * Secure storage for sensitive data like API keys.
 */
export interface SecretStorage {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}

// ============================================================================
// Tools API
// ============================================================================

/**
 * Context passed to tool execution.
 */
export interface ToolContext {
    threadId: string;
    messageId: string;
    abortSignal?: AbortSignal;
}

/**
 * Definition for a tool that can be used by the AI assistant.
 * Uses Zod schema for parameter validation.
 */
export interface ToolDefinition<TParams extends z.ZodType = z.ZodType> {
    description: string;
    parameters: TParams;
    execute: (params: z.infer<TParams>, context: ToolContext) => Promise<unknown>;
}

/**
 * API for registering and managing AI tools.
 */
export interface ToolsAPI {
    register<TParams extends z.ZodType>(id: string, definition: ToolDefinition<TParams>): Disposable;
    unregister(id: string): void;
}

// ============================================================================
// Commands API
// ============================================================================

/**
 * API for registering command palette commands.
 */
export interface CommandsAPI {
    register(id: string, handler: (...args: unknown[]) => Promise<unknown> | unknown): Disposable;
    execute<T>(id: string, ...args: unknown[]): Promise<T>;
}

// ============================================================================
// Events API (Hooks)
// ============================================================================

/**
 * Model pricing information (costs are per million tokens in USD).
 */
export interface ModelPricing {
    /** Cost per million input tokens */
    input?: number;
    /** Cost per million output tokens */
    output?: number;
    /** Cost per million cached input tokens */
    cacheRead?: number;
}

/**
 * Token usage statistics.
 */
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedInputTokens?: number;
}

/**
 * Tool execution context.
 */
export interface ToolExecutionContext {
    threadId: string;
    messageId: string;
    sessionId?: string;
}

/**
 * Available hook names for event subscriptions.
 */
export type HookName =
    | 'chat.message.willSend'
    | 'chat.message.didSend'
    | 'chat.message.didReceive'
    | 'chat.thread.created'
    | 'chat.thread.deleted'
    | 'thread.activated'
    | 'tool.willExecute'
    | 'tool.didExecute'
    | 'tool.onError'
    | 'app.ready'
    | 'app.willQuit';

/**
 * Hook handler function type.
 */
export type HookHandler<T extends HookName> = (
    input: HookInput<T>,
    output: HookOutput<T>
) => void | Promise<void>;

/**
 * Hook input types based on hook name.
 */
export type HookInput<T extends HookName> = T extends 'chat.message.willSend'
    ? { threadId: string; content: string; model: string; providerId: string }
    : T extends 'chat.message.didReceive'
      ? {
            threadId: string;
            model: string;
            providerId: string;
            response: { content: string; usage?: TokenUsage };
            pricing?: ModelPricing;
        }
      : T extends 'chat.thread.created'
        ? { threadId: string; title: string; model?: string }
        : T extends 'thread.activated'
          ? {
                threadId: string;
                title?: string;
                model?: string;
                providerId?: string;
                usage?: TokenUsage;
                pricing?: ModelPricing;
            }
          : T extends 'tool.willExecute'
            ? { tool: string; args: Record<string, unknown>; context: ToolExecutionContext }
            : T extends 'tool.didExecute'
              ? { tool: string; args: Record<string, unknown>; result: unknown; duration: number; context: ToolExecutionContext }
              : T extends 'tool.onError'
                ? { tool: string; args: Record<string, unknown>; error: Error; duration: number; context: ToolExecutionContext }
                : unknown;

/**
 * Hook output types based on hook name.
 */
export type HookOutput<T extends HookName> = T extends 'chat.message.willSend'
    ? { content?: string; cancel?: boolean }
    : T extends 'tool.willExecute'
      ? { args?: Record<string, unknown>; cancel?: boolean }
      : T extends 'tool.didExecute'
        ? { result?: unknown }
        : T extends 'tool.onError'
          ? { result?: unknown; rethrow?: boolean }
          : Record<string, unknown>;

/**
 * API for subscribing to lifecycle events.
 */
export interface EventsAPI {
    on<T extends HookName>(hookName: T, handler: HookHandler<T>, options?: { priority?: number }): Disposable;
    once<T extends HookName>(hookName: T, handler: HookHandler<T>): Disposable;
}

// ============================================================================
// UI API
// ============================================================================

/**
 * Options for showing notifications.
 */
export interface NotificationOptions {
    type?: 'info' | 'success' | 'warning' | 'error';
    duration?: number;
    action?: {
        label: string;
        callback: () => void;
    };
}

/**
 * Quick pick item for selection dialogs.
 */
export interface QuickPickItem<T = string> {
    label: string;
    description?: string;
    detail?: string;
    value: T;
}

/**
 * Options for quick pick dialogs.
 */
export interface QuickPickOptions {
    title?: string;
    placeholder?: string;
    canSelectMany?: boolean;
}

/**
 * Options for input box dialogs.
 */
export interface InputBoxOptions {
    title?: string;
    prompt?: string;
    placeholder?: string;
    value?: string;
    password?: boolean;
    validateInput?: (value: string) => string | undefined;
}

/**
 * Options for confirm dialogs.
 */
export interface ConfirmOptions {
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    type?: 'info' | 'warning' | 'danger';
}

/**
 * Options for progress indicators.
 */
export interface ProgressOptions {
    title: string;
    cancellable?: boolean;
}

/**
 * Progress report for updating progress indicators.
 */
export interface ProgressReport {
    increment?: number;
    message?: string;
}

/**
 * Progress task function type.
 */
export type ProgressTask<T> = (
    progress: { report: (value: ProgressReport) => void },
    token: { isCancellationRequested: boolean }
) => Promise<T>;

/**
 * A status bar item that can display information.
 */
export interface StatusBarItem extends Disposable {
    text: string;
    tooltip?: string;
    command?: string;
    show(): void;
    hide(): void;
}

/**
 * Options for creating a status bar item.
 */
export interface StatusBarItemOptions {
    id: string;
    alignment: 'left' | 'right';
    priority?: number;
}

/**
 * Theme definition.
 */
export interface Theme {
    id: string;
    name: string;
    type: 'dark' | 'light';
}

/**
 * UI utilities for plugins.
 */
export interface UIAPI {
    showNotification(message: string, options?: NotificationOptions): void;
    showError(message: string): void;
    showWarning(message: string): void;
    showQuickPick<T>(items: QuickPickItem<T>[], options?: QuickPickOptions): Promise<T | undefined>;
    showInputBox(options?: InputBoxOptions): Promise<string | undefined>;
    showConfirmDialog(message: string, options?: ConfirmOptions): Promise<boolean>;
    withProgress<T>(options: ProgressOptions, task: ProgressTask<T>): Promise<T>;
    createStatusBarItem(options: StatusBarItemOptions): StatusBarItem;
    readonly theme: {
        current: Theme;
        onChange: Event<Theme>;
    };
}

// ============================================================================
// Chat API
// ============================================================================

/**
 * A chat message.
 */
export interface Message {
    id: string;
    threadId: string;
    role: 'user' | 'assistant' | 'system';
    content: unknown; // Can be string or UIMessage with parts
    createdAt: string;
}

/**
 * A chat thread/conversation.
 */
export interface Thread {
    id: string;
    title?: string;
    model?: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * API for accessing chat threads and messages.
 */
export interface ChatAPI {
    listThreads(): Promise<Thread[]>;
    getThread(id: string): Promise<Thread | undefined>;
    getActiveThread(): Promise<Thread | undefined>;
    createThread(options?: { title?: string; model?: string }): Promise<Thread>;
    getMessages(threadId: string): Promise<Message[]>;
}

// ============================================================================
// Channel API
// ============================================================================

/**
 * A message sent/received through an external channel integration.
 */
export interface ChannelMessage {
    id: string;
    /** Plugin-defined channel id (e.g. "dingding", "slack"). */
    channelId: string;
    /** Plugin-defined conversation/session id (e.g. group chat id). */
    conversationId: string;
    /** Platform user id (if available). */
    authorId?: string;
    authorName?: string;
    /** Plain text content (rich parts can be added later). */
    content: string;
    createdAt: string;
}

/**
 * Handler for sending messages to a channel.
 */
export interface ChannelSendHandler {
    sendMessage(request: {
        conversationId: string;
        content: string;
        replyToMessageId?: string;
        metadata?: Record<string, unknown>;
    }): Promise<{ messageId?: string }>;
}

/**
 * Channel definition for registering custom channels.
 */
export interface ChannelDefinition {
    id: string;
    name: string;
    icon?: string;
    capabilities?: Array<'send' | 'webhook-receive' | 'attachments' | 'reply'>;
    send?: ChannelSendHandler;
}

/**
 * API for managing channel integrations.
 */
export interface ChannelsAPI {
    list(): Promise<Array<{ id: string; name: string; enabled: boolean }>>;
    get(id: string): Promise<{ id: string; name: string; enabled: boolean } | undefined>;
    register(channel: ChannelDefinition): Disposable;
}

// ============================================================================
// Provider API
// ============================================================================

/**
 * AI provider information.
 */
export interface Provider {
    id: string;
    name: string;
    type: string;
    enabled: boolean;
}

/**
 * Provider definition for registering custom providers.
 */
export interface ProviderDefinition {
    id: string;
    name: string;
    icon?: string;
    getModels(): Promise<Array<{ id: string; name: string }>>;
    createChatCompletion(request: {
        model: string;
        messages: Message[];
        stream?: boolean;
    }): Promise<ReadableStream | { content: string }>;
}

/**
 * API for managing AI providers.
 */
export interface ProvidersAPI {
    list(): Promise<Provider[]>;
    get(id: string): Promise<Provider | undefined>;
    register(provider: ProviderDefinition): Disposable;
}

// ============================================================================
// Workspace API
// ============================================================================

/**
 * File statistics.
 */
export interface FileStat {
    type: 'file' | 'directory' | 'symlink';
    size: number;
    mtime: number;
    ctime: number;
}

/**
 * File type.
 */
export type FileType = 'file' | 'directory' | 'symlink' | 'unknown';

/**
 * Workspace folder.
 */
export interface WorkspaceFolder {
    id: string;
    path: string;
    name: string;
}

/**
 * File system watcher.
 */
export interface FileSystemWatcher extends Disposable {
    onDidCreate: Event<string>;
    onDidChange: Event<string>;
    onDidDelete: Event<string>;
}

/**
 * API for workspace and file system operations.
 */
export interface WorkspaceAPI {
    readonly rootPath: string | undefined;
    readonly workspaceFolders: WorkspaceFolder[];
    readFile(filePath: string): Promise<Uint8Array>;
    writeFile(filePath: string, content: Uint8Array): Promise<void>;
    stat(filePath: string): Promise<FileStat>;
    readDirectory(dirPath: string): Promise<[string, FileType][]>;
    createFileSystemWatcher(pattern: string): FileSystemWatcher;
}

// ============================================================================
// Settings API
// ============================================================================

/**
 * Settings change event.
 */
export interface SettingsChangeEvent {
    key: string;
    oldValue: unknown;
    newValue: unknown;
}

/**
 * API for reading and writing plugin settings.
 */
export interface SettingsAPI {
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Promise<void>;
    onDidChange: Event<SettingsChangeEvent>;
}

// ============================================================================
// i18n API
// ============================================================================

/**
 * Internationalization API.
 */
export interface I18nAPI {
    t(key: string, params?: Record<string, unknown>): string;
    locale: string;
    onDidChangeLocale: Event<string>;
}

// ============================================================================
// Plugin Context
// ============================================================================

/**
 * The main context object passed to plugins during activation.
 * Provides access to all Alma APIs.
 */
export interface PluginContext {
    // Plugin info
    readonly id: string;
    readonly extensionPath: string;
    readonly storagePath: string;
    readonly globalStoragePath: string;

    // Logging
    readonly logger: Logger;

    // Storage APIs
    readonly storage: {
        local: Storage;
        workspace: Storage;
        secrets: SecretStorage;
    };

    // Tool registration
    readonly tools: ToolsAPI;

    // Command registration
    readonly commands: CommandsAPI;

    // Event system (hooks)
    readonly events: EventsAPI;

    // UI APIs
    readonly ui: UIAPI;

    // Chat APIs
    readonly chat: ChatAPI;

    // Provider APIs
    readonly providers: ProvidersAPI;

    // Channel APIs
    readonly channels: ChannelsAPI;

    // Workspace APIs
    readonly workspace: WorkspaceAPI;

    // Settings APIs
    readonly settings: SettingsAPI;

    // i18n
    readonly i18n: I18nAPI;
}

// ============================================================================
// Plugin Entry Point
// ============================================================================

/**
 * The activation function that plugins must export.
 *
 * @example
 * ```typescript
 * import type { PluginContext, PluginActivation } from 'alma-plugin-api';
 *
 * export async function activate(context: PluginContext): Promise<PluginActivation> {
 *     context.logger.info('Plugin activated!');
 *
 *     // Register a command
 *     const commandDisposable = context.commands.register('myCommand', () => {
 *         context.ui.showNotification('Hello!');
 *     });
 *
 *     // Subscribe to events
 *     const eventDisposable = context.events.on('chat.message.didReceive', (input) => {
 *         context.logger.info('Message received:', input.response.content);
 *     });
 *
 *     return {
 *         dispose: () => {
 *             commandDisposable.dispose();
 *             eventDisposable.dispose();
 *             context.logger.info('Plugin deactivated');
 *         }
 *     };
 * }
 * ```
 */
export type ActivateFunction = (context: PluginContext) => Promise<PluginActivation>;
