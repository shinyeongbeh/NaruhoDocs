import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { LLMProvider, LLMProviderOptions, LLMProviderError, UsageInfo } from './base';
import { createChat, ChatSession } from '../langchain-backend/llm';

export class OOTBProvider implements LLMProvider {
    readonly name = 'Out-of-the-Box Gemini';
    private readonly BUILT_IN_API_KEY = process.env.NARUHODOCS_BUILT_IN_KEY || 'AIzaSyD2krwtvNseweqLLJfRForQnHK9Uid0nfE'; // Using your existing key
    private readonly DAILY_LIMIT = 50;
    private usageTracker: Map<string, number> = new Map();

    get isAvailable(): boolean {
        return !!this.BUILT_IN_API_KEY; // Only available if built-in key is set
    }

    async initialize(options: LLMProviderOptions): Promise<void> {
        if (!this.BUILT_IN_API_KEY) {
            throw new LLMProviderError(
                'Built-in API key not configured. Please use BYOK mode instead.',
                this.name,
                'AUTH_FAILED'
            );
        }
        // No additional initialization needed for OOTB
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
        if (!this.BUILT_IN_API_KEY) {
            return false;
        }
        
        try {
            const model = new ChatGoogleGenerativeAI({
                apiKey: this.BUILT_IN_API_KEY,
                model: 'gemini-2.0-flash'
            });

            await model.invoke('Test');
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
