import * as vscode from 'vscode';

export interface TreeNode {
    id: string;
    name: string;
    type: 'file' | 'folder';
    path: string;
    children?: TreeNode[];
    size?: number;
    hasDocumentation?: boolean;
    documentationCoverage?: number;
}

export interface D3TreeVisualization {
    html: string;
    css: string;
    javascript: string;
}

export class D3TreeRenderer {
    
    public generateInteractiveTree(rootNode: TreeNode): D3TreeVisualization {
        const html = this.generateHTML();
        const css = this.generateCSS();
        const javascript = this.generateJavaScript(rootNode);
        
        return { html, css, javascript };
    }

    private generateHTML(): string {
        return `
        <div id="tree-container">
            <div id="tree-controls">
                <button id="expand-all">Expand All</button>
                <button id="collapse-all">Collapse All</button>
                <button id="toggle-docs">Show Documentation Coverage</button>
                <button id="export-tree">Export</button>
            </div>
            <div id="tree-legend">
                <div class="legend-item">
                    <span class="legend-color folder"></span>
                    <span>Folder</span>
                </div>
                <div class="legend-item">
                    <span class="legend-color file"></span>
                    <span>File</span>
                </div>
                <div class="legend-item">
                    <span class="legend-color documented"></span>
                    <span>Has Documentation</span>
                </div>
                <div class="legend-item">
                    <span class="legend-color undocumented"></span>
                    <span>Needs Documentation</span>
                </div>
            </div>
            <svg id="tree-svg"></svg>
        </div>`;
    }

    private generateCSS(): string {
        return `
        #tree-container {
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-foreground);
        }

        #tree-controls {
            padding: 10px;
            display: flex;
            gap: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-panel-background);
        }

        #tree-controls button {
            padding: 6px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: background 0.2s;
        }

        #tree-controls button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        #tree-legend {
            padding: 8px 10px;
            display: flex;
            gap: 15px;
            font-size: 11px;
            background: var(--vscode-panel-background);
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .legend-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .legend-color {
            width: 12px;
            height: 12px;
            border-radius: 2px;
        }

        .legend-color.folder {
            background: #42a5f5;
        }

        .legend-color.file {
            background: #66bb6a;
        }

        .legend-color.documented {
            background: #4caf50;
        }

        .legend-color.undocumented {
            background: #ff9800;
        }

        #tree-svg {
            flex: 1;
            width: 100%;
            min-height: 400px;
        }

        .tree-node {
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .tree-node-rect {
            fill: var(--vscode-button-background);
            stroke: var(--vscode-button-border);
            stroke-width: 1;
            rx: 3;
            transition: all 0.3s ease;
        }

        .tree-node:hover .tree-node-rect {
            fill: var(--vscode-button-hoverBackground);
            stroke-width: 2;
        }

        .tree-node-text {
            fill: var(--vscode-button-foreground);
            font-family: var(--vscode-font-family);
            font-size: 12px;
            text-anchor: middle;
            dominant-baseline: central;
        }

        .tree-link {
            fill: none;
            stroke: var(--vscode-foreground);
            stroke-width: 1.5;
            stroke-opacity: 0.6;
        }

        .tree-node.folder .tree-node-rect {
            fill: #42a5f5;
        }

        .tree-node.file .tree-node-rect {
            fill: #66bb6a;
        }

        .tree-node.documented .tree-node-rect {
            fill: #4caf50;
        }

        .tree-node.undocumented .tree-node-rect {
            fill: #ff9800;
        }

        .tree-node.collapsed .tree-node-rect {
            fill: #616161;
        }

        .tree-tooltip {
            position: absolute;
            background: var(--vscode-editorHoverWidget-background);
            border: 1px solid var(--vscode-editorHoverWidget-border);
            border-radius: 4px;
            padding: 8px;
            font-size: 12px;
            pointer-events: none;
            z-index: 1000;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }

        @media (max-width: 768px) {
            #tree-controls {
                flex-wrap: wrap;
                gap: 5px;
            }
            
            #tree-controls button {
                font-size: 11px;
                padding: 5px 8px;
            }
            
            #tree-legend {
                flex-wrap: wrap;
                gap: 8px;
            }
        }`;
    }

