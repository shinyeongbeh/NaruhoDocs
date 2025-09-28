import * as vscode from 'vscode';
import { LLMProviderManager } from '../llm-providers/manager';
import { ModelConfigManager } from './ModelConfigManager.js';
import { ChatSession, createChat } from '../langchain-backend/llm';
import { ThreadManager } from './ThreadManager';
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
    private context!: vscode.ExtensionContext;
    private threadManager?: ThreadManager;
    // sessionModelHints stores the model name chosen at session creation time so
    // logs remain historically accurate even if the user later changes model settings.
    // We intentionally DO NOT retroactively update existing sessions when settings change.
    private outputChannel: vscode.OutputChannel | undefined;
    private modelConfigManager: ModelConfigManager | undefined;
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
        grammar_check: 0,
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
        'grammar_check': { temperature: 0 },
        'generate_doc': { temperature: 0.2 },
        'visualization_context': { temperature: 0 },
    };

    private constructor(private providerManager: LLMProviderManager) {}

    public initializePersistence(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    public setThreadManager(manager: ThreadManager): void {
        this.threadManager = manager;
    }

    public async saveState(): Promise<void> {
        if (!this.context) { return; }
    
        if (this.threadManager) {
            const sessions = this.threadManager.getSessions();
            const savePromises: Promise<void>[] = [];
            for (const sessionId of sessions.keys()) {
                savePromises.push(this.threadManager.saveThreadHistory(sessionId));
            }
            if (savePromises.length > 0) {
                await Promise.all(savePromises);
            }
            const lastActiveId = this.threadManager.getActiveThreadId();
            if (lastActiveId) {
                await this.context.globalState.update('lastActiveThreadId', lastActiveId);
            }
        }
    }
    
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

    /** Inject model config manager (per-repo JSON) */
    public setModelConfigManager(mgr: ModelConfigManager) {
        this.modelConfigManager = mgr;
    }

    /** Lightweight structured lifecycle/event logging separate from invokeTracked */
    public logEvent(event: string, data?: Record<string, any>) {
        if (!this.verboseLogging || !this.outputChannel) { return; }
        try {
            const timestamp = new Date().toISOString();
            const payload = data ? (() => { try { const j = JSON.stringify(data); return j.length>400 ? j.slice(0,400)+'…' : j; } catch { return '[unserializable]'; } })() : '';
            this.outputChannel.appendLine(`[${timestamp}] event=${event}${payload ? ' data='+payload : ''}`);
        } catch {/* ignore */}
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
            case 'grammar_check':
                return this.handleGrammarCheck(req);
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
        // If session exists and not forced new, return it unless local provider model changed underneath
        const existing = this.sessionCache.get(key);
        const taskType: LLMTaskType = options?.taskType || 'chat';
        const policy = this.modelPolicy[taskType] || { temperature: 0 };
        const temperature = options?.temperatureOverride ?? policy.temperature ?? 0;

        // MODEL RESOLUTION
        // New precedence (user configuration has priority over static policy hints):
        // 1. Explicit override passed in options
        // 2. Per-task setting (naruhodocs.llm.models.<task>)
        // 3. Default model setting (naruhodocs.llm.defaultModel)
        // 4. Policy modelHint (code-defined fallback suggestion)
        // 5. Provider-specific fallback: if provider=local use naruhodocs.llm.localModel (or default), else gemini-2.0-flash
        let modelHint = options?.modelOverride;
        let modelResolutionTrace: string[] = [];
        let providerType = 'ootb';
        try {
            providerType = vscode.workspace.getConfiguration('naruhodocs').get<string>('llm.provider', 'ootb');
        } catch { /* ignore */ }

        if (modelHint) {
            modelResolutionTrace.push('explicit-override');
        } else if (this.modelConfigManager?.isActive()) {
            // Use file-based resolution
            const resolved = this.modelConfigManager.resolveModel(providerType, taskType, policy.modelHint, providerType === 'local' ? 'gemma3:1b' : 'gemini-2.0-flash');
            modelHint = resolved.model;
            modelResolutionTrace = ['file-active', ...resolved.trace];
        } else {
            // Legacy settings-based path
            try {
                const config = vscode.workspace.getConfiguration('naruhodocs');
                const taskSettingMap: Record<LLMTaskType, string> = {
                    chat: 'naruhodocs.llm.models.chat',
                    summarize: 'naruhodocs.llm.models.summarize',
                    read_files: 'naruhodocs.llm.models.readFiles',
                    analyze: 'naruhodocs.llm.models.analyze',
                    translate: 'naruhodocs.llm.models.translate',
                    grammar_check: 'naruhodocs.llm.models.grammarCheck',
                    generate_doc: 'naruhodocs.llm.models.generateDoc',
                    visualization_context: 'naruhodocs.llm.models.visualizationContext'
                };
                const perTaskSetting = (config.get<string>(taskSettingMap[taskType] as any) || '').trim();
                if (perTaskSetting) { modelHint = perTaskSetting; modelResolutionTrace.push('per-task-setting'); }
                if (!modelHint) {
                    const defaultModelSetting = (config.get<string>('naruhodocs.llm.defaultModel') || '').trim();
                    if (defaultModelSetting) { modelHint = defaultModelSetting; modelResolutionTrace.push('default-setting'); }
                }
                if (!modelHint && policy.modelHint) { modelHint = policy.modelHint; modelResolutionTrace.push('policy-hint'); }
                if (!modelHint) {
                    if (providerType === 'local') {
                        modelHint = (config.get<string>('llm.localModel') || config.get<string>('naruhodocs.llm.localModel') || 'gemma3:1b');
                        modelResolutionTrace.push('local-provider-fallback');
                    } else {
                        modelHint = 'gemini-2.0-flash';
                        modelResolutionTrace.push('gemini-fallback');
                    }
                }
            } catch {
                modelHint = 'unknown-model';
                modelResolutionTrace.push('error-unknown');
            }
        }

        // If existing session and not forceNew, check if local provider model changed compared to stored hint
        if (existing && !options?.forceNew) {
            const config = vscode.workspace.getConfiguration('naruhodocs');
            const providerType = config.get<string>('llm.provider', 'ootb');
            if (providerType === 'local') {
                // Derive current effective local model using same precedence as resolution above to avoid false mismatches
                let currentLocalModel: string | undefined;
                if (this.modelConfigManager?.isActive()) {
                    try {
                        const resolvedCurrent = this.modelConfigManager.resolveModel('local', taskType, policy.modelHint, 'gemma3:1b');
                        currentLocalModel = resolvedCurrent.model;
                    } catch { /* ignore */ }
                }
                if (!currentLocalModel) {
                    currentLocalModel = (config.get<string>('llm.localModel') || config.get<string>('naruhodocs.llm.localModel')) || undefined;
                }
                const stored = this.sessionModelHints.get(key);
                // Only recreate if both stored and newly derived model are defined and differ
                if (stored && currentLocalModel && stored !== currentLocalModel && !options?.modelOverride) {
                    this.clearSession(key); // model change requires new session for clarity
                } else {
                    return existing; // Reuse existing session (preserve history)
                }
            } else {
                return existing; // Non-local provider reuse is fine
            }
        }

        // Prefer provider manager if initialized
        const provider = this.providerManager.getCurrentProvider?.();
        if (provider) {
            try {
                const session = await provider.createChatSession(systemMessage, { temperature, model: modelHint });
                this.sessionCache.set(key, session);
                this.sessionProviders.set(key, provider.name);
                this.sessionSystemMessages.set(key, systemMessage);
                this.sessionModelHints.set(key, modelHint);
                this.logEvent('session_init', { key, provider: provider.name, model: modelHint, taskType, resolution: modelResolutionTrace });
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
        this.logEvent('session_init', { key, provider: 'fallback-gemini', model: modelHint, taskType, resolution: modelResolutionTrace });
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
    // The old persistence methods (saveState, restoreState) are now replaced by the new saveState method above.
    // The restoration logic is handled by the ThreadManager and ChatViewProvider.

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

    private async handleGrammarCheck(req: GrammarCheckRequest): Promise<LLMResponse> {
        const systemMessage = req.systemMessage || 'You are an AI data filter. Your sole purpose is to return a JSON array.';
        const session = await this.getSession(req.sessionId || 'grammar_check', systemMessage, { taskType: 'grammar_check' });
        // This handler directly uses the prompt from the request, without modification.
        const answer = await this.invokeTracked(session, req.prompt, 'grammar_check', req.prompt.length, { sessionId: req.sessionId });
        return { type: 'grammar_check', content: answer, meta: { provider: this.sessionProviders.get(req.sessionId || 'grammar_check') } };
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
                historySnapshot = hist.map((m: any) => {
                    let role: string | undefined = (m as any).type || (typeof (m as any)._getType === 'function' ? (m as any)._getType() : undefined);
                    if (!role || role === 'unknown') {
                        const ctor = m.constructor?.name?.toLowerCase?.() || '';
                        if (ctor.includes('human')) { role = 'human'; }
                        else if (ctor.includes('ai')) { role = 'ai'; }
                    }
                    if (role === 'user') { role = 'human'; }
                    if (role === 'assistant' || role === 'bot') { role = 'ai'; }
                    if (role !== 'human' && role !== 'ai') { role = 'unknown'; }
                    const content = (m as any).text || (typeof (m as any).content === 'string' ? (m as any).content : JSON.stringify((m as any).content || ''));
                    return { role, content: content.toString() };
                });
            }
        } catch { /* ignore */ }
        // Verbose pre-dispatch logging of context going to the model
        try {
            if (this.verboseLogging && this.outputChannel) {
                let sessionKey: string | undefined;
                for (const [k, s] of this.sessionCache.entries()) { if (s === session) { sessionKey = k; break; } }
                const providerName = sessionKey ? this.sessionProviders.get(sessionKey) : 'unknown-provider';
                const modelHint = sessionKey ? this.sessionModelHints.get(sessionKey) : undefined;
                const systemMsg = sessionKey ? this.sessionSystemMessages.get(sessionKey) : undefined;
                const timestamp = new Date().toISOString();
                this.outputChannel.appendLine(`[${timestamp}] dispatch_start task=${task} provider=${providerName || 'unknown'} model=${modelHint || 'unknown'} session=${sessionKey || 'n/a'} historyMessages=${historySnapshot.length} promptChars=${prompt.length}`);
                if (systemMsg) {
                    const sysPreview = systemMsg.length > 200 ? systemMsg.slice(0,200) + '…' : systemMsg;
                    this.outputChannel.appendLine(`  SYSTEM(full) >>> ${sysPreview.replace(/\r?\n/g,' \u23CE ')}`);
                }
                if (historySnapshot.length) {
                    const recent = historySnapshot.slice(-12); // up to last 12 messages
                    recent.forEach((m, idx) => {
                        const content = m.content.length > 220 ? m.content.slice(0,220)+'…' : m.content;
                        const roleLabel = m.role === 'human' ? 'HUMAN' : (m.role === 'ai' ? 'AI' : 'UNKNOWN');
                        this.outputChannel!.appendLine(`  CONTEXT[${recent.length-idx}/${historySnapshot.length}] ${roleLabel}: ${content.replace(/\r?\n/g,' \u23CE ')}`);
                    });
                } else {
                    this.outputChannel.appendLine('  CONTEXT (none)');
                }
                const combinedChars = historySnapshot.reduce((acc, m) => acc + m.content.length, 0) + prompt.length;
                this.outputChannel.appendLine(`  CONTEXT_STATS totalChars=${combinedChars} estTokens~= ${this.estimateTokens('', combinedChars)} (history + prompt)`);
            }
        } catch { /* ignore logging errors */ }
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
                this.outputChannel.appendLine(`[${timestamp}] task=${task} provider=${providerName} model=${modelHint || 'unknown'} durationMs=${durationMs} inTokens~= ${estIn} outTokens~= ${estOut}${metaLine}`);
                this.outputChannel.appendLine(`  SYSTEM>>> ${systemSnippet.replace(/\r?\n/g, ' \u23CE ')}`);
                if (historySnapshot.length) {
                    const recent = historySnapshot.slice(-6); // last 6 messages
                    recent.forEach((m, idx) => {
                        const content = m.content.length > 160 ? m.content.slice(0,160)+'…' : m.content;
                        const roleLabel = m.role === 'human' ? 'HUMAN' : (m.role === 'ai' ? 'AI' : 'UNKNOWN');
                        this.outputChannel!.appendLine(`  HIST[${recent.length-idx}] ${roleLabel}: ${content.replace(/\r?\n/g,' \u23CE ')}`);
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
export type LLMTaskType = 'chat' | 'summarize' | 'read_files' | 'analyze' | 'translate' | 'grammar_check' | 'generate_doc' | 'visualization_context';

export interface BaseLLMRequest { type: LLMTaskType; sessionId?: string; systemMessage?: string; }
export interface ChatRequest extends BaseLLMRequest { type: 'chat'; prompt: string; }
export interface SummarizeRequest extends BaseLLMRequest { type: 'summarize'; content: string; format?: string; requirements?: string[]; targetId?: string; }
export interface ReadFilesRequest extends BaseLLMRequest { type: 'read_files'; files: Array<{ path: string; content: string }>; prompt?: string; }
export interface AnalyzeRequest extends BaseLLMRequest { type: 'analyze'; analysisGoal: string; context: string; }
export interface TranslateRequest extends BaseLLMRequest { type: 'translate'; content: string; targetLanguage: string; }
export interface GrammarCheckRequest extends BaseLLMRequest { type: 'grammar_check'; prompt: string; }
export interface GenerateDocRequest extends BaseLLMRequest { type: 'generate_doc'; title: string; sourceContent: string; purpose?: string; tone?: string; }
export interface VisualizationContextRequest extends BaseLLMRequest { type: 'visualization_context'; contextType: string; userPrompt: string; botResponse: string; }

export type LLMRequest = ChatRequest | SummarizeRequest | ReadFilesRequest | AnalyzeRequest | TranslateRequest | GrammarCheckRequest | GenerateDocRequest | VisualizationContextRequest;

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
