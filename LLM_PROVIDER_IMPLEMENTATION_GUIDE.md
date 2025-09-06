# LLM Provider Implementation Guide

This guide outlines how to implement three LLM provider options for NaruhoDocs:
1. **OOTB (Out-of-the-Box)**: Built-in Gemini with rate limits
2. **BYOK (Bring Your Own Key)**: User-provided API key for unlimited access
3. **Local**: Local LLM via Ollama or similar

## Current State Analysis

Based on the codebase analysis, NaruhoDocs currently uses:
- Single Gemini provider in `src/langchain-backend/llm.ts`
- API key from settings or environment variable
- Direct ChatGoogleGenerativeAI integration

## Implementation Plan

### Phase 1: Provider Infrastructure

#### 1.1 Create Provider Interface

Create `src/llm-providers/base.ts`:

```typescript
export interface LLMProviderOptions {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    temperature?: number;
}

export interface LLMProvider {
    readonly name: string;
    readonly isAvailable: boolean;
    
    initialize(options: LLMProviderOptions): Promise<void>;
    createChatSession(systemMessage: string): Promise<ChatSession>;
    testConnection(): Promise<boolean>;
    getUsageInfo(): Promise<UsageInfo>;
}

export interface UsageInfo {
    requestsToday: number;
    requestsRemaining: number;
    isUnlimited: boolean;
    resetTime?: Date;
}

export class LLMProviderError extends Error {
    constructor(
        message: string,
        public readonly provider: string,
        public readonly code: 'AUTH_FAILED' | 'RATE_LIMITED' | 'NETWORK_ERROR' | 'MODEL_ERROR'
    ) {
        super(message);
        this.name = 'LLMProviderError';
    }
}
```

#### 1.2 Update package.json Configuration

Add these configuration options to `package.json`:

```json
{
  "contributes": {
    "configuration": {
      "title": "NaruhoDocs",
      "properties": {
        "naruhodocs.llm.provider": {
          "type": "string",
          "enum": ["ootb", "byok", "local"],
          "enumDescriptions": [
            "Out-of-the-box: Use built-in Gemini with daily limits",
            "Bring Your Own Key: Use your own API key for unlimited access",
            "Local LLM: Use local models via Ollama or similar"
          ],
          "default": "ootb",
          "description": "LLM provider option to use"
        },
        "naruhodocs.llm.apiKey": {
          "type": "string",
          "default": "",
          "description": "API key for BYOK mode (stored securely)",
          "when": "config.naruhodocs.llm.provider == 'byok'"
        },
        "naruhodocs.llm.localBackend": {
          "type": "string",
          "enum": ["ollama", "lmstudio", "llamacpp", "textgen", "custom"],
          "enumDescriptions": [
            "Ollama - Easy model management with built-in API",
            "LM Studio - User-friendly GUI with OpenAI-compatible API",
            "llama.cpp - Lightweight C++ implementation",
            "Text Generation WebUI - Advanced web interface",
            "Custom - Custom API endpoint"
          ],
          "default": "ollama",
          "description": "Local LLM backend to use",
          "when": "config.naruhodocs.llm.provider == 'local'"
        },
        "naruhodocs.llm.localModel": {
          "type": "string",
          "default": "llama3.1:8b",
          "description": "Local model name for local LLM",
          "when": "config.naruhodocs.llm.provider == 'local'"
        },
        "naruhodocs.llm.localUrl": {
          "type": "string",
          "default": "http://localhost:11434",
          "description": "Local LLM server URL",
          "when": "config.naruhodocs.llm.provider == 'local'"
        }
      }
    },
    "commands": [
      {
        "command": "naruhodocs.configureLLM",
        "title": "Configure LLM Provider",
        "category": "NaruhoDocs"
      },
      {
        "command": "naruhodocs.testLLMConnection",
        "title": "Test LLM Connection",
        "category": "NaruhoDocs"
      }
    ]
  }
}
```

### Phase 2: Provider Implementations

#### 2.1 OOTB Provider (`src/llm-providers/ootb.ts`)

