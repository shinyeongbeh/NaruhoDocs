import * as vscode from 'vscode';
import { LLMProviderManager } from '../llm-providers/manager';
import { ChatSession, createChat } from '../langchain-backend/llm';
import { BaseMessage } from '@langchain/core/messages';

/**
 * Centralized LLM request routing layer.
 * All extension features should call this service instead of directly instantiating chats or providers.
 * This enables dynamic model selection based on request type, size, or user configuration.
 */
export class LLMService {
    private static instance: LLMService | undefined;
    private sessionCache: Map<string, ChatSession> = new Map();
    private sessionProviders: Map<string, string> = new Map();
    private sessionSystemMessages: Map<string, string> = new Map();
    private sessionModelHints: Map<string, string | undefined> = new Map();
    private outputChannel: vscode.OutputChannel | undefined;
    private verboseLogging: boolean = false;
    // Usage tracking
    private dayStamp: string = this.currentDayStamp();
    private requestCount: number = 0;
    private estimatedInputTokens: number = 0;
    private estimatedOutputTokens: number = 0;
    private perTaskCounts: Record<LLMTaskType, number> = {
        chat: 0,
        summarize: 0,
        read_files: 0,
        analyze: 0,
        translate: 0,
        generate_doc: 0,
        visualization_context: 0
    };

    // Simple policy map allowing different model names per task (future configurable)
    private modelPolicy: Record<LLMTaskType, { modelHint?: string; temperature?: number }> = {
        'chat': { temperature: 0 },
        'summarize': { temperature: 0, modelHint: 'gemini-2.0-flash' },
        'read_files': { temperature: 0, modelHint: 'gemini-2.0-flash' },
        'analyze': { temperature: 0.1 },
        'translate': { temperature: 0 },
        'generate_doc': { temperature: 0.2 },
        'visualization_context': { temperature: 0 },
    };

    private constructor(private providerManager: LLMProviderManager) {}

    public static getOrCreate(providerManager: LLMProviderManager): LLMService {
        if (!this.instance) {
            this.instance = new LLMService(providerManager);
        } else {
            // Update provider manager reference if changed
            this.instance.providerManager = providerManager;
        }
        // Refresh verbose logging setting each retrieval (cheap)
        try {
            const config = vscode.workspace.getConfiguration('naruhodocs');
            this.instance.verboseLogging = !!config.get<boolean>('logging.verbose');
        } catch { /* ignore */ }
        return this.instance;
    }

    /** Inject output channel from extension activation */
    public setOutputChannel(ch: vscode.OutputChannel) {
        this.outputChannel = ch;
    }

    /** Refresh configuration-driven flags */
    public refreshConfig() {
        const config = vscode.workspace.getConfiguration('naruhodocs');
        this.verboseLogging = !!config.get<boolean>('logging.verbose');
    }

    /** Public high-level request API */
    public async request(req: LLMRequest): Promise<LLMResponse> {
        this.rolloverIfNeeded();
        switch (req.type) {
            case 'chat':
                return this.handleChat(req);
            case 'summarize':
                return this.handleSummarize(req);
            case 'read_files':
                return this.handleReadFiles(req);
            case 'analyze':
                return this.handleAnalyze(req);
            case 'translate':
                return this.handleTranslate(req);
            case 'generate_doc':
                return this.handleGenerateDoc(req);
            case 'visualization_context':
                return this.handleVisualizationContext(req);
            default:
                throw new Error(`Unsupported LLM request type: ${(req as any).type}`);
        }
    }

