import * as vscode from 'vscode';
import { createChat, ChatSession } from './langchain-backend/llm.js';
import { SystemMessages } from './SystemMessages';

export class ChatViewProvider implements vscode.WebviewViewProvider {
	private existingDocFiles: string[] = [];
	private didDevCleanupOnce: boolean = false;
	private fileWatcher?: vscode.FileSystemWatcher;
	/**
	 * Switch the system message for a document-based thread to beginner mode.
	 */
	public async setThreadBeginnerMode(sessionId: string) {
		if(sessionId === 'naruhodocs-general-thread') {
			return;
		}
		console.log('ChatViewProvider: setThreadBeginnerMode called', sessionId);
		const session = this.sessions.get(sessionId);
		const title = this.threadTitles.get(sessionId) || '';
		let initialContext = '';
		// Use sessionId as file path for document threads
		try {
			const uri = vscode.Uri.parse(sessionId);
			const doc = await vscode.workspace.openTextDocument(uri);
			initialContext = doc.getText();
		} catch (e) {
			initialContext = '';
		}
		if (session) {
			const sysMessage = SystemMessages.DOCUMENT_SPECIFIC_BEGINNER(title, initialContext);
			session.setCustomSystemMessage(sysMessage);
		}
	}

	/**
	 * Switch the system message for a document-based thread to developer mode.
	 */
	public async setThreadDeveloperMode(sessionId: string) {
		if(sessionId === 'naruhodocs-general-thread') {
			return;
		}
		console.log('ChatViewProvider: setThreadDeveloperMode called');
		const session = this.sessions.get(sessionId);
		const title = this.threadTitles.get(sessionId) || '';
		let initialContext = '';
		// Use sessionId as file path for document threads
		try {
			const uri = vscode.Uri.parse(sessionId);
			const doc = await vscode.workspace.openTextDocument(uri);
			initialContext = doc.getText();
		} catch (e) {
			initialContext = '';
		}
		if (session) {
			const sysMessage = SystemMessages.DOCUMENT_SPECIFIC_DEVELOPER(title, initialContext);
			session.setCustomSystemMessage(sysMessage);
		}
	}
	/**
	 * Send a message to a specific thread and display the bot response.
	 */
	public async sendMessageToThread(sessionId: string, prompt: string) {
    this.setActiveThread(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
        this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: 'No active thread.' });
        return;
    }
    // Immediately show user message
    this._view?.webview.postMessage({ type: 'addMessage', sender: 'You', message: prompt });
    // Then asynchronously get and show bot response
    session.chat(prompt)
        .then(async botResponse => {
            this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: botResponse });
            const history = session.getHistory();
            await this.context.workspaceState.update(`thread-history-${sessionId}`, history);
        })
        .catch((error: any) => {
            this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: `Error: ${error.message || 'Unable to connect to LLM.'}` });
        });
}
	
	public static readonly viewType = 'naruhodocs.chatView';

	private _view?: vscode.WebviewView;

	// Thread management
	private sessions: Map<string, ChatSession> = new Map();
	private activeThreadId?: string;
	private threadTitles: Map<string, string> = new Map(); // sessionId -> document title

	private context: vscode.ExtensionContext;
	constructor(
		private readonly _extensionUri: vscode.Uri,
		private apiKey?: string,
		context?: vscode.ExtensionContext
	) {
		this.context = context!;

		// Create the general-purpose thread on initialization
		const generalThreadId = 'naruhodocs-general-thread';
		const generalThreadTitle = 'General Purpose';
		const sysMessage = SystemMessages.GENERAL_PURPOSE;

		const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
		this.sessions.set(generalThreadId, session);
		this.threadTitles.set(generalThreadId, generalThreadTitle);
		this.activeThreadId = generalThreadId; // Set as the default active thread

		// Watch for file deletions (markdown/txt)
		this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{md,txt}');
		this.fileWatcher.onDidDelete(async (uri) => {
			const sessionId = uri.toString();
			if (this.sessions.has(sessionId)) {
				this.sessions.delete(sessionId);
				this.threadTitles.delete(sessionId);
				await this.context.workspaceState.update(`thread-history-${sessionId}`, undefined);
				// If the deleted thread was active, switch to general
				if (this.activeThreadId === sessionId) {
					this.activeThreadId = 'naruhodocs-general-thread';
				}
				this._postThreadList();
				if (this._view) {
					this._view.webview.postMessage({ type: 'resetState' });
				}
			}
		});
	}

	public async resolveWebviewView(
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

		// Always reset state in dev mode (only once per debug session)
		if (this.context.extensionMode === vscode.ExtensionMode.Development && !this.didDevCleanupOnce) {
			webviewView.webview.postMessage({ type: 'resetState' });
			// Clear persisted thread histories and reset thread list to only General once
			const historyKeys = this.context.workspaceState.keys ? this.context.workspaceState.keys() : [];
			for (const key of historyKeys) {
				if (typeof key === 'string' && key.startsWith('thread-history-')) {
					await this.context.workspaceState.update(key, undefined);
				}
			}
			// Preserve General thread, clear others
			const generalId = 'naruhodocs-general-thread';
			const preservedSession = this.sessions.get(generalId);
			const preservedTitle = this.threadTitles.get(generalId);
			this.sessions = new Map();
			this.threadTitles = new Map();
			if (preservedSession && preservedTitle) {
				this.sessions.set(generalId, preservedSession);
				this.threadTitles.set(generalId, preservedTitle);
				this.activeThreadId = generalId;
			}
			this.didDevCleanupOnce = true;
		}

		// Restore threads from workspaceState
		const keys = this.context.workspaceState.keys ? this.context.workspaceState.keys() : [];
		await this.restoreThreads(keys);

		// Ensure currently open documents are represented as threads when the view opens
		try {
			const openDocs = vscode.workspace.textDocuments;
			for (const document of openDocs) {
				const fileNameLower = document.fileName.toLowerCase();
				if (fileNameLower.endsWith('.md') || fileNameLower.endsWith('.txt')) {
					const sessionId = document.uri.toString();
					this.createThread(sessionId, document.getText(), document.fileName);
				}
			}
		} catch {}

		// 🔥 Always push active thread + history when webview is first resolved
		this._postThreadList();
		if (this.activeThreadId) {
			const session = this.sessions.get(this.activeThreadId);
			if (session) {
				const history = session.getHistory();
				this._view?.webview.postMessage({ type: 'showHistory', history });
			}
		}

		// Refresh UI whenever the view becomes visible again (e.g., after switching panels)
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this._postThreadList();
				if (this.activeThreadId) {
					const session = this.sessions.get(this.activeThreadId);
					if (session) {
						const history = session.getHistory();
						this._view?.webview.postMessage({ type: 'showHistory', history });
					}
				}
			}
		});

		webviewView.webview.onDidReceiveMessage(async data => {
			console.log('[NaruhoDocs] Webview received message:', data.type);
			if (data.type === 'scanDocs') {
				console.log('[NaruhoDocs] scanDocs triggered from webview');
				await vscode.commands.executeCommand('naruhodocs.scanDocs');
				return;
			}
			if (data.type === 'existingDocs') {
				this.existingDocFiles = Array.isArray(data.files) ? data.files : [];
				return;
			}
			const session = this.activeThreadId ? this.sessions.get(this.activeThreadId) : undefined;
			switch (data.type) {
				case 'generateDoc': {
					console.log('[NaruhoDocs] generateDoc triggered:', data.docType, data.fileName);
					// Determine file name
					let fileName = '';
					switch (data.docType) {
						case 'README':
							fileName = 'README.md';
							break;
						case 'API Reference':
							fileName = 'API_REFERENCE.md';
							break;
						case 'Getting Started':
							fileName = 'GETTING_STARTED.md';
							break;
						case 'Contributing Guide':
							fileName = 'CONTRIBUTING.md';
							break;
						case 'Changelog':
							fileName = 'CHANGELOG.md';
							break;
						case 'Quickstart Guide':
							fileName = 'vsc-extension-quickstart.md';
							break;
						default:
							fileName = `${data.docType.replace(/\s+/g, '_').toUpperCase()}.md`;
							break;
					}
					// Check if file already exists in workspace
					const wsFolders = vscode.workspace.workspaceFolders;
					if (wsFolders && wsFolders.length > 0) {
						const wsUri = wsFolders[0].uri;
						const foundFiles = await vscode.workspace.findFiles(`**/${fileName}`);
						if (foundFiles.length > 0) {
							this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: `This file already exists at: ${foundFiles[0].fsPath}` });
						} else {
							// Gather workspace context for AI
							const { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } = require('./langchain-backend/features');
							const filenamesTool = new RetrieveWorkspaceFilenamesTool();
							const fileListStr = await filenamesTool._call();
							const fileList = fileListStr.split('\n').filter((line: string) => line && !line.startsWith('Files in the workspace:'));
							const contentTool = new RetrieveFileContentTool();
							const filesAndContents = [];
							for (let i = 0; i < Math.min(fileList.length, 20); i++) {
	 							const path = fileList[i];
	 							console.log('[NaruhoDocs][DEBUG] Scanning file:', path);
	 							const content = await contentTool._call(path);
	 							filesAndContents.push({ path, content });
							}
							// Use AI to generate starter content
							let aiContent = '';
							try {
								const chat = createChat({ apiKey: this.apiKey, maxHistoryMessages: 10 });
								aiContent = await chat.chat(`Generate a starter documentation for ${fileName} based on this project. Here are the workspace files and contents:
${filesAndContents.map(f => `File: ${f.path}\n${f.content}`).join('\n\n')}`);
							} catch (err) {
								aiContent = `# ${data.docType}\n\nDescribe your documentation needs here.`;
							}
							const fileUri = vscode.Uri.joinPath(wsUri, fileName);
							try {
								await vscode.workspace.fs.writeFile(fileUri, Buffer.from(aiContent, 'utf8'));
								this._view?.webview.postMessage({ type: 'docCreated', filePath: fileUri.fsPath });
								console.log('[NaruhoDocs] Doc created:', fileUri.fsPath);
								// Trigger a fresh scan to update modal choices
								await vscode.commands.executeCommand('naruhodocs.scanDocs');
								console.log('[NaruhoDocs] scanDocs triggered after doc creation');
							} catch (err: any) {
								this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: `Error creating doc: ${err.message}` });
							}
						}
					} else {
						this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: 'No workspace folder open.' });
					}
					break;
				}
				case 'setThreadBeginnerMode': {
					await this.setThreadBeginnerMode(data.sessionId);
					break;
				}
				case 'setThreadDeveloperMode': {
					await this.setThreadDeveloperMode(data.sessionId);
					break;
				}
				case 'sendMessage': {
					const userMessage = data.value as string;
					try {
						if (!session) { throw new Error('No active thread'); }
						const botResponse = await session.chat(userMessage);
						this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: botResponse });
						// Save history after message
						if (this.activeThreadId && session) {
							const history = session.getHistory();
							await this.context.workspaceState.update(`thread-history-${this.activeThreadId}`, history);
						}
					} catch (error: any) {
						this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: `Error: ${error.message || 'Unable to connect to LLM.'}` });
					}
					break;
				}
				case 'resetSession': {
					if (session) { session.reset(); }
					this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: 'Conversation reset.' });
					// Clear history in storage
					if (this.activeThreadId) {
						await this.context.workspaceState.update(`thread-history-${this.activeThreadId}`, []);
					}
					break;
				}
				case 'switchThread': {
					const sessionId = data.sessionId as string;
					this.setActiveThread(sessionId);
					break;
				}
				case 'createFile': {
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
	}

	public postMessage(message: any) {
		if (this._view) {
			this._view.webview.postMessage(message);
		}
	}

	// Create a new thread/session for a document
	public createThread(sessionId: string, initialContext: string, title: string) {
		if (!this.sessions.has(sessionId)) {
			const sysMessage = SystemMessages.DOCUMENT_SPECIFIC_DEVELOPER(title, initialContext);
			// Try to load history from workspaceState
			const savedHistory = this.context.workspaceState.get<any[]>(`thread-history-${sessionId}`);
			const session = createChat({ apiKey: this.apiKey, maxHistoryMessages: 40, systemMessage: sysMessage });
			if (savedHistory && Array.isArray(savedHistory)) {
				session.setHistory(savedHistory);
			}
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

			const isGeneralTab = this.activeThreadId === 'naruhodocs-general-thread';
			this._view.webview.postMessage({ type: 'toggleGeneralTabUI', visible: isGeneralTab });
		}
	}


	private _getHtmlForWebview(webview: vscode.Webview) {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
		const markdownItUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'markdown-it', 'dist', 'markdown-it.min.js'));
		const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
		const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
		const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
		const styleMarkdownUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'markdown.css'));
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
				<link href="${styleMarkdownUri}" rel="stylesheet">
				
				<title>NaruhoDocs Chat</title>
			</head>
			<body>
				<div class="chat-container">
					<div class="chat-header" style="margin-bottom:12px; position:relative;">
						<span id="hamburger-menu" style="cursor:pointer; background:#f3f3f3; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.04);">
							<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<line x1="4" y1="7" x2="20" y2="7"></line>
								<line x1="4" y1="12" x2="20" y2="12"></line>
								<line x1="4" y1="17" x2="20" y2="17"></line>
							</svg>
						</span>
						<span id="current-doc-name"></span>
						<div id="dropdown-container" style="display:none; position:absolute; left:0; top:40px; z-index:10;">
							<div id="thread-list-menu"></div>
						</div>
					</div>
					<!-- ...existing chat UI... -->
					<div id="general-buttons" style="display:none; margin-top:18px; justify-content:center;">
						<button id="generate-doc-btn" style="margin-right:8px;">Generate Document</button>
						<button id="suggest-template-btn">Suggest Template</button>
					</div>
					<div id="thread-tabs" style="display:flex; gap:4px; margin-bottom:8px;"></div>
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
						<!--<button id="create-file-btn" style="margin-top:10px;">Create Default File</button>-->
					</div>
				</div>

				<script nonce="${nonce}" src="${markdownItUri}"></script>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}

	private async restoreThreads(keys: readonly string[]) {
		for (const key of keys) {
			if (key.startsWith('thread-history-')) {
				const sessionId = key.replace('thread-history-', '');
				const savedHistory = this.context.workspaceState.get<any[]>(key);
				const title = sessionId.split('/').pop() || sessionId;
				let documentText = '';
				try {
					const uri = vscode.Uri.parse(sessionId);
					const doc = await vscode.workspace.openTextDocument(uri);
					documentText = doc.getText();
				} catch (e) {
					documentText = '';
				}
				this.createThread(sessionId, documentText, title);
			}
		}
		this._postThreadList();
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