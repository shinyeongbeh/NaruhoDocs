import * as vscode from 'vscode';
import { createChat, ChatSession } from './langchain-backend/llm.js';

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'naruhodocs.chatView';

	private _view?: vscode.WebviewView;

	// Thread management
	private sessions: Map<string, ChatSession> = new Map();
	private activeThreadId?: string;
	private threadTitles: Map<string, string> = new Map(); // sessionId -> document title

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private apiKey?: string
	) {}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async data => {
			const session = this.activeThreadId ? this.sessions.get(this.activeThreadId) : undefined;
			switch (data.type) {
				case 'sendMessage': {
					const userMessage = data.value as string;
					try {
						if (!session) { throw new Error('No active thread'); }
						const botResponse = await session.chat(userMessage);
						this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: botResponse });
					} catch (error: any) {
						this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: `Error: ${error.message || 'Unable to connect to LLM.'}` });
					}
					break;
				}
				case 'resetSession': {
					if (session) { session.reset(); }
					this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: 'Conversation reset.' });
					break;
				}
				case 'switchThread': {
					const sessionId = data.sessionId as string;
					this.setActiveThread(sessionId);
					break;
				}
				case 'createFile':
					{
						// Create a default file in the workspace root
						const wsFolders = vscode.workspace.workspaceFolders;
						if (wsFolders && wsFolders.length > 0) {
							const wsUri = wsFolders[0].uri;
							const fileUri = vscode.Uri.joinPath(wsUri, 'NaruhoDocsFile.txt');
							try {
								await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
								this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: `File created: ${fileUri.fsPath}` });
							} catch (err: any) {
								this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: `Error creating file: ${err.message}` });
							}
						} else {
							this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: 'No workspace folder open.' });
						}
						break;
					}
			}
		});

		// On initial load, send thread list and active thread
		this._postThreadList();
	}

	public postMessage(message: any) {
		if (this._view) {
			this._view.webview.postMessage(message);
		}
	}

	// Create a new thread/session for a document
	public createThread(sessionId: string, initialContext: string, title: string) {
		if (!this.sessions.has(sessionId)) {
			const sysMessage = `You are an AI assistant that helps answer anything about this document. Be helpful, concise, and accurate. The document:  ${title}\n\n${initialContext}`;
			const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
			// if (initialContext) {
			// 	session.chat(`Document loaded: ${title}\n\n${initialContext.substring(0, 1000)}`); // Only send first 1000 chars for context
			// }
			this.sessions.set(sessionId, session);
			this.threadTitles.set(sessionId, title);
			this._postThreadList();
		}
	}

	// Switch active thread
	public setActiveThread(sessionId: string) {
		if (this.sessions.has(sessionId)) {
			this.activeThreadId = sessionId;
			this._postThreadList();
			// Optionally, clear chat UI or show history
			const session = this.sessions.get(sessionId);
			if (session && this._view) {
				const history = session.getHistory();
				this._view.webview.postMessage({ type: 'showHistory', history });
			}
		}
	}

	private _postThreadList() {
		if (this._view) {
			const threads = Array.from(this.threadTitles.entries()).map(([id, title]) => ({ id, title }));
			this._view.webview.postMessage({ type: 'threadList', threads, activeThreadId: this.activeThreadId });
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
		const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
		const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
		const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
		const nonce = getNonce();

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
					Use a content security policy to only allow loading images from https or from our extension directory,
					and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
				<link href="${styleMainUri}" rel="stylesheet">
				
				<title>NaruhoDocs Chat</title>
			</head>
			<body>
				<div class="chat-container">
					<div id="chat-messages" class="chat-messages"></div>
					<div class="chat-input-container">
						<div class="chat-input-wrapper" style="position:relative; width:100%;">
							<textarea id="chat-input" class="chat-input" placeholder="How can I help?" style="padding-right:32px;"></textarea>
							<span id="send-icon" style="position:absolute; right:8px; top:50%; transform:translateY(-50%); cursor:pointer;">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<line x1="22" y1="2" x2="11" y2="13"></line>
									<polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
								</svg>
							</span>
						</div>
						<button id="create-file-btn" style="margin-top:10px;">Create Default File</button>
					</div>
				</div>

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
