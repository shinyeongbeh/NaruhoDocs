// @ts-check

// This script will be run within the webview itself for visualization
(function () {
    /**
     * @typedef {Object} VisualizationResult
     * @property {'mermaid'|'d3'|'vis'|'folderList'|'error'} type
     * @property {string} content
     * @property {string} title
     * @property {string=} error
     */
    // @ts-ignore: acquireVsCodeApi is provided by VS Code webview
    const vscode = acquireVsCodeApi();

    // Global declarations for libraries loaded via script tags
    // @ts-ignore: mermaid is loaded as a global script
    const mermaidLib = window.mermaid;

    // DOM elements
    const visualizationType = document.getElementById('visualization-type');
    const generateBtn = document.getElementById('generate-btn');
    const exportBtn = document.getElementById('export-btn');
    const loadingElement = document.getElementById('loading');
    const errorElement = document.getElementById('error');
    const errorMessage = document.getElementById('error-message');
    const visualizationContainer = document.getElementById('visualization-container');

    /** @type {VisualizationResult|null} */
    let currentVisualization = /** @type {any} */(null);
    let restoring = false;

    // Initialize Mermaid
    if (typeof mermaidLib !== 'undefined') {
        mermaidLib.initialize({ 
            startOnLoad: false,
            theme: 'dark',
            themeVariables: {
                darkMode: true,
                primaryColor: '#007acc',
                primaryTextColor: '#ffffff',
                primaryBorderColor: '#007acc',
                lineColor: '#cccccc',
                secondaryColor: '#1e1e1e',
                tertiaryColor: '#252526'
            }
        });
    }

    // Event listeners
    if (generateBtn) {
        generateBtn.addEventListener('click', generateVisualization);
    }

    if (exportBtn) {
        exportBtn.addEventListener('click', exportVisualization);
    }

    // Listen for messages from the extension
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'visualizationResult':
                handleVisualizationResult(message.result);
                break;
        }
    });

    function generateVisualization() {
        if (!visualizationType) {
            return;
        }

        const selectedType = (visualizationType instanceof HTMLSelectElement) ? 
            visualizationType.value : '';
        showLoading(true);
        hideError();

        // Disable generate button during generation
        if (generateBtn && generateBtn instanceof HTMLButtonElement) {
            generateBtn.disabled = true;
            generateBtn.textContent = 'Generating...';
        }

        // Send request to extension
        vscode.postMessage({
            type: 'generateVisualization',
            visualizationType: selectedType
        });
    }

    /**
     * @param {VisualizationResult} result
     */
    function handleVisualizationResult(result) {
        showLoading(false);
        
        // Re-enable generate button
        if (generateBtn && generateBtn instanceof HTMLButtonElement) {
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate';
        }

        if (result.type === 'error') {
            showError(result.error || 'Unknown error occurred');
            return;
        }

    currentVisualization = result;
    saveState();
        
        try {
            renderVisualization(result);
            
            // Enable export button
            if (exportBtn && exportBtn instanceof HTMLButtonElement) {
                exportBtn.disabled = false;
            }
        } catch (error) {
            console.error('Error rendering visualization:', error);
            const msg = error && typeof error === 'object' && 'message' in error ? /** @type {any} */(error).message : 'Unknown error';
            showError(`Failed to render visualization: ${msg}`);
        }
    }

    /**
     * @param {VisualizationResult} result
     */
    function renderVisualization(result) {
        if (!visualizationContainer) {
            return;
        }

        // Clear previous content
        visualizationContainer.innerHTML = '';

        switch (result.type) {
            case 'mermaid':
                renderMermaidDiagram(result.content);
                break;
            case 'd3':
                renderD3Visualization(result.content);
                break;
            case 'vis':
                renderVisVisualization(result.content);
                break;
            case 'folderList':
                renderFolderAscii(result.content);
                break;
            default:
                throw new Error(`Unsupported visualization type: ${result.type}`);
        }
        // Add title if provided
        if (result.title) {
            const titleElement = document.createElement('h2');
            titleElement.textContent = result.title;
            titleElement.style.textAlign = 'center';
            titleElement.style.marginBottom = '20px';
            titleElement.style.color = 'var(--vscode-foreground)';
            visualizationContainer.insertBefore(titleElement, visualizationContainer.firstChild);
        }
        // Add export controls
        addExportControls();
    }

    /**
     * @param {string} content
     */
    function renderMermaidDiagram(content) {
        if (typeof mermaidLib === 'undefined') {
            throw new Error('Mermaid library not loaded');
        }

        const container = document.createElement('div');
        container.className = 'mermaid-container';
        
        const diagramElement = document.createElement('div');
        diagramElement.className = 'mermaid';
        diagramElement.textContent = content;
        
        container.appendChild(diagramElement);
        if (visualizationContainer) {
            visualizationContainer.appendChild(container);
        }

        // Render the Mermaid diagram
        mermaidLib.init(undefined, diagramElement);
    }

    /**
     * @param {string} content
     */
    function renderD3Visualization(content) {
        // TODO: Implement D3.js visualization rendering
        const container = document.createElement('div');
        container.className = 'd3-container';
        container.innerHTML = '<p>D3.js visualization coming soon...</p>';
        if (visualizationContainer) {
            visualizationContainer.appendChild(container);
        }
    }

    /**
     * @param {string} content
     */
    function renderVisVisualization(content) {
        // TODO: Implement Vis.js visualization rendering
        const container = document.createElement('div');
        container.className = 'vis-container';
        container.innerHTML = '<p>Vis.js visualization coming soon...</p>';
        if (visualizationContainer) {
            visualizationContainer.appendChild(container);
        }
    }

    /**
     * Render ASCII folder tree
     * @param {string} asciiContent
     */
    function renderFolderAscii(/** @type {string} */ asciiContent) {
        const container = document.createElement('div');
        container.className = 'folder-list-container';
        const pre = document.createElement('pre');
        pre.className = 'folder-ascii-tree';
        pre.textContent = asciiContent;
        container.appendChild(pre);
        // Store last ascii content for copy button logic in addExportControls
        (container.dataset || (/** @type {any} */(container).dataset = {})).asciiTree = asciiContent;
        if (visualizationContainer) { visualizationContainer.appendChild(container); }
    }

    function addExportControls() {
        if (!visualizationContainer) { return; }
        // Remove any existing controls to avoid duplicates on re-render
        const existing = visualizationContainer.querySelector('.visualization-controls');
        if (existing) { existing.remove(); }

        const controls = document.createElement('div');
        controls.className = 'visualization-controls';

        const zoomInBtn = createControlButton('🔍+', 'Zoom In', () => {
            // TODO: Implement zoom functionality
            console.log('Zoom in clicked');
        });

        const zoomOutBtn = createControlButton('🔍-', 'Zoom Out', () => {
            // TODO: Implement zoom functionality
            console.log('Zoom out clicked');
        });

        const resetBtn = createControlButton('🔄', 'Reset View', () => {
            // TODO: Implement reset functionality
            console.log('Reset view clicked');
        });

        // Copy button for folderList (ASCII) – placed first for visibility
        if (currentVisualization && currentVisualization.type === 'folderList') {
            const copyBtn = createControlButton('📋', 'Copy folder structure', async () => {
                try {
                    if (!currentVisualization) { throw new Error('No visualization'); }
                    await navigator.clipboard.writeText(currentVisualization.content);
                    copyBtn.textContent = '✔';
                    copyBtn.setAttribute('aria-label', 'Copied');
                    setTimeout(() => { copyBtn.textContent = '📋'; copyBtn.setAttribute('aria-label', 'Copy folder structure'); }, 1400);
                } catch (e) {
                    copyBtn.textContent = '✖';
                    copyBtn.setAttribute('aria-label', 'Copy failed');
                    setTimeout(() => { copyBtn.textContent = '📋'; copyBtn.setAttribute('aria-label', 'Copy folder structure'); }, 1400);
                }
            });
            copyBtn.setAttribute('aria-label', 'Copy folder structure');
            controls.appendChild(copyBtn);
        }

        controls.appendChild(zoomInBtn);
        controls.appendChild(zoomOutBtn);
        controls.appendChild(resetBtn);

        visualizationContainer.appendChild(controls);
    }

    /**
     * @param {string} text
     * @param {string} title
     * @param {() => void} onClick
     */
    function createControlButton(text, title, onClick) {
        const button = document.createElement('button');
        button.className = 'control-button';
        button.textContent = text;
        button.title = title;
        button.addEventListener('click', onClick);
        return button;
    }

    function exportVisualization() {
        if (!currentVisualization) {
            showError('No visualization to export');
            return;
        }

        // For now, export as Mermaid source code
        // TODO: Implement proper image export
        vscode.postMessage({
            type: 'exportVisualization',
            content: currentVisualization.content,
            format: 'mmd',
            title: currentVisualization.title
        });
    }

    /**
     * @param {boolean} show
     */
    function showLoading(show) {
        if (loadingElement) {
            if (show) {
                loadingElement.classList.remove('hidden');
                if (visualizationContainer) {
                    visualizationContainer.style.opacity = '0.5';
                }
            } else {
                loadingElement.classList.add('hidden');
                if (visualizationContainer) {
                    visualizationContainer.style.opacity = '1';
                }
            }
        }
    }

    /**
     * @param {string} message
     */
    function showError(message) {
        if (errorElement && errorMessage) {
            errorMessage.textContent = message;
            errorElement.classList.remove('hidden');
        }
    }

    function hideError() {
        if (errorElement) {
            errorElement.classList.add('hidden');
        }
    }

    // Restore state if needed
    const state = vscode.getState();
    if (state && state.currentVisualization) {
        restoring = true;
        currentVisualization = state.currentVisualization;
    try { if (currentVisualization) { handleVisualizationResult(currentVisualization); } } finally { restoring = false; }
    }

    // Save state when visualization changes
    function saveState() {
        vscode.setState({
            currentVisualization: currentVisualization,
            selectedType: visualizationType instanceof HTMLSelectElement ? visualizationType.value : undefined
        });
    }

    // Persist visualization type changes
    if (visualizationType instanceof HTMLSelectElement) {
        visualizationType.addEventListener('change', saveState);
        if (state && state.selectedType) {
            visualizationType.value = state.selectedType;
        }
    }

}());
