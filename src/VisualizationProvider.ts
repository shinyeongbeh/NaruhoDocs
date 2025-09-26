import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { LLMProviderManager } from './llm-providers/manager';
import { LLMService } from './managers/LLMService';
import { ProjectAnalyzer } from './analyzers/ProjectAnalyzer';
import { DocumentAnalyzer } from './analyzers/DocumentAnalyzer';
import { ArchitectureAnalyzer } from './analyzers/ArchitectureAnalyzer';
import { FolderStructureAnalyzer } from './analyzers/FolderStructureAnalyzer';
import { DocumentRelationsAnalyzer } from './analyzers/DocumentRelationsAnalyzer';
import { D3TreeRenderer, TreeNode } from './renderers/D3TreeRenderer';
import { VisualizationViewProvider } from './VisualizationViewProvider';
import { OutputLogger } from './utils/OutputLogger';

export interface VisualizationOption {
    id: string;
    title: string;
    description: string;
    icon: string;
}

export interface VisualizationResult {
    type: 'mermaid' | 'd3' | 'vis' | 'error';
    content: string;
    title: string;
    error?: string;
}

export class VisualizationProvider {
    private readonly projectAnalyzer: ProjectAnalyzer;
    private readonly documentAnalyzer: DocumentAnalyzer;
    private readonly d3TreeRenderer: D3TreeRenderer;
    private chatProvider?: any; // Reference to ChatViewProvider for sending messages

    private static readonly visualizationOptions: VisualizationOption[] = [
        {
            id: 'architecture',
            title: 'Project Architecture',
            description: 'Generate architecture diagrams showing component relationships and system structure',
            icon: '🏗️'
        },
        {
            id: 'folderStructure',
            title: 'Folder Structure',
            description: 'Interactive tree view of project structure with documentation coverage analysis',
            icon: '📁'
        },
        {
            id: 'docRelations',
            title: 'Document Relations',
            description: 'Visualize relationships and cross-references between documentation files',
            icon: '🔗'
        }
    ];

