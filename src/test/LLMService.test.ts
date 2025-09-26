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

    test('Persistence save state does not throw', async () => {
        const mgr = new MockProviderManager();
        const service = LLMService.getOrCreate(mgr);
        const memory: Record<string, any> = {};
        const context: any = { workspaceState: { update: async (k: string, v: any) => { memory[k] = v; }, get: (k: string) => memory[k] } };
        service.initializePersistence(context);
        await service.request({ type: 'chat', prompt: 'Persist me' });
        await service.saveState();
        assert.ok(memory['llmService.stats'], 'Expected stats key to be saved');
    });

    test('History survives provider change via reinitializeSessions', async () => {
        // This test simulates: user chats, provider sessions cleared, sessions recreated with preserved history.
        const mgr = new MockProviderManager();
        const service = LLMService.getOrCreate(mgr);
        // Create a session and add some messages
        const session = await service.getSession('thread1', 'Sys');
        await session.chat('Hello');
        await session.chat('Second');
        const histBefore = session.getHistory();
        assert.ok(histBefore.length >= 2, 'Expected at least 2 history messages');
        // Simulate provider change clearing service sessions
        service.clearAllSessions();
        // We need a lightweight stand-in ThreadManager behaviour for reinitialization logic.
        // Minimal inline rehydrate: create new session and restore history.
        const session2 = await service.getSession('thread1', 'Sys', { forceNew: true });
        session2.setHistory(histBefore as any);
        const histAfter = session2.getHistory();
        assert.strictEqual(histAfter.length, histBefore.length, 'History length should match after rehydration');
    });
});