```typescript
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { LLMProvider, LLMProviderOptions, LLMProviderError, UsageInfo } from './base';
import { createChat, ChatSession } from '../langchain-backend/llm';

export class OOTBProvider implements LLMProvider {
    readonly name = 'Out-of-the-Box Gemini';
    private readonly BUILT_IN_API_KEY = 'YOUR_BUILT_IN_KEY_HERE'; // Replace with actual key
    private readonly DAILY_LIMIT = 50;
    private usageTracker: Map<string, number> = new Map();

    get isAvailable(): boolean {
        return true; // Always available with built-in key
    }

    async initialize(options: LLMProviderOptions): Promise<void> {
        // No initialization needed for OOTB
    }

    async createChatSession(systemMessage: string): Promise<ChatSession> {
        const today = new Date().toDateString();
        const todayUsage = this.usageTracker.get(today) || 0;

        if (todayUsage >= this.DAILY_LIMIT) {
            throw new LLMProviderError(
                `Daily limit of ${this.DAILY_LIMIT} requests reached. Upgrade to BYOK for unlimited access.`,
                this.name,
                'RATE_LIMITED'
            );
        }

        try {
            const session = createChat({
                apiKey: this.BUILT_IN_API_KEY,
                model: 'gemini-2.0-flash',
                temperature: 0,
                systemMessage
            });

            // Track usage
            this.usageTracker.set(today, todayUsage + 1);
            return session;
        } catch (error) {
            throw new LLMProviderError(
                'Failed to create OOTB chat session',
                this.name,
                'MODEL_ERROR'
            );
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            const session = await this.createChatSession('Test connection');
            return true;
        } catch (error) {
            return false;
        }
    }

    async getUsageInfo(): Promise<UsageInfo> {
        const today = new Date().toDateString();
        const requestsToday = this.usageTracker.get(today) || 0;

        return {
            requestsToday,
            requestsRemaining: Math.max(0, this.DAILY_LIMIT - requestsToday),
            isUnlimited: false,
            resetTime: new Date(new Date().setHours(24, 0, 0, 0))
        };
    }
}
```

#### 2.2 BYOK Provider (`src/llm-providers/byok.ts`)

```typescript
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { LLMProvider, LLMProviderOptions, LLMProviderError, UsageInfo } from './base';
import { createChat, ChatSession } from '../langchain-backend/llm';

export class BYOKProvider implements LLMProvider {
    readonly name = 'Bring Your Own Key';
    private apiKey?: string;

    get isAvailable(): boolean {
        return !!this.apiKey;
    }

    async initialize(options: LLMProviderOptions): Promise<void> {
        if (!options.apiKey) {
            throw new LLMProviderError(
                'API key is required for BYOK mode',
                this.name,
                'AUTH_FAILED'
            );
        }

        this.apiKey = options.apiKey;

        // Test the API key
        try {
            await this.testConnection();
        } catch (error) {
            throw new LLMProviderError(
                'Invalid API key provided',
                this.name,
                'AUTH_FAILED'
            );
        }
    }

    async createChatSession(systemMessage: string): Promise<ChatSession> {
        if (!this.apiKey) {
            throw new LLMProviderError(
                'Provider not initialized',
                this.name,
                'AUTH_FAILED'
            );
        }

        try {
            return createChat({
                apiKey: this.apiKey,
                model: 'gemini-2.0-flash',
                temperature: 0,
                systemMessage
            });
        } catch (error) {
            throw new LLMProviderError(
                'Failed to create BYOK chat session',
                this.name,
                'MODEL_ERROR'
            );
        }
    }

    async testConnection(): Promise<boolean> {
        if (!this.apiKey) return false;

        try {
            const model = new ChatGoogleGenerativeAI({
                apiKey: this.apiKey,
                model: 'gemini-2.0-flash'
            });

            // Simple test message
            await model.invoke('Test');
            return true;
        } catch (error) {
            return false;
        }
    }

    async getUsageInfo(): Promise<UsageInfo> {
        return {
            requestsToday: 0,
            requestsRemaining: Infinity,
            isUnlimited: true
        };
    }
}
```

#### 2.3 Local Provider (`src/llm-providers/local.ts`)

First, add local LLM dependencies:
```bash
npm install @langchain/community node-fetch
```

