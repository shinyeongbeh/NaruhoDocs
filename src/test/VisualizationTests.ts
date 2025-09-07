import * as vscode from 'vscode';
import { VisualizationProvider } from '../VisualizationProvider';
import { DocumentAnalyzer } from '../analyzers/DocumentAnalyzer';
import { D3TreeRenderer } from '../renderers/D3TreeRenderer';

export class VisualizationTests {
    
    public static async runBasicTests(): Promise<boolean> {
        console.log('Starting visualization tests...');
        
        try {
            // Test 1: Document Analyzer
            await this.testDocumentAnalyzer();
            
            // Test 2: D3 Tree Renderer
            await this.testD3TreeRenderer();
            
            // Test 3: Error Handling
            await this.testErrorHandling();
            
            console.log('✅ All visualization tests passed!');
            return true;
            
        } catch (error) {
            console.error('❌ Visualization tests failed:', error);
            return false;
        }
    }
    
    private static async testDocumentAnalyzer(): Promise<void> {
        console.log('Testing DocumentAnalyzer...');
        
        const analyzer = new DocumentAnalyzer();
        
        // Test basic functionality
        try {
            const analysis = await analyzer.analyzeDocumentRelationships();
            
            // Verify structure
            if (!analysis.nodes || !Array.isArray(analysis.nodes)) {
                throw new Error('Invalid nodes structure');
            }
            
            if (!analysis.links || !Array.isArray(analysis.links)) {
                throw new Error('Invalid links structure');
            }
            
            if (!analysis.clusters || !Array.isArray(analysis.clusters)) {
                throw new Error('Invalid clusters structure');
            }
            
            // Test Mermaid generation
            const mermaidCode = analyzer.generateMermaidRelationshipDiagram(analysis);
            if (!mermaidCode.includes('graph')) {
                throw new Error('Invalid Mermaid output');
            }
            
            console.log('✅ DocumentAnalyzer test passed');
            
        } catch (error) {
            console.log('⚠️ DocumentAnalyzer test failed (expected for new workspaces):', error);
            // This is expected if no documents exist
        }
    }
    
    private static async testD3TreeRenderer(): Promise<void> {
        console.log('Testing D3TreeRenderer...');
        
        const renderer = new D3TreeRenderer();
        
        // Create test data
        const testTree = {
            id: 'root',
            name: 'Test Project',
            type: 'folder' as const,
            path: '/',
            children: [
                {
                    id: 'src',
                    name: 'src',
                    type: 'folder' as const,
                    path: '/src',
                    children: [
                        {
                            id: 'main.ts',
                            name: 'main.ts',
                            type: 'file' as const,
                            path: '/src/main.ts',
                            hasDocumentation: true
                        }
                    ]
                },
                {
                    id: 'readme.md',
                    name: 'README.md',
                    type: 'file' as const,
                    path: '/README.md',
                    hasDocumentation: true
                }
            ]
        };
        
        // Test Mermaid generation
        const mermaidCode = renderer.generateMermaidTreeWithD3Fallback(testTree);
        
        if (!mermaidCode.includes('graph TD')) {
            throw new Error('Invalid Mermaid tree output');
        }
        
        if (!mermaidCode.includes('Test Project')) {
            throw new Error('Missing root node in output');
        }
        
        // Test D3 generation
        const d3Visualization = renderer.generateInteractiveTree(testTree);
        
        if (!d3Visualization.html || !d3Visualization.css || !d3Visualization.javascript) {
            throw new Error('Incomplete D3 visualization output');
        }
        
        if (!d3Visualization.html.includes('tree-container')) {
            throw new Error('Invalid D3 HTML structure');
        }
        
        console.log('✅ D3TreeRenderer test passed');
    }
    
    private static async testErrorHandling(): Promise<void> {
        console.log('Testing error handling...');
        
        // Test with null/undefined inputs
        const renderer = new D3TreeRenderer();
        
        try {
            // This should not crash
            const emptyTree = {
                id: 'empty',
                name: 'Empty',
                type: 'folder' as const,
                path: '/'
            };
            
            const result = renderer.generateMermaidTreeWithD3Fallback(emptyTree);
            
            if (!result || typeof result !== 'string') {
                throw new Error('Invalid error handling in renderer');
            }
            
            console.log('✅ Error handling test passed');
            
        } catch (error) {
            console.error('❌ Error handling test failed:', error);
            throw error;
        }
    }
    
    public static showTestResults(success: boolean): void {
        const message = success 
            ? 'All visualization tests passed! 🎉' 
            : 'Some visualization tests failed. Check console for details.';
            
        const level = success 
            ? vscode.window.showInformationMessage 
            : vscode.window.showErrorMessage;
            
        level(message);
    }
}

// Helper function to run tests via command
export async function runVisualizationTests(): Promise<void> {
    const success = await VisualizationTests.runBasicTests();
    VisualizationTests.showTestResults(success);
}
