import * as vscode from 'vscode';

export interface EmbeddingProviderConfig {
    name: string;
    type: string; // e.g. 'local', 'huggingface', etc.
    model?: string;
    baseUrl?: string;
    note?: string;
    llmEngine?: string;
}

export interface EmbeddingConfigSchemaV1 {
    version: 1;
    providers: Record<string, EmbeddingProviderConfig>;
}

/**
 * Manages per-repo embedding model configuration via .naruhodocs/embeddings.json
 * If present, this file overrides settings-based embedding resolution (except explicit runtime overrides).
 */
export class EmbeddingConfigManager {
    private config: EmbeddingConfigSchemaV1 | undefined;
    private configPath: vscode.Uri | undefined;
    private active = false;

    constructor(private context: vscode.ExtensionContext) {}

    public async load(): Promise<void> {
        try {
            const ws = vscode.workspace.workspaceFolders?.[0];
            if (!ws) { this.active = false; return; }
            this.configPath = vscode.Uri.joinPath(ws.uri, '.naruhodocs', 'embeddings.json');
            let exists = true;
            try { await vscode.workspace.fs.stat(this.configPath); } catch { exists = false; }
            if (!exists) { this.active = false; return; }
            const buf = await vscode.workspace.fs.readFile(this.configPath);
            const text = Buffer.from(buf).toString('utf8');
            const parsed = JSON.parse(text);
            if (parsed && parsed.version === 1 && parsed.providers) {
                this.config = parsed as EmbeddingConfigSchemaV1;
                this.active = true;
            } else {
                this.active = false;
            }
        } catch (e) {
            console.warn('[EmbeddingConfigManager] Failed to load embeddings.json:', e);
            this.active = false;
        }
    }

    public isActive(): boolean { return this.active; }

    /** Resolve embedding provider by name */
    public resolveProvider(name: string): EmbeddingProviderConfig | undefined {
        if (!this.active || !this.config) { return undefined; }
        return this.config.providers[name];
    }

    /** Scaffold a default config file if missing */
    public async scaffoldIfMissing(): Promise<void> {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) { return; }
        const dir = vscode.Uri.joinPath(ws.uri, '.naruhodocs');
        const file = vscode.Uri.joinPath(dir, 'embeddings.json');
        let exists = true;
        try { await vscode.workspace.fs.stat(file); } catch { exists = false; }
        if (exists) { return; }
        // Ensure directory
        await vscode.workspace.fs.createDirectory(dir);
        const defaultConfig: EmbeddingConfigSchemaV1 = {
            version: 1,
            providers: {
                local: { name: 'Local', type: 'local', llmEngine: 'ollama', model: 'snowflake-arctic-embed:33m', baseUrl: 'http://localhost:11434', note: 'Default local embedding model' },
                cloudHuggingface: { name: 'huggingface', type: 'huggingface', model: 'sentence-transformers/all-MiniLM-L6-v2', note: 'Default cloud embedding model' },
            }
        };
        await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(defaultConfig, null, 2), 'utf8'));
    }

    public async write(): Promise<void> {
        if (!this.config || !this.configPath) { return; }
        await vscode.workspace.fs.writeFile(this.configPath, Buffer.from(JSON.stringify(this.config, null, 2), 'utf8'));
    }

    public async upsertProvider(name: string, config: EmbeddingProviderConfig) {
        if (!this.config) { return; }
        this.config.providers[name] = config;
        await this.write();
    }
}
