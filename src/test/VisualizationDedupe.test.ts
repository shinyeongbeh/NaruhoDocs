import * as assert from 'assert';
import { VisualizationProvider, VisualizationResult } from '../VisualizationProvider';
import { LLMProviderManager } from '../llm-providers/manager';
import * as vscode from 'vscode';

// Lightweight mock ChatProvider capturing bot messages
class MockChatProvider {
  public messages: string[] = [];
  addBotMessage(msg: string) { this.messages.push(msg); }
}

describe('VisualizationProvider dedupe', () => {
  it('should not add duplicate visualization messages with identical hash', async () => {
    const context = { workspaceState: { get: (_k: string, def?: any) => def, update: (_k: string, _v: any) => Promise.resolve() } } as unknown as vscode.ExtensionContext;
  const manager = new LLMProviderManager();
  const provider = new VisualizationProvider(context as any, manager);
    const mockChat = new MockChatProvider();
    provider.setChatProvider(mockChat as any);

    const result: VisualizationResult = { type: 'mermaid', content: 'graph TD\nA-->B', title: 'Test Architecture' };
    // First insertion
    (provider as any).addVisualizationToAIHistory(result);
    // Simulate stored hash by capturing current workspaceState behavior is mocked always default; monkey patch
    let lastHash: string | undefined;
    (context.workspaceState as any).get = (_k: string, def?: any) => lastHash || def;
    (context.workspaceState as any).update = (k: string, v: any) => { lastHash = v; return Promise.resolve(); };
    // Second identical insertion should be skipped
    (provider as any).addVisualizationToAIHistory(result);

    assert.strictEqual(mockChat.messages.length, 1, 'Duplicate visualization message was added');
  });
});