```typescript
import { ChatOllama } from '@langchain/community/chat_models/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { LLMProvider, LLMProviderOptions, LLMProviderError, UsageInfo } from './base';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } from '../langchain-backend/features';
import { ChatSession } from '../langchain-backend/llm';
import fetch from 'node-fetch';

export interface LocalBackendConfig {
    type: 'ollama' | 'lmstudio' | 'llamacpp' | 'textgen' | 'custom';
    baseUrl: string;
    defaultModel: string;
    apiFormat: 'ollama' | 'openai' | 'llamacpp' | 'textgen';
    healthEndpoint?: string;
    modelsEndpoint?: string;
}

export class LocalProvider implements LLMProvider {
    readonly name = 'Local LLM';
    private model?: any;
    private backendConfig?: LocalBackendConfig;

    get isAvailable(): boolean {
        return !!this.model;
    }

    async initialize(options: LLMProviderOptions): Promise<void> {
        const backend = options.backend || 'ollama';
        const baseUrl = options.baseUrl || this.getDefaultUrl(backend);
        const modelName = options.model || this.getDefaultModel(backend);

        this.backendConfig = this.getBackendConfig(backend, baseUrl, modelName);

        try {
            // Test connection first
            if (!(await this.testConnection())) {
                throw new Error('Connection test failed');
            }

            // Create model based on backend type
            this.model = this.createModelForBackend(this.backendConfig, options);

        } catch (error) {
            throw new LLMProviderError(
                `Failed to connect to ${backend} at ${baseUrl}. Make sure the server is running.`,
                this.name,
                'NETWORK_ERROR'
            );
        }
    }

    private getBackendConfig(backend: string, baseUrl: string, model: string): LocalBackendConfig {
        const configs: Record<string, LocalBackendConfig> = {
            ollama: {
                type: 'ollama',
                baseUrl,
                defaultModel: model,
                apiFormat: 'ollama',
                healthEndpoint: '/api/tags',
                modelsEndpoint: '/api/tags'
            },
            lmstudio: {
                type: 'lmstudio',
                baseUrl: baseUrl.replace(':1234', ':1234/v1'), // Ensure /v1 suffix
                defaultModel: model,
                apiFormat: 'openai',
                healthEndpoint: '/models',
                modelsEndpoint: '/models'
            },
            llamacpp: {
                type: 'llamacpp',
                baseUrl,
                defaultModel: model,
                apiFormat: 'llamacpp',
                healthEndpoint: '/health',
                modelsEndpoint: '/v1/models'
            },
            textgen: {
                type: 'textgen',
                baseUrl: baseUrl.replace(':7860', ':5000'), // Common port difference
                defaultModel: model,
                apiFormat: 'textgen',
                healthEndpoint: '/v1/models',
                modelsEndpoint: '/v1/models'
            },
            custom: {
                type: 'custom',
                baseUrl,
                defaultModel: model,
                apiFormat: 'openai', // Default to OpenAI-compatible
                healthEndpoint: '/health',
                modelsEndpoint: '/models'
            }
        };

        return configs[backend] || configs.custom;
    }

    private getDefaultUrl(backend: string): string {
        const defaultUrls: Record<string, string> = {
            ollama: 'http://localhost:11434',
            lmstudio: 'http://localhost:1234',
            llamacpp: 'http://localhost:8080',
            textgen: 'http://localhost:5000',
            custom: 'http://localhost:8080'
        };
        return defaultUrls[backend] || defaultUrls.custom;
    }

    private getDefaultModel(backend: string): string {
        const defaultModels: Record<string, string> = {
            ollama: 'llama3.1:8b',
            lmstudio: 'local-model',
            llamacpp: 'model',
            textgen: 'model',
            custom: 'model'
        };
        return defaultModels[backend] || defaultModels.custom;
    }

    private createModelForBackend(config: LocalBackendConfig, options: LLMProviderOptions): any {
        switch (config.apiFormat) {
            case 'ollama':
                return new ChatOllama({
                    baseUrl: config.baseUrl,
                    model: config.defaultModel,
                    temperature: options.temperature || 0,
                });

            case 'openai':
                // LM Studio, and other OpenAI-compatible APIs
                return new ChatOpenAI({
                    openAIApiKey: 'not-needed', // Local servers don't need API key
                    configuration: {
                        baseURL: config.baseUrl,
                    },
                    modelName: config.defaultModel,
                    temperature: options.temperature || 0,
                });

            case 'llamacpp':
                // llama.cpp server (OpenAI-compatible)
                return new ChatOpenAI({
                    openAIApiKey: 'not-needed',
                    configuration: {
                        baseURL: `${config.baseUrl}/v1`,
                    },
                    modelName: config.defaultModel,
                    temperature: options.temperature || 0,
                });

            case 'textgen':
                // Text Generation WebUI (OpenAI-compatible)
                return new ChatOpenAI({
                    openAIApiKey: 'not-needed',
                    configuration: {
                        baseURL: `${config.baseUrl}/v1`,
                    },
                    modelName: config.defaultModel,
                    temperature: options.temperature || 0,
                });

            default:
                throw new Error(`Unsupported API format: ${config.apiFormat}`);
        }
    }

    async createChatSession(systemMessage: string): Promise<ChatSession> {
        if (!this.model || !this.backendConfig) {
            throw new LLMProviderError(
                'Provider not initialized',
                this.name,
                'MODEL_ERROR'
            );
        }

        // Create a custom ChatSession compatible with existing interface
        return this.createLocalChatSession(systemMessage);
    }

    private createLocalChatSession(systemMessage: string): ChatSession {
        // Adapt the existing createChat logic to work with any local model
        // This is a simplified version - you'll need to implement the full logic
        const maxHistory = 40;
        let history: any[] = [];

        if (systemMessage) {
            history.push({ role: 'system', content: systemMessage });
        }

        // Define tools (same as original)
        const retrieveFilenames = tool(
            async () => {
                const toolInstance = new RetrieveWorkspaceFilenamesTool();
                return await toolInstance._call();
            },
            {
                name: 'retrieveFilenames',
                description: 'Retrieve all filenames in the workspace.',
            }
        );

        const retrieveFileContent = tool(
            async ({ filePath }) => {
                const toolInstance = new RetrieveFileContentTool();
                return await toolInstance._call(filePath);
            },
            {
                name: 'retrieveFileContent',
                description: 'Retrieve the content of a specific file.',
                schema: z.object({
                    filePath: z.string().describe('The path of the file to read.'),
                }),
            }
        );

        // Create agent with local model
        const agent = createReactAgent({
            llm: this.model,
            tools: [retrieveFilenames, retrieveFileContent],
        });

        return {
            async chat(userMessage: string): Promise<string> {
                try {
                    history.push({ role: 'user', content: userMessage });
                    
                    const response = await agent.invoke({
                        messages: history,
                    });

                    const lastMessage = response.messages[response.messages.length - 1];
                    let aiText = '';
                    
                    if (typeof lastMessage.content === 'string') {
                        aiText = lastMessage.content;
                    } else if (Array.isArray(lastMessage.content)) {
                        aiText = lastMessage.content.map(c =>
                            typeof c === 'string' ? c : JSON.stringify(c)
                        ).join(' ');
                    } else {
                        aiText = JSON.stringify(lastMessage.content);
                    }

                    history.push({ role: 'assistant', content: aiText });

                    // Prune history if too long
                    if (history.length > maxHistory) {
                        history = history.slice(history.length - maxHistory);
                    }

                    return aiText;
                } catch (error) {
                    throw new Error(`Local LLM error: ${error}`);
                }
            },

            reset() {
                history = [];
                if (systemMessage) {
                    history.push({ role: 'system', content: systemMessage });
                }
            },

            getHistory() {
                return history.filter(msg => msg.role !== 'system');
            },

            setHistory(historyArr: any[]) {
                history = [];
                if (systemMessage) {
                    history.push({ role: 'system', content: systemMessage });
                }
                history.push(...historyArr);
            },

            setCustomSystemMessage(msg: string) {
                history = history.filter(m => m.role !== 'system');
                history.unshift({ role: 'system', content: msg });
            }
        };
    }

    async testConnection(): Promise<boolean> {
        if (!this.backendConfig) return false;

        try {
            const healthUrl = `${this.backendConfig.baseUrl}${this.backendConfig.healthEndpoint}`;
            const response = await fetch(healthUrl);
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    async getAvailableModels(): Promise<string[]> {
        if (!this.backendConfig) return [];

        try {
            const modelsUrl = `${this.backendConfig.baseUrl}${this.backendConfig.modelsEndpoint}`;
            const response = await fetch(modelsUrl);
            
            if (!response.ok) return [];

            const data = await response.json();

            // Parse models based on backend type
            switch (this.backendConfig.type) {
                case 'ollama':
                    return data.models?.map((m: any) => m.name) || [];
                case 'lmstudio':
                case 'llamacpp':
                case 'textgen':
                    return data.data?.map((m: any) => m.id) || [];
                default:
                    return [];
            }
        } catch (error) {
            return [];
        }
    }

    async getUsageInfo(): Promise<UsageInfo> {
        return {
            requestsToday: 0,
            requestsRemaining: Infinity,
            isUnlimited: true
        };
    }

    getBackendInfo(): LocalBackendConfig | undefined {
        return this.backendConfig;
    }
}
```

