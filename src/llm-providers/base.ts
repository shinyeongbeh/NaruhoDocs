import { ChatSession } from '../langchain-backend/llm';

export interface LLMProviderOptions {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    temperature?: number;
    backend?: string; // For local providers to specify backend type
}

export interface LLMProvider {
    readonly name: string;
    readonly isAvailable: boolean;
    
    initialize(options: LLMProviderOptions): Promise<void>;
    createChatSession(systemMessage: string, options?: { temperature?: number; model?: string }): Promise<ChatSession>;
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
