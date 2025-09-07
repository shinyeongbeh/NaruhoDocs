import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatSession } from '../langchain-backend/llm';
import { LLMProviderManager } from '../llm-providers/manager';

export interface DocumentNode {
    name: string;
    path: string;
    type: 'markdown' | 'text' | 'config' | 'other';
    size: number;
    lastModified: Date;
    links: DocumentLink[];
    backlinks: DocumentLink[];
    importance?: 'critical' | 'high' | 'medium' | 'low';
    category?: string;
    hasReadme?: boolean;
}

export interface DocumentLink {
    from: string;
    to: string;
    type: 'reference' | 'include' | 'hyperlink' | 'image';
    isBroken: boolean;
    lineNumber?: number;
}

export interface DocumentRelationsAnalysis {
    documents: DocumentNode[];
    links: DocumentLink[];
    clusters: DocumentCluster[];
    insights: {
        documentationHealth: string;
        orphanedDocuments: string[];
        brokenLinks: DocumentLink[];
        missingDocumentation: string[];
        improvementSuggestions: string[];
    };
    mermaidDiagram: string;
}

export interface DocumentCluster {
    name: string;
    documents: string[];
    purpose: string;
    completeness: number;
}

export class DocumentRelationsAnalyzer {
    private llmSession?: ChatSession;
    private analysisContext: Map<string, any> = new Map();
    
    constructor(private llmManager: LLMProviderManager) {}

