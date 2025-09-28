import * as vscode from 'vscode';
import * as path from 'path';

export interface ProviderTaskModelsV1 {
    defaultModel?: string;
    tasks?: Record<string, string>;
}

export interface ModelsConfigSchemaV1 {
    version: 1;
    providers: Record<string, ProviderTaskModelsV1>;
}

export interface ProviderTaskModelsV2 extends ProviderTaskModelsV1 {
    backend?: string;       // local only
    baseUrl?: string;       // local only
    note?: string;          // optional metadata
}

export interface ModelsConfigSchemaV2 {
    version: 2;
    providers: Record<string, ProviderTaskModelsV2>;
}

/**
 * Manages per-repo model configuration via .naruhodocs/models.json
 * If present, this file overrides settings-based model resolution (except explicit runtime overrides).
 */
export class ModelConfigManager {
    private config: ModelsConfigSchemaV2 | undefined;
    private configPath: vscode.Uri | undefined;
    private active = false;

    constructor(private context: vscode.ExtensionContext) {}

    public async load(): Promise<void> {
        try {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) { this.active = false; return; }
            this.configPath = vscode.Uri.joinPath(ws.uri, '.naruhodocs', 'models.json');
            let exists = true;
            try { await vscode.workspace.fs.stat(this.configPath); } catch { exists = false; }
            if (!exists) { this.active = false; return; }
            const buf = await vscode.workspace.fs.readFile(this.configPath);
            const text = Buffer.from(buf).toString('utf8');
            const parsed = JSON.parse(text);
            if (parsed && parsed.version === 2 && parsed.providers) {
                // Remove legacy 'ootb' provider if still present
                if (parsed.providers.ootb) {
                    delete parsed.providers.ootb;
                }
                // Migrate legacy 'byok' key to 'cloud'
                if (parsed.providers.byok && !parsed.providers.cloud) {
                    parsed.providers.cloud = parsed.providers.byok;
                    delete parsed.providers.byok;
                }
                this.config = parsed as ModelsConfigSchemaV2;
                this.active = true;
            } else if (parsed && parsed.version === 1 && parsed.providers) {
                // Migrate v1 -> v2
                const migrated: ModelsConfigSchemaV2 = {
                    version: 2,
                    providers: {}
                };
                for (const [prov, entry] of Object.entries(parsed.providers as Record<string, ProviderTaskModelsV1>)) {
                    if (prov === 'byok') {
                        migrated.providers.cloud = { ...entry } as any;
                        continue;
                    }
                    migrated.providers[prov] = { ...entry };
                }
                // Remove deprecated 'ootb' provider if present during migration
                if (migrated.providers.ootb) {
                    delete migrated.providers.ootb;
                }
                // Attempt to enrich local provider with legacy settings if present
                try {
                    const cfg = vscode.workspace.getConfiguration('naruhodocs');
                    const backend = cfg.get<string>('llm.localBackend');
                    const baseUrl = cfg.get<string>('llm.localUrl');
                    if (migrated.providers.local) {
                        if (backend) { migrated.providers.local.backend = backend; }
                        if (baseUrl) { migrated.providers.local.baseUrl = baseUrl; }
                    }
                } catch { /* ignore */ }
                this.config = migrated;
                await this.write();
                this.active = true;
                // Log migration via output channel (caller will log event) handled externally
            } else {
                this.active = false;
            }
        } catch (e) {
            console.warn('[ModelConfigManager] Failed to load models.json:', e);
            this.active = false;
        }
    }

    public isActive(): boolean { return this.active; }

    /** Resolve model for provider+task. Fallback precedence inside file scope: task -> provider default */
    public resolveModel(provider: string, task: string, policyHint?: string, ultimateFallback?: string): { model: string; trace: string[] } {
        const trace: string[] = [];
        if (!this.active || !this.config) {
            return { model: policyHint || ultimateFallback || 'unknown-model', trace: ['inactive'] };
        }
        const providerEntry = this.config.providers[provider];
        if (providerEntry?.tasks && providerEntry.tasks[task]) {
            trace.push('file-task');
            return { model: providerEntry.tasks[task], trace };
        }
        if (providerEntry?.defaultModel) {
            trace.push('file-default');
            return { model: providerEntry.defaultModel, trace };
        }
        if (policyHint) { trace.push('policy-hint'); return { model: policyHint, trace }; }
        trace.push('ultimate-fallback');
        return { model: ultimateFallback || 'unknown-model', trace };
    }

    /** Scaffold a default config file if missing */
    public async scaffoldIfMissing(): Promise<void> {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) { return; }
        const dir = vscode.Uri.joinPath(ws.uri, '.naruhodocs');
        const file = vscode.Uri.joinPath(dir, 'models.json');
    let exists = true;
    try { await vscode.workspace.fs.stat(file); } catch { exists = false; }
    if (exists) { return; }
        // Ensure directory
        await vscode.workspace.fs.createDirectory(dir);
        const defaultConfig: ModelsConfigSchemaV2 = {
            version: 2,
            providers: {
                cloud: { defaultModel: 'gemini-2.0-flash', note: 'Cloud (API Key) provider. Edit per-task overrides below.' },
                local: { defaultModel: 'gemma3:1b', backend: 'ollama', baseUrl: 'http://localhost:11434', tasks: {}, note: 'Local runtime provider. Ensure model pulled in Ollama/LM Studio.' }
            }
        };
        await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(defaultConfig, null, 2), 'utf8'));
    }

    public getProviderEntry(provider: string): ProviderTaskModelsV2 | undefined {
    if (!this.config) { return undefined; }
        return this.config.providers[provider];
    }

    public async write(): Promise<void> {
    if (!this.config || !this.configPath) { return; }
        await vscode.workspace.fs.writeFile(this.configPath, Buffer.from(JSON.stringify(this.config, null, 2), 'utf8'));
    }

    public async upsertTaskOverride(provider: string, task: string, model: string) {
    if (!this.config) { return; }
        if (!this.config.providers[provider]) {
            this.config.providers[provider] = { defaultModel: model, tasks: {} };
        }
        const entry = this.config.providers[provider];
        entry.tasks = entry.tasks || {};
        entry.tasks[task] = model;
        await this.write();
    }
}