### Phase 3: Provider Manager

#### 3.1 Create Provider Manager (`src/llm-providers/manager.ts`)

```typescript
import * as vscode from 'vscode';
import { LLMProvider, LLMProviderError } from './base';
import { OOTBProvider } from './ootb';
import { BYOKProvider } from './byok';
import { LocalProvider } from './local';
import { ChatSession } from '../langchain-backend/llm';

export class LLMProviderManager {
    private currentProvider?: LLMProvider;
    private readonly providers: Map<string, LLMProvider> = new Map();

    constructor() {
        this.providers.set('ootb', new OOTBProvider());
        this.providers.set('byok', new BYOKProvider());
        this.providers.set('local', new LocalProvider());
    }

    async initializeFromConfig(): Promise<void> {
        const config = vscode.workspace.getConfiguration('naruhodocs');
        const providerType = config.get<string>('llm.provider', 'ootb');
        
        const provider = this.providers.get(providerType);
        if (!provider) {
            throw new Error(`Unknown provider type: ${providerType}`);
        }

        try {
            const options: any = {
                apiKey: config.get<string>('llm.apiKey'),
                model: config.get<string>('llm.localModel'),
                baseUrl: config.get<string>('llm.localUrl'),
                temperature: 0
            };

            // Add backend type for local provider
            if (providerType === 'local') {
                options.backend = config.get<string>('llm.localBackend', 'ollama');
            }

            await provider.initialize(options);

            this.currentProvider = provider;
            
            vscode.window.showInformationMessage(
                `NaruhoDocs: ${provider.name} provider initialized successfully`
            );
        } catch (error) {
            if (error instanceof LLMProviderError) {
                this.handleProviderError(error, providerType);
            } else {
                vscode.window.showErrorMessage(`Failed to initialize ${provider.name}: ${error}`);
            }
        }
    }

    async createChatSession(systemMessage: string): Promise<ChatSession> {
        if (!this.currentProvider) {
            throw new Error('No LLM provider initialized');
        }

        return this.currentProvider.createChatSession(systemMessage);
    }

    async testConnection(): Promise<boolean> {
        if (!this.currentProvider) return false;
        return this.currentProvider.testConnection();
    }

    async getUsageInfo() {
        if (!this.currentProvider) return null;
        return this.currentProvider.getUsageInfo();
    }

    getCurrentProvider(): LLMProvider | undefined {
        return this.currentProvider;
    }

    private handleProviderError(error: LLMProviderError, providerType: string): void {
        switch (error.code) {
            case 'AUTH_FAILED':
                if (providerType === 'byok') {
                    vscode.window.showErrorMessage(
                        'Invalid API key. Please check your settings.',
                        'Open Settings'
                    ).then(selection => {
                        if (selection === 'Open Settings') {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'naruhodocs.llm');
                        }
                    });
                }
                break;
            case 'RATE_LIMITED':
                vscode.window.showWarningMessage(
                    error.message,
                    'Upgrade to BYOK'
                ).then(selection => {
                    if (selection === 'Upgrade to BYOK') {
                        vscode.commands.executeCommand('naruhodocs.configureLLM');
                    }
                });
                break;
            case 'NETWORK_ERROR':
                if (providerType === 'local') {
                    vscode.window.showErrorMessage(
                        'Cannot connect to local LLM. Make sure Ollama is running.',
                        'Install Ollama',
                        'Check Settings'
                    ).then(selection => {
                        if (selection === 'Install Ollama') {
                            vscode.env.openExternal(vscode.Uri.parse('https://ollama.ai'));
                        } else if (selection === 'Check Settings') {
                            vscode.commands.executeCommand('workbench.action.openSettings', 'naruhodocs.llm');
                        }
                    });
                }
                break;
            default:
                vscode.window.showErrorMessage(error.message);
                break;
        }
    }
}
```