    private llmService: LLMService;
    private visualizationView?: VisualizationViewProvider; // optional sidebar view reference

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly llmManager: LLMProviderManager
    ) {
        this.projectAnalyzer = new ProjectAnalyzer();
        this.documentAnalyzer = new DocumentAnalyzer();
        this.d3TreeRenderer = new D3TreeRenderer();
        this.llmService = LLMService.getOrCreate(this.llmManager);
    }

    public setChatProvider(chatProvider: any): void {
        this.chatProvider = chatProvider;
    }

    /** Set the dedicated visualization view (sidebar) so we can mirror results there */
    public setVisualizationView(view: VisualizationViewProvider): void {
        this.visualizationView = view;
    }

    public static getVisualizationOptions(): VisualizationOption[] {
        return this.visualizationOptions;
    }

    public async showVisualizationMenu(documentUri?: vscode.Uri): Promise<void> {
        try {
            const items = VisualizationProvider.visualizationOptions.map(option => ({
                label: `${option.icon} ${option.title}`,
                description: option.description,
                detail: option.id
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select visualization type',
                ignoreFocusOut: true
            });

            if (selected) {
                await this.generateAndSendVisualization(selected.detail as string, documentUri);
            }
        } catch (error) {
            console.error('Error showing visualization menu:', error);
            vscode.window.showErrorMessage(`Failed to show visualization menu: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async generateAndSendVisualization(type: string, documentUri?: vscode.Uri): Promise<void> {
        try {
            // Show progress with more detailed messages
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Generating visualization...',
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0, message: 'Initializing...' });

                try {
                    progress.report({ increment: 25, message: 'Analyzing...' });
                    const result = await this.performVisualizationGeneration(type, documentUri, progress);
                    progress.report({ increment: 90, message: 'Finalizing...' });
                    this.sendVisualizationToChat(result);
                    progress.report({ increment: 100, message: 'Complete!' });
                } catch (analysisError) {
                    console.error('Analysis error:', analysisError);
                    progress.report({ increment: 60, message: 'Using fallback...' });
                    const fallbackResult = this.generateFallbackVisualization(type, analysisError as Error);
                    this.sendVisualizationToChat(fallbackResult);
                    progress.report({ increment: 100, message: 'Fallback complete' });
                    vscode.window.showWarningMessage(`Visualization generated with limited analysis: ${(analysisError as Error).message}`);
                }
            });
        } catch (error) {
            console.error('Error generating visualization:', error);
            vscode.window.showErrorMessage(
                `Failed to generate visualization: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'Retry',
                'Cancel'
            ).then(selection => {
                if (selection === 'Retry') {
                    this.generateAndSendVisualization(type, documentUri);
                }
            });
        }
    }

    /**
     * Core generation logic used by both command palette flow and view provider direct calls.
     * Ensures a single path for producing the final VisualizationResult (no placeholders).
     */
    private async performVisualizationGeneration(type: string, documentUri?: vscode.Uri, progress?: vscode.Progress<{message?: string; increment?: number}>): Promise<VisualizationResult> {
        switch (type) {
            case 'architecture':
                progress?.report({ message: 'Analyzing project architecture...' });
                return await this.generateArchitectureVisualization(documentUri);
            case 'folderStructure':
                progress?.report({ message: 'Scanning folder structure...' });
                return await this.generateFolderStructureVisualization();
            case 'docRelations':
                progress?.report({ message: 'Analyzing document relationships...' });
                return await this.generateDocumentRelationsVisualization();
            default:
                throw new Error(`Unknown visualization type: ${type}`);
        }
    }

    private generateFallbackVisualization(type: string, error: Error): VisualizationResult {
        let content: string;
        let title: string;
        
        switch (type) {
            case 'architecture':
                content = `graph TD
    A[VS Code Extension] --> B[Webview Provider]
    A --> C[Command Handlers] 
    A --> D[File System]
    B --> E[Chat Interface]
    B --> F[Visualization Interface]
    C --> G[AI Integration]
    
    style A fill:#f9f,stroke:#333,stroke-width:2px
    style G fill:#bbf,stroke:#333,stroke-width:2px`;
                title = 'Project Architecture (Fallback)';
                break;
                
            case 'folderStructure':
                content = `graph TD
    Root[📁 Project Root] --> Src[📁 src]
    Root --> Config[⚙️ Config Files]
    Root --> Docs[📚 Documentation]
    Src --> Components[📁 Components]
    Src --> Utils[📁 Utilities]
    Config --> Package[📄 package.json]
    Config --> TSConfig[📄 tsconfig.json]
    Docs --> README[📝 README.md]
    
    classDef folder fill:#42a5f5
    classDef file fill:#66bb6a
    classDef config fill:#ff9800`;
                title = 'Project Structure (Fallback)';
                break;
                
            case 'docRelations':
                content = `graph LR
    README[📄 README.md] --> GUIDE[📋 User Guide]
    README --> API[📖 API Docs]
    API --> CODE[💻 Implementation]
    GUIDE --> EXAMPLES[📝 Examples]
    
    classDef default fill:#e1f5fe
    classDef readme fill:#fff3e0`;
                title = 'Document Relations (Fallback)';
                break;
                
            default:
                content = `graph TD
    A[Visualization Error] --> B[${error.message}]
    B --> C[Using Fallback Diagram]
    
    style A fill:#ff9800
    style B fill:#ffebee`;
                title = 'Error Fallback';
        }
        
        return {
            type: 'mermaid',
            content,
            title: title + ` (Limited due to: ${error.message})`
        };
    }

    private sendVisualizationToChat(result: VisualizationResult): void {
        if (!this.chatProvider) {
            vscode.window.showErrorMessage('Chat provider not available');
            return;
        }

        // Focus chat so user sees the forthcoming bot message produced by addVisualizationToAIHistory
        vscode.commands.executeCommand('naruhodocs.chatView.focus');

        // Show in dedicated visualization view (sidebar) immediately
        try {
            this.visualizationView?.showVisualization(result);
        } catch (e) {
            console.warn('Failed to post visualization to view:', e);
        }

        // Add compact visualization message (dedup + flagged) ONLY; removed legacy packaging prompt
        this.addVisualizationToAIHistory(result);
    }

    private addVisualizationToAIHistory(result: VisualizationResult): void {
        try {
            if (!this.chatProvider) { return; }

            const vizType = this.getVisualizationType(result.title);
            const trimmedContent = this.tokenHygiene(result.content);
            const compactMessage = this.buildCompactVisualizationMessage(result.title, trimmedContent, vizType);
            const hash = this.hashContent(compactMessage);
            const hashKey = `visualization:lastHash:${vizType}`;
            const lastHash = this.context.workspaceState.get<string>(hashKey, '');

            if (lastHash === hash) {
                vscode.window.setStatusBarMessage(`Visualization unchanged – not duplicated in chat history.`, 4000);
                OutputLogger.viz(`Skipped duplicate visualization (type=${vizType}) hash=${hash.slice(0,8)}`);
                return;
            }

            try {
                void this.context.workspaceState.update(hashKey, hash);
            } catch { /* ignore */ }

            if (typeof (this.chatProvider as any).addBotMessage === 'function') {
                (this.chatProvider as any).addBotMessage(compactMessage, { messageType: 'visualization', flags: ['visualization', vizType] });
            } else {
                (this.chatProvider as any).addContextToActiveSession('Visualization', compactMessage);
            }
            OutputLogger.viz(`Inserted visualization type=${vizType} title="${result.title}" hash=${hash.slice(0,8)} length=${trimmedContent.length}`);
        } catch (error) {
            console.error('Error adding compact visualization message:', error);
            OutputLogger.error(`Failed to add visualization: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private buildCompactVisualizationMessage(title: string, mermaid: string, vizType: string): string {
        // Reintroduced concise heading: project name + descriptor retained for clarity.
        return `<!--naruhodocs:visualization:${vizType}-->\n## ${title}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``;
    }

    private hashContent(content: string): string {
        try { return crypto.createHash('sha256').update(content).digest('hex'); } catch { return '' + content.length; }
    }

    private tokenHygiene(content: string): string {
        // Trim blank lines, collapse multiple blank lines, enforce length ceiling (very large diagrams simplified upstream)
        let cleaned = content.split('\n')
            .map(l => l.trimEnd())
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        return cleaned;
    }

    // Removed verbose context builders (createProjectContext, createDetailedAIContext)

    private getVisualizationType(title: string): string {
        if (title.includes('Architecture')) {
            return 'architecture';
        }
        if (title.includes('Folder Structure')) {
            return 'folder structure';
        }
        if (title.includes('Document Relations')) {
            return 'document relations';
        }
        return 'project';
    }

    private extractDiagramStructure(mermaidContent: string): string {
        // Extract key information from the mermaid diagram for AI reference
        const lines = mermaidContent.split('\n').filter(line => line.trim());
        const nodes = lines.filter(line => 
            line.includes('[') && line.includes(']') && !line.includes('-->')
        ).slice(0, 8); // First 8 nodes
        
        const connections = lines.filter(line => 
            line.includes('-->')
        ).slice(0, 6); // First 6 connections

        let structure = '';
        if (nodes.length > 0) {
            structure += `\n**Main Components (Sampled nodes/edges):**\n${nodes.map(node => `- ${node.trim()}`).join('\n')}`;
        }
        if (connections.length > 0) {
            structure += `\n\n**Key Relationships (Sampled nodes/edges):**\n${connections.map(conn => `- ${conn.trim()}`).join('\n')}`;
        }

        return structure || 'Complex structure (sample omitted).';
    }

    // (Removed) formatVisualizationForChat & createVisualizationContext – replaced by compact message pathway only.

    private optimizeMermaidContent(content: string): string {
        // Split content into lines for processing
        let lines = content.split('\n');
        
        // Remove excessive whitespace and empty lines
        lines = lines.map(line => line.trim()).filter(line => line.length > 0);
        
        // Limit the number of nodes to prevent complexity issues
        const maxNodes = 50;
        let nodeCount = 0;
        const filteredLines: string[] = [];
        
        for (const line of lines) {
            // Count nodes (lines that don't start with common Mermaid keywords)
            if (!line.match(/^(graph|classDef|style|class|click|%%)/) && line.includes('[')) {
                nodeCount++;
                if (nodeCount > maxNodes) {
                    // Add a truncation notice
                    if (!filteredLines.some(l => l.includes('...'))) {
                        filteredLines.push('    TRUNCATED[... More items available]');
                        filteredLines.push('    style TRUNCATED fill:#ffeb3b,stroke:#f57f17');
                    }
                    continue;
                }
            }
            filteredLines.push(line);
        }
        
        // Rejoin and ensure it's within reasonable limits
        let optimized = filteredLines.join('\n');
        
        // If still too large, create a simplified version
        if (optimized.length > 8000) {
            optimized = this.createSimplifiedDiagram(content);
        }
        
        return optimized;
    }

    private createSimplifiedDiagram(originalContent: string): string {
        // Create a very simple fallback diagram
        if (originalContent.includes('Project Folder Structure')) {
            return `graph TD
    Root[📁 Project Root] --> Src[📁 src]
    Root --> Media[📁 media] 
    Root --> Config[⚙️ Config Files]
    Src --> Extensions[📄 VS Code Extension]
    Src --> LLM[🤖 AI Integration]
    Media --> UI[🎨 User Interface]
    Config --> Build[🔧 Build Tools]
    
    style Root fill:#42a5f5
    style Src fill:#66bb6a
    style Media fill:#ff9800
    
    click Root "Project contains multiple directories and files"
    click Src "Source code and main functionality"`;
        } else if (originalContent.includes('Document Relationships')) {
            return `graph LR
    README[📄 README] --> DOCS[📚 Documentation]
    DOCS --> API[📖 API Reference]
    DOCS --> GUIDE[📋 User Guide]
    API --> CODE[💻 Implementation]
    
    style README fill:#fff3e0
    style DOCS fill:#e8f5e8`;
        } else {
            return `graph TD
    A[Project Analysis] --> B[Simplified View]
    B --> C[Full details available on request]
    
    style A fill:#e3f2fd
    style C fill:#ffeb3b`;
        }
    }

    public async generateVisualization(type: string, documentUri?: vscode.Uri): Promise<VisualizationResult> {
        try {
            const result = await vscode.window.withProgress<VisualizationResult>({
                location: vscode.ProgressLocation.Notification,
                title: 'Generating visualization...',
                cancellable: false
            }, async (progress) => {
                try {
                    return await this.performVisualizationGeneration(type, documentUri, progress);
                } catch (e) {
                    return this.generateFallbackVisualization(type, e as Error);
                }
            });
            return result;
        } catch (error) {
            console.error('Error generating visualization:', error);
            return this.generateFallbackVisualization(type, error as Error);
        }
    }

    private async generateArchitectureVisualization(documentUri?: vscode.Uri): Promise<VisualizationResult> {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder found. Please open a project folder in VS Code.');
            }
            const rootPath = workspaceFolders[0].uri.fsPath;
            const projectName = workspaceFolders[0].name;

            // Skip analysis if this appears to be the NaruhoDocs extension itself
            if (projectName.toLowerCase().includes('naruhodocs') || rootPath.includes('NaruhoDocs')) {
                return {
                    type: 'mermaid',
                    content: `graph TD\n    A[Extension Project Detected] --> B[Open a different workspace]\n    B --> C[Use File > Open Folder]\n    A --> D[Architecture analysis skipped]\n    style A fill:#ffcc80,stroke:#fb8c00\n    style B fill:#e3f2fd,stroke:#1976d2\n    style C fill:#e8f5e9,stroke:#388e3c\n    style D fill:#f3e5f5,stroke:#9c27b0`,
                    title: 'Extension Project (Architecture Skipped)'
                };
            }

            // Perform architecture analysis via analyzer
            const analyzer = new ArchitectureAnalyzer(this.llmManager);
            const analysis = await analyzer.analyzeProjectArchitecture();
            const content = analyzer.generateMermaidDiagram(analysis);

            return {
                type: 'mermaid',
                content: this.optimizeMermaidContent(content),
                title: `${projectName} Architecture`
                // title: `${projectName} Architecture (${analysis.components.length} components)`
            };
        } catch (error) {
            console.error('Error generating architecture visualization:', error);
            throw error;
        }
    }

    private async generateFolderStructureVisualization(): Promise<VisualizationResult> {
        try {
            // Get workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder found');
            }

            const projectName = workspaceFolders[0].name;

            // Skip analysis if this appears to be the NaruhoDocs extension itself
            if (projectName.toLowerCase().includes('naruhodocs') || projectName.includes('NaruhoDocs')) {
                return {
                    type: 'mermaid',
                    content: `graph TD
    A[⚠️ Extension Project Detected] --> B[This appears to be the NaruhoDocs extension project]
    B --> C[Please open your own project to analyze its folder structure]
    C --> D[Use File > Open Folder to open your project]
    
    style A fill:#ff9800,stroke:#f57c00
    style D fill:#4caf50,stroke:#388e3c`,
                    title: 'Please Open Your Project'
                };
            }

            // Use the intelligent AI-powered folder structure analyzer
            const folderAnalyzer = new FolderStructureAnalyzer(this.llmManager);
            const aiAnalysis = await folderAnalyzer.analyzeFolderStructure();

            if (aiAnalysis) {
                // AI analysis succeeded - use the intelligent diagram
                const result: VisualizationResult = {
                    type: 'mermaid' as const,
                    content: this.optimizeMermaidContent(aiAnalysis.mermaidDiagram),
                    title: `${projectName} Folder Structure (${aiAnalysis.insights.organizationPattern})`
                };
                return result;
            } else {
                // Fallback to basic file analysis
                const basicAnalysis = await this.projectAnalyzer.analyzeProject();
                const content = this.projectAnalyzer.generateMermaidTreeDiagram(basicAnalysis);
                
                return {
                    type: 'mermaid',
                    content,
                    title: `Project Folder Structure (${basicAnalysis.totalFiles} files analyzed)`
                };
            }
        } catch (error) {
            console.error('Error analyzing folder structure:', error);
            // Fallback to placeholder if analysis fails
            const content = `graph TD
    Root[📁 Project Root] --> Src[📁 src]
    Root --> Config[⚙️ Config Files]
    Root --> Docs[� Documentation]
    Src --> Components[� Components]
    Src --> Utils[� Utilities]
    Config --> Package[📄 package.json]
    Config --> TSConfig[📄 tsconfig.json]
    Docs --> README[📝 README.md]
    Docs --> Guide[� User Guide]`;

            return {
                type: 'mermaid',
                content,
                title: 'Project Folder Structure (Fallback)'
            };
        }
    }

    private async generateDocumentRelationsVisualization(): Promise<VisualizationResult> {
        try {
            // Get workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder found');
            }

            const projectName = workspaceFolders[0].name;

            // Skip analysis if this appears to be the NaruhoDocs extension itself
            if (projectName.toLowerCase().includes('naruhodocs') || projectName.includes('NaruhoDocs')) {
                return {
                    type: 'mermaid',
                    content: `graph TD
    A[⚠️ Extension Project Detected] --> B[This appears to be the NaruhoDocs extension project]
    B --> C[Please open your own project to analyze its documentation]
    C --> D[Use File > Open Folder to open your project]
    
    style A fill:#ff9800,stroke:#f57c00
    style D fill:#4caf50,stroke:#388e3c`,
                    title: 'Please Open Your Project'
                };
            }

            // Use the intelligent AI-powered document relations analyzer
            const docRelationsAnalyzer = new DocumentRelationsAnalyzer(this.llmManager);
            const aiAnalysis = await docRelationsAnalyzer.analyzeDocumentRelations();

            if (aiAnalysis) {
                // AI analysis succeeded - use the intelligent diagram
                const subtitle = aiAnalysis.insights.brokenLinks.length > 0 || aiAnalysis.insights.orphanedDocuments.length > 0 
                    ? ` (${aiAnalysis.insights.brokenLinks.length} broken links, ${aiAnalysis.insights.orphanedDocuments.length} orphaned docs)`
                    : ` (${aiAnalysis.documents.length} documents, ${aiAnalysis.links.length} connections)`;

                const result: VisualizationResult = {
                    type: 'mermaid' as const,
                    content: this.optimizeMermaidContent(aiAnalysis.mermaidDiagram),
                    title: `${projectName} Document Relations ${subtitle}`
                };
                return result;
            } else {
                // Fallback to basic document analysis
                const basicAnalysis = await this.documentAnalyzer.analyzeDocumentRelationships();
                const content = this.documentAnalyzer.generateMermaidRelationshipDiagram(basicAnalysis);
                
                const brokenLinksCount = basicAnalysis.brokenLinks.length;
                const orphanedCount = basicAnalysis.orphanedDocuments.length;
                const subtitle = brokenLinksCount > 0 || orphanedCount > 0 
                    ? ` (${brokenLinksCount} broken links, ${orphanedCount} orphaned docs)`
                    : ` (${basicAnalysis.nodes.length} documents, ${basicAnalysis.links.length} connections)`;
                
                return {
                    type: 'mermaid',
                    content,
                    title: 'Document Relationships' + subtitle
                };
            }
        } catch (error) {
            console.error('Error analyzing document relationships:', error);
            // Fallback diagram
            const content = `graph LR
    README[📄 README.md] --> IMPL[📄 IMPLEMENTATION_PLAN.md]
    README --> VIZ[📄 VISUALIZATION_PLAN.md]
    IMPL --> CODE[💻 Source Code]
    VIZ --> IMPL
    CODE --> TESTS[🧪 Test Files]
    
    classDef default fill:#e1f5fe
    classDef readme fill:#fff3e0`;

            return {
                type: 'mermaid',
                content,
                title: 'Document Relationships (Fallback)'
            };
        }
    }

    private getPlaceholderDiagram(type: string): string {
        switch (type) {
            case 'architecture':
                return `graph TD
    A[VS Code Extension] --> B[Webview Provider]
    A --> C[Command Handlers]
    A --> D[File System]
    B --> E[Chat Interface]
    B --> F[Visualization Interface]
    C --> G[AI Integration]`;
            case 'folderStructure':
                return `graph TD
    Root[📁 Project Root] --> Src[📁 src]
    Root --> Config[⚙️ Config Files]
    Src --> Components[📁 Components]
    Src --> Utils[📁 Utilities]`;
            case 'docRelations':
                return `graph LR
    Docs[📚 Documentation] --> API[📖 API Docs]
    Docs --> Guide[📋 User Guide]
    API --> Code[💻 Implementation]
    Guide --> Examples[📝 Examples]`;
            default:
                return 'graph TD\n    A[Start] --> B[End]';
        }
    }

    private getTitleForType(type: string): string {
        const option = VisualizationProvider.visualizationOptions.find(opt => opt.id === type);
        return option ? option.title : 'Visualization';
    }

    public async visualizeArchitecture(): Promise<void> {
        await this.generateAndSendVisualization('architecture');
    }

    public async visualizeFolderStructure(): Promise<void> {
        await this.generateAndSendVisualization('folderStructure');
    }

    public async visualizeDocRelations(): Promise<void> {
        await this.generateAndSendVisualization('docRelations');
    }

    private convertToTreeStructure(analysis: any): TreeNode {
        // Convert the project analysis into a tree structure for D3 rendering
        const rootNode: TreeNode = {
            id: 'root',
            name: 'Project Root',
            type: 'folder',
            path: '',
            children: [],
            documentationCoverage: analysis.documentationCoverage
        };

        // Build tree from analysis data - use fallback structure if needed
        try {
            if (analysis.structure) {
                rootNode.children = this.buildTreeFromStructure(analysis.structure);
            }
        } catch (error) {
            console.error('Error building tree structure:', error);
            // Return basic structure
            rootNode.children = [
                {
                    id: 'src',
                    name: 'src',
                    type: 'folder',
                    path: 'src',
                    children: []
                },
                {
                    id: 'media',
                    name: 'media',
                    type: 'folder', 
                    path: 'media',
                    children: []
                }
            ];
        }

        return rootNode;
    }

    private buildTreeFromStructure(structure: any): TreeNode[] {
        const nodes: TreeNode[] = [];
        
        // This is a simplified conversion - build from available data
        if (structure.directories) {
            structure.directories.forEach((dir: any) => {
                nodes.push({
                    id: dir.path,
                    name: dir.name,
                    type: 'folder',
                    path: dir.path,
                    children: dir.children ? this.buildTreeFromStructure(dir.children) : [],
                    hasDocumentation: dir.hasDocumentation
                });
            });
        }

        if (structure.files) {
            structure.files.forEach((file: any) => {
                nodes.push({
                    id: file.path,
                    name: file.name,
                    type: 'file',
                    path: file.path,
                    size: file.size,
                    hasDocumentation: file.hasDocumentation
                });
            });
        }

        return nodes;
    }
}