    /** Retrieve (or create) a chat session bound to a logical key */
    public async getSession(key: string, systemMessage: string, options?: { forceNew?: boolean; taskType?: LLMTaskType; temperatureOverride?: number; modelOverride?: string }): Promise<ChatSession> {
        if (!options?.forceNew && this.sessionCache.has(key)) {
            return this.sessionCache.get(key)!;
        }
        const taskType: LLMTaskType = options?.taskType || 'chat';
        const policy = this.modelPolicy[taskType] || { temperature: 0 };
        const temperature = options?.temperatureOverride ?? policy.temperature ?? 0;
        const modelHint = options?.modelOverride || policy.modelHint;

        // Prefer provider manager if initialized
        const provider = this.providerManager.getCurrentProvider?.();
        if (provider) {
            try {
                const session = await provider.createChatSession(systemMessage, { temperature, model: modelHint });
                this.sessionCache.set(key, session);
                this.sessionProviders.set(key, provider.name);
                this.sessionSystemMessages.set(key, systemMessage);
                this.sessionModelHints.set(key, modelHint);
                return session;
            } catch (e) {
                console.warn('[LLMService] Provider session creation failed, falling back to direct createChat:', e);
            }
        }

        // Fallback to direct Gemini session (legacy path)
        const config = vscode.workspace.getConfiguration('naruhodocs');
        const apiKeySetting = config.get<string>('geminiApiKey');
        const session = createChat({ apiKey: apiKeySetting, systemMessage, temperature, model: modelHint });
        this.sessionCache.set(key, session);
        this.sessionProviders.set(key, 'fallback-gemini');
        this.sessionSystemMessages.set(key, systemMessage);
        this.sessionModelHints.set(key, modelHint);
        return session;
    }

    public clearSession(key: string) {
        this.sessionCache.delete(key);
        this.sessionProviders.delete(key);
        this.sessionSystemMessages.delete(key);
        this.sessionModelHints.delete(key);
    }

    public clearAllSessions() {
        this.sessionCache.clear();
        this.sessionProviders.clear();
        this.sessionSystemMessages.clear();
        this.sessionModelHints.clear();
    }

    // ---- Persistence ----
    private persistenceInitialized = false;
    private context: vscode.ExtensionContext | undefined;
    public initializePersistence(context: vscode.ExtensionContext) {
        this.context = context;
        this.persistenceInitialized = true;
    }

    public async saveState() {
        if (!this.persistenceInitialized || !this.context) { return; }
        // Serialize sessions: we only have access via getHistory()/system message (not directly stored per session). We capture limited history.
        const snapshots: Record<string, { systemMessage?: string; history: Array<{ role: string; content: string }> }> = {};
        for (const [key, session] of this.sessionCache.entries()) {
            try {
                const rawHistory = session.getHistory();
                // We don't have direct system message accessor; store none. Future: extend ChatSession.
                snapshots[key] = {
                    systemMessage: undefined,
                    history: rawHistory.slice(-12).map(m => ({ role: (m as any).type, content: (m as any).text }))
                };
            } catch (e) {
                console.warn('[LLMService] Failed to snapshot session', key, e);
            }
        }
        const stats = this.getStats();
        await this.context.workspaceState.update('llmService.sessionSnapshots', snapshots);
        await this.context.workspaceState.update('llmService.statsSnapshot', stats);
        await this.context.workspaceState.update('llmService.sessionProviders', Array.from(this.sessionProviders.entries()));
    }

    public async restoreState() {
        if (!this.persistenceInitialized || !this.context) { return; }
        const snapshots = this.context.workspaceState.get<Record<string, { systemMessage?: string; history: Array<{ role: string; content: string }> }>>('llmService.sessionSnapshots');
        if (snapshots) {
            for (const key of Object.keys(snapshots)) {
                const snap = snapshots[key];
                try {
                    const session = await this.getSession(key, snap.systemMessage || 'You are a helpful assistant.', { forceNew: true });
                    // Rebuild BaseMessage[] minimal structure
                    const rebuild: BaseMessage[] = snap.history.map(h => ({
                        _getType() { return h.role; },
                        get type() { return h.role; },
                        get lc_namespace() { return []; },
                        get lc_serializable() { return true; },
                        content: h.content,
                        get text() { return h.content; }
                    } as any));
                    session.setHistory(rebuild);
                } catch (e) {
                    console.warn('[LLMService] Failed to restore session', key, e);
                }
            }
        }
    const stats = this.context.workspaceState.get<any>('llmService.statsSnapshot');
        if (stats && stats.day === this.dayStamp) {
            // Only restore if same day
            this.requestCount = stats.requests || 0;
            this.estimatedInputTokens = stats.estimatedInputTokens || 0;
            this.estimatedOutputTokens = stats.estimatedOutputTokens || 0;
            if (stats.perTask) {
                (Object.keys(this.perTaskCounts) as LLMTaskType[]).forEach(k => {
                    this.perTaskCounts[k] = stats.perTask[k] || 0;
                });
            }
        }
        const providerPairs = this.context?.workspaceState.get<[string, string][]>('llmService.sessionProviders');
        if (providerPairs) {
            this.sessionProviders = new Map(providerPairs);
        }
    }

