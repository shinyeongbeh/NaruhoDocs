import * as vscode from 'vscode';
import * as path from 'path';

export interface DocumentLink {
    source: string;
    target: string;
    type: 'reference' | 'include' | 'image' | 'link';
    lineNumber?: number;
}

export interface DocumentNode {
    id: string;
    title: string;
    path: string;
    type: 'markdown' | 'text' | 'readme' | 'documentation';
    size: number;
    lastModified: Date;
    outgoingLinks: DocumentLink[];
    incomingLinks: DocumentLink[];
}

export interface DocumentRelationshipAnalysis {
    nodes: DocumentNode[];
    links: DocumentLink[];
    clusters: DocumentCluster[];
    orphanedDocuments: string[];
    brokenLinks: DocumentLink[];
    recommendedConnections: DocumentLink[];
}

export interface DocumentCluster {
    id: string;
    name: string;
    documents: string[];
    type: 'feature' | 'topic' | 'component' | 'guide';
}

export class DocumentAnalyzer {
    private workspaceRoot: string = '';

    constructor() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            this.workspaceRoot = workspaceFolders[0].uri.fsPath;
        }
    }

    public async analyzeDocumentRelationships(): Promise<DocumentRelationshipAnalysis> {
        try {
            // Find all documentation files
            const documentFiles = await this.findDocumentationFiles();
            
            // Analyze each document for links and references
            const nodes = await this.analyzeDocuments(documentFiles);
            
            // Extract all links
            const links = this.extractAllLinks(nodes);
            
            // Identify broken links
            const brokenLinks = this.identifyBrokenLinks(links, nodes);
            
            // Cluster related documents
            const clusters = this.clusterDocuments(nodes);
            
            // Find orphaned documents
            const orphanedDocuments = this.findOrphanedDocuments(nodes);
            
            // Suggest new connections
            const recommendedConnections = this.suggestConnections(nodes);

            return {
                nodes,
                links,
                clusters,
                orphanedDocuments,
                brokenLinks,
                recommendedConnections
            };
        } catch (error) {
            console.error('Error analyzing document relationships:', error);
            throw error;
        }
    }

    private async findDocumentationFiles(): Promise<vscode.Uri[]> {
        const patterns = [
            '**/*.md',
            '**/*.txt',
            '**/README*',
            '**/CHANGELOG*',
            '**/CONTRIBUTING*',
            '**/LICENSE*',
            '**/INSTALLATION*',
            '**/GUIDE*'
        ];

        const files: vscode.Uri[] = [];
        for (const pattern of patterns) {
            const found = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
            files.push(...found);
        }

        // Remove duplicates
        const uniqueFiles = files.filter((file, index, self) =>
            index === self.findIndex(f => f.fsPath === file.fsPath)
        );

        return uniqueFiles;
    }

    private async analyzeDocuments(files: vscode.Uri[]): Promise<DocumentNode[]> {
        const nodes: DocumentNode[] = [];

        for (const file of files) {
            try {
                const content = await vscode.workspace.fs.readFile(file);
                const text = Buffer.from(content).toString('utf8');
                const stats = await vscode.workspace.fs.stat(file);

                const node: DocumentNode = {
                    id: this.getRelativePath(file.fsPath),
                    title: this.extractTitle(text, file.fsPath),
                    path: file.fsPath,
                    type: this.determineDocumentType(file.fsPath, text),
                    size: stats.size,
                    lastModified: new Date(stats.mtime),
                    outgoingLinks: this.extractLinks(text, file.fsPath),
                    incomingLinks: []
                };

                nodes.push(node);
            } catch (error) {
                console.error(`Error analyzing document ${file.fsPath}:`, error);
            }
        }

        // Calculate incoming links
        this.calculateIncomingLinks(nodes);

        return nodes;
    }

    private extractTitle(content: string, filePath: string): string {
        // Try to extract title from markdown heading
        const h1Match = content.match(/^#\s+(.+)$/m);
        if (h1Match) {
            return h1Match[1].trim();
        }

        // Try to extract from HTML title tag
        const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) {
            return titleMatch[1].trim();
        }

        // Fallback to filename
        return path.basename(filePath, path.extname(filePath));
    }

    private determineDocumentType(filePath: string, content: string): DocumentNode['type'] {
        const fileName = path.basename(filePath).toLowerCase();
        
        if (fileName.includes('readme')) {
            return 'readme';
        }
        
        if (fileName.endsWith('.md')) {
            return 'markdown';
        }
        
        if (fileName.endsWith('.txt')) {
            return 'text';
        }
        
        // Check content for documentation patterns
        if (content.includes('# API') || content.includes('## API') || 
            content.includes('documentation') || content.includes('guide')) {
            return 'documentation';
        }
        
        return 'markdown';
    }

    private extractLinks(content: string, sourcePath: string): DocumentLink[] {
        const links: DocumentLink[] = [];
        
        // Markdown links: [text](url)
        const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
        let match;
        while ((match = markdownLinkRegex.exec(content)) !== null) {
            const url = match[2];
            if (this.isLocalLink(url)) {
                const lineNumber = this.getLineNumber(content, match.index!);
                links.push({
                    source: this.getRelativePath(sourcePath),
                    target: this.resolveRelativePath(url, sourcePath),
                    type: this.getLinkType(url),
                    lineNumber
                });
            }
        }

        // Wiki-style links: [[page]]
        const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
        while ((match = wikiLinkRegex.exec(content)) !== null) {
            const target = match[1];
            const lineNumber = this.getLineNumber(content, match.index!);
            links.push({
                source: this.getRelativePath(sourcePath),
                target: target + '.md', // Assume .md extension
                type: 'reference',
                lineNumber
            });
        }

        // Image references: ![alt](path)
        const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        while ((match = imageRegex.exec(content)) !== null) {
            const url = match[2];
            if (this.isLocalLink(url)) {
                const lineNumber = this.getLineNumber(content, match.index!);
                links.push({
                    source: this.getRelativePath(sourcePath),
                    target: this.resolveRelativePath(url, sourcePath),
                    type: 'image',
                    lineNumber
                });
            }
        }

        return links;
    }

    private isLocalLink(url: string): boolean {
        return !url.startsWith('http://') && 
               !url.startsWith('https://') && 
               !url.startsWith('mailto:') &&
               !url.startsWith('#'); // Skip anchor links
    }

    private getLinkType(url: string): DocumentLink['type'] {
        if (url.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
            return 'image';
        }
        if (url.match(/\.(md|txt)$/i)) {
            return 'reference';
        }
        return 'link';
    }

    private resolveRelativePath(relativePath: string, sourcePath: string): string {
        const sourceDir = path.dirname(sourcePath);
        const resolved = path.resolve(sourceDir, relativePath);
        return this.getRelativePath(resolved);
    }

    private getRelativePath(absolutePath: string): string {
        return path.relative(this.workspaceRoot, absolutePath).replace(/\\/g, '/');
    }

    private getLineNumber(content: string, index: number): number {
        return content.substring(0, index).split('\n').length;
    }

    private calculateIncomingLinks(nodes: DocumentNode[]): void {
        // Clear existing incoming links
        nodes.forEach(node => node.incomingLinks = []);

        // Calculate incoming links based on outgoing links
        nodes.forEach(sourceNode => {
            sourceNode.outgoingLinks.forEach(link => {
                const targetNode = nodes.find(n => n.id === link.target);
                if (targetNode) {
                    targetNode.incomingLinks.push(link);
                }
            });
        });
    }

    private extractAllLinks(nodes: DocumentNode[]): DocumentLink[] {
        const allLinks: DocumentLink[] = [];
        nodes.forEach(node => {
            allLinks.push(...node.outgoingLinks);
        });
        return allLinks;
    }

    private identifyBrokenLinks(links: DocumentLink[], nodes: DocumentNode[]): DocumentLink[] {
        const existingFiles = new Set(nodes.map(n => n.id));
        return links.filter(link => !existingFiles.has(link.target));
    }

    private clusterDocuments(nodes: DocumentNode[]): DocumentCluster[] {
        const clusters: DocumentCluster[] = [];
        
        // Cluster by directory structure
        const directoryGroups = new Map<string, string[]>();
        
        nodes.forEach(node => {
            const dir = path.dirname(node.id);
            if (!directoryGroups.has(dir)) {
                directoryGroups.set(dir, []);
            }
            directoryGroups.get(dir)!.push(node.id);
        });

        // Convert directory groups to clusters
        directoryGroups.forEach((documents, dir) => {
            if (documents.length > 1) { // Only create clusters with multiple documents
                clusters.push({
                    id: dir || 'root',
                    name: dir === '.' ? 'Root Documentation' : path.basename(dir),
                    documents,
                    type: this.determineClusterType(dir, documents)
                });
            }
        });

        // Cluster by topic similarity (simple keyword-based)
        const topicClusters = this.clusterByTopics(nodes);
        clusters.push(...topicClusters);

        return clusters;
    }

    private determineClusterType(dir: string, documents: string[]): DocumentCluster['type'] {
        const dirName = dir.toLowerCase();
        
        if (dirName.includes('guide') || dirName.includes('tutorial')) {
            return 'guide';
        }
        if (dirName.includes('component') || dirName.includes('src')) {
            return 'component';
        }
        if (dirName.includes('feature')) {
            return 'feature';
        }
        
        return 'topic';
    }

    private clusterByTopics(nodes: DocumentNode[]): DocumentCluster[] {
        const topicClusters: DocumentCluster[] = [];
        
        // Simple topic detection based on common keywords
        const topics = ['api', 'install', 'config', 'test', 'deploy', 'develop'];
        
        topics.forEach(topic => {
            const relatedDocs = nodes.filter(node => 
                node.title.toLowerCase().includes(topic) ||
                node.id.toLowerCase().includes(topic)
            ).map(node => node.id);
            
            if (relatedDocs.length > 1) {
                topicClusters.push({
                    id: `topic-${topic}`,
                    name: `${topic.charAt(0).toUpperCase() + topic.slice(1)} Documentation`,
                    documents: relatedDocs,
                    type: 'topic'
                });
            }
        });
        
        return topicClusters;
    }

    private findOrphanedDocuments(nodes: DocumentNode[]): string[] {
        return nodes
            .filter(node => 
                node.incomingLinks.length === 0 && 
                node.outgoingLinks.length === 0 &&
                !node.id.toLowerCase().includes('readme')
            )
            .map(node => node.id);
    }

    private suggestConnections(nodes: DocumentNode[]): DocumentLink[] {
        const suggestions: DocumentLink[] = [];
        
        // Suggest connections between documents with similar topics
        nodes.forEach(sourceNode => {
            nodes.forEach(targetNode => {
                if (sourceNode.id !== targetNode.id) {
                    const similarity = this.calculateTopicSimilarity(sourceNode, targetNode);
                    if (similarity > 0.3 && !this.hasConnection(sourceNode, targetNode)) {
                        suggestions.push({
                            source: sourceNode.id,
                            target: targetNode.id,
                            type: 'reference'
                        });
                    }
                }
            });
        });
        
        return suggestions.slice(0, 10); // Limit to top 10 suggestions
    }

    private calculateTopicSimilarity(node1: DocumentNode, node2: DocumentNode): number {
        const words1 = this.extractKeywords(node1.title + ' ' + node1.id);
        const words2 = this.extractKeywords(node2.title + ' ' + node2.id);
        
        const intersection = words1.filter(word => words2.includes(word));
        const union = [...new Set([...words1, ...words2])];
        
        return intersection.length / union.length;
    }

    private extractKeywords(text: string): string[] {
        return text.toLowerCase()
            .replace(/[^a-z\s]/g, '')
            .split(/\s+/)
            .filter(word => word.length > 2)
            .filter(word => !['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'may', 'she', 'use', 'her', 'many', 'oil', 'sit', 'word'].includes(word));
    }

    private hasConnection(node1: DocumentNode, node2: DocumentNode): boolean {
        return node1.outgoingLinks.some(link => link.target === node2.id) ||
               node2.outgoingLinks.some(link => link.target === node1.id);
    }

    public generateMermaidRelationshipDiagram(analysis: DocumentRelationshipAnalysis): string {
        const lines: string[] = ['graph TD'];
        
        // Add nodes
        analysis.nodes.forEach(node => {
            const nodeId = this.sanitizeId(node.id);
            const icon = this.getNodeIcon(node.type);
            const label = `${icon} ${node.title}`;
            lines.push(`    ${nodeId}["${label}"]`);
            
            // Style nodes based on type
            lines.push(`    class ${nodeId} ${node.type}`);
        });
        
        // Add links
        analysis.links.forEach(link => {
            const sourceId = this.sanitizeId(link.source);
            const targetId = this.sanitizeId(link.target);
            const linkStyle = this.getLinkStyle(link.type);
            lines.push(`    ${sourceId} ${linkStyle} ${targetId}`);
        });
        
        // Add broken links as red connections
        analysis.brokenLinks.forEach(link => {
            const sourceId = this.sanitizeId(link.source);
            const targetId = this.sanitizeId(link.target);
            lines.push(`    ${sourceId} -.->|broken| ${targetId}[${targetId}]`);
            lines.push(`    class ${targetId} broken`);
        });
        
        // Add styling
        lines.push('');
        lines.push('    classDef markdown fill:#e1f5fe');
        lines.push('    classDef readme fill:#fff3e0');
        lines.push('    classDef documentation fill:#f3e5f5');
        lines.push('    classDef broken fill:#ffebee,stroke:#f44336');
        
        return lines.join('\n');
    }

    private sanitizeId(id: string): string {
        return id.replace(/[^a-zA-Z0-9]/g, '_');
    }

    private getNodeIcon(type: DocumentNode['type']): string {
        switch (type) {
            case 'readme': return '📘';
            case 'markdown': return '📄';
            case 'documentation': return '📚';
            case 'text': return '📝';
            default: return '📄';
        }
    }

    private getLinkStyle(type: DocumentLink['type']): string {
        switch (type) {
            case 'reference': return '-->';
            case 'include': return '==>';
            case 'image': return '-.->'; 
            case 'link': return '-->';
            default: return '-->';
        }
    }
}