    private generateJavaScript(rootNode: TreeNode): string {
        return `
        (function() {
            // D3.js Tree Visualization
            const data = ${JSON.stringify(rootNode, null, 2)};
            
            const margin = { top: 20, right: 90, bottom: 30, left: 90 };
            const width = 800 - margin.left - margin.right;
            const height = 600 - margin.top - margin.bottom;
            
            let showDocumentationMode = false;
            let i = 0;
            let duration = 750;
            let root;
            
            // Create the tree layout
            const tree = d3.tree().size([height, width]);
            
            // Create the SVG container
            const svg = d3.select("#tree-svg")
                .attr("width", width + margin.right + margin.left)
                .attr("height", height + margin.top + margin.bottom);
                
            const g = svg.append("g")
                .attr("transform", "translate(" + margin.left + "," + margin.top + ")");
                
            // Create tooltip
            const tooltip = d3.select("body").append("div")
                .attr("class", "tree-tooltip")
                .style("opacity", 0);
            
            // Initialize the tree
            root = d3.hierarchy(data, d => d.children);
            root.x0 = height / 2;
            root.y0 = 0;
            
            // Collapse all nodes initially except the first level
            if (root.children) {
                root.children.forEach(collapse);
            }
            
            update(root);
            
            // Control button handlers
            d3.select("#expand-all").on("click", function() {
                expandAll(root);
                update(root);
            });
            
            d3.select("#collapse-all").on("click", function() {
                if (root.children) {
                    root.children.forEach(collapse);
                }
                update(root);
            });
            
            d3.select("#toggle-docs").on("click", function() {
                showDocumentationMode = !showDocumentationMode;
                d3.select(this).text(showDocumentationMode ? "Hide Documentation Coverage" : "Show Documentation Coverage");
                updateNodeStyles();
            });
            
            d3.select("#export-tree").on("click", function() {
                exportSVG();
            });
            
            function update(source) {
                // Compute the new tree layout
                const treeData = tree(root);
                const nodes = treeData.descendants();
                const links = treeData.descendants().slice(1);
                
                // Normalize for fixed-depth
                nodes.forEach(d => d.y = d.depth * 180);
                
                // Update the nodes
                const node = g.selectAll("g.tree-node")
                    .data(nodes, d => d.id || (d.id = ++i));
                
                // Enter any new nodes at the parent's previous position
                const nodeEnter = node.enter().append("g")
                    .attr("class", d => "tree-node " + getNodeClass(d))
                    .attr("transform", d => "translate(" + source.y0 + "," + source.x0 + ")")
                    .on("click", click)
                    .on("mouseover", showTooltip)
                    .on("mouseout", hideTooltip);
                
                // Add rectangles for the nodes
                nodeEnter.append("rect")
                    .attr("class", "tree-node-rect")
                    .attr("width", 1e-6)
                    .attr("height", 1e-6)
                    .attr("x", -5)
                    .attr("y", -10);
                
                // Add labels for the nodes
                nodeEnter.append("text")
                    .attr("class", "tree-node-text")
                    .attr("dy", ".35em")
                    .text(d => d.data.name);
                
                // Update existing nodes
                const nodeUpdate = nodeEnter.merge(node);
                
                // Transition to the proper position for the node
                nodeUpdate.transition()
                    .duration(duration)
                    .attr("transform", d => "translate(" + d.y + "," + d.x + ")");
                
                // Update the node attributes and style
                nodeUpdate.select("rect")
                    .transition()
                    .duration(duration)
                    .attr("width", d => Math.max(60, d.data.name.length * 8))
                    .attr("height", 20)
                    .attr("x", d => -(Math.max(60, d.data.name.length * 8)) / 2)
                    .attr("y", -10);
                
                // Remove any exiting nodes
                const nodeExit = node.exit().transition()
                    .duration(duration)
                    .attr("transform", d => "translate(" + source.y + "," + source.x + ")")
                    .remove();
                
                nodeExit.select("rect")
                    .attr("width", 1e-6)
                    .attr("height", 1e-6);
                
                nodeExit.select("text")
                    .style("fill-opacity", 1e-6);
                
                // Update the links
                const link = g.selectAll("path.tree-link")
                    .data(links, d => d.id);
                
                // Enter any new links at the parent's previous position
                const linkEnter = link.enter().insert("path", "g")
                    .attr("class", "tree-link")
                    .attr("d", d => {
                        const o = {x: source.x0, y: source.y0};
                        return diagonal(o, o);
                    });
                
                // Update existing links
                const linkUpdate = linkEnter.merge(link);
                
                // Transition back to the parent element position
                linkUpdate.transition()
                    .duration(duration)
                    .attr("d", d => diagonal(d, d.parent));
                
                // Remove any exiting links
                link.exit().transition()
                    .duration(duration)
                    .attr("d", d => {
                        const o = {x: source.x, y: source.y};
                        return diagonal(o, o);
                    })
                    .remove();
                
                // Store the old positions for transition
                nodes.forEach(d => {
                    d.x0 = d.x;
                    d.y0 = d.y;
                });
            }
            
            function getNodeClass(d) {
                let classes = [d.data.type];
                
                if (showDocumentationMode) {
                    if (d.data.hasDocumentation) {
                        classes.push('documented');
                    } else if (d.data.type === 'file') {
                        classes.push('undocumented');
                    }
                }
                
                if (d._children) {
                    classes.push('collapsed');
                }
                
                return classes.join(' ');
            }
            
            function updateNodeStyles() {
                g.selectAll("g.tree-node")
                    .attr("class", d => "tree-node " + getNodeClass(d));
            }
            
            function click(event, d) {
                if (d.children) {
                    d._children = d.children;
                    d.children = null;
                } else {
                    d.children = d._children;
                    d._children = null;
                }
                update(d);
            }
            
            function collapse(d) {
                if (d.children) {
                    d._children = d.children;
                    d._children.forEach(collapse);
                    d.children = null;
                }
            }
            
            function expandAll(d) {
                if (d._children) {
                    d.children = d._children;
                    d._children = null;
                }
                if (d.children) {
                    d.children.forEach(expandAll);
                }
            }
            
            function diagonal(s, d) {
                const path = \`M \${s.y} \${s.x}
                        C \${(s.y + d.y) / 2} \${s.x},
                          \${(s.y + d.y) / 2} \${d.x},
                          \${d.y} \${d.x}\`;
                return path;
            }
            
            function showTooltip(event, d) {
                let content = \`<strong>\${d.data.name}</strong><br>\`;
                content += \`Type: \${d.data.type}<br>\`;
                content += \`Path: \${d.data.path}<br>\`;
                
                if (d.data.size) {
                    content += \`Size: \${formatBytes(d.data.size)}<br>\`;
                }
                
                if (d.data.hasDocumentation !== undefined) {
                    content += \`Documentation: \${d.data.hasDocumentation ? 'Yes' : 'No'}<br>\`;
                }
                
                if (d.data.documentationCoverage !== undefined) {
                    content += \`Coverage: \${Math.round(d.data.documentationCoverage * 100)}%\`;
                }
                
                tooltip.transition()
                    .duration(200)
                    .style("opacity", .9);
                    
                tooltip.html(content)
                    .style("left", (event.pageX + 10) + "px")
                    .style("top", (event.pageY - 28) + "px");
            }
            
            function hideTooltip() {
                tooltip.transition()
                    .duration(500)
                    .style("opacity", 0);
            }
            
            function formatBytes(bytes, decimals = 2) {
                if (bytes === 0) return '0 Bytes';
                const k = 1024;
                const dm = decimals < 0 ? 0 : decimals;
                const sizes = ['Bytes', 'KB', 'MB', 'GB'];
                const i = Math.floor(Math.log(bytes) / Math.log(k));
                return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
            }
            
            function exportSVG() {
                const svgElement = document.querySelector("#tree-svg");
                const svgData = new XMLSerializer().serializeToString(svgElement);
                const svgBlob = new Blob([svgData], {type: "image/svg+xml;charset=utf-8"});
                const downloadLink = document.createElement("a");
                downloadLink.href = URL.createObjectURL(svgBlob);
                downloadLink.download = "project-tree.svg";
                document.body.appendChild(downloadLink);
                downloadLink.click();
                document.body.removeChild(downloadLink);
            }
            
            // Make the SVG responsive
            function resize() {
                const container = document.getElementById('tree-container');
                const containerWidth = container.clientWidth;
                const containerHeight = container.clientHeight - 100; // Account for controls and legend
                
                svg.attr("width", containerWidth)
                   .attr("height", containerHeight);
                   
                tree.size([containerHeight - margin.top - margin.bottom, 
                          containerWidth - margin.left - margin.right]);
                          
                update(root);
            }
            
            // Listen for window resize
            window.addEventListener('resize', resize);
            
            // Initial resize
            resize();
        })();`;
    }

