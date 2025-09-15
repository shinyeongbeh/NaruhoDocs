import * as vscode from 'vscode';
import { createChat, ChatSession } from '../langchain-backend/llm';
import { SystemMessages } from '../SystemMessages';
import { LLMProviderManager } from '../llm-providers/manager';

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

    // Initialize the general-purpose thread
    public async initializeGeneralThread(): Promise<void> {
        const generalThreadId = 'naruhodocs-general-thread';
        const generalThreadTitle = 'General Purpose';
        const sysMessage = SystemMessages.GENERAL_PURPOSE;

        // Use LLM manager if available, fallback to direct createChat
        if (this.llmManager) {
            try {
                const session = await this.llmManager.createChatSession(sysMessage);
                this.sessions.set(generalThreadId, session);
                this.threadTitles.set(generalThreadId, generalThreadTitle);
                this.activeThreadId = generalThreadId;
            } catch (error) {
                console.error('Failed to create general chat session:', error);
                // Fallback to direct method
                const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
                this.sessions.set(generalThreadId, session);
                this.threadTitles.set(generalThreadId, generalThreadTitle);
                this.activeThreadId = generalThreadId;
            }
        } else {
            const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
            this.sessions.set(generalThreadId, session);
            this.threadTitles.set(generalThreadId, generalThreadTitle);
            this.activeThreadId = generalThreadId;
        }
    }

    // Create a new thread/session for a document
    public createThread(sessionId: string, initialContext: string, title: string): void {
        if (!this.sessions.has(sessionId)) {
            const sysMessage = SystemMessages.DOCUMENT_SPECIFIC_DEVELOPER(title, initialContext);
            // Try to load history from workspaceState
            const savedHistory = this.context.workspaceState.get<any[]>(`thread-history-${sessionId}`);
            
            // Use the LLM manager instead of direct createChat
            if (this.llmManager) {
                this.llmManager.createChatSession(sysMessage).then(session => {
                    if (savedHistory && Array.isArray(savedHistory)) {
                        session.setHistory(savedHistory);
                    }
                    this.sessions.set(sessionId, session);
                    this.threadTitles.set(sessionId, title);
                    this.onThreadListChange?.();
                }).catch(error => {
                    console.error('Failed to create chat session:', error);
                    // Fallback to existing method for backward compatibility
                    const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
                    if (savedHistory && Array.isArray(savedHistory)) {
                        session.setHistory(savedHistory);
                    }
                    this.sessions.set(sessionId, session);
                    this.threadTitles.set(sessionId, title);
                    this.onThreadListChange?.();
                });
            } else {
                // Fallback to existing method for backward compatibility
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

    // Get a specific session
    public getSession(sessionId: string): ChatSession | undefined {
        return this.sessions.get(sessionId);
    }

    // Get the active session
    public getActiveSession(): ChatSession | undefined {
        return this.activeThreadId ? this.sessions.get(this.activeThreadId) : undefined;
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
    public async updateLLMManager(newLLMManager: LLMProviderManager): Promise<void> {
        this.llmManager = newLLMManager;
        
        // Recreate the general purpose session with the new provider
        const generalThreadId = 'naruhodocs-general-thread';
        if (this.sessions.has(generalThreadId)) {
            const generalThreadTitle = 'General Purpose';
            const sysMessage = SystemMessages.GENERAL_PURPOSE;
            
            if (this.llmManager) {
                try {
                    const session = await this.llmManager.createChatSession(sysMessage);
                    this.sessions.set(generalThreadId, session);
                    this.threadTitles.set(generalThreadId, generalThreadTitle);
                    if (this.activeThreadId === generalThreadId) {
                        this.onThreadListChange?.();
                    }
                } catch (error) {
                    console.error('Failed to update general chat session:', error);
                    throw error; // Let the caller handle the error
                }
            }
        }
    }

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
