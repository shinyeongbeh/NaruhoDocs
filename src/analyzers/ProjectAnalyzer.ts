import * as vscode from 'vscode';
import * as path from 'path';

export interface FileNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    children?: FileNode[];
    hasDocumentation?: boolean;
    documentationType?: 'markdown' | 'text' | 'code-comments' | 'none';
}

export interface ProjectAnalysis {
    structure: FileNode;
    totalFiles: number;
    documentedFiles: number;
    undocumentedFiles: number;
    documentationCoverage: number;
    fileTypes: Map<string, number>;
}

export class ProjectAnalyzer {
    constructor() {}

    public async analyzeProject(): Promise<ProjectAnalysis> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            throw new Error('No workspace folder found');
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const rootNode = await this.buildFileTree(workspaceFolders[0].uri);
        
        const analysis = this.calculateAnalysis(rootNode);
        
        return {
            structure: rootNode,
            ...analysis
        };
    }

    private async buildFileTree(uri: vscode.Uri): Promise<FileNode> {
        const stat = await vscode.workspace.fs.stat(uri);
        const isDirectory = stat.type === vscode.FileType.Directory;
        
        const node: FileNode = {
            name: path.basename(uri.fsPath),
            path: uri.fsPath,
            type: isDirectory ? 'directory' : 'file',
            hasDocumentation: false,
            documentationType: 'none'
        };

        if (isDirectory) {
            try {
                const children = await vscode.workspace.fs.readDirectory(uri);
                node.children = [];
                
                for (const [name, type] of children) {
                    // Skip common directories we don't want to analyze
                    if (this.shouldSkipPath(name)) {
                        continue;
                    }
                    
                    const childUri = vscode.Uri.joinPath(uri, name);
                    const childNode = await this.buildFileTree(childUri);
                    node.children.push(childNode);
                }
                
                // Sort children: directories first, then files
                node.children.sort((a, b) => {
                    if (a.type !== b.type) {
                        return a.type === 'directory' ? -1 : 1;
                    }
                    return a.name.localeCompare(b.name);
                });
            } catch (error) {
                console.warn(`Could not read directory ${uri.fsPath}:`, error);
            }
        } else {
            // Analyze file for documentation
            this.analyzeFileDocumentation(node);
        }

        return node;
    }

    private shouldSkipPath(name: string): boolean {
        const skipPatterns = [
            'node_modules',
            '.git',
            '.vscode',
            'dist',
            'out',
            'build',
            '.DS_Store',
            'Thumbs.db',
            '__pycache__',
            '.pytest_cache',
            '.coverage',
            '*.pyc',
            '*.pyo',
            '*.pyd'
        ];

        return skipPatterns.some(pattern => {
            if (pattern.includes('*')) {
                const regex = new RegExp(pattern.replace(/\*/g, '.*'));
                return regex.test(name);
            }
            return name === pattern;
        });
    }

    private analyzeFileDocumentation(node: FileNode): void {
        const ext = path.extname(node.name).toLowerCase();
        const basename = path.basename(node.name, ext).toLowerCase();

        // Check if it's a documentation file
        if (ext === '.md' || ext === '.txt' || ext === '.rst' || ext === '.adoc') {
            node.hasDocumentation = true;
            node.documentationType = ext === '.md' ? 'markdown' : 'text';
            return;
        }

        // Check if it's a README or similar
        if (basename.includes('readme') || basename.includes('changelog') || 
            basename.includes('license') || basename.includes('contributing')) {
            node.hasDocumentation = true;
            node.documentationType = 'markdown';
            return;
        }

        // For code files, we assume they might have inline documentation
        const codeExtensions = ['.ts', '.js', '.py', '.java', '.cpp', '.c', '.h', '.cs', '.go', '.rs', '.php'];
        if (codeExtensions.includes(ext)) {
            node.documentationType = 'code-comments';
            // We could analyze the file content for JSDoc/docstrings in the future
        }

        node.hasDocumentation = false;
    }

    private calculateAnalysis(rootNode: FileNode): Omit<ProjectAnalysis, 'structure'> {
        let totalFiles = 0;
        let documentedFiles = 0;
        const fileTypes = new Map<string, number>();

        const traverse = (node: FileNode) => {
            if (node.type === 'file') {
                totalFiles++;
                
                const ext = path.extname(node.name).toLowerCase() || 'no-extension';
                fileTypes.set(ext, (fileTypes.get(ext) || 0) + 1);
                
                if (node.hasDocumentation) {
                    documentedFiles++;
                }
            }
            
            if (node.children) {
                node.children.forEach(traverse);
            }
        };

        traverse(rootNode);

        const undocumentedFiles = totalFiles - documentedFiles;
        const documentationCoverage = totalFiles > 0 ? (documentedFiles / totalFiles) * 100 : 0;

        return {
            totalFiles,
            documentedFiles,
            undocumentedFiles,
            documentationCoverage,
            fileTypes
        };
    }

    public generateMermaidTreeDiagram(analysis: ProjectAnalysis): string {
        const lines: string[] = ['graph TD'];
        const nodeCounter = { value: 0 };
        
        const generateNodeId = () => `N${++nodeCounter.value}`;
        
        const traverse = (node: FileNode, parentId?: string): string => {
            const nodeId = generateNodeId();
            const icon = this.getNodeIcon(node);
            const style = this.getNodeStyle(node);
            
            // Create node definition
            lines.push(`    ${nodeId}["${icon} ${node.name}"]`);
            
            // Add styling
            if (style) {
                lines.push(`    ${nodeId} --> ${nodeId}_style[${style}]`);
            }
            
            // Connect to parent
            if (parentId) {
                lines.push(`    ${parentId} --> ${nodeId}`);
            }
            
            // Process children
            if (node.children && node.children.length > 0) {
                // Limit children to avoid too large diagrams
                const displayChildren = node.children.slice(0, 10);
                displayChildren.forEach(child => traverse(child, nodeId));
                
                // Add indicator if there are more children
                if (node.children.length > 10) {
                    const moreId = generateNodeId();
                    lines.push(`    ${moreId}["... ${node.children.length - 10} more items"]`);
                    lines.push(`    ${nodeId} --> ${moreId}`);
                }
            }
            
            return nodeId;
        };
        
        traverse(analysis.structure);
        
        // Add legend
        lines.push('');
        lines.push('    %% Legend');
        lines.push('    classDef documented fill:#d4edda,stroke:#28a745');
        lines.push('    classDef undocumented fill:#f8d7da,stroke:#dc3545');
        lines.push('    classDef directory fill:#e2e3e5,stroke:#6c757d');
        
        return lines.join('\n');
    }

    private getNodeIcon(node: FileNode): string {
        if (node.type === 'directory') {
            return '📁';
        }
        
        const ext = path.extname(node.name).toLowerCase();
        const iconMap: Record<string, string> = {
            '.md': '📝',
            '.txt': '📄',
            '.ts': '📘',
            '.js': '📙',
            '.py': '🐍',
            '.json': '⚙️',
            '.html': '🌐',
            '.css': '🎨',
            '.scss': '🎨',
            '.png': '🖼️',
            '.jpg': '🖼️',
            '.jpeg': '🖼️',
            '.gif': '🖼️',
            '.svg': '🎯'
        };
        
        return iconMap[ext] || '📄';
    }

    private getNodeStyle(node: FileNode): string | null {
        if (node.type === 'directory') {
            return 'directory';
        }
        
        if (node.hasDocumentation) {
            return 'documented';
        }
        
        return 'undocumented';
    }
}
