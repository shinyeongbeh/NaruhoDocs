// @ts-check

// This script will be run within the webview itself for visualization
(function () {
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

    let currentVisualization = null;

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
        
        try {
            renderVisualization(result);
            
            // Enable export button
            if (exportBtn && exportBtn instanceof HTMLButtonElement) {
                exportBtn.disabled = false;
            }
        } catch (error) {
            console.error('Error rendering visualization:', error);
            showError(`Failed to render visualization: ${error.message}`);
        }
    }

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

    function renderD3Visualization(content) {
        // TODO: Implement D3.js visualization rendering
        const container = document.createElement('div');
        container.className = 'd3-container';
        container.innerHTML = '<p>D3.js visualization coming soon...</p>';
        if (visualizationContainer) {
            visualizationContainer.appendChild(container);
        }
    }

    function renderVisVisualization(content) {
        // TODO: Implement Vis.js visualization rendering
        const container = document.createElement('div');
        container.className = 'vis-container';
        container.innerHTML = '<p>Vis.js visualization coming soon...</p>';
        if (visualizationContainer) {
            visualizationContainer.appendChild(container);
        }
    }

    function addExportControls() {
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

        controls.appendChild(zoomInBtn);
        controls.appendChild(zoomOutBtn);
        controls.appendChild(resetBtn);

        if (visualizationContainer) {
            visualizationContainer.appendChild(controls);
        }
    }

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
        currentVisualization = state.currentVisualization;
        handleVisualizationResult(currentVisualization);
    }

    // Save state when visualization changes
    function saveState() {
        vscode.setState({
            currentVisualization: currentVisualization
        });
    }

    // Auto-save state periodically
    setInterval(saveState, 1000);

}());