    public generateMermaidTreeWithD3Fallback(rootNode: TreeNode): string {
        // Generate Mermaid diagram as primary option
        const mermaidCode = this.generateMermaidTree(rootNode);
        
        // Include D3 fallback in comments for future use
        const d3Fallback = `
<!-- D3.js Interactive Tree Available -->
<!-- Use VisualizationProvider.generateD3Tree() for interactive version -->
        `;
        
        return mermaidCode + '\n' + d3Fallback;
    }

    private generateMermaidTree(node: TreeNode, prefix: string = ''): string {
        const lines: string[] = [];
        
        if (prefix === '') {
            lines.push('graph TD');
        }
        
        const nodeId = this.sanitizeId(node.path);
        const icon = node.type === 'folder' ? '📁' : '📄';
        const docIcon = node.hasDocumentation ? '✅' : '❌';
        const label = `${icon} ${node.name}${node.hasDocumentation !== undefined ? ' ' + docIcon : ''}`;
        
        if (prefix === '') {
            lines.push(`    ${nodeId}["${label}"]`);
        }
        
        if (node.children) {
            node.children.forEach(child => {
                const childId = this.sanitizeId(child.path);
                const childIcon = child.type === 'folder' ? '📁' : '📄';
                const childDocIcon = child.hasDocumentation !== undefined ? (child.hasDocumentation ? '✅' : '❌') : '';
                const childLabel = `${childIcon} ${child.name}${childDocIcon ? ' ' + childDocIcon : ''}`;
                
                lines.push(`    ${nodeId} --> ${childId}["${childLabel}"]`);
                
                // Recursively add children
                if (child.children && child.children.length > 0) {
                    const childLines = this.generateMermaidTree(child, '    ').split('\n').slice(1); // Skip the graph TD line
                    lines.push(...childLines);
                }
            });
        }
        
        // Add styling
        if (prefix === '') {
            lines.push('');
            lines.push('    classDef folder fill:#42a5f5,stroke:#1976d2,color:#fff');
            lines.push('    classDef file fill:#66bb6a,stroke:#388e3c,color:#fff');
            lines.push('    classDef documented fill:#4caf50,stroke:#2e7d32,color:#fff');
            lines.push('    classDef undocumented fill:#ff9800,stroke:#f57c00,color:#fff');
        }
        
        return lines.join('\n');
    }

    private sanitizeId(path: string): string {
        return path.replace(/[^a-zA-Z0-9]/g, '_');
    }
}
