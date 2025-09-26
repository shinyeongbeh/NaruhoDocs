import * as assert from 'assert';
import * as vscode from 'vscode';
import { ThreadManager } from '../managers/ThreadManager';
import { LLMProviderManager } from '../llm-providers/manager';
import { SystemMessages } from '../SystemMessages';

// Lightweight in-memory ExtensionContext mock for workspaceState/globalState
class MemoryMemento implements vscode.Memento {
	private store = new Map<string, any>();
	get<T>(key: string, defaultValue?: T): T | undefined {
		return this.store.has(key) ? this.store.get(key) : defaultValue;
	}
	update(key: string, value: any): Thenable<void> {
		if (value === undefined) {
			this.store.delete(key);
		} else {
			this.store.set(key, value);
		}
		return Promise.resolve();
	}
	keys(): readonly string[] {
		return Array.from(this.store.keys());
	}
}

const makeContext = (): vscode.ExtensionContext => {
	return {
		extensionUri: vscode.Uri.parse('file:///fake'),
		environmentVariableCollection: {} as any,
		subscriptions: [],
		workspaceState: new MemoryMemento() as any,
		globalState: new MemoryMemento() as any,
		secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } as any,
		extensionMode: vscode.ExtensionMode.Test,
		asAbsolutePath: (rel: string) => rel,
		storagePath: undefined,
		globalStoragePath: '',
		logPath: '',
		extensionPath: '',
		globalStorageUri: vscode.Uri.parse('file:///global'),
		logUri: vscode.Uri.parse('file:///log'),
		storageUri: undefined,
		extension: undefined as any,
		languageModelAccessInformation: undefined as any
	};
};

describe('General Thread Hydration', () => {
	it('restores general thread history from workspaceState after reopen', async () => {
		const ctx = makeContext();
		const llmMgr = new LLMProviderManager();
		const tm1 = new ThreadManager(ctx, undefined, llmMgr, () => {});

		// Simulate initial general thread creation & messages
		await tm1.initializeGeneralThread();
		const generalId = 'naruhodocs-general-thread';
		const session = tm1.getSession(generalId);
		assert.ok(session, 'general session should exist');
		(session as any).setHistory([
			{ type: 'human', text: 'Hello' },
			{ type: 'ai', text: 'Hi there' },
		]);
		await tm1.saveThreadHistory(generalId);
		const persisted = ctx.workspaceState.get<any[]>(`thread-history-${generalId}`);
		assert.ok(persisted && persisted.length === 2, 'persisted history should have 2 entries');

		// Simulate extension reload: new ThreadManager instance reading same context
		const tm2 = new ThreadManager(ctx, undefined, llmMgr, () => {});
		await tm2.restoreThreads(ctx.workspaceState.keys());
		await tm2.initializeGeneralThread();
		const restoredSession = tm2.getSession(generalId);
		assert.ok(restoredSession, 'restored general session should exist');
		const hist = restoredSession!.getHistory();
		assert.strictEqual(hist.length, 2, 'restored history should contain 2 messages');
		// Validate content order
		const first = (hist[0] as any).text || (hist[0] as any).content;
		const second = (hist[1] as any).text || (hist[1] as any).content;
		assert.strictEqual(first, 'Hello');
		assert.strictEqual(second, 'Hi there');
	});
});