    // ---- Handlers ----
    private async handleChat(req: ChatRequest): Promise<LLMResponse> {
        const sessionId = req.sessionId || 'general';
        const session = await this.getSession(sessionId, req.systemMessage || 'You are a helpful assistant.', { taskType: 'chat' });
        const meta = { sessionId };
        const answer = await this.invokeTracked(session, req.prompt, 'chat', req.prompt.length, meta);
        return { type: 'chat', content: answer, meta: { ...meta, provider: this.sessionProviders.get(sessionId) } };
    }

    private async handleSummarize(req: SummarizeRequest): Promise<LLMResponse> {
        const systemMessage = req.systemMessage || 'You are an expert technical summarizer. Provide concise, accurate summaries.';
        const sessionKey = req.sessionId || `summarize:${req.targetId || 'generic'}`;
        const session = await this.getSession(sessionKey, systemMessage, { taskType: 'summarize' });
        const prompt = `Summarize the following content${req.format ? ' in ' + req.format + ' format' : ''}:\n\n${truncate(req.content, 12000)}\n\nRequirements: ${req.requirements?.join('; ') || 'Concise, accurate'}.`;
        const meta = { targetId: req.targetId, format: req.format, requirements: req.requirements };
        const answer = await this.invokeTracked(session, prompt, 'summarize', req.content.length, meta);
        return { type: 'summarize', content: answer, meta: { chars: req.content.length, provider: this.sessionProviders.get(sessionKey) } };
    }

    private async handleReadFiles(req: ReadFilesRequest): Promise<LLMResponse> {
        const systemMessage = req.systemMessage || 'You are a codebase assistant. You read and extract relevant information from files.';
        const session = await this.getSession('read_files', systemMessage, { taskType: 'read_files' });
        const joined = req.files.map(f => `--- FILE: ${f.path} ---\n${truncate(f.content, 6000)}`).join('\n\n');
        const question = req.prompt || 'Provide a concise overview of the important elements in these files.';
        const composed = `${question}\n\n${joined}`;
        const meta = { fileCount: req.files.length };
        const answer = await this.invokeTracked(session, composed, 'read_files', joined.length, meta);
        return { type: 'read_files', content: answer, meta: { fileCount: req.files.length, provider: this.sessionProviders.get('read_files') } };
    }

    private async handleAnalyze(req: AnalyzeRequest): Promise<LLMResponse> {
        const systemMessage = req.systemMessage || 'You are a senior software architect performing a focused analysis.';
        const session = await this.getSession(req.sessionId || 'analyze', systemMessage, { taskType: 'analyze' });
        const prompt = `${req.analysisGoal}\n\nContext:\n${truncate(req.context, 10000)}\n\nProvide analysis with bullet points and actionable insights.`;
        const meta = { sessionId: req.sessionId, goal: req.analysisGoal };
        const answer = await this.invokeTracked(session, prompt, 'analyze', req.context.length, meta);
        return { type: 'analyze', content: answer, meta: { provider: this.sessionProviders.get(req.sessionId || 'analyze') } };
    }

    private async handleTranslate(req: TranslateRequest): Promise<LLMResponse> {
        const systemMessage = req.systemMessage || 'You are a professional technical translator. Preserve code blocks and formatting.';
        const session = await this.getSession(`translate:${req.targetLanguage}`, systemMessage, { taskType: 'translate' });
        const prompt = `Translate the following text to ${req.targetLanguage} while preserving meaning and structure.\n\n${truncate(req.content, 10000)}`;
        const meta = { targetLanguage: req.targetLanguage };
        const answer = await this.invokeTracked(session, prompt, 'translate', req.content.length, meta);
        return { type: 'translate', content: answer, meta: { targetLanguage: req.targetLanguage, provider: this.sessionProviders.get(`translate:${req.targetLanguage}`) } };
    }

