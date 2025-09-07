import * as vscode from 'vscode';
import { LLMProviderManager } from './llm-providers/manager';
import { ProjectAnalyzer } from './analyzers/ProjectAnalyzer';
import { DocumentAnalyzer } from './analyzers/DocumentAnalyzer';
import { ArchitectureAnalyzer } from './analyzers/ArchitectureAnalyzer';
import { FolderStructureAnalyzer } from './analyzers/FolderStructureAnalyzer';
import { DocumentRelationsAnalyzer } from './analyzers/DocumentRelationsAnalyzer';
import { D3TreeRenderer, TreeNode } from './renderers/D3TreeRenderer';

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

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly llmManager: LLMProviderManager
    ) {
        this.projectAnalyzer = new ProjectAnalyzer();
        this.documentAnalyzer = new DocumentAnalyzer();
        this.d3TreeRenderer = new D3TreeRenderer();
    }

    public setChatProvider(chatProvider: any): void {
        this.chatProvider = chatProvider;
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

                let result: VisualizationResult;
                
                try {
                    switch (type) {
                        case 'architecture':
                            progress.report({ increment: 25, message: 'Analyzing project architecture...' });
                            result = await this.generateArchitectureVisualization(documentUri);
                            break;
                        case 'folderStructure':
                            progress.report({ increment: 25, message: 'Scanning folder structure...' });
                            result = await this.generateFolderStructureVisualization();
                            break;
                        case 'docRelations':
                            progress.report({ increment: 25, message: 'Analyzing document relationships...' });
                            result = await this.generateDocumentRelationsVisualization();
                            break;
                        default:
                            throw new Error(`Unknown visualization type: ${type}`);
                    }
                    
                    progress.report({ increment: 75, message: 'Rendering visualization...' });
                    
                    if (result.type === 'error') {
                        throw new Error(result.error || 'Visualization generation failed');
                    }

                    progress.report({ increment: 100, message: 'Complete!' });
                    
                    // Send visualization to chat
                    this.sendVisualizationToChat(result);
                    
                } catch (analysisError) {
                    console.error('Analysis error:', analysisError);
                    
                    // Generate fallback visualization
                    progress.report({ increment: 50, message: 'Generating fallback visualization...' });
                    const fallbackResult = this.generateFallbackVisualization(type, analysisError as Error);
                    progress.report({ increment: 100, message: 'Fallback complete!' });
                    
                    this.sendVisualizationToChat(fallbackResult);
                    
                    // Show warning to user
                    vscode.window.showWarningMessage(
                        `Visualization generated with limited analysis due to: ${(analysisError as Error).message}`,
                        'OK'
                    );
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

        // Focus the chat view
        vscode.commands.executeCommand('naruhodocs.chatView.focus');

        // Create a formatted message with the visualization
        const visualizationMessage = this.formatVisualizationForChat(result);
        
        // Send the visualization message to the webview for display
        this.chatProvider.postMessage({
            type: 'addMessage',
            sender: 'Bot',
            message: visualizationMessage
        });

        // IMPORTANT: Also add detailed analysis to the AI's conversation history
        this.addVisualizationToAIHistory(result);
    }

    private addVisualizationToAIHistory(result: VisualizationResult): void {
        try {
            console.log('=== ADDING VISUALIZATION TO AI HISTORY ===\n' +
                `Visualization Title: ${result.title}\n` +
                `Chart Provider Available: ${!!this.chatProvider}\n` +
                '==========================================');
            
            // Get the chat provider to add context
            if (!this.chatProvider) {
                console.warn('No chat provider available to add visualization context');
                return;
            }

            // Create detailed analysis for the AI to reference
            const aiContextMessage = this.createDetailedAIContext(result);
            
            // Create a simulated user->bot exchange to add context to the AI history
            const userMessage = `Please generate a ${this.getVisualizationType(result.title)} visualization for this project.`;
            const botResponse = `I've analyzed the project and generated a ${result.type} visualization. ${aiContextMessage}

The diagram shows the following structure:
${this.extractDiagramStructure(result.content)}

You can ask me questions about specific components, relationships, patterns, or request explanations about any part of this analysis.`;

            // Add this exchange to the session history using the ChatViewProvider method
            (this.chatProvider as any).addContextToActiveSession(userMessage, botResponse);
            
            console.log('Successfully added visualization context to AI history');
            
        } catch (error) {
            console.error('Error adding visualization to AI history:', error);
        }
    }

    private createDetailedAIContext(result: VisualizationResult): string {
        if (result.title.includes('Architecture')) {
            return `Here's my architectural analysis of your project:

**Project Type**: Identified from code structure and dependencies
**Components Found**: Main modules, services, and their relationships
**Architecture Patterns**: Detected patterns like MVC, layered architecture, or microservices
**Data Flow**: How information moves through the system
**Dependencies**: Both internal component dependencies and external libraries

The mermaid diagram visualizes these relationships and you can ask about:
- Specific components and their purposes
- How data flows between components  
- Architectural patterns being used
- Suggestions for improvements or refactoring
- Dependencies and their implications`;

        } else if (result.title.includes('Folder Structure')) {
            return `Here's my folder structure analysis of your project:

**Organization Pattern**: Detected organizational approach (feature-based, layered, etc.)
**Naming Conventions**: Patterns in folder and file naming
**Structure Logic**: Understanding of why folders are organized this way
**Documentation Coverage**: Assessment of README files and documentation
**Improvement Areas**: Suggested organizational improvements

The diagram shows the folder hierarchy and you can ask about:
- Why certain folders are organized this way
- Naming convention recommendations
- Missing documentation or structure gaps
- How to better organize specific parts
- Best practices for this type of project`;

        } else if (result.title.includes('Document Relations')) {
            return `Here's my documentation analysis of your project:

**Document Network**: Relationships between documentation files
**Link Analysis**: Connections and cross-references between docs
**Coverage Assessment**: Documentation completeness evaluation
**Orphaned Documents**: Files with no incoming or outgoing links
**Broken Links**: Invalid references that need fixing
**Missing Documentation**: Gaps in documentation coverage

The diagram shows document relationships and you can ask about:
- How to fix broken links
- What documentation is missing
- How to improve document organization
- Strategies for better cross-referencing
- Documentation best practices for your project type`;

        } else {
            return `I've generated a visualization analysis of your project structure. You can ask me questions about specific aspects, request explanations of the relationships shown, or get suggestions for improvements.`;
        }
    }

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
            structure += `\n**Main Components:**\n${nodes.map(node => `- ${node.trim()}`).join('\n')}`;
        }
        if (connections.length > 0) {
            structure += `\n\n**Key Relationships:**\n${connections.map(conn => `- ${conn.trim()}`).join('\n')}`;
        }

        return structure || 'Complex structure with multiple interconnected components.';
    }

    private formatVisualizationForChat(result: VisualizationResult): string {
        // Optimize the Mermaid content to prevent text size errors
        const optimizedContent = this.optimizeMermaidContent(result.content);
        
        // Format the visualization as a Mermaid code block that will be rendered in the chat
        return `## ${result.title}\n\n\`\`\`mermaid\n${optimizedContent}\n\`\`\``;
    }

    private createVisualizationContext(result: VisualizationResult): string {
        // Create a descriptive context that the AI can reference
        const context = `Generated ${result.type} visualization: "${result.title}". `;
        
        if (result.title.includes('Architecture')) {
            return context + 'This AI-generated diagram shows the project architecture with components, dependencies, and data flow patterns. Users can ask questions about specific components, architectural patterns, design decisions, or request suggestions for improvements and refactoring.';
        } else if (result.title.includes('Folder Structure')) {
            return context + 'This AI-generated diagram shows the project folder organization and structure patterns. Users can ask about the organization approach, naming conventions, suggested improvements, or how to better organize their project files.';
        } else if (result.title.includes('Document Relations')) {
            return context + 'This AI-generated diagram shows relationships between documentation files and identifies gaps. Users can ask about broken links, missing documentation, orphaned documents, or how to improve their documentation structure.';
        } else {
            return context + 'This AI-generated visualization provides insights about the project. Users can ask questions about specific parts, request explanations, or ask for modifications and improvements.';
        }
    }

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
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Generating visualization...',
                cancellable: false
            }, async (progress) => {
                progress.report({ increment: 0, message: 'Analyzing project structure...' });

                switch (type) {
                    case 'architecture':
                        return await this.generateArchitectureVisualization(documentUri);
                    case 'folderStructure':
                        return await this.generateFolderStructureVisualization();
                    case 'docRelations':
                        return await this.generateDocumentRelationsVisualization();
                    default:
                        throw new Error(`Unknown visualization type: ${type}`);
                }
            });

            // For now, return a placeholder result
            return {
                type: 'mermaid',
                content: this.getPlaceholderDiagram(type),
                title: this.getTitleForType(type)
            };
        } catch (error) {
            console.error('Error generating visualization:', error);
            return {
                type: 'error',
                content: '',
                title: 'Error',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    private async generateArchitectureVisualization(documentUri?: vscode.Uri): Promise<VisualizationResult> {
        try {
            // Get current workspace information (user's project, not extension)
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
                    content: `graph TD
    A[⚠️ Extension Project Detected] --> B[This appears to be the NaruhoDocs extension project]
    B --> C[Please open your own project to analyze its architecture]
    C --> D[Use File > Open Folder to open your project]
    
    style A fill:#ff9800,stroke:#f57c00
    style D fill:#4caf50,stroke:#388e3c`,
                    title: 'Please Open Your Project'
                };
            }

            // Use the intelligent AI-powered architecture analyzer
            const architectureAnalyzer = new ArchitectureAnalyzer(this.llmManager);
            const aiAnalysis = await architectureAnalyzer.analyzeProjectArchitecture();

            if (aiAnalysis) {
                // AI analysis succeeded - generate the intelligent diagram
                const mermaidContent = architectureAnalyzer.generateMermaidDiagram(aiAnalysis);
                return {
                    type: 'mermaid',
                    content: this.optimizeMermaidContent(mermaidContent),
                    title: `${projectName} Architecture (${aiAnalysis.components.length} components)`
                };
            }

            // Fallback to basic file analysis
            const analysis = await this.projectAnalyzer.analyzeProject();
            
            // Try to get LLM analysis for user's project
            try {
                // Simple fallback approach since LLM integration is complex
                console.log('Analyzing user project:', projectName);
            } catch (llmError) {
                console.log('LLM analysis failed, using fallback:', llmError);
            }

            // Create architecture based on user's project analysis
            const fileTypeStats = Array.from(analysis.fileTypes.entries())
                .filter(([ext, count]) => count > 0)
                .map(([ext, count]) => `${ext}: ${count}`)
                .join(', ');

            const content = `graph TD
    User[👤 User] --> Project[� ${projectName}]
    
    Project --> Files[📁 File Structure]
    Files --> TotalFiles["� ${analysis.totalFiles} Total Files"]
    Files --> FileTypes["� Types: ${fileTypeStats}"]
    
    Project --> Analysis[� Analysis Results]
    Analysis --> Analyzed["✅ ${analysis.totalFiles} Files Analyzed"]
    Analysis --> Structure["�️ Project Structure Mapped"]
    
    ${this.generateFileTypeNodes(analysis.fileTypes)}
    
    style Project fill:#42a5f5,stroke:#1976d2
    style Analysis fill:#4caf50,stroke:#388e3c
    style Analyzed fill:#8bc34a,stroke:#689f38
    style Structure fill:#ff9800,stroke:#f57c00`;

            return {
                type: 'mermaid',
                content: this.optimizeMermaidContent(content),
                title: `${projectName} Architecture (${analysis.totalFiles} files analyzed)`
            };
        } catch (error) {
            console.error('Error generating architecture visualization:', error);
            throw error;
        }
    }

    private generateFileTypeNodes(fileTypes: Map<string, number>): string {
        const nodes: string[] = [];
        let nodeCounter = 0;
        
        for (const [ext, count] of fileTypes.entries()) {
            if (count > 0 && nodeCounter < 8) { // Limit to prevent overcrowding
                const nodeId = `Type${nodeCounter}`;
                const icon = this.getFileTypeIcon(ext);
                nodes.push(`    FileTypes --> ${nodeId}["${icon} ${ext}: ${count}"]`);
                nodeCounter++;
            }
        }
        
        return nodes.join('\n    ');
    }

    private getFileTypeIcon(ext: string): string {
        const iconMap: Record<string, string> = {
            '.js': '🟨',
            '.ts': '🔷', 
            '.tsx': '⚛️',
            '.jsx': '⚛️',
            '.py': '🐍',
            '.java': '☕',
            '.cpp': '⚡',
            '.c': '⚡',
            '.cs': '🔷',
            '.php': '🐘',
            '.rb': '💎',
            '.go': '🐹',
            '.rs': '🦀',
            '.html': '🌐',
            '.css': '🎨',
            '.scss': '🎨',
            '.json': '⚙️',
            '.xml': '📄',
            '.md': '📝',
            '.txt': '📄',
            '.yml': '⚙️',
            '.yaml': '⚙️'
        };
        
        return iconMap[ext] || '📄';
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
                
                // Add to AI history for future reference
                this.addVisualizationToAIHistory(result);
                
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
                
                // Add to AI history for future reference
                this.addVisualizationToAIHistory(result);
                
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
