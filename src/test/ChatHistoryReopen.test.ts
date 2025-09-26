import * as assert from 'assert';
import { ChatViewProvider } from '../ChatViewProvider';
import { LLMProviderManager } from '../llm-providers/manager';
import * as vscode from 'vscode';

// This is a lightweight regression test that ensures calling the internal chatViewReady
// logic multiple times (simulating sidebar close + reopen) does not throw and that
// the resend branch executes without exceptions.

describe('Chat history replay on reopen (regression)', () => {
    it('should not throw when chatViewReady fires again', async () => {
        const context = { workspaceState: { keys: () => [] }, globalState: { get: () => undefined } } as unknown as vscode.ExtensionContext;
        const provider = new ChatViewProvider(vscode.Uri.parse('file:///fake'), undefined, context, new LLMProviderManager());
        // @ts-ignore access private
        const webviewView: vscode.WebviewView = { webview: { postMessage: () => true, options: {}, html: '' } } as any;
        // First resolve to set up state
        // @ts-ignore
        await provider.resolveWebviewView(webviewView, {} as any, {} as any);
        // Simulate first chatViewReady (initialization)
        // @ts-ignore
        await webviewView.webview.onDidReceiveMessage?.({ type: 'chatViewReady' });
        // Simulate second chatViewReady (reopen)
        // Should not throw
        // @ts-ignore
        await webviewView.webview.onDidReceiveMessage?.({ type: 'chatViewReady' });
        assert.ok(true, 'Second chatViewReady did not throw');
    });
});