### Phase 4: Update Existing Code

#### 4.1 Update extension.ts

```typescript
// Add to existing imports
import { LLMProviderManager } from './llm-providers/manager';

export function activate(context: vscode.ExtensionContext) {
    // Create provider manager
    const llmManager = new LLMProviderManager();
    
    // Initialize provider from configuration
    llmManager.initializeFromConfig().catch(error => {
        console.error('Failed to initialize LLM provider:', error);
    });

    // Update ChatViewProvider instantiation
    const chatViewProvider = new ChatViewProvider(
        context.extensionUri,
        undefined, // Remove direct API key
        context,
        llmManager  // Pass the manager instead
    );

    // Add new commands
    context.subscriptions.push(
        vscode.commands.registerCommand('naruhodocs.configureLLM', async () => {
            await showLLMConfigurationQuickPick(llmManager);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('naruhodocs.testLLMConnection', async () => {
            const isConnected = await llmManager.testConnection();
            const provider = llmManager.getCurrentProvider();
            if (isConnected) {
                vscode.window.showInformationMessage(`✅ ${provider?.name} connection successful`);
            } else {
                vscode.window.showErrorMessage(`❌ ${provider?.name} connection failed`);
            }
        })
    );

    // ... rest of existing code
}

async function showLLMConfigurationQuickPick(llmManager: LLMProviderManager) {
    const items = [
        {
            label: '🚀 Out-of-the-Box',
            description: 'Built-in Gemini with daily limits',
            value: 'ootb'
        },
        {
            label: '🔑 Bring Your Own Key',
            description: 'Unlimited access with your API key',
            value: 'byok'
        },
        {
            label: '🏠 Local LLM',
            description: 'Use local models (Ollama, LM Studio, etc.)',
            value: 'local'
        }
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose your LLM provider'
    });

    if (selected) {
        const config = vscode.workspace.getConfiguration('naruhodocs');
        await config.update('llm.provider', selected.value, vscode.ConfigurationTarget.Global);

        if (selected.value === 'byok') {
            const apiKey = await vscode.window.showInputBox({
                prompt: 'Enter your Google Gemini API key',
                password: true
            });
            if (apiKey) {
                await config.update('llm.apiKey', apiKey, vscode.ConfigurationTarget.Global);
            }
        } else if (selected.value === 'local') {
            await configureLocalLLM(config);
        }

        // Reinitialize with new settings
        await llmManager.initializeFromConfig();
    }
}

async function configureLocalLLM(config: vscode.WorkspaceConfiguration) {
    const backendItems = [
        {
            label: '🦙 Ollama',
            description: 'Easy model management (Recommended)',
            value: 'ollama',
            defaultUrl: 'http://localhost:11434',
            defaultModel: 'llama3.1:8b'
        },
        {
            label: '🎮 LM Studio',
            description: 'User-friendly GUI interface',
            value: 'lmstudio',
            defaultUrl: 'http://localhost:1234',
            defaultModel: 'local-model'
        },
        {
            label: '⚡ llama.cpp',
            description: 'Lightweight C++ implementation',
            value: 'llamacpp',
            defaultUrl: 'http://localhost:8080',
            defaultModel: 'model'
        },
        {
            label: '🌐 Text Generation WebUI',
            description: 'Advanced web interface',
            value: 'textgen',
            defaultUrl: 'http://localhost:5000',
            defaultModel: 'model'
        },
        {
            label: '🔧 Custom',
            description: 'Custom API endpoint',
            value: 'custom',
            defaultUrl: 'http://localhost:8080',
            defaultModel: 'model'
        }
    ];

    const selectedBackend = await vscode.window.showQuickPick(backendItems, {
        placeHolder: 'Choose your local LLM backend'
    });

    if (selectedBackend) {
        await config.update('llm.localBackend', selectedBackend.value, vscode.ConfigurationTarget.Global);
        
        // Ask for custom URL if needed
        const customUrl = await vscode.window.showInputBox({
            prompt: `Enter the URL for ${selectedBackend.label}`,
            value: selectedBackend.defaultUrl,
            validateInput: (value) => {
                try {
                    new URL(value);
                    return null;
                } catch {
                    return 'Please enter a valid URL';
                }
            }
        });

        if (customUrl) {
            await config.update('llm.localUrl', customUrl, vscode.ConfigurationTarget.Global);
        }

        // Ask for model name
        const modelName = await vscode.window.showInputBox({
            prompt: `Enter the model name for ${selectedBackend.label}`,
            value: selectedBackend.defaultModel,
            placeHolder: 'e.g., llama3.1:8b, codellama:7b'
        });

        if (modelName) {
            await config.update('llm.localModel', modelName, vscode.ConfigurationTarget.Global);
        }

        // Show setup instructions
        showLocalLLMSetupInstructions(selectedBackend.value);
    }
}

function showLocalLLMSetupInstructions(backend: string) {
    const instructions: Record<string, string> = {
        ollama: `