    public async analyzeDocumentRelations(): Promise<DocumentRelationsAnalysis | null> {
        try {
            // Initialize AI session for document analysis
            await this.initializeAISession();
            
            // Get workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                throw new Error('No workspace folder found');
            }

            const rootPath = workspaceFolders[0].uri.fsPath;

            // Phase 1: Discover all documentation files
            const documents = await this.discoverDocuments(rootPath);
            
            // Phase 2: Analyze links and relationships
            const links = await this.analyzeDocumentLinks(documents);
            
            // Phase 3: AI-powered clustering and insights
            const { clusters, insights } = await this.generateClusteringAndInsights(documents, links);
            
            // Phase 4: Generate intelligent Mermaid diagram
            const mermaidDiagram = await this.generateIntelligentMermaidDiagram(documents, links, clusters);

            return {
                documents,
                links,
                clusters,
                insights,
                mermaidDiagram
            };
        } catch (error) {
            console.error('Error in AI document relations analysis:', error);
            return null;
        }
    }

    private async initializeAISession(): Promise<void> {
        const systemMessage = `You are an expert technical documentation analyst and information architect. You analyze documentation relationships to understand information flow, identify gaps, and suggest improvements. Focus on:

1. **Documentation Structure**: Understand how documents relate to each other
2. **Information Flow**: Track how information flows between documents
3. **Coverage Analysis**: Identify gaps in documentation coverage
4. **User Journey**: Understand how users navigate through documentation
5. **Quality Assessment**: Evaluate documentation completeness and usefulness

Provide actionable insights about documentation organization and quality.`;

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

    private async discoverDocuments(rootPath: string): Promise<DocumentNode[]> {
        const documents: DocumentNode[] = [];
        
        try {
            await this.scanForDocuments(rootPath, documents, 0, 5); // Max depth 5
        } catch (error) {
            console.error('Error discovering documents:', error);
        }

        return documents;
    }

    private async scanForDocuments(dirPath: string, documents: DocumentNode[], currentDepth: number, maxDepth: number): Promise<void> {
        if (currentDepth >= maxDepth) {
            return;
        }

        try {
            const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
            
            for (const item of items) {
                // Skip hidden files and common build directories
                if (item.name.startsWith('.') || 
                    ['node_modules', 'dist', 'build', 'coverage', '__pycache__'].includes(item.name)) {
                    continue;
                }

                const itemPath = path.join(dirPath, item.name);
                
                if (item.isDirectory()) {
                    await this.scanForDocuments(itemPath, documents, currentDepth + 1, maxDepth);
                } else if (this.isDocumentFile(item.name)) {
                    try {
                        const stats = await fs.promises.stat(itemPath);
                        const document: DocumentNode = {
                            name: item.name,
                            path: itemPath,
                            type: this.getDocumentType(item.name),
                            size: stats.size,
                            lastModified: stats.mtime,
                            links: [],
                            backlinks: []
                        };
                        
                        documents.push(document);
                    } catch (error) {
                        console.error(`Error processing document ${itemPath}:`, error);
                    }
                }
            }
        } catch (error) {
            console.error(`Error scanning directory ${dirPath}:`, error);
        }
    }

    private isDocumentFile(filename: string): boolean {
        const docExtensions = ['.md', '.txt', '.rst', '.adoc', '.mdx'];
        const configExtensions = ['.json', '.yaml', '.yml', '.toml'];
        const extension = path.extname(filename).toLowerCase();
        
        return docExtensions.includes(extension) || 
               configExtensions.includes(extension) ||
               ['README', 'CHANGELOG', 'LICENSE', 'CONTRIBUTING'].some(name => 
                   filename.toUpperCase().includes(name));
    }

    private getDocumentType(filename: string): DocumentNode['type'] {
        const extension = path.extname(filename).toLowerCase();
        
        if (['.md', '.mdx', '.rst', '.adoc'].includes(extension)) {
            return 'markdown';
        } else if (['.json', '.yaml', '.yml', '.toml'].includes(extension)) {
            return 'config';
        } else if (['.txt'].includes(extension)) {
            return 'text';
        } else {
            return 'other';
        }
    }

    private async analyzeDocumentLinks(documents: DocumentNode[]): Promise<DocumentLink[]> {
        const allLinks: DocumentLink[] = [];
        
        for (const doc of documents) {
            try {
                const content = await fs.promises.readFile(doc.path, 'utf-8');
                const links = this.extractLinksFromContent(content, doc.path);
                
                doc.links = links;
                allLinks.push(...links);
                
                // Add backlinks
                for (const link of links) {
                    const targetDoc = documents.find(d => 
                        d.path === link.to || 
                        d.name === path.basename(link.to) ||
                        d.path.endsWith(link.to)
                    );
                    
                    if (targetDoc) {
                        targetDoc.backlinks.push(link);
                    }
                }
            } catch (error) {
                console.error(`Error reading document ${doc.path}:`, error);
            }
        }

        return allLinks;
    }

    private extractLinksFromContent(content: string, filePath: string): DocumentLink[] {
        const links: DocumentLink[] = [];
        const lines = content.split('\n');
        
        lines.forEach((line, index) => {
            // Markdown links: [text](url)
            const markdownLinks = line.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g);
            for (const match of markdownLinks) {
                links.push({
                    from: filePath,
                    to: match[2],
                    type: 'hyperlink',
                    isBroken: false, // Will be checked later
                    lineNumber: index + 1
                });
            }
            
            // Reference links: [text]: url
            const refLinks = line.matchAll(/\[([^\]]+)\]:\s*(.+)/g);
            for (const match of refLinks) {
                links.push({
                    from: filePath,
                    to: match[2],
                    type: 'reference',
                    isBroken: false,
                    lineNumber: index + 1
                });
            }
            
            // Image links: ![alt](url)
            const imageLinks = line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g);
            for (const match of imageLinks) {
                links.push({
                    from: filePath,
                    to: match[2],
                    type: 'image',
                    isBroken: false,
                    lineNumber: index + 1
                });
            }
        });
        
        return links;
    }

    private async generateClusteringAndInsights(
        documents: DocumentNode[], 
        links: DocumentLink[]
    ): Promise<{ clusters: DocumentCluster[]; insights: DocumentRelationsAnalysis['insights'] }> {
        
        if (!this.llmSession) {
            return this.getFallbackClustersAndInsights(documents, links);
        }

        try {
            const documentsSummary = documents.map(doc => ({
                name: doc.name,
                type: doc.type,
                size: doc.size,
                linkCount: doc.links.length,
                backlinkCount: doc.backlinks.length
            }));

            const linksSummary = links.map(link => ({
                from: path.basename(link.from),
                to: path.basename(link.to),
                type: link.type
            }));

            const prompt = `Analyze this documentation structure:

Documents (${documents.length} total):
${documentsSummary.map(doc => `- ${doc.name} (${doc.type}, ${doc.linkCount} links, ${doc.backlinkCount} backlinks)`).join('\n')}

Links (${links.length} total):
${linksSummary.slice(0, 20).map(link => `- ${link.from} → ${link.to} (${link.type})`).join('\n')}
${links.length > 20 ? `... and ${links.length - 20} more links` : ''}

Provide analysis in JSON format:
{
  "clusters": [
    {
      "name": "cluster name",
      "documents": ["doc1.md", "doc2.md"],
      "purpose": "purpose description",
      "completeness": 85
    }
  ],
  "insights": {
    "documentationHealth": "overall assessment",
    "orphanedDocuments": ["isolated docs"],
    "missingDocumentation": ["suggested missing docs"],
    "improvementSuggestions": ["specific improvements"]
  }
}

Focus on practical insights about documentation organization.`;

            const response = await this.llmSession.chat(prompt);
            
            try {
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const analysis = JSON.parse(jsonMatch[0]);
                    
                    return {
                        clusters: Array.isArray(analysis.clusters) ? analysis.clusters : [],
                        insights: {
                            documentationHealth: analysis.insights?.documentationHealth || 'Unable to assess',
                            orphanedDocuments: Array.isArray(analysis.insights?.orphanedDocuments) ? analysis.insights.orphanedDocuments : [],
                            brokenLinks: links.filter(link => link.isBroken),
                            missingDocumentation: Array.isArray(analysis.insights?.missingDocumentation) ? analysis.insights.missingDocumentation : [],
                            improvementSuggestions: Array.isArray(analysis.insights?.improvementSuggestions) ? analysis.insights.improvementSuggestions : []
                        }
                    };
                }
            } catch (parseError) {
                console.error('Error parsing AI clustering response:', parseError);
            }
        } catch (error) {
            console.error('Error in AI clustering analysis:', error);
        }

        return this.getFallbackClustersAndInsights(documents, links);
    }

    private getFallbackClustersAndInsights(
        documents: DocumentNode[], 
        links: DocumentLink[]
    ): { clusters: DocumentCluster[]; insights: DocumentRelationsAnalysis['insights'] } {
        
        const clusters: DocumentCluster[] = [
            {
                name: 'Core Documentation',
                documents: documents.filter(doc => 
                    doc.name.toLowerCase().includes('readme') || 
                    doc.name.toLowerCase().includes('getting')
                ).map(doc => doc.name),
                purpose: 'Main project documentation and getting started guides',
                completeness: 70
            },
            {
                name: 'Technical Documentation',
                documents: documents.filter(doc => 
                    doc.name.toLowerCase().includes('api') || 
                    doc.name.toLowerCase().includes('spec')
                ).map(doc => doc.name),
                purpose: 'Technical specifications and API documentation',
                completeness: 60
            }
        ];

        const orphanedDocuments = documents
            .filter(doc => doc.links.length === 0 && doc.backlinks.length === 0)
            .map(doc => doc.name);

        return {
            clusters,
            insights: {
                documentationHealth: `${documents.length} documents found with ${links.length} connections`,
                orphanedDocuments,
                brokenLinks: links.filter(link => link.isBroken),
                missingDocumentation: ['API documentation', 'Contributing guidelines', 'Troubleshooting guide'],
                improvementSuggestions: ['Add more cross-references', 'Create index document', 'Organize by topic']
            }
        };
    }

    private async generateIntelligentMermaidDiagram(
        documents: DocumentNode[], 
        links: DocumentLink[], 
        clusters: DocumentCluster[]
    ): Promise<string> {
        
        if (!this.llmSession) {
            return this.generateBasicMermaidDiagram(documents, links);
        }

        try {
            const documentsSummary = documents.slice(0, 15).map(doc => doc.name).join(', ');
            const clustersSummary = clusters.map(cluster => 
                `${cluster.name}: ${cluster.documents.join(', ')}`
            ).join('; ');

            const prompt = `Create a Mermaid flowchart showing document relationships:

Documents: ${documentsSummary}
Clusters: ${clustersSummary}
Total Links: ${links.length}

Create a diagram that:
1. Shows main documents and their connections
2. Groups documents by clusters/topics
3. Uses appropriate icons and colors
4. Highlights important documents (README, API docs, etc.)
5. Keeps it readable (max 15 nodes)

Return only the Mermaid code starting with "graph TD" or "graph LR".`;

            const response = await this.llmSession.chat(prompt);
            
            const mermaidMatch = response.match(/graph\s+(TD|LR|TB|RL)[\s\S]*?(?=\n\n|\n$|$)/i);
            if (mermaidMatch) {
                return mermaidMatch[0].trim();
            }
        } catch (error) {
            console.error('Error generating AI Mermaid diagram for documents:', error);
        }

        return this.generateBasicMermaidDiagram(documents, links);
    }

    private generateBasicMermaidDiagram(documents: DocumentNode[], links: DocumentLink[]): string {
        let diagram = 'graph TD\n';
        
        // Add important documents
        const importantDocs = documents
            .filter(doc => 
                doc.name.toLowerCase().includes('readme') ||
                doc.name.toLowerCase().includes('api') ||
                doc.name.toLowerCase().includes('getting') ||
                doc.links.length > 0 ||
                doc.backlinks.length > 0
            )
            .slice(0, 10);

        const nodeMap = new Map<string, string>();
        let nodeCounter = 0;

        // Create nodes
        for (const doc of importantDocs) {
            const nodeId = `N${nodeCounter++}`;
            const icon = this.getDocumentIcon(doc);
            nodeMap.set(doc.path, nodeId);
            diagram += `    ${nodeId}["${icon} ${doc.name}"]\n`;
        }

        // Create connections
        for (const link of links) {
            const fromId = nodeMap.get(link.from);
            const toDoc = documents.find(doc => 
                doc.path === link.to || 
                doc.name === path.basename(link.to)
            );
            const toId = toDoc ? nodeMap.get(toDoc.path) : null;
            
            if (fromId && toId && fromId !== toId) {
                diagram += `    ${fromId} --> ${toId}\n`;
            }
        }

        // Add styling
        diagram += `
    classDef readme fill:#4caf50,stroke:#388e3c,color:#fff
    classDef api fill:#2196f3,stroke:#1976d2,color:#fff
    classDef config fill:#ff9800,stroke:#f57c00,color:#fff
    classDef other fill:#9e9e9e,stroke:#616161,color:#fff`;

        return diagram;
    }

    private getDocumentIcon(doc: DocumentNode): string {
        if (doc.name.toLowerCase().includes('readme')) {
            return '📋';
        }
        if (doc.name.toLowerCase().includes('api')) {
            return '📖';
        }
        if (doc.name.toLowerCase().includes('config')) {
            return '⚙️';
        }
        if (doc.name.toLowerCase().includes('license')) {
            return '📄';
        }
        if (doc.name.toLowerCase().includes('changelog')) {
            return '📝';
        }
        if (doc.type === 'markdown') {
            return '📝';
        }
        if (doc.type === 'config') {
            return '⚙️';
        }
        return '📄';
    }
}