    private async handleGenerateDoc(req: GenerateDocRequest): Promise<LLMResponse> {
        const systemMessage = req.systemMessage || 'You are an expert technical writer generating high-quality documentation.';
        const session = await this.getSession(req.sessionId || 'generate_doc', systemMessage, { taskType: 'generate_doc', temperatureOverride: 0.2 });
        const prompt = `Generate documentation for: ${req.title}\nPurpose: ${req.purpose || 'General documentation'}\nTone: ${req.tone || 'professional'}\n\nSource Material:\n${truncate(req.sourceContent, 15000)}\n\nReturn well-structured markdown.`;
        const meta = { title: req.title, tone: req.tone, purpose: req.purpose };
        const answer = await this.invokeTracked(session, prompt, 'generate_doc', req.sourceContent.length, meta);
        return { type: 'generate_doc', content: answer, meta: { title: req.title, provider: this.sessionProviders.get(req.sessionId || 'generate_doc') } };
    }

    private async handleVisualizationContext(req: VisualizationContextRequest): Promise<LLMResponse> {
        const session = await this.getSession(req.sessionId || 'general', req.systemMessage || 'You are a helpful assistant with project visualization context.', { taskType: 'visualization_context' });
        const packagingPrompt = `Incorporate the following visualization context into your working memory for subsequent questions. Do not output an explanation unless asked later.\nType: ${req.contextType}\nUser Request: ${req.userPrompt}\nVisualization Summary:\n${truncate(req.botResponse, 8000)}\nRespond with: ACK`;
        const meta = { contextType: req.contextType, userPrompt: req.userPrompt };
        const ack = await this.invokeTracked(session, packagingPrompt, 'visualization_context', req.botResponse.length, meta);
        return { type: 'visualization_context', content: ack.startsWith('ACK') ? 'ACK' : ack, meta: { provider: this.sessionProviders.get(req.sessionId || 'general') } };
    }

    // ---- Tracking Helpers ----
    private async invokeTracked(session: ChatSession, prompt: string, task: LLMTaskType, inputSize?: number, meta?: Record<string, any>): Promise<string> {
        // Capture history BEFORE sending prompt
        let historySnapshot: Array<{ role: string; content: string }> = [];
        try {
            const hist = session.getHistory?.();
            if (hist) {
                historySnapshot = hist.map((m: any) => ({ role: m.type || 'unknown', content: (m.text || '').toString() }));
            }
        } catch { /* ignore */ }
        const before = Date.now();
        const answer = await session.chat(prompt);
        const durationMs = Date.now() - before;
        this.requestCount++;
        this.perTaskCounts[task] = (this.perTaskCounts[task] || 0) + 1;
        const estIn = this.estimateTokens(prompt, inputSize);
        const estOut = this.estimateTokens(answer);
        this.estimatedInputTokens += estIn;
        this.estimatedOutputTokens += estOut;
        try {
            if (this.verboseLogging && this.outputChannel) {
                // Try to locate provider by scanning sessionProviders map (reverse lookup)
                let providerName: string | undefined;
                for (const [k, v] of this.sessionProviders.entries()) {
                    // Heuristic: if session object reference matches cache entry
                    if (this.sessionCache.get(k) === session) { providerName = v; break; }
                }
                providerName = providerName || 'unknown-provider';
                const safePrompt = prompt.length > 400 ? prompt.slice(0, 400) + '…' : prompt;
                const safeAnswer = answer.length > 400 ? answer.slice(0, 400) + '…' : answer;
                const timestamp = new Date().toISOString();
                // Retrieve system message & model hint if available
                let sessionKey: string | undefined;
                for (const [k, s] of this.sessionCache.entries()) {
                    if (s === session) { sessionKey = k; break; }
                }
                const systemMsg = sessionKey ? this.sessionSystemMessages.get(sessionKey) : undefined;
                const modelHint = sessionKey ? this.sessionModelHints.get(sessionKey!) : undefined;
                const systemSnippet = systemMsg ? (systemMsg.length > 120 ? systemMsg.slice(0,120)+'…' : systemMsg) : 'n/a';
                let metaLine = '';
                if (meta) {
                    try {
                        const json = JSON.stringify(meta);
                        metaLine = ' meta=' + (json.length > 240 ? json.slice(0,240)+'…' : json);
                    } catch { /* ignore */ }
                }
                this.outputChannel.appendLine(`[${timestamp}] task=${task} provider=${providerName} model=${modelHint || 'default'} durationMs=${durationMs} inTokens~= ${estIn} outTokens~= ${estOut}${metaLine}`);
                this.outputChannel.appendLine(`  SYSTEM>>> ${systemSnippet.replace(/\r?\n/g, ' \u23CE ')}`);
                if (historySnapshot.length) {
                    const recent = historySnapshot.slice(-6); // last 6 messages
                    recent.forEach((m, idx) => {
                        const content = m.content.length > 160 ? m.content.slice(0,160)+'…' : m.content;
                        this.outputChannel!.appendLine(`  HIST[${recent.length-idx}] ${m.role.toUpperCase()}: ${content.replace(/\r?\n/g,' \u23CE ')}`);
                    });
                }
                this.outputChannel.appendLine(`  PROMPT>>> ${safePrompt.replace(/\r?\n/g, ' \u23CE ')}`);
                this.outputChannel.appendLine(`  RESPONSE<<< ${safeAnswer.replace(/\r?\n/g, ' \u23CE ')}`);
                this.outputChannel.appendLine('');
            }
        } catch { /* swallow logging errors */ }
        return answer;
    }