To set up Ollama:
1. Download from: https://ollama.ai
2. Install and run: ollama pull llama3.1:8b
3. The API will be available at http://localhost:11434
        `,
        lmstudio: `
To set up LM Studio:
1. Download from: https://lmstudio.ai
2. Download a model in the app
3. Start the local server (usually on port 1234)
        `,
        llamacpp: `
To set up llama.cpp:
1. Build from: https://github.com/ggerganov/llama.cpp
2. Run: ./server -m model.gguf --port 8080
3. API will be available at http://localhost:8080
        `,
        textgen: `
To set up Text Generation WebUI:
1. Clone: https://github.com/oobabooga/text-generation-webui
2. Install and run with --api flag
3. API will be available at http://localhost:5000
        `,
        custom: `
For custom setup:
1. Ensure your API is OpenAI-compatible
2. Use the correct base URL and model name
3. Test the connection using the "Test LLM Connection" command
        `
    };

    const instruction = instructions[backend] || instructions.custom;
    
    vscode.window.showInformationMessage(
        `${backend.charAt(0).toUpperCase() + backend.slice(1)} Setup Instructions`,
        'Show Details'
    ).then(selection => {
        if (selection === 'Show Details') {
            vscode.window.showInformationMessage(instruction.trim());
        }
    });
}
```

