import * as vscode from 'vscode';
import { createChat, ChatSession } from '../langchain-backend/llm';
import { SystemMessages } from '../SystemMessages';
import { LLMProviderManager } from '../llm-providers/manager';
import { LLMService } from './LLMService';

export class ThreadManager {
    private sessions: Map<string, ChatSession> = new Map();
    private activeThreadId?: string;
    private threadTitles: Map<string, string> = new Map(); // sessionId -> document title
    private systemMessages: Map<string, string> = new Map(); // sessionId -> system message (for rehydration)

    constructor(
        private context: vscode.ExtensionContext,
        private apiKey?: string,
        private llmManager?: LLMProviderManager,
        private onThreadListChange?: () => void
    ) { }

    private get llmService(): LLMService | undefined {
        if (!this.llmManager) { return undefined; }
        return LLMService.getOrCreate(this.llmManager);
    }

    /** Append contextual user+bot messages to a thread's history and persist. */
    public async appendContext(sessionId: string, userMessage: string, botResponse: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) { return; }
        try {
            const current = session.getHistory();
            const serialized = current.map((m: any) => {
                const directType = (m as any).type || (typeof (m as any)._getType === 'function' ? (m as any)._getType() : undefined);
                let role = directType || 'unknown';
                if (role !== 'human' && role !== 'ai') {
                    const ctor = m.constructor?.name?.toLowerCase?.() || '';
                    if (ctor.includes('human')) { role = 'human'; }
                    else if (ctor.includes('ai')) { role = 'ai'; }
                }
                if (role === 'user') { role = 'human'; }
                if (role === 'assistant' || role === 'bot') { role = 'ai'; }
                const text = (m as any).text || (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
                return { type: role, text };
            });
            serialized.push({ type: 'human', text: userMessage });
            serialized.push({ type: 'ai', text: botResponse });
            session.setHistory(serialized as any);
            await this.context.workspaceState.update(`thread-history-${sessionId}`, serialized);
        } catch (e) {
            console.warn('[ThreadManager] appendContext failed for', sessionId, e);
        }
    }

    // Initialize the general-purpose thread
    public async initializeGeneralThread(): Promise<void> {
        await this.llmManager?.initializeFromConfig();
        const generalThreadId = 'naruhodocs-general-thread';
        const generalThreadTitle = 'General Purpose';
        const sysMessage = SystemMessages.GENERAL_PURPOSE;
        this.systemMessages.set(generalThreadId, sysMessage);

        // If a session was already restored from history, do not create a new one.
        if (this.sessions.has(generalThreadId)) {
            return;
        }

        // If no session exists, create a new one.
        if (this.llmService) {
            try {
                const session = await this.llmService.getSession(generalThreadId, sysMessage, { taskType: 'chat', forceNew: true });
                this.sessions.set(generalThreadId, session);
                this.threadTitles.set(generalThreadId, generalThreadTitle);
                this.activeThreadId = generalThreadId;
                return;
            } catch (error) {
                console.error('LLMService general thread creation failed, falling back:', error);
            }
        }
        // Fallback direct
        const fallbackSession = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
        this.sessions.set(generalThreadId, fallbackSession);
        this.threadTitles.set(generalThreadId, generalThreadTitle);
        this.activeThreadId = generalThreadId;
    }

    // Create a new thread/session for a document. Returns a promise that resolves when the session is ready.
    public createThread(sessionId: string, initialContext: string, title: string): Promise<void> {
        if (this.sessions.has(sessionId)) {
            // Already exists – nothing to do
            return Promise.resolve();
        }
        const sysMessage = SystemMessages.DOCUMENT_SPECIFIC_DEVELOPER(title, initialContext);
        const savedHistory = this.context.workspaceState.get<any[]>(`thread-history-${sessionId}`);
        this.systemMessages.set(sessionId, sysMessage);
        const applyHistory = (session: ChatSession) => {
            if (savedHistory && Array.isArray(savedHistory)) {
                try { session.setHistory(savedHistory as any); } catch { /* ignore */ }
            }
        };
        if (this.llmService) {
            return this.llmService.getSession(sessionId, sysMessage, { taskType: 'chat' })
                .then(session => {
                    applyHistory(session);
                    this.sessions.set(sessionId, session);
                    this.threadTitles.set(sessionId, title);
                    this.onThreadListChange?.();
                })
                .catch(err => {
                    console.error('LLMService session creation failed, fallback:', err);
                    const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
                    applyHistory(session);
                    this.sessions.set(sessionId, session);
                    this.threadTitles.set(sessionId, title);
                    this.onThreadListChange?.();
                });
        } else {
            const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
            applyHistory(session);
            this.sessions.set(sessionId, session);
            this.threadTitles.set(sessionId, title);
            this.onThreadListChange?.();
            return Promise.resolve();
        }
    }

