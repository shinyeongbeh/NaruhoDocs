import * as assert from 'assert';
import { LLMService } from '../managers/LLMService';
import { LLMProviderManager } from '../llm-providers/manager';
import { ChatSession } from '../langchain-backend/llm';

// Lightweight mock provider + manager
class MockChatSession implements ChatSession {
    private history: any[] = [];
    constructor(private systemMessage: string) {}
    async chat(userMessage: string): Promise<string> {
        this.history.push({ role: 'user', content: userMessage });
        const reply = `MOCK_RESPONSE:${userMessage.substring(0, 20)}`;
        this.history.push({ role: 'ai', content: reply });
        return reply;
    }
    reset(): void { this.history = []; }
    getHistory(): any[] { return this.history; }
    setHistory(h: any[]): void { this.history = h; }
    setCustomSystemMessage(): void { /* noop */ }
}

class MockProvider { name='mock'; isAvailable=true; async initialize(){} async createChatSession(systemMessage: string){ return new MockChatSession(systemMessage);} async testConnection(){return true;} async getUsageInfo(){return {requestsToday:0, requestsRemaining:Infinity, isUnlimited:true};}}

class MockProviderManager extends LLMProviderManager {
    private mock = new MockProvider() as any;
    constructor(){ super(); (this as any).currentProvider = this.mock; }
    getCurrentProvider(){ return this.mock; }
}

suite('LLMService Tests', () => {
    setup(() => {
        // Reset singleton between tests for isolation
        (LLMService as any).instance = undefined;
    });
    test('Session reuse with same key', async () => {
        const mgr = new MockProviderManager();
        const service = LLMService.getOrCreate(mgr);
        const s1 = await service.getSession('key1', 'System A');
        const s2 = await service.getSession('key1', 'System A');
        assert.strictEqual(s1, s2, 'Expected same session instance to be reused');
    });

    test('Different keys create different sessions', async () => {
        const mgr = new MockProviderManager();
        const service = LLMService.getOrCreate(mgr);
        const s1 = await service.getSession('keyA', 'Sys');
        const s2 = await service.getSession('keyB', 'Sys');
        assert.notStrictEqual(s1, s2, 'Expected different session objects');
    });

    test('Summarize request returns summarize type', async () => {
        const mgr = new MockProviderManager();
        const service = LLMService.getOrCreate(mgr);
        const resp = await service.request({ type: 'summarize', content: 'Some long content', sessionId: 'sum1' });
        assert.strictEqual(resp.type, 'summarize');
        assert.ok(resp.content.startsWith('MOCK_RESPONSE'), 'Mock response prefix');
    });

    test('Translate request returns translate type', async () => {
        const mgr = new MockProviderManager();
        const service = LLMService.getOrCreate(mgr);
        const resp = await service.request({ type: 'translate', content: 'Hello World', targetLanguage: 'French' });
        assert.strictEqual(resp.type, 'translate');
    });

    test('Stats accumulate across requests', async () => {
        const mgr = new MockProviderManager();
        const service = LLMService.getOrCreate(mgr);
        await service.request({ type: 'chat', prompt: 'Hello there' });
        await service.request({ type: 'chat', prompt: 'Second message' });
        const stats = service.getStats();
        assert.strictEqual(stats.requests, 2, 'Expected 2 requests counted');
        assert.ok(stats.estimatedInputTokens > 0, 'Expected input tokens > 0');
        assert.ok(stats.perTask.chat === 2, 'Per-task chat count should be 2');
    });

    test('Persistence save and restore (same day)', async () => {
        const mgr = new MockProviderManager();
        const service = LLMService.getOrCreate(mgr);
        // Mock context
        const memory: Record<string, any> = {};
        const context: any = { workspaceState: { update: async (k: string, v: any) => { memory[k] = v; }, get: (k: string) => memory[k] } };
        service.initializePersistence(context);
        await service.request({ type: 'chat', prompt: 'Persist me' });
        const preStats = service.getStats();
        await service.saveState();
        // Simulate extension reload by clearing singleton
        (LLMService as any).instance = undefined;
        const mgr2 = new MockProviderManager();
        const service2 = LLMService.getOrCreate(mgr2);
        service2.initializePersistence(context);
        await service2.restoreState();
        const restoredStats = service2.getStats();
        assert.strictEqual(restoredStats.requests, preStats.requests, 'Should restore request count for same day');
    });
});
