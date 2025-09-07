import * as vscode from 'vscode';
import { VisualizationProvider, VisualizationResult } from './VisualizationProvider';

export class VisualizationViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'naruhodocs.visualizationView';

    private _view?: vscode.WebviewView;

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

        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(
            async (data) => {
                switch (data.type) {
                    case 'generateVisualization': {
                        const result = await this.visualizationProvider.generateVisualization(data.visualizationType);
                        this._view?.webview.postMessage({
                            type: 'visualizationResult',
                            result: result
                        });
                        break;
                    }
                    case 'exportVisualization': {
                        await this.exportVisualization(data.content, data.format, data.title);
                        break;
                    }
                }
            },
            undefined,
            []
        );
    }

    public showVisualization(result: VisualizationResult) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'visualizationResult',
                result: result
            });
            
            // Make the visualization view visible
            this._view.show?.(true);
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
								<option value="docRelations">🔗 Document Relations</option>
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