    // Switch active thread
    public setActiveThread(sessionId: string): void {
        if (this.sessions.has(sessionId)) {
            // Before switching, save the history of the current (outgoing) thread.
            if (this.activeThreadId) {
                this.saveThreadHistory(this.activeThreadId);
            }
            this.activeThreadId = sessionId;
            this.onThreadListChange?.();
        }
    }

    // Get the active thread ID
    public getActiveThreadId(): string | undefined {
        return this.activeThreadId;
    }

    // Add a new session
    public setSession(sessionId: string, session: ChatSession): void {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, session);
        }
    }

    // Get a specific session
    public getSession(sessionId: string): ChatSession | undefined {
        return this.sessions.get(sessionId);
    }

    // Check if a session exists
    public hasSession(sessionId: string): boolean {
        return this.sessions.has(sessionId);
    }

    // Get the active session
    public getActiveSession(): ChatSession | undefined {
        return this.activeThreadId ? this.sessions.get(this.activeThreadId) : undefined;
    }

    // Set thread title
    public setThreadTitle(sessionId: string, title: string): void {
        this.threadTitles.set(sessionId, title);
    }

    // Get all thread titles
    public getThreadTitles(): Map<string, string> {
        return this.threadTitles;
    }

    private threadManager?: ThreadManager; // Ensure this property exists

    public setThreadManager(manager: ThreadManager): void {
        this.threadManager = manager;
    }

    public async saveState(): Promise<void> {
        const sessions = this.getSessions();
        const savePromises: Promise<void>[] = [];
        for (const sessionId of sessions.keys()) {
            savePromises.push(this.saveThreadHistory(sessionId));
        }
        if (savePromises.length > 0) {
            await Promise.all(savePromises);
            // console.log(`[NaruhoDocs] Saved state for ${savePromises.length} threads.`);
        }
        // Also persist the last active thread ID
        const lastActiveId = this.getActiveThreadId();
        if (lastActiveId) {
            await this.context.globalState.update('lastActiveThreadId', lastActiveId);
        }
    }

    // Get all sessions
    public getSessions(): Map<string, ChatSession> {
        return this.sessions;
    }

    public getSystemMessage(sessionId: string): string | undefined {
        if(!this.systemMessages.has(sessionId)){
            throw new Error(`No system message found for sessionId: ${sessionId}`);
        }
        return this.systemMessages.get(sessionId);
    }

    // Remove a thread
    public async removeThread(sessionId: string): Promise<void> {
        if (this.sessions.has(sessionId)) {
            this.sessions.delete(sessionId);
            this.threadTitles.delete(sessionId);
            this.systemMessages.delete(sessionId);
            await this.context.workspaceState.update(`thread-history-${sessionId}`, undefined);
            // If the deleted thread was active, switch to general
            if (this.activeThreadId === sessionId) {
                this.activeThreadId = 'naruhodocs-general-thread';
            }
            this.onThreadListChange?.();
        }
    }

    // Reset development state (for dev mode cleanup)
    public async resetDevState(): Promise<void> {
        // Clear persisted thread histories and reset thread list to only General once
        const historyKeys = this.context.workspaceState.keys ? this.context.workspaceState.keys() : [];
        for (const key of historyKeys) {
            if (typeof key === 'string' && key.startsWith('thread-history-')) {
                await this.context.workspaceState.update(key, undefined);
            }
        }
        // Preserve General thread, clear others
        const generalId = 'naruhodocs-general-thread';
        const preservedSession = this.sessions.get(generalId);
        const preservedTitle = this.threadTitles.get(generalId);
        this.sessions = new Map();
        this.threadTitles = new Map();
        this.systemMessages = new Map([[generalId, SystemMessages.GENERAL_PURPOSE]]);
        if (preservedSession && preservedTitle) {
            this.sessions.set(generalId, preservedSession);
            this.threadTitles.set(generalId, preservedTitle);
            this.activeThreadId = generalId;
        }
    }

    // Restore threads from workspace state
    public async restoreThreads(keys: readonly string[]): Promise<void> {
        const creationPromises: Promise<void>[] = [];
        for (const key of keys) {
            if (key.startsWith('thread-history-')) {
                const sessionId = key.replace('thread-history-', '');
                // if (sessionId === 'naruhodocs-general-thread') {
                //     continue;
                // }
                let documentText = '';
                try {
                    const uri = vscode.Uri.parse(sessionId);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    documentText = doc.getText();
                } catch { /* ignore */ }
                const title = sessionId.split('/').pop() || sessionId;
                creationPromises.push(this.createThread(sessionId, documentText, title));
            }
        }
        await Promise.all(creationPromises);
        this.onThreadListChange?.();
    }

    // Update LLM manager and recreate general thread
    // public async updateLLMManager(newLLMManager: LLMProviderManager): Promise<void> {}

    // Save thread history to workspace state
    public async saveThreadHistory(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            const raw = session.getHistory();
            const serialized = raw.map((m: any) => {
                const directType = (m as any).type;
                const fnType = typeof m._getType === 'function' ? m._getType() : undefined;
                let role = directType || fnType || 'unknown';
                if (role !== 'human' && role !== 'ai') {
                    const ctor = m.constructor?.name?.toLowerCase?.() || '';
                    if (ctor.includes('human')) { role = 'human'; }
                    else if (ctor.includes('ai')) { role = 'ai'; }
                }
                const text = (m as any).text || (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
                if (role === 'user') { role = 'human'; }
                if (role === 'assistant' || role === 'bot') { role = 'ai'; }
                return { type: role, text };
            });
            await this.context.workspaceState.update(`thread-history-${sessionId}`, serialized);
        }
    }

    // Reset a specific session
    public async resetSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.reset();
            // Clear history in storage
            await this.context.workspaceState.update(`thread-history-${sessionId}`, []);
        }
    }

    // Get thread list data for UI
    public getThreadListData(): { threads: Array<{ id: string, title: string }>, activeThreadId: string | undefined } {
        const threads = Array.from(this.threadTitles.entries()).map(([id, title]) => ({ id, title }));
        return { threads, activeThreadId: this.activeThreadId };
    }

    /**
     * Reinitialize all existing thread sessions after a provider change while preserving history.
     * This is necessary because LLMService.clearAllSessions() removes its internal sessions cache,
     * and subsequent trackedChat() calls would otherwise start fresh, losing conversational context.
     */
    public async reinitializeSessions(llmService: LLMService): Promise<void> {
        const entries = Array.from(this.sessions.entries());
        for (const [sessionId, oldSession] of entries) {
            try {
                const history = oldSession.getHistory().map((m: any) => {
                    const directType = (m as any).type || (typeof m._getType === 'function' ? m._getType() : undefined);
                    let role = directType || 'unknown';
                    if (role !== 'human' && role !== 'ai') {
                        const ctor = m.constructor?.name?.toLowerCase?.() || '';
                        if (ctor.includes('human')) { role = 'human'; }
                        else if (ctor.includes('ai')) { role = 'ai'; }
                    }
                    const text = (m as any).text || (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
                    if (role === 'user') { role = 'human'; }
                    if (role === 'assistant' || role === 'bot') { role = 'ai'; }
                    return { type: role, text };
                });
                const sys = this.systemMessages.get(sessionId) || SystemMessages.GENERAL_PURPOSE;
                const newSession = await llmService.getSession(sessionId, sys, { taskType: 'chat', forceNew: true });
                newSession.setHistory(history as any);
                this.sessions.set(sessionId, newSession);
                // Persist snapshot again (best-effort)
                await this.saveThreadHistory(sessionId);
            } catch (e) {
                console.warn('[ThreadManager] Failed to reinitialize session', sessionId, e);
            }
        }
        // Ensure active thread still valid
        if (this.activeThreadId && !this.sessions.has(this.activeThreadId)) {
            this.activeThreadId = 'naruhodocs-general-thread';
        }
        this.onThreadListChange?.();
    }
    
    public static async clearAllThreadHistoryOnce(context: vscode.ExtensionContext): Promise<void> {
        console.log('Clearing all thread history...');
        const keys = context.workspaceState.keys();
        let cleared = 0;
        for (const key of keys) {
            if (typeof key === 'string' && key.startsWith('thread-history-')) {
                await context.workspaceState.update(key, undefined);
                cleared++;
            }
        }
        console.log(`Cleared ${cleared} thread histories`);

        // Close all open tabs/editors
        try {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            console.log('Closed all open tabs');
        } catch (error) {
            console.warn('Failed to close tabs:', error);
        }

        console.log('All thread history and tabs cleared');
    }
}
