import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatSession } from '../langchain-backend/llm';
import { LLMProviderManager } from '../llm-providers/manager';

export interface FolderNode {
    name: string;
    path: string;
    type: 'file' | 'folder';
    size?: number;
    extension?: string;
    children?: FolderNode[];
    purpose?: string;
    importance?: 'high' | 'medium' | 'low';
    documentationCoverage?: number;
}

export interface FolderStructureAnalysis {
    rootName: string;
    structure: FolderNode;
    insights: {
        organizationPattern: string;
        conventionsUsed: string[];
        suggestedImprovements: string[];
        documentationGaps: string[];
    };
    mermaidDiagram: string;
}

export class FolderStructureAnalyzer {
    private llmSession?: ChatSession;
    private analysisContext: Map<string, any> = new Map();
    
    constructor(private llmManager: LLMProviderManager) {}

    public async analyzeFolderStructure(): Promise<FolderStructureAnalysis | null> {
        try {
            // Initialize AI session for folder analysis
            await this.initializeAISession();
            
            // Get workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder found');
            }

            const rootPath = workspaceFolders[0].uri.fsPath;
            const rootName = workspaceFolders[0].name;

            // Phase 1: Scan folder structure
            const structure = await this.scanFolderStructure(rootPath, rootName);
            
            // Phase 2: AI Analysis of organization patterns
            const insights = await this.analyzeOrganizationPatterns(structure);
            
            // Phase 3: Generate intelligent Mermaid diagram
            const mermaidDiagram = await this.generateIntelligentMermaidDiagram(structure, insights);

            return {
                rootName,
                structure,
                insights,
                mermaidDiagram
            };
        } catch (error) {
            console.error('Error in AI folder structure analysis:', error);
            return null;
        }
    }

    private async initializeAISession(): Promise<void> {
        const systemMessage = `You are an expert software architect and project organization specialist. You analyze folder structures to understand project organization patterns, identify best practices, and suggest improvements. Focus on:

1. **Organization Patterns**: Identify architectural patterns (MVC, layered, feature-based, etc.)
2. **Naming Conventions**: Analyze folder and file naming patterns
3. **Structure Logic**: Understand the reasoning behind the organization
4. **Documentation Gaps**: Identify missing documentation or README files
5. **Improvement Suggestions**: Suggest better organization if needed

Provide concise, actionable insights about project structure and organization.`;

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
            maxHistoryMessages: 30,
            temperature: 0.1 
        });
    }

    private async scanFolderStructure(rootPath: string, rootName: string): Promise<FolderNode> {
        const rootNode: FolderNode = {
            name: rootName,
            path: rootPath,
            type: 'folder',
            children: []
        };

        try {
            await this.scanDirectory(rootPath, rootNode, 0, 4); // Max depth 4
        } catch (error) {
            console.error('Error scanning directory:', error);
        }

        return rootNode;
    }

    private async scanDirectory(dirPath: string, parentNode: FolderNode, currentDepth: number, maxDepth: number): Promise<void> {
        if (currentDepth >= maxDepth) {
            return;
        }

        try {
            const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
            
            // Filter out common unnecessary folders
            const filteredItems = items.filter(item => 
                !item.name.startsWith('.') && 
                !['node_modules', 'dist', 'build', 'coverage', '__pycache__'].includes(item.name)
            );

            for (const item of filteredItems) {
                const itemPath = path.join(dirPath, item.name);
                
                if (item.isDirectory()) {
                    const folderNode: FolderNode = {
                        name: item.name,
                        path: itemPath,
                        type: 'folder',
                        children: []
                    };
                    
                    parentNode.children!.push(folderNode);
                    await this.scanDirectory(itemPath, folderNode, currentDepth + 1, maxDepth);
                } else {
                    const extension = path.extname(item.name);
                    let size = 0;
                    
                    try {
                        const stats = await fs.promises.stat(itemPath);
                        size = stats.size;
                    } catch (error) {
                        // Ignore stat errors
                    }

                    const fileNode: FolderNode = {
                        name: item.name,
                        path: itemPath,
                        type: 'file',
                        size,
                        extension
                    };
                    
                    parentNode.children!.push(fileNode);
                }
            }
        } catch (error) {
            console.error(`Error reading directory ${dirPath}:`, error);
        }
    }

    private async analyzeOrganizationPatterns(structure: FolderNode): Promise<FolderStructureAnalysis['insights']> {
        if (!this.llmSession) {
            return this.getFallbackInsights();
        }

        try {
            // Create a simplified structure representation for AI analysis
            const structureDescription = this.createStructureDescription(structure);
            
            const prompt = `Analyze this project folder structure:

${structureDescription}

Please analyze and provide insights in JSON format:
{
  "organizationPattern": "Brief description of the main organizational pattern (e.g., 'MVC architecture', 'Feature-based organization', 'Layered architecture')",
  "conventionsUsed": ["List of naming/organization conventions observed"],
  "suggestedImprovements": ["List of specific suggestions for better organization"],
  "documentationGaps": ["List of missing documentation or README files"]
}

Focus on practical insights about project organization and structure.`;

            const response = await this.llmSession.chat(prompt);
            
            try {
                // Extract JSON from response
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const insights = JSON.parse(jsonMatch[0]);
                    return {
                        organizationPattern: insights.organizationPattern || 'Standard project structure',
                        conventionsUsed: Array.isArray(insights.conventionsUsed) ? insights.conventionsUsed : [],
                        suggestedImprovements: Array.isArray(insights.suggestedImprovements) ? insights.suggestedImprovements : [],
                        documentationGaps: Array.isArray(insights.documentationGaps) ? insights.documentationGaps : []
                    };
                }
            } catch (parseError) {
                console.error('Error parsing AI response:', parseError);
            }
        } catch (error) {
            console.error('Error in AI analysis of organization patterns:', error);
        }

        return this.getFallbackInsights();
    }

    private createStructureDescription(node: FolderNode, indent: string = ''): string {
        let description = `${indent}${node.type === 'folder' ? '📁' : '📄'} ${node.name}\n`;
        
        if (node.children && node.children.length > 0) {
            // Limit to important items to avoid overwhelming the AI
            const importantChildren = node.children
                .filter(child => this.isImportantItem(child))
                .slice(0, 10); // Limit items per folder
            
            for (const child of importantChildren) {
                description += this.createStructureDescription(child, indent + '  ');
            }
            
            if (node.children.length > importantChildren.length) {
                description += `${indent}  ... and ${node.children.length - importantChildren.length} more items\n`;
            }
        }
        
        return description;
    }

    private isImportantItem(node: FolderNode): boolean {
        if (node.type === 'folder') {
            return true; // All folders are important for structure
        }
        
        // Important file types
        const importantExtensions = ['.md', '.json', '.yaml', '.yml', '.js', '.ts', '.py', '.java', '.cpp', '.cs'];
        const importantNames = ['README', 'LICENSE', 'CHANGELOG', 'package.json', 'tsconfig.json'];
        
        return importantExtensions.includes(node.extension || '') || 
               importantNames.some(name => node.name.toLowerCase().includes(name.toLowerCase()));
    }

    private getFallbackInsights(): FolderStructureAnalysis['insights'] {
        return {
            organizationPattern: 'Standard project structure',
            conventionsUsed: ['Folder-based organization', 'Descriptive naming'],
            suggestedImprovements: ['Consider adding more documentation', 'Organize by feature or layer'],
            documentationGaps: ['README files in subdirectories', 'API documentation']
        };
    }

    private async generateIntelligentMermaidDiagram(structure: FolderNode, insights: FolderStructureAnalysis['insights']): Promise<string> {
        if (!this.llmSession) {
            return this.generateBasicMermaidDiagram(structure);
        }

        try {
            const prompt = `Based on this folder structure analysis, create a Mermaid diagram that shows the project organization:

Structure: ${this.createStructureDescription(structure)}
Organization Pattern: ${insights.organizationPattern}
Conventions: ${insights.conventionsUsed.join(', ')}

Create a Mermaid flowchart that:
1. Shows the main folders and their relationships
2. Uses appropriate icons and colors
3. Highlights important files and folders
4. Groups related components
5. Keeps it clean and readable (max 20 nodes)

Return only the Mermaid code starting with "graph TD" or "graph LR".`;

            const response = await this.llmSession.chat(prompt);
            
            // Extract mermaid code from response
            const mermaidMatch = response.match(/graph\s+(TD|LR|TB|RL)[\s\S]*?(?=\n\n|\n$|$)/i);
            if (mermaidMatch) {
                return mermaidMatch[0].trim();
            }
        } catch (error) {
            console.error('Error generating AI Mermaid diagram:', error);
        }

        return this.generateBasicMermaidDiagram(structure);
    }

    private generateBasicMermaidDiagram(structure: FolderNode): string {
        let diagram = 'graph TD\n';
        let nodeCounter = 0;
        const nodeMap = new Map<string, string>();

        const addNode = (node: FolderNode, parentId?: string): string => {
            const nodeId = `N${nodeCounter++}`;
            const icon = node.type === 'folder' ? '📁' : '📄';
            nodeMap.set(node.path, nodeId);
            
            diagram += `    ${nodeId}["${icon} ${node.name}"]\n`;
            
            if (parentId) {
                diagram += `    ${parentId} --> ${nodeId}\n`;
            }
            
            return nodeId;
        };

        // Add root and important children
        const rootId = addNode(structure);
        
        if (structure.children) {
            const importantChildren = structure.children
                .filter(child => this.isImportantItem(child))
                .slice(0, 8); // Limit for readability
            
            for (const child of importantChildren) {
                const childId = addNode(child, rootId);
                
                if (child.children && child.type === 'folder') {
                    const importantGrandchildren = child.children
                        .filter(grandchild => this.isImportantItem(grandchild))
                        .slice(0, 3);
                    
                    for (const grandchild of importantGrandchildren) {
                        addNode(grandchild, childId);
                    }
                }
            }
        }

        // Add styling
        diagram += `
    classDef folderStyle fill:#42a5f5,stroke:#1976d2,color:#fff
    classDef fileStyle fill:#66bb6a,stroke:#388e3c,color:#fff
    classDef configStyle fill:#ff9800,stroke:#f57c00,color:#fff`;

        return diagram;
    }
}