#### 4.2 Update ChatViewProvider.ts

```typescript
// Update constructor
constructor(
    private readonly _extensionUri: vscode.Uri,
    private apiKey?: string, // Keep for backward compatibility
    context?: vscode.ExtensionContext,
    private llmManager?: LLMProviderManager
) {
    // ... existing code but use llmManager instead of direct createChat calls
}

// Update createThread method
public createThread(sessionId: string, initialContext: string, title: string) {
    if (!this.sessions.has(sessionId)) {
        const sysMessage = SystemMessages.DOCUMENT_SPECIFIC_DEVELOPER(title, initialContext);
        const savedHistory = this.context.workspaceState.get<any[]>(`thread-history-${sessionId}`);
        
        // Use the manager instead of direct createChat
        if (this.llmManager) {
            this.llmManager.createChatSession(sysMessage).then(session => {
                if (savedHistory && Array.isArray(savedHistory)) {
                    session.setHistory(savedHistory);
                }
                this.sessions.set(sessionId, session);
                this.threadTitles.set(sessionId, title);
                this._postThreadList();
            }).catch(error => {
                console.error('Failed to create chat session:', error);
            });
        } else {
            // Fallback to existing method for backward compatibility
            const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
            // ... existing code
        }
    }
}
```

## Implementation Steps

