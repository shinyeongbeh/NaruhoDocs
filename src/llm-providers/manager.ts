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
            console.log(`LLMProviderManager: Initialized ${provider.name}`);
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
        if (!this.currentProvider) {
            return false;
        }
        return this.currentProvider.testConnection();
    }

    async getUsageInfo() {
        if (!this.currentProvider) {
            return null;
        }
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
                } else if (providerType === 'ootb') {
                    vscode.window.showErrorMessage(
                        'Built-in API key not available. Please use BYOK mode.',
                        'Configure BYOK'
                    ).then(selection => {
                        if (selection === 'Configure BYOK') {
                            vscode.commands.executeCommand('naruhodocs.configureLLM');
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
                        'Cannot connect to local LLM. Make sure your server is running.',
                        'Install Guide',
                        'Check Settings'
                    ).then(selection => {
                        if (selection === 'Install Guide') {
                            this.showLocalLLMInstallGuide();
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

    private showLocalLLMInstallGuide(): void {
        const message = `
Local LLM Setup Guide:

1. Ollama (Recommended):
   - Download: https://ollama.ai
   - Run: ollama pull llama3.1:8b

2. LM Studio:
   - Download: https://lmstudio.ai
   - Start local server

3. Text Generation WebUI:
   - Clone: https://github.com/oobabooga/text-generation-webui
   - Run with --api flag
        `;

        vscode.window.showInformationMessage(
            'Local LLM Setup Required',
            'Show Guide'
        ).then(selection => {
            if (selection === 'Show Guide') {
                vscode.window.showInformationMessage(message);
            }
        });
    }
}
