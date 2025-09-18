import * as vscode from 'vscode';
import { createChat, ChatSession } from '../langchain-backend/llm';
import { SystemMessages } from '../SystemMessages';
import { LLMProviderManager } from '../llm-providers/manager';
import { LLMService } from './LLMService';

export class ThreadManager {
    private sessions: Map<string, ChatSession> = new Map();
    private activeThreadId?: string;
    private threadTitles: Map<string, string> = new Map(); // sessionId -> document title
    
    constructor(
        private context: vscode.ExtensionContext,
        private apiKey?: string,
        private llmManager?: LLMProviderManager,
        private onThreadListChange?: () => void
    ) {}

    private get llmService(): LLMService | undefined {
        if (!this.llmManager) { return undefined; }
        return LLMService.getOrCreate(this.llmManager);
    }

    // Initialize the general-purpose thread
    public async initializeGeneralThread(): Promise<void> {
        await this.llmManager?.initializeFromConfig();
        const generalThreadId = 'naruhodocs-general-thread';
        const generalThreadTitle = 'General Purpose';
        const sysMessage = SystemMessages.GENERAL_PURPOSE;

        // Use LLM manager if available, fallback to direct createChat
        if (this.llmService) {
            try {
                const session = await this.llmService.getSession(generalThreadId, sysMessage, { taskType: 'chat' });
                this.sessions.set(generalThreadId, session);
                this.threadTitles.set(generalThreadId, generalThreadTitle);
                this.activeThreadId = generalThreadId;
                // General thread initialized via LLMService
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

    // Create a new thread/session for a document
    public createThread(sessionId: string, initialContext: string, title: string): void {
        if (!this.sessions.has(sessionId)) {
            const sysMessage = SystemMessages.DOCUMENT_SPECIFIC_DEVELOPER(title, initialContext);
            // Try to load history from workspaceState
            const savedHistory = this.context.workspaceState.get<any[]>(`thread-history-${sessionId}`);
            
            // Use the LLM manager instead of direct createChat
            if (this.llmService) {
                this.llmService.getSession(sessionId, sysMessage, { taskType: 'chat' }).then(session => {
                    if (savedHistory && Array.isArray(savedHistory)) {
                        session.setHistory(savedHistory);
                    }
                    this.sessions.set(sessionId, session);
                    this.threadTitles.set(sessionId, title);
                    this.onThreadListChange?.();
                }).catch(err => {
                    console.error('LLMService session creation failed, fallback:', err);
                    const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
                    if (savedHistory && Array.isArray(savedHistory)) {
                        session.setHistory(savedHistory);
                    }
                    this.sessions.set(sessionId, session);
                    this.threadTitles.set(sessionId, title);
                    this.onThreadListChange?.();
                });
            } else {
                const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
                if (savedHistory && Array.isArray(savedHistory)) {
                    session.setHistory(savedHistory);
                }
                this.sessions.set(sessionId, session);
                this.threadTitles.set(sessionId, title);
                this.onThreadListChange?.();
            }
        }
    }

    // Switch active thread
    public setActiveThread(sessionId: string): void {
        if (this.sessions.has(sessionId)) {
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

    // Get all sessions
    public getSessions(): Map<string, ChatSession> {
        return this.sessions;
    }

    // Remove a thread
    public async removeThread(sessionId: string): Promise<void> {
        if (this.sessions.has(sessionId)) {
            this.sessions.delete(sessionId);
            this.threadTitles.delete(sessionId);
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
        if (preservedSession && preservedTitle) {
            this.sessions.set(generalId, preservedSession);
            this.threadTitles.set(generalId, preservedTitle);
            this.activeThreadId = generalId;
        }
    }

    // Restore threads from workspace state
    public async restoreThreads(keys: readonly string[]): Promise<void> {
        for (const key of keys) {
            if (key.startsWith('thread-history-')) {
                const sessionId = key.replace('thread-history-', '');
                const savedHistory = this.context.workspaceState.get<any[]>(key);
                const title = sessionId.split('/').pop() || sessionId;
                let documentText = '';
                try {
                    const uri = vscode.Uri.parse(sessionId);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    documentText = doc.getText();
                } catch (e) {
                    documentText = '';
                }
                this.createThread(sessionId, documentText, title);
            }
        }
        this.onThreadListChange?.();
    }

    // Update LLM manager and recreate general thread
    // public async updateLLMManager(newLLMManager: LLMProviderManager): Promise<void> {}

    // Save thread history to workspace state
    public async saveThreadHistory(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            const history = session.getHistory();
            await this.context.workspaceState.update(`thread-history-${sessionId}`, history);
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
    public getThreadListData(): { threads: Array<{id: string, title: string}>, activeThreadId: string | undefined } {
        const threads = Array.from(this.threadTitles.entries()).map(([id, title]) => ({ id, title }));
        return { threads, activeThreadId: this.activeThreadId };
    }
}