    /** Convenience helper for ad-hoc chat style interactions when caller already knows the session id & system message */
    public async trackedChat(options: { sessionId: string; systemMessage: string; prompt: string; task?: LLMTaskType; temperatureOverride?: number; modelOverride?: string; forceNew?: boolean }): Promise<string> {
        const { sessionId, systemMessage, prompt, task = 'chat', temperatureOverride, modelOverride, forceNew } = options;
        const session = await this.getSession(sessionId, systemMessage, { taskType: task, temperatureOverride, modelOverride, forceNew });
        return this.invokeTracked(session, prompt, task, prompt.length, { sessionId });
    }

    private estimateTokens(text: string, rawLen?: number): number {
        // Rough heuristic: average 4 characters per token for English-like text
        const length = rawLen ?? text.length;
        return Math.max(1, Math.round(length / 4));
    }

    private rolloverIfNeeded() {
        const stamp = this.currentDayStamp();
        if (stamp !== this.dayStamp) {
            this.dayStamp = stamp;
            this.requestCount = 0;
            this.estimatedInputTokens = 0;
            this.estimatedOutputTokens = 0;
            (Object.keys(this.perTaskCounts) as LLMTaskType[]).forEach(k => this.perTaskCounts[k] = 0);
        }
    }

    private currentDayStamp(): string {
        const d = new Date();
        return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
    }

    public getStats() {
        return {
            day: this.dayStamp,
            requests: this.requestCount,
            estimatedInputTokens: this.estimatedInputTokens,
            estimatedOutputTokens: this.estimatedOutputTokens,
            perTask: { ...this.perTaskCounts }
        };
    }
}

// ---- Types ----
export type LLMTaskType = 'chat' | 'summarize' | 'read_files' | 'analyze' | 'translate' | 'generate_doc' | 'visualization_context';

export interface BaseLLMRequest { type: LLMTaskType; sessionId?: string; systemMessage?: string; }
export interface ChatRequest extends BaseLLMRequest { type: 'chat'; prompt: string; }
export interface SummarizeRequest extends BaseLLMRequest { type: 'summarize'; content: string; format?: string; requirements?: string[]; targetId?: string; }
export interface ReadFilesRequest extends BaseLLMRequest { type: 'read_files'; files: Array<{ path: string; content: string }>; prompt?: string; }
export interface AnalyzeRequest extends BaseLLMRequest { type: 'analyze'; analysisGoal: string; context: string; }
export interface TranslateRequest extends BaseLLMRequest { type: 'translate'; content: string; targetLanguage: string; }
export interface GenerateDocRequest extends BaseLLMRequest { type: 'generate_doc'; title: string; sourceContent: string; purpose?: string; tone?: string; }
export interface VisualizationContextRequest extends BaseLLMRequest { type: 'visualization_context'; contextType: string; userPrompt: string; botResponse: string; }

export type LLMRequest = ChatRequest | SummarizeRequest | ReadFilesRequest | AnalyzeRequest | TranslateRequest | GenerateDocRequest | VisualizationContextRequest;

export interface LLMResponse { type: LLMTaskType; content: string; meta?: Record<string, any>; }

// Utility: safe truncation
function truncate(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    return text.slice(0, max) + `\n...[truncated ${text.length - max} chars]`;
}

// For potential future advanced history capture if direct access is added
export interface SessionSnapshot {
    systemMessage?: string;
    history: BaseMessage[];
}
