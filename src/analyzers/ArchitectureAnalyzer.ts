import * as vscode from 'vscode';
import * as path from 'path';
import { ChatSession } from '../langchain-backend/llm';
import { LLMProviderManager } from '../llm-providers/manager';

export interface ArchitectureComponent {
    name: string;
    type: 'module' | 'service' | 'controller' | 'model' | 'view' | 'utility' | 'config' | 'api' | 'database' | 'external';
    description: string;
    dependencies: string[];
    files: string[];
    layer: 'presentation' | 'business' | 'data' | 'infrastructure' | 'cross-cutting';
}

export interface ArchitectureAnalysis {
    projectType: string;
    components: ArchitectureComponent[];
    dataFlow: Array<{ from: string; to: string; description: string }>;
    externalDependencies: string[];
    architecturePatterns: string[];
    recommendations: string[];
}

export class ArchitectureAnalyzer {
    private llmSession?: ChatSession;
    private analysisContext: Map<string, any> = new Map();
    
    constructor(private llmManager: LLMProviderManager) {}

    public async analyzeProjectArchitecture(): Promise<ArchitectureAnalysis> {
        try {
            // Initialize AI session for architecture analysis
            await this.initializeAISession();
            
            // Phase 1: Project Discovery
            const projectOverview = await this.discoverProjectType();
            
            // Phase 2: File Structure Analysis
            const fileStructure = await this.analyzeFileStructure();
            
            // Phase 3: Dependency Analysis
            const dependencies = await this.analyzeDependencies();
            
            // Phase 4: Component Identification
            const components = await this.identifyComponents(projectOverview, fileStructure, dependencies);
            
            // Phase 5: Architecture Pattern Recognition
            const patterns = await this.recognizeArchitecturePatterns(components);
            
            // Phase 6: Data Flow Analysis
            const dataFlow = await this.analyzeDataFlow(components);
            
            // Phase 7: Generate Final Analysis
            const analysis: ArchitectureAnalysis = {
                projectType: projectOverview.type,
                components,
                dataFlow,
                externalDependencies: dependencies.external,
                architecturePatterns: patterns,
                recommendations: await this.generateRecommendations(components, patterns)
            };
            
            return analysis;
        } catch (error) {
            console.error('Architecture analysis failed:', error);
            throw new Error(`Failed to analyze project architecture: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async initializeAISession(): Promise<void> {
        const systemMessage = `You are an expert software architect and code analyst. Your role is to analyze project structures and understand software architecture.

Your capabilities:
- Identify architectural patterns and design principles
- Understand component relationships and dependencies  
- Recognize different types of software projects (web apps, APIs, libraries, etc.)
- Analyze code structure and organization
- Generate clear, accurate architectural diagrams

When analyzing files, focus on:
- Import/export statements to understand dependencies
- Class/function/component structure
- Configuration files to understand project setup
- Entry points and main application files
- Database connections and external service integrations

Be precise and factual. Base your analysis on actual code content, not assumptions.`;

        if (this.llmManager.getCurrentProvider) {
            const provider = this.llmManager.getCurrentProvider();
            if (provider) {
                this.llmSession = await provider.createChatSession(systemMessage);
                return;
            }
        }
        
        // Fallback - try to create session directly
        const { createChat } = require('../langchain-backend/llm');
        this.llmSession = createChat({ 
            systemMessage,
            maxHistoryMessages: 50,
            temperature: 0.1 
        });
    }

    private async discoverProjectType(): Promise<{ type: string; framework?: string; language: string }> {
        // Get key project files
        const keyFiles = await this.getKeyProjectFiles();
        
        const prompt = `Analyze these project files and identify the project type, main programming language, and framework if applicable:

${keyFiles.map(f => `=== ${f.path} ===\n${f.content.substring(0, 2000)}`).join('\n\n')}

Respond in JSON format:
{
    "type": "web-app|api|library|cli-tool|desktop-app|mobile-app|extension|other",
    "language": "javascript|typescript|python|java|etc",
    "framework": "react|vue|angular|express|fastapi|spring|etc or null",
    "description": "brief description of what this project does"
}`;

        const response = await this.llmSession!.chat(prompt);
        
        try {
            const analysis = JSON.parse(this.extractJSON(response));
            this.analysisContext.set('projectType', analysis);
            return analysis;
        } catch (error) {
            // Fallback analysis
            return {
                type: 'web-app',
                language: 'typescript',
                framework: 'unknown'
            };
        }
    }

    private async analyzeFileStructure(): Promise<any> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return {};
        }

        // Get directory structure
        const structure = await this.buildDirectoryMap();
        
        const prompt = `Analyze this directory structure and identify the architectural organization:

${JSON.stringify(structure, null, 2)}

Based on the folder names and file organization, identify:
1. What architectural pattern is being used (MVC, layered, microservices, etc.)
2. Main functional areas/modules
3. Configuration and build files
4. Entry points and main application files

Respond in JSON format with your analysis.`;

        const response = await this.llmSession!.chat(prompt);
        const analysis = JSON.parse(this.extractJSON(response));
        this.analysisContext.set('fileStructure', analysis);
        return analysis;
    }

    private async analyzeDependencies(): Promise<{ internal: string[]; external: string[] }> {
        // Find package.json, requirements.txt, or other dependency files
        const depFiles = await this.getDependencyFiles();
        
        const prompt = `Analyze these dependency files to understand project dependencies:

${depFiles.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n')}

Identify:
1. External libraries and frameworks being used
2. Their purposes (database, UI, testing, build tools, etc.)
3. Any notable architectural implications

Respond in JSON format:
{
    "external": ["library1", "library2"],
    "categories": {
        "ui": ["react", "material-ui"],
        "database": ["prisma", "mongodb"],
        "testing": ["jest", "cypress"],
        "build": ["webpack", "babel"]
    }
}`;

        const response = await this.llmSession!.chat(prompt);
        
        try {
            const deps = JSON.parse(this.extractJSON(response));
            this.analysisContext.set('dependencies', deps);
            return {
                internal: [],
                external: deps.external || []
            };
        } catch (error) {
            return { internal: [], external: [] };
        }
    }

    private async identifyComponents(projectOverview: any, fileStructure: any, dependencies: any): Promise<ArchitectureComponent[]> {
        // Get main source files for analysis
        const sourceFiles = await this.getMainSourceFiles();
        
        const prompt = `Based on the project analysis so far:
- Project Type: ${projectOverview.type} (${projectOverview.framework || 'no framework'})
- File Structure: ${JSON.stringify(fileStructure, null, 2)}
- Dependencies: ${dependencies.external?.join(', ') || 'none identified'}

Now analyze these key source files to identify architectural components:

${sourceFiles.map(f => `=== ${f.path} ===\n${f.content.substring(0, 1500)}`).join('\n\n')}

Identify the main architectural components, their types, and relationships. For each component:
1. Name and purpose
2. Type (controller, service, model, view, utility, etc.)
3. Dependencies on other components  
4. Architectural layer (presentation, business, data, etc.)

Respond in JSON format:
{
    "components": [
        {
            "name": "ComponentName",
            "type": "controller|service|model|view|utility|config|api|database|external",
            "description": "what this component does",
            "dependencies": ["other", "components"],
            "files": ["file1.ts", "file2.ts"],
            "layer": "presentation|business|data|infrastructure|cross-cutting"
        }
    ]
}`;

        const response = await this.llmSession!.chat(prompt);
        
        try {
            const analysis = JSON.parse(this.extractJSON(response));
            return analysis.components || [];
        } catch (error) {
            console.error('Failed to parse component analysis:', error);
            return [];
        }
    }

    private async recognizeArchitecturePatterns(components: ArchitectureComponent[]): Promise<string[]> {
        const prompt = `Based on these identified components:

${JSON.stringify(components, null, 2)}

What architectural patterns and design principles are being used? Consider:
- MVC, MVP, MVVM patterns
- Layered architecture
- Microservices vs monolith
- Repository pattern
- Dependency injection
- Event-driven architecture
- Clean architecture principles

Respond with a JSON array of identified patterns: ["pattern1", "pattern2"]`;

        const response = await this.llmSession!.chat(prompt);
        
        try {
            return JSON.parse(this.extractJSON(response));
        } catch (error) {
            return ['layered-architecture'];
        }
    }

    private async analyzeDataFlow(components: ArchitectureComponent[]): Promise<Array<{ from: string; to: string; description: string }>> {
        const prompt = `Analyze the data flow between these components:

${JSON.stringify(components, null, 2)}

Identify the main data flows - how information moves through the system. Consider:
- User requests and responses
- Database operations
- API calls
- Event flows
- Component communication

Respond in JSON format:
{
    "flows": [
        {
            "from": "ComponentA",
            "to": "ComponentB", 
            "description": "description of what data/control flows"
        }
    ]
}`;

        const response = await this.llmSession!.chat(prompt);
        
        try {
            const analysis = JSON.parse(this.extractJSON(response));
            return analysis.flows || [];
        } catch (error) {
            return [];
        }
    }

    private async generateRecommendations(components: ArchitectureComponent[], patterns: string[]): Promise<string[]> {
        const prompt = `Based on the analyzed architecture:
Components: ${components.length} identified
Patterns: ${patterns.join(', ')}

Provide 3-5 brief architectural recommendations for improving this codebase:
- Code organization improvements
- Design pattern suggestions
- Scalability considerations
- Maintainability improvements

Respond as a JSON array of recommendation strings.`;

        const response = await this.llmSession!.chat(prompt);
        
        try {
            return JSON.parse(this.extractJSON(response));
        } catch (error) {
            return ['Consider implementing dependency injection', 'Separate concerns into distinct layers'];
        }
    }

    public generateMermaidDiagram(analysis: ArchitectureAnalysis): string {
        const lines: string[] = ['graph TB'];
        
        // Add components grouped by layer
        const layerGroups: Record<string, ArchitectureComponent[]> = {};
        analysis.components.forEach(comp => {
            if (!layerGroups[comp.layer]) {
                layerGroups[comp.layer] = [];
            }
            layerGroups[comp.layer].push(comp);
        });

        // Add components with appropriate icons
        analysis.components.forEach(comp => {
            const icon = this.getComponentIcon(comp.type);
            const nodeId = comp.name.replace(/[^a-zA-Z0-9]/g, '');
            lines.push(`    ${nodeId}["${icon} ${comp.name}"]`);
        });

        // Add relationships based on dependencies and data flow
        analysis.components.forEach(comp => {
            const fromId = comp.name.replace(/[^a-zA-Z0-9]/g, '');
            comp.dependencies.forEach(dep => {
                const depComp = analysis.components.find(c => c.name === dep);
                if (depComp) {
                    const toId = dep.replace(/[^a-zA-Z0-9]/g, '');
                    lines.push(`    ${fromId} --> ${toId}`);
                }
            });
        });

        // Add data flows
        analysis.dataFlow.forEach(flow => {
            const fromId = flow.from.replace(/[^a-zA-Z0-9]/g, '');
            const toId = flow.to.replace(/[^a-zA-Z0-9]/g, '');
            lines.push(`    ${fromId} -.-> ${toId}`);
        });

        // Add styling by layer
        lines.push('');
        lines.push('    %% Styling by architectural layer');
        Object.keys(layerGroups).forEach(layer => {
            const style = this.getLayerStyle(layer);
            layerGroups[layer].forEach(comp => {
                const nodeId = comp.name.replace(/[^a-zA-Z0-9]/g, '');
                lines.push(`    style ${nodeId} ${style}`);
            });
        });

        return lines.join('\n');
    }

    private getComponentIcon(type: string): string {
        const icons: Record<string, string> = {
            'controller': '🎮',
            'service': '⚙️',
            'model': '📦',
            'view': '🖼️',
            'utility': '🔧',
            'config': '⚙️',
            'api': '🌐',
            'database': '🗄️',
            'external': '🔗',
            'module': '📋'
        };
        return icons[type] || '📄';
    }

    private getLayerStyle(layer: string): string {
        const styles: Record<string, string> = {
            'presentation': 'fill:#e3f2fd,stroke:#1976d2',
            'business': 'fill:#e8f5e8,stroke:#4caf50', 
            'data': 'fill:#fff3e0,stroke:#ff9800',
            'infrastructure': 'fill:#f3e5f5,stroke:#9c27b0',
            'cross-cutting': 'fill:#fce4ec,stroke:#e91e63'
        };
        return styles[layer] || 'fill:#f5f5f5,stroke:#757575';
    }

    // Helper methods for file analysis
    private async getKeyProjectFiles(): Promise<Array<{ path: string; content: string }>> {
        const keyFiles = ['package.json', 'tsconfig.json', 'main.js', 'index.js', 'app.js', 'main.ts', 'index.ts', 'app.ts', 'README.md'];
        const files: Array<{ path: string; content: string }> = [];
        
        for (const fileName of keyFiles) {
            try {
                const foundFiles = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 3);
                if (foundFiles.length > 0) {
                    const content = await vscode.workspace.fs.readFile(foundFiles[0]);
                    files.push({
                        path: foundFiles[0].fsPath,
                        content: Buffer.from(content).toString('utf8')
                    });
                }
            } catch (error) {
                // File not found or not readable
            }
        }
        
        return files;
    }

    private async getDependencyFiles(): Promise<Array<{ path: string; content: string }>> {
        const depFiles = ['package.json', 'requirements.txt', 'Pipfile', 'pom.xml', 'build.gradle', 'Cargo.toml'];
        const files: Array<{ path: string; content: string }> = [];
        
        for (const fileName of depFiles) {
            try {
                const foundFiles = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 2);
                if (foundFiles.length > 0) {
                    const content = await vscode.workspace.fs.readFile(foundFiles[0]);
                    files.push({
                        path: foundFiles[0].fsPath,
                        content: Buffer.from(content).toString('utf8')
                    });
                }
            } catch (error) {
                // File not found or not readable
            }
        }
        
        return files;
    }

    private async getMainSourceFiles(): Promise<Array<{ path: string; content: string }>> {
        const patterns = ['**/src/**/*.{ts,js,tsx,jsx,py,java,cs}', '**/*.{ts,js,tsx,jsx,py,java,cs}'];
        const files: Array<{ path: string; content: string }> = [];
        
        for (const pattern of patterns) {
            try {
                const foundFiles = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 15);
                
                for (const file of foundFiles.slice(0, 10)) { // Limit to avoid overwhelming AI
                    try {
                        const content = await vscode.workspace.fs.readFile(file);
                        const text = Buffer.from(content).toString('utf8');
                        
                        // Skip very large files or test files
                        if (text.length < 10000 && !file.fsPath.includes('.test.') && !file.fsPath.includes('.spec.')) {
                            files.push({
                                path: file.fsPath,
                                content: text
                            });
                        }
                    } catch (error) {
                        // Skip unreadable files
                    }
                }
                
                if (files.length >= 8) {
                    break; // Enough files for analysis
                }
            } catch (error) {
                // Pattern not found
            }
        }
        
        return files;
    }

    private async buildDirectoryMap(): Promise<any> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return {};
        }

        const rootUri = workspaceFolders[0].uri;
        return await this.buildDirectoryTree(rootUri, 3); // Max depth 3
    }

    private async buildDirectoryTree(uri: vscode.Uri, maxDepth: number, currentDepth = 0): Promise<any> {
        if (currentDepth >= maxDepth) {
            return {};
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            const tree: any = {};

            for (const [name, type] of entries) {
                // Skip common directories we don't need
                if (['node_modules', '.git', 'dist', 'build', 'out'].includes(name)) {
                    continue;
                }

                if (type === vscode.FileType.Directory) {
                    const childUri = vscode.Uri.joinPath(uri, name);
                    tree[name] = await this.buildDirectoryTree(childUri, maxDepth, currentDepth + 1);
                } else {
                    tree[name] = 'file';
                }
            }

            return tree;
        } catch (error) {
            return {};
        }
    }

    private extractJSON(text: string): string {
        // Try to find JSON in the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return jsonMatch[0];
        }
        
        // Try to find JSON array
        const arrayMatch = text.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            return arrayMatch[0];
        }
        
        throw new Error('No JSON found in response');
    }
}
