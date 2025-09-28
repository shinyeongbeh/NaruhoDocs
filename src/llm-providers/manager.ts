import * as vscode from 'vscode';
import { LLMProvider, LLMProviderError } from './base';
import { BYOKProvider } from './byok';
import { LocalProvider } from './local';
import { ChatSession } from '../langchain-backend/llm';
import { ModelConfigManager } from '../managers/ModelConfigManager';

export class LLMProviderManager {
    private currentProvider?: LLMProvider;
    private readonly providers: Map<string, LLMProvider> = new Map();
    private modelConfigManager?: ModelConfigManager; // optional injection – lets us honor models.json at provider init time

    constructor() {
    // Removed deprecated 'ootb' provider. Providers: 'cloud' (formerly 'byok') and 'local'.
    this.providers.set('cloud', new BYOKProvider());
        this.providers.set('local', new LocalProvider());
    }

    /** Inject active ModelConfigManager so we can source local backend/model from models.json */
    public setModelConfigManager(mgr: ModelConfigManager) {
        this.modelConfigManager = mgr;
    }

    async initializeFromConfig(): Promise<void> {
        // Add a small delay to ensure configuration is fully loaded (helps with packaged extensions)
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const config = vscode.workspace.getConfiguration('naruhodocs');
        let providerType = config.get<string>('llm.provider', 'cloud');
        // Migration: map legacy identifiers to current ones
        if (providerType === 'ootb') {
            const apiKey = config.get<string>('llm.apiKey') || config.get<string>('geminiApiKey') || '';
            providerType = apiKey ? 'cloud' : 'local';
            try { await config.update('llm.provider', providerType, vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
            console.log('[NaruhoDocs] Migrated legacy provider "ootb" ->', providerType);
    } else if (providerType === 'byok') { // legacy id still encountered via old settings.json; migrate to cloud
            providerType = 'cloud';
            try { await config.update('llm.provider', providerType, vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
            console.log('[NaruhoDocs] Migrated legacy provider "byok" -> cloud');
        }
        console.log('[NaruhoDocs] LLMProviderManager: Initializing provider type:', providerType);
        
        const provider = this.providers.get(providerType);
        if (!provider) {
            console.error('[NaruhoDocs] LLMProviderManager: Unknown provider type:', providerType);
            throw new Error(`Unknown provider type: ${providerType}`);
        }
        console.log('[NaruhoDocs] LLMProviderManager: Found provider:', provider.name);

        try {
            const options: any = {
                apiKey: config.get<string>('llm.apiKey'),
                temperature: 0
            };

            if (providerType === 'local') {
                // precedence: models.json (if active) -> settings -> hardcoded fallback
                let usedSource: string[] = [];
                if (this.modelConfigManager?.isActive()) {
                    const entry = this.modelConfigManager.getProviderEntry('local');
                    if (entry) {
                        if (entry.backend) { options.backend = entry.backend; usedSource.push('file-backend'); }
                        if (entry.baseUrl) { options.baseUrl = entry.baseUrl; usedSource.push('file-baseUrl'); }
                        if (entry.defaultModel) { options.model = entry.defaultModel; usedSource.push('file-defaultModel'); }
                    }
                    // If no explicit defaultModel in entry, resolve via task-based resolver for chat
                    if (!options.model) {
                        const resolved = this.modelConfigManager.resolveModel('local', 'chat', undefined, 'gemma3:1b');
                        options.model = resolved.model; usedSource.push('file-resolve:' + resolved.trace.join('+'));
                    }
                }
                if (!options.backend) {
                    options.backend = config.get<string>('llm.localBackend', 'ollama'); usedSource.push('setting-backend');
                }
                if (!options.baseUrl) {
                    options.baseUrl = config.get<string>('llm.localUrl'); if (options.baseUrl) { usedSource.push('setting-baseUrl'); }
                }
                if (!options.model) {
                    const modelSetting = config.get<string>('llm.localModel');
                    if (modelSetting) { options.model = modelSetting; usedSource.push('setting-model'); }
                }
                if (!options.model) { options.model = 'gemma3:1b'; usedSource.push('hardcoded-fallback'); }
                if (!options.baseUrl) { options.baseUrl = 'http://localhost:11434'; usedSource.push('hardcoded-baseUrl'); }
                console.log('[NaruhoDocs] Local provider init model resolution path:', usedSource.join(' > '));
            } else {
                // Non-local providers keep existing settings path
                options.model = config.get<string>('llm.localModel'); // still supply optional for compatibility
            }

            console.log('[NaruhoDocs] LLMProviderManager: Initializing provider with options:', { 
                ...options, 
                apiKey: options.apiKey ? '[REDACTED]' : undefined 
            });

            // Validate configuration before attempting initialization
            if (providerType === 'local' && !options.baseUrl) {
                throw new Error('Local LLM provider requires baseUrl to be configured (after resolution)');
            }
            if (providerType === 'cloud' && !options.apiKey) {
                throw new Error('Cloud provider requires API key to be configured');
            }

            await provider.initialize(options);
            console.log('[NaruhoDocs] LLMProviderManager: Provider initialized successfully');

            // Local model availability validation (best-effort)
            if (providerType === 'local') {
                try {
                    const local = provider as any;
                    if (local.getAvailableModels) {
                        const models: string[] = await local.getAvailableModels();
                        const requested = options.model;
                        if (requested && models.length && !models.includes(requested)) {
                            vscode.window.showWarningMessage(`Local model '${requested}' not found in available models (${models.slice(0,10).join(', ')}). Pull or adjust models.json.`);
                        }
                    }
                } catch {/* ignore */}
            }

            this.currentProvider = provider; // Silent success (status bar will reflect provider)
            // Removed toast notification for provider initialization.
        } catch (error) {
            if (error instanceof LLMProviderError) {
                this.handleProviderError(error, providerType);
            } else {
                vscode.window.showErrorMessage(`Failed to initialize ${provider.name}: ${error}`);
            }
        }
    }

    async createChatSession(systemMessage: string, options?: { temperature?: number; model?: string }): Promise<ChatSession> {
        if (!this.currentProvider) {
            throw new Error('No LLM provider initialized');
        }
        return this.currentProvider.createChatSession(systemMessage, options);
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
                if (providerType === 'cloud') {
                    vscode.window.showErrorMessage(
                        'Invalid Cloud API key. Please check your settings.',
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
                    'Configure Cloud Provider'
                ).then(selection => {
                    if (selection === 'Configure Cloud Provider') {
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
   - Run: ollama pull gemma3:1b

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
