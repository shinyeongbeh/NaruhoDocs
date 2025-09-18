import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { LLMProvider, LLMProviderOptions, LLMProviderError, UsageInfo } from './base';
import { createChat, ChatSession } from '../langchain-backend/llm';

export class OOTBProvider implements LLMProvider {
    readonly name = 'Out-of-the-Box Gemini';
    // Built-in key is now ONLY sourced from environment for security; no hard-coded fallback committed to repo
    private readonly BUILT_IN_API_KEY = process.env.NARUHODOCS_BUILT_IN_KEY || '';
    private readonly DAILY_LIMIT = 50; // Retained constant for potential future soft warnings (limit no longer enforced)
    // Map<dateString, count>
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

    async createChatSession(systemMessage: string, options?: { temperature?: number; model?: string }): Promise<ChatSession> {
        if (!this.BUILT_IN_API_KEY) {
            throw new LLMProviderError(
                'Built-in key unavailable. Switch to BYOK or configure environment variable NARUHODOCS_BUILT_IN_KEY.',
                this.name,
                'AUTH_FAILED'
            );
        }
        try {
            const baseSession = createChat({
                apiKey: this.BUILT_IN_API_KEY,
                model: options?.model || 'gemini-2.0-flash',
                temperature: options?.temperature ?? 0,
                systemMessage
            });

            // Wrap chat method to enforce DAILY_LIMIT per invocation instead of per session creation
            const self = this;
            const wrapped: ChatSession = {
                async chat(userMessage: string): Promise<string> {
                    const today = new Date().toDateString();
                    const count = self.usageTracker.get(today) || 0;
                    const answer = await baseSession.chat(userMessage);
                    self.usageTracker.set(today, count + 1); // Increment count (no hard limit)
                    return answer;
                },
                reset() { baseSession.reset(); },
                getHistory() { return baseSession.getHistory(); },
                setHistory(arr) { baseSession.setHistory(arr); },
                setCustomSystemMessage(msg: string) { baseSession.setCustomSystemMessage(msg); }
            };
            return wrapped;
        } catch (error: any) {
            throw new LLMProviderError(
                `Failed to create OOTB chat session: ${error?.message || 'Unknown error'}`,
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
            const session = createChat({
                apiKey: this.BUILT_IN_API_KEY,
                model: 'gemini-2.0-flash',
                temperature: 0,
                systemMessage: 'Health check'
            });
            await session.chat('ping');
            return true;
        } catch {
            return false;
        }
    }

    async getUsageInfo(): Promise<UsageInfo> {
        const today = new Date().toDateString();
        const requestsToday = this.usageTracker.get(today) || 0;
        return {
            requestsToday,
            requestsRemaining: Infinity, // No enforced limit now
            isUnlimited: true,
            resetTime: new Date(new Date().setHours(24, 0, 0, 0))
        };
    }
}
