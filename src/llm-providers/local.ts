import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { LLMProvider, LLMProviderOptions, LLMProviderError, UsageInfo } from './base';
import { ChatSession, createChat } from '../langchain-backend/llm';
import { AIMessage, HumanMessage, BaseMessage, SystemMessage } from '@langchain/core/messages';
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
        
        console.log('[NaruhoDocs] LocalProvider: Initializing with:', { backend, baseUrl, modelName });

        this.backendConfig = this.getBackendConfig(backend, baseUrl, modelName);
        console.log('[NaruhoDocs] LocalProvider: Backend config:', this.backendConfig);

        try {
            // Test connection first
            console.log('[NaruhoDocs] LocalProvider: Testing connection...');
            if (!(await this.testConnection())) {
                console.error('[NaruhoDocs] LocalProvider: Connection test failed');
                throw new Error('Connection test failed');
            }
            console.log('[NaruhoDocs] LocalProvider: Connection test passed');

            // Create model based on backend type
            console.log('[NaruhoDocs] LocalProvider: Creating model for backend...');
            this.model = this.createModelForBackend(this.backendConfig, options);
            console.log('[NaruhoDocs] LocalProvider: Model created successfully');

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
                baseUrl: baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`,
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
                baseUrl: baseUrl.replace(':7860', ':5000'),
                defaultModel: model,
                apiFormat: 'textgen',
                healthEndpoint: '/v1/models',
                modelsEndpoint: '/v1/models'
            },
            custom: {
                type: 'custom',
                baseUrl,
                defaultModel: model,
                apiFormat: 'openai',
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
            ollama: 'gemma3:1b',
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
                    apiKey: 'not-needed',
                    configuration: {
                        baseURL: config.baseUrl,
                    },
                    modelName: config.defaultModel,
                    temperature: options.temperature || 0,
                });

            case 'llamacpp':
                // llama.cpp server (OpenAI-compatible)
                return new ChatOpenAI({
                    apiKey: 'not-needed',
                    configuration: {
                        baseURL: `${config.baseUrl}/v1`,
                    },
                    modelName: config.defaultModel,
                    temperature: options.temperature || 0,
                });

            case 'textgen':
                // Text Generation WebUI (OpenAI-compatible)
                return new ChatOpenAI({
                    apiKey: 'not-needed',
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

    async createChatSession(systemMessage: string, options?: { temperature?: number; model?: string }): Promise<ChatSession> {
        if (!this.model || !this.backendConfig) {
            throw new LLMProviderError(
                'Provider not initialized',
                this.name,
                'MODEL_ERROR'
            );
        }
        // Apply model override (if provided) by updating backend config and recreating model
        if (options?.model && this.backendConfig.defaultModel !== options.model) {
            try {
                this.backendConfig.defaultModel = options.model;
                this.model = this.createModelForBackend(this.backendConfig, { temperature: options.temperature });
            } catch (e) {
                console.warn('[LocalProvider] Failed to apply model override:', e);
            }
        }

        // Use simplified chat session for local models to avoid agent/tool binding issues
        return this.createLocalChatSession(systemMessage, options);
    }

    private createLocalChatSession(systemMessage: string, options?: { temperature?: number }): ChatSession {
        const maxHistory = 40;
        let history: BaseMessage[] = [];
        const model = this.model; // Capture model reference

        if (systemMessage) {
            history.push(new SystemMessage(systemMessage));
        }

        function prune() {
            if (history.length > maxHistory) {
                // Keep system message at the start, prune from the middle
                const systemMsg = history.find(msg => msg instanceof SystemMessage);
                const otherMsgs = history.filter(msg => !(msg instanceof SystemMessage));
                history = systemMsg ? [systemMsg, ...otherMsgs.slice(-maxHistory + 1)] : otherMsgs.slice(-maxHistory);
            }
        }

        return {
            async chat(userMessage: string): Promise<string> {
                try {
                    history.push(new HumanMessage(userMessage));
                    prune();

                    // Use the model directly without agents
                    const response = await model.invoke(history);

                    let aiText = '';
                    
                    if (typeof response.content === 'string') {
                        aiText = response.content;
                    } else if (Array.isArray(response.content)) {
                        aiText = response.content.map((c: any) =>
                            typeof c === 'string' ? c : JSON.stringify(c)
                        ).join(' ');
                    } else {
                        aiText = JSON.stringify(response.content);
                    }

                    // Extract all <think> blocks (reasoning) before storing final answer
                    const thinkBlocks: string[] = [];
                    aiText = aiText.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
                        const cleaned = String(inner).trim();
                        if (cleaned) { thinkBlocks.push(cleaned); }
                        return ''; // remove from visible answer
                    }).trim();

                    // Build collapsible reasoning section if any think blocks were present
                    const vscode = require('vscode');
                    const showReasoning = vscode.workspace.getConfiguration('naruhodocs').get('llm.showReasoning', true) as boolean;
                    if (thinkBlocks.length && showReasoning) {
                        const joined = thinkBlocks.join('\n---\n');
                        // Replace literal \n with actual newlines for proper formatting
                        const normalized = joined.replace(/\\n/g, '\n');
                        // Escape HTML entities to avoid accidental rendering inside code fence
                        const escaped = normalized
                            .replace(/&/g, '&amp;')
                            .replace(/</g, '&lt;')
                            .replace(/>/g, '&gt;');
                        const reasoningSection = `\n\n<details class="ai-reasoning">\n<summary>Show reasoning</summary>\n\n\`\`\`text\n${escaped}\n\`\`\`\n\n</details>\n\n`;
                        aiText = aiText + reasoningSection;
                    }

                    const aiMessage = new AIMessage(aiText);
                    history.push(aiMessage);
                    prune();

                    return aiText;
                } catch (error) {
                    throw new Error(`Local LLM error: ${error}`);
                }
            },

            reset() {
                history = [];
                if (systemMessage) {
                    history.push(new SystemMessage(systemMessage));
                }
            },

            getHistory() {
                return history.filter(msg => !(msg instanceof SystemMessage));
            },

            setHistory(historyArr: BaseMessage[]) {
                history = [];
                if (systemMessage) {
                    history.push(new SystemMessage(systemMessage));
                }
                for (const msg of historyArr) {
                    const type = (msg as any).type;
                    const text = (msg as any).text;
                    if (type === 'human') { 
                        history.push(new HumanMessage(text)); 
                    }
                    if (type === 'ai') { 
                        history.push(new AIMessage(text)); 
                    }
                }
            },

            setCustomSystemMessage(msg: string) {
                history = history.filter(m => !(m instanceof SystemMessage));
                history.unshift(new SystemMessage(msg));
            }
        };
    }

    async testConnection(): Promise<boolean> {
        if (!this.backendConfig) {
            return false;
        }

        try {
            const healthUrl = `${this.backendConfig.baseUrl}${this.backendConfig.healthEndpoint}`;
            const response = await fetch(healthUrl);
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    async getAvailableModels(): Promise<string[]> {
        if (!this.backendConfig) {
            return [];
        }

        try {
            const modelsUrl = `${this.backendConfig.baseUrl}${this.backendConfig.modelsEndpoint}`;
            const response = await fetch(modelsUrl);
            
            if (!response.ok) {
                return [];
            }

            const data = await response.json() as any;

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
