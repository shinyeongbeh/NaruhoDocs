import * as vscode from 'vscode';
import { VisualizationProvider, VisualizationResult } from './VisualizationProvider';

export class VisualizationViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'naruhodocs.visualizationView';

    private _view?: vscode.WebviewView;
    // Cache last visualization so we can restore after the user closes/reopens the sidebar
    private _lastResult?: VisualizationResult;
    // Whether the webview has signaled it's ready to accept messages
    private _isReady: boolean = false;
    // Queue messages if webview not ready yet
    private _pendingMessages: any[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly visualizationProvider: VisualizationProvider
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        this._isReady = false;
        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'generateVisualization': {
                    const result = await this.visualizationProvider.generateVisualization(data.visualizationType);
                    this._lastResult = result;
                    this._postMessage({
                        type: 'visualizationResult',
                        result
                    });
                    break;
                }
                case 'exportVisualization': {
                    await this.exportVisualization(data.content, data.format, data.title);
                    break;
                }
                case 'visualizationViewReady': {
                    this._isReady = true;
                    if (this._pendingMessages.length) {
                        for (const msg of this._pendingMessages) {
                            try { this._view?.webview.postMessage(msg); } catch { /* ignore */ }
                        }
                        this._pendingMessages = [];
                    }
                    if (this._lastResult) {
                        this._postMessage({ type: 'visualizationResult', result: this._lastResult });
                    }
                    break;
                }
            }
        });

        // If we already have a cached result (e.g., user reopened view), attempt delayed replay
        if (this._lastResult) {
            setTimeout(() => {
                if (this._isReady) {
                    this._postMessage({ type: 'visualizationResult', result: this._lastResult });
                }
            }, 150);
        }

        // Re-send visualization when view becomes visible again (covers collapse/expand scenario)
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this._lastResult && this._isReady) {
                this._postMessage({ type: 'visualizationResult', result: this._lastResult });
            }
        });
    }

    public showVisualization(result: VisualizationResult) {
        this._lastResult = result;
        this._postMessage({ type: 'visualizationResult', result });
        this._view?.show?.(true);
    }

    /** Post a message, queueing if webview not yet ready */
    private _postMessage(message: any) {
        if (!this._view) { return; }
        if (this._isReady) {
            try { this._view.webview.postMessage(message); } catch { /* ignore */ }
        } else {
            this._pendingMessages.push(message);
        }
    }

    private async exportVisualization(content: string, format: string, title: string) {
        try {
            const fileName = `${title.replace(/\s+/g, '_').toLowerCase()}.${format}`;
            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(fileName),
                filters: {
                    'SVG': ['svg'],
                    'PNG': ['png'],
                    'Mermaid': ['mmd'],
                    'All Files': ['*']
                }
            });

            if (uri) {
                let exportContent = content;
                if (format === 'mmd') {
                    // For Mermaid files, save the raw diagram code
                    exportContent = content;
                } else {
                    // For other formats, we would need to implement actual image generation
                    // For now, save as text
                    exportContent = `<!-- ${title} -->\n${content}`;
                }

                await vscode.workspace.fs.writeFile(uri, Buffer.from(exportContent, 'utf8'));
                vscode.window.showInformationMessage(`Visualization exported to ${uri.fsPath}`);
            }
        } catch (error) {
            console.error('Error exporting visualization:', error);
            vscode.window.showErrorMessage(`Failed to export visualization: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'visualization.js'));
        const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
        const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'visualization.css'));

        // CDN for Mermaid.js
        const mermaidUri = 'https://cdn.jsdelivr.net/npm/mermaid@10.6.1/dist/mermaid.min.js';

        // Use a nonce to only allow a specific script to be run.
        const nonce = getNonce();

        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; img-src ${webview.cspSource} https:;">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
				<link href="${styleMainUri}" rel="stylesheet">
				<title>Visualization</title>
			</head>
			<body>
				<div class="container">
					<div class="header">
						<h1>Project Visualization</h1>
						<div class="controls">
							<select id="visualization-type">
								<option value="architecture">🏗️ Architecture</option>
								<option value="folderStructure">📁 Folder Structure</option>
							</select>
							<button id="generate-btn" class="primary-button">Generate</button>
							<button id="export-btn" class="secondary-button" disabled>Export</button>
						</div>
					</div>
					
					<div id="loading" class="loading hidden">
						<div class="spinner"></div>
						<p>Generating visualization...</p>
					</div>
					
					<div id="error" class="error hidden">
						<p id="error-message"></p>
					</div>
					
					<div id="visualization-container" class="visualization-container">
						<div class="placeholder">
							<p>🎨 Select a visualization type and click Generate to create your project visualization</p>
						</div>
					</div>
				</div>

				<script nonce="${nonce}" src="${mermaidUri}"></script>
				<script nonce="${nonce}" src="${scriptUri}"></script>
                <script nonce="${nonce}">try{const vscode=acquireVsCodeApi();vscode.postMessage({type:'visualizationViewReady'});}catch{}</script>
			</body>
			</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