1. **Phase 1**: Create the provider infrastructure (base interface, configuration)
2. **Phase 2**: Implement each provider (OOTB, BYOK, Local)
3. **Phase 3**: Create the provider manager
4. **Phase 4**: Update existing code to use the new system
5. **Testing**: Test each provider thoroughly
6. **Documentation**: Update README with setup instructions

## Popular Local LLM Options

### **1. Ollama (Recommended for Beginners)**
- **Pros**: Easy installation, automatic model management, built-in API
- **Cons**: Limited advanced configuration options
- **Setup**: `ollama pull llama3.1:8b` → Ready to use
- **API**: Native Ollama API format
- **Default Port**: 11434

### **2. LM Studio**
- **Pros**: Beautiful GUI, model discovery, easy model switching
- **Cons**: Proprietary software, limited to GUI interaction
- **Setup**: Download app → Browse and download models → Start server
- **API**: OpenAI-compatible
- **Default Port**: 1234

### **3. llama.cpp**
- **Pros**: Lightweight, fast inference, highly optimizable
- **Cons**: Command-line only, manual model conversion required
- **Setup**: Build from source → Convert models → Run server
- **API**: OpenAI-compatible
- **Default Port**: 8080

### **4. Text Generation WebUI (oobabooga)**
- **Pros**: Advanced features, multiple backends, extensive customization
- **Cons**: Complex setup, resource intensive
- **Setup**: Python environment → Install → Run with --api flag
- **API**: OpenAI-compatible + custom endpoints
- **Default Port**: 5000

### **5. Custom Solutions**
- **Pros**: Full control, integration with existing infrastructure
- **Cons**: Requires custom implementation
- **Setup**: User-defined
- **API**: Usually OpenAI-compatible
- **Port**: User-defined

## Implementation Benefits

With this enhanced local provider implementation, users get:

1. **Multiple Backend Support**: Choose the best tool for their needs
2. **Unified Interface**: Same API regardless of backend
3. **Automatic Configuration**: Smart defaults for each backend type
4. **Easy Switching**: Change backends without code changes
5. **Model Discovery**: List available models for each backend
6. **Setup Guidance**: Built-in instructions for each backend

## Advanced Features

### Model Discovery and Selection

Add a command to let users browse available models:

```typescript
context.subscriptions.push(
    vscode.commands.registerCommand('naruhodocs.selectLocalModel', async () => {
        const provider = llmManager.getCurrentProvider();
        if (provider instanceof LocalProvider) {
            const models = await provider.getAvailableModels();
            if (models.length > 0) {
                const selected = await vscode.window.showQuickPick(models, {
                    placeHolder: 'Select a model to use'
                });
                if (selected) {
                    const config = vscode.workspace.getConfiguration('naruhodocs');
                    await config.update('llm.localModel', selected, vscode.ConfigurationTarget.Global);
                    await llmManager.initializeFromConfig();
                }
            } else {
                vscode.window.showInformationMessage('No models found. Make sure your local LLM server is running.');
            }
        }
    })
);
```

### Backend Health Monitoring

```typescript
// Add to LLMProviderManager
async startHealthMonitoring(): Promise<void> {
    if (this.currentProvider instanceof LocalProvider) {
        setInterval(async () => {
            const isHealthy = await this.currentProvider.testConnection();
            if (!isHealthy) {
                vscode.window.showWarningMessage(
                    'Local LLM connection lost. Check if your server is running.',
                    'Retry Connection'
                ).then(selection => {
                    if (selection === 'Retry Connection') {
                        this.initializeFromConfig();
                    }
                });
            }
        }, 30000); // Check every 30 seconds
    }
}
```

## Next Steps

1. Start with Phase 1 to establish the foundation
2. Implement OOTB provider first (simplest)
3. Add BYOK provider (most commonly used)
4. Add Local provider last (most complex)
5. Test thoroughly with each provider
6. Update documentation and user guides

This architecture provides a solid foundation for supporting multiple LLM providers while maintaining a great user experience.
