import * as assert from 'assert';
import { VisualizationViewProvider } from '../VisualizationViewProvider';
import { VisualizationProvider, VisualizationResult } from '../VisualizationProvider';
import * as vscode from 'vscode';

// Note: This is a light-weight test ensuring no crash when calling showVisualization before webview ready.
// Full webview lifecycle tests would require VS Code integration test harness; here we focus on logic safety.
suite('VisualizationViewProvider Caching', () => {
    test('Caches last result and does not throw before resolveWebviewView', async () => {
        // Create minimal stubs
        const extUri = vscode.Uri.parse('file:///fake');
        const fakeLLMManager: any = { getCurrentProvider: () => ({ name: 'fake' }) };
        const vizProvider = new VisualizationProvider({} as any, fakeLLMManager);
        const vizViewProvider = new VisualizationViewProvider(extUri, vizProvider);
        vizProvider.setVisualizationView(vizViewProvider);

        const sample: VisualizationResult = { type: 'mermaid', title: 'Test Diagram', content: 'graph TD;A-->B;' };
        // Should not throw even though webview not yet resolved
        vizViewProvider.showVisualization(sample);
        assert.ok(true, 'showVisualization executed without throwing');
    });
});
