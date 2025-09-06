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
        if (!this.apiKey) {
            return false;
        }

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
