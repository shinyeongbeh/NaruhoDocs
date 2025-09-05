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
		if (sessionId === 'naruhodocs-general-thread') {
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
		if (sessionId === 'naruhodocs-general-thread') {
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
			return Promise.resolve('No active thread.');
		}
		// Immediately show user message
		this._view?.webview.postMessage({ type: 'addMessage', sender: 'You', message: prompt });
		// Await and return bot response
		try {
			const botResponse = await session.chat(prompt);
			this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: botResponse });
			const history = session.getHistory();
			await this.context.workspaceState.update(`thread-history-${sessionId}`, history);
			return botResponse;
		} catch (error: any) {
			const errorMsg = `Error: ${error.message || 'Unable to connect to LLM.'}`;
			this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: errorMsg });
			return errorMsg;
		}
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
		} catch { }

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
				case 'suggestTemplate': {
					// Generate template using AI and show save modal
					let templateContent = '';
					try {
						if (!session) { throw new Error('No active thread');}
						templateContent = await session.chat(`Generate a documentation template for ${data.templateType || 'this project'}.`);
					} catch (err) {
						templateContent = 'Unable to generate template.';
					}
					this._view?.webview.postMessage({
						type: 'showSaveTemplateButtons',
						template: templateContent,
						sessionId: this.activeThreadId
					});
					break;
				}
				case 'generateDoc': {
					console.log('[NaruhoDocs] generateDoc triggered:', data.docType, data.fileName);
					// Use AI-provided filename if available, otherwise fallback
					let fileName = data.fileName && typeof data.fileName === 'string' && data.fileName.trim() !== ''
						? data.fileName.trim()
						: `${data.docType.replace(/\s+/g, '_').toUpperCase()}.md`;
					const wsFolders = vscode.workspace.workspaceFolders;
					if (wsFolders && wsFolders.length > 0) {
						const wsUri = wsFolders[0].uri;
						const foundFiles = await vscode.workspace.findFiles(`**/${fileName}`);
						if (foundFiles.length > 0) {
							this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: `This file already exists at: ${foundFiles[0].fsPath}` });
						} else {
							// Gather workspace filenames
							const { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } = require('./langchain-backend/features');
							const filenamesTool = new RetrieveWorkspaceFilenamesTool();
							const fileListStr = await filenamesTool._call();
							const fileList = fileListStr.split('\n').filter((line: string) => line && !line.startsWith('Files in the workspace:'));

							// Always include project metadata and README/config files for richer context
							const metaFiles = ['package.json', 'tsconfig.json', 'README.md', 'readme.md', 'api_reference.md', 'API_REFERENCE.md'];
							const extraFiles = fileList.filter((f: string) => metaFiles.includes(f.split(/[/\\]/).pop()?.toLowerCase() || ''));

							// Ask AI which files are relevant for documentation
							const sys = `You are an AI assistant that helps users create project documentation files based on the project files and contents. 
							The output should be in markdown format. Do not include code fences or explanations, just the documentation. 
							First, select the most relevant files from this list for generating documentation for ${fileName}. 
							Always include project metadata and README/config files if available. Return only a JSON array of file paths, no explanation.`;
							const chat = createChat({ apiKey: this.apiKey, maxHistoryMessages: 10, systemMessage: sys });
							let relevantFiles: string[] = [];
							try {
								const aiResponse = await chat.chat(
									`Here is the list of files in the workspace:\n${fileList.join('\n')}
									\nWhich files are most relevant for generating documentation for ${fileName}? 
									Always include project metadata and README/config files if available. Return only a JSON array of file paths.`
								);
								// Try to parse the AI response as JSON array
								const match = aiResponse.match(/\[.*\]/s);
								if (match) {
									relevantFiles = JSON.parse(match[0]);
								} else {
									// fallback: use all files
									relevantFiles = fileList;
								}
							} catch (err) {
								relevantFiles = fileList;
							}
							// Ensure meta files are always included
							for (const meta of extraFiles) {
								if (!relevantFiles.includes(meta)) {
									relevantFiles.push(meta);
								}
							}
							// Now scan only relevant files
							const contentTool = new RetrieveFileContentTool();
							const filesAndContents = [];
							for (const path of relevantFiles) {
								try {
									const content = await contentTool._call(path);
									filesAndContents.push({ path, content });
								} catch (e) { }
							}
							// Use AI to generate starter content
							let aiContent = '';
							try {
								const sys2 = `
								You are an impeccable and meticulous technical documentation specialist. Your purpose is to produce clear, accurate, and professional technical documents based on the given content.

								Primary Goal: Generate high-quality technical documentation that is comprehensive, logically structured, and easy for the intended audience to understand.

								Instructions:
								You will be given the file name of the documentation to create, along with the relevant files and their contents from the user's project workspace.
								Your task is to analyze these files and generate a well-organized documentation file that thoroughly covers the subject matter implied by the file name.

								Mandatory Rules:
								Do not include private or sensitive information from the provided files. For example, API keys.
								Handling Ambiguity: If a user request is vague or missing critical information (e.g., a technical name, a specific version, or the document's purpose), you must respond by asking for the necessary details. Never make assumptions or generate generic content.
								Clarity and Simplicity: Prioritize clarity and conciseness above all else. Use plain language, active voice, and short sentences. Avoid jargon, buzzwords, and redundant phrases unless they are essential for technical accuracy.
								Structured Content: All documents must follow a clear, hierarchical structure using Markdown.
								Actionable and Factual: Documents must be useful. For guides, provide clear, step-by-step instructions. For concepts, provide accurate, verifiable information. Do not include opinions or subjective statements.
								Review and Refine: Before finalizing, internally review the document for consistency, accuracy, and adherence to these rules. Ensure all headings are descriptive and the flow is logical.
								Formatting: The final output must be in markdown format. Do not include code fences, explanations, or conversational text.
								`;
								const chat2 = createChat({ apiKey: this.apiKey, maxHistoryMessages: 10, systemMessage: sys2 });
								const filesAndContentsString = filesAndContents.map(f => `File: ${f.path}\n${f.content}`).join('\n\n');
								aiContent = await chat2.chat(`
									Generate a starter documentation for ${fileName} based on this project. 
									Here are the relevant workspace files and contents:\n${filesAndContentsString}`);
								aiContent = aiContent.replace(/^```markdown\s*/i, '').replace(/^\*\*\*markdown\s*/i, '').replace(/```$/g, '').trim();
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
							} catch (err) {
								const errorMsg = typeof err === 'object' && err !== null && 'message' in err ? (err as any).message : String(err);
								this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: `Error creating doc: ${errorMsg}` });
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
						// If the user message is a template request, show save prompt
						if (/generate (a )?.*template/i.test(userMessage)) {
							this._view?.webview.postMessage({
								type: 'showSaveTemplateButtons',
								template: botResponse,
								sessionId: this.activeThreadId
							});
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
				//this one Shin created for saving translation
				case 'createAndSaveFile':
					{
						// Accept a text parameter for file content
						const text = data.text || '';
						const uri = data.uri || '';
						let newUri = '';
						if (uri) {
							try {
								const fileUri = vscode.Uri.parse(uri);
								// Get parent folder URI
								const parentPaths = fileUri.path.split('/');
								const originalFileName = parentPaths.pop() || '';
								// Insert '-translated' before extension
								const dotIdx = originalFileName.lastIndexOf('.');
								let translatedFileName = '';
								if (dotIdx > 0) {
									translatedFileName = originalFileName.slice(0, dotIdx) + '-translated' + originalFileName.slice(dotIdx);
								} else {
									translatedFileName = originalFileName + '-translated';
								}
								const translatedFileUri = vscode.Uri.joinPath(fileUri.with({ path: parentPaths.join('/') }), translatedFileName);

								const content = text ? Buffer.from(text, 'utf8') : new Uint8Array();
								await vscode.workspace.fs.writeFile(translatedFileUri, content);
								this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: `File created: ${translatedFileUri.fsPath}` });


							} catch (e: any) {
								newUri = '';
								this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: `Error creating file: ${e.message}` });
							}
						} else {
							this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: 'No valid folder to save translated file.' });
						}
						break;
					}
				case 'createAndSaveTemplateFile': {
					let text = data.text || '';
					text = text.replace(/^```markdown\s*/i, '')
						.replace(/^\*\*\*markdown\s*/i, '')
						.replace(/```$/g, '')
						.trim();

					const uri = data.uri || '';
					const generalThreadId = 'naruhodocs-general-thread';

					// ✅ Always use selection for filename
					const baseType = (data.docType || data.templateType || 'generic').toLowerCase();

					// Normalize → lowercase, snake_case, safe characters
					const suggestedFileName = baseType
						.trim()
						.replace(/\s+/g, '_')      // spaces → underscores
						.replace(/[^\w\-]/g, '')   // remove unsafe chars
						+ '_template.md';

					if (uri === generalThreadId || !uri) {
						// Save in workspace root
						const wsFolders = vscode.workspace.workspaceFolders;
						if (wsFolders && wsFolders.length > 0) {
							const wsUri = wsFolders[0].uri;
							const templateFileUri = vscode.Uri.joinPath(wsUri, suggestedFileName);
							const content = text ? Buffer.from(text, 'utf8') : new Uint8Array();
							try {
								await vscode.workspace.fs.writeFile(templateFileUri, content);
								this._view?.webview.postMessage({
									type: 'addMessage',
									sender: 'System',
									message: `Template file created: ${templateFileUri.fsPath}`
								});
							} catch (e: any) {
								this._view?.webview.postMessage({
									type: 'addMessage',
									sender: 'System',
									message: `Error creating template file: ${e.message}`
								});
							}
						} else {
							this._view?.webview.postMessage({
								type: 'addMessage',
								sender: 'System',
								message: 'No workspace folder open.'
							});
						}
					} else {
						try {
							const fileUri = vscode.Uri.parse(uri);
							const parentPaths = fileUri.path.split('/');
							const templateFileUri = vscode.Uri.joinPath(fileUri.with({ path: parentPaths.join('/') }), suggestedFileName);
							const content = text ? Buffer.from(text, 'utf8') : new Uint8Array();
							await vscode.workspace.fs.writeFile(templateFileUri, content);
							this._view?.webview.postMessage({
								type: 'addMessage',
								sender: 'System',
								message: `Template file created: ${templateFileUri.fsPath}`
							});
						} catch (e: any) {
							this._view?.webview.postMessage({
								type: 'addMessage',
								sender: 'System',
								message: `Error creating template file: ${e.message}`
							});
						}
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