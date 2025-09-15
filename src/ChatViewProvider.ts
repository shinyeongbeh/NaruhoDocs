import * as vscode from 'vscode';
import { createChat, ChatSession } from './langchain-backend/llm';
import { SystemMessages } from './SystemMessages';
import { LLMProviderManager } from './llm-providers/manager';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { DocumentSuggestion } from './general-purpose/DocumentSuggestion';
import { GenerateDocument } from './general-purpose/GenerateDocument';
import { BeginnerDevMode } from './document-based/BeginnerDevMode';
import { getNonce } from './utils/utils';
import { ThreadManager } from './managers/ThreadManager';

export class ChatViewProvider implements vscode.WebviewViewProvider {
	private documentSuggestion = new DocumentSuggestion();
	private docGenerate = new GenerateDocument();
	private setBeginnerDevMode = new BeginnerDevMode();

	private existingDocFiles: string[] = [];
	private didDevCleanupOnce: boolean = false;
	private fileWatcher?: vscode.FileSystemWatcher;

	public static readonly viewType = 'naruhodocs.chatView';

	private _view?: vscode.WebviewView;

	// Thread management - delegated to ThreadManager
	private threadManager: ThreadManager;

	private context: vscode.ExtensionContext;
	constructor(
		private readonly _extensionUri: vscode.Uri,
		private apiKey?: string, // Keep for backward compatibility
		context?: vscode.ExtensionContext,
		private llmManager?: LLMProviderManager
	) {
		this.context = context!;

		// Initialize thread manager
		this.threadManager = new ThreadManager(
			this.context,
			this.apiKey,
			this.llmManager,
			() => this._postThreadList() // Callback for thread list changes
		);

		// Initialize the general-purpose thread
		this.threadManager.initializeGeneralThread().catch(error => {
			console.error('Failed to initialize general thread:', error);
		});

		// Watch for file deletions (markdown/txt)
		this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{md,txt}');
		this.fileWatcher.onDidDelete(async (uri) => {
			const sessionId = uri.toString();
			await this.threadManager.removeThread(sessionId);
			if (this._view) {
				this._view.webview.postMessage({ type: 'resetState' });
			}
		});
	}

	// Scan documents in workspace and get document suggestions from AI 
	async scanDocs() {
		// Get all filenames and contents
		const filesAndContents = await this.documentSuggestion.getWorkspaceFilesAndContents();
		// Get AI suggestions
		const aiSuggestions = await this.documentSuggestion.getAISuggestions(filesAndContents);
		console.log('AI suggestions: ', aiSuggestions);
		// Pass all AI suggestions to modal, but filter after AI generates
		this.postMessage({
			type: 'aiSuggestedDocs',
			suggestions: aiSuggestions,
			existingFiles: filesAndContents.map(f => f.path.split(/[/\\]/).pop()?.toLowerCase())
		});
	}

	/**
	 * Send a message to a specific thread and display the bot response.
	 */
	public async sendMessageToThread(sessionId: string, prompt: string) {
		this.threadManager.setActiveThread(sessionId);
		const session = this.threadManager.getSession(sessionId);
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
			await this.threadManager.saveThreadHistory(sessionId);
			return botResponse;
		} catch (error: any) {
			const errorMsg = `Error: ${error.message || 'Unable to connect to LLM.'}`;
			this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: errorMsg });
			return errorMsg;
		}
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
			await this.threadManager.resetDevState();
			this.didDevCleanupOnce = true;
		}

		// Restore threads from workspaceState
		const keys = this.context.workspaceState.keys ? this.context.workspaceState.keys() : [];
		await this.threadManager.restoreThreads(keys);

		// Ensure currently open documents are represented as threads when the view opens
		try {
			const openDocs = vscode.workspace.textDocuments;
			for (const document of openDocs) {
				const fileNameLower = document.fileName.toLowerCase();
				if (fileNameLower.endsWith('.md') || fileNameLower.endsWith('.txt')) {
					const sessionId = document.uri.toString();
					this.threadManager.createThread(sessionId, document.getText(), document.fileName);
				}
			}
		} catch { }

		// 🔥 Always push active thread + history when webview is first resolved
		this._postThreadList();
		const activeThreadId = this.threadManager.getActiveThreadId();
		if (activeThreadId) {
			const session = this.threadManager.getSession(activeThreadId);
			if (session) {
				const history = session.getHistory();
				this._view?.webview.postMessage({ type: 'showHistory', history });
			}
		}

		// Refresh UI whenever the view becomes visible again (e.g., after switching panels)
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this._postThreadList();
				const activeThreadId = this.threadManager.getActiveThreadId();
				if (activeThreadId) {
					const session = this.threadManager.getSession(activeThreadId);
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
			const session = this.threadManager.getActiveSession();
			switch (data.type) {
				// case 'suggestTemplate': {
				// 	// Generate template using AI and show save modal
				// 	let templateContent = '';
				// 	try {
				// 		if (!session) { throw new Error('No active thread'); }
				// 		templateContent = await session.chat(`Generate a documentation template for ${data.templateType || 'this project'}.`);
				// 	} catch (err) {
				// 		templateContent = 'Unable to generate template.';
				// 	}
				// 	this._view?.webview.postMessage({
				// 		type: 'showSaveTemplateButtons',
				// 		template: templateContent,
				// 		sessionId: this.activeThreadId,
				// 		templateType: data.templateType || 'README'
				// 	});
				// 	break;
				// }
				case 'generateDoc': {
					console.log('[NaruhoDocs] generateDoc triggered (doc-generate thread):', data.docType, data.fileName);

					const response = await this.docGenerate.generate(data);	
					console.log('Response from docGenerate.generate:', response);
					this._view?.webview.postMessage({ type: response.type, sender: response.sender, message: response.message });

					break;				
				}
				case 'setThreadBeginnerMode': {
					await this.setBeginnerDevMode.setThreadBeginnerMode(data.sessionId, this.threadManager.getSessions(), this.threadManager.getThreadTitles());
					break;
				}
				case 'setThreadDeveloperMode': {
					await this.setBeginnerDevMode.setThreadDeveloperMode(data.sessionId, this.threadManager.getSessions(), this.threadManager.getThreadTitles());
					break;
				}
				case 'sendMessage': {
					const userMessage = data.value as string;
					
					// Log initial message processing
					const activeThreadId = this.threadManager.getActiveThreadId();
					console.log('=== MESSAGE PROCESSING START ===\n' +
						`Raw User Message: ${userMessage}\n` +
						`Session Available: ${!!session}\n` +
						`Active Thread ID: ${activeThreadId}\n` +
						'================================');
					
					try {
						if (!session) { throw new Error('No active thread'); }
						// If the user message is a template request, scan files and generate a template with full context
						if (/generate (a )?.*template/i.test(userMessage)) {
							// Extract template type
							let templateType = 'README';
							const match = userMessage.match(/generate (?:a )?(.*) template/i);
							if (match && match[1]) {
								templateType = match[1].trim();
							}
							// Gather workspace filenames
							const { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } = require('./langchain-backend/features');
							const filenamesTool = new RetrieveWorkspaceFilenamesTool();
							const fileListStr = await filenamesTool._call();
							const fileList = fileListStr.split('\n').filter((line: string) => line && !line.startsWith('Files in the workspace:'));

							// Always include project metadata and README/config files for richer context
							const metaFiles = ['package.json', 'tsconfig.json', 'README.md', 'readme.md', 'api_reference.md', 'API_REFERENCE.md'];
							const extraFiles = fileList.filter((f: string) => metaFiles.includes(f.split(/[/\\]/).pop()?.toLowerCase() || ''));

							// Ask AI which files are relevant for documentation
							const sys = `You are an AI assistant that helps users create project documentation templates based on the project files and contents.\nThe output should be in markdown format. Do not include code fences or explanations, just the template.\nFirst, select ALL the relevant files from this list for generating a ${templateType} template. You need to select as many files as needed but be concise.\nAlways include project metadata and README/config files if available. Return only a JSON array of file paths, no explanation.`;
							const chat = createChat({ apiKey: this.apiKey, maxHistoryMessages: 10, systemMessage: sys });
							let relevantFiles: string[] = [];
							try {
								const aiResponse = await chat.chat(
									`Here is the list of files in the workspace:\n${fileList.join('\n')}\n\nWhich files are most relevant for generating a ${templateType} template? Always include project metadata and README/config files if available. Return only a JSON array of file paths.`
								);
								// Try to parse the AI response as JSON array
								const matchFiles = aiResponse.match(/\[.*\]/s);
								if (matchFiles) {
									relevantFiles = JSON.parse(matchFiles[0]);
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
							// Use AI to generate template content
							let templateContent = '';
							try {
								const sys2 = `You are an impeccable and meticulous technical documentation specialist. Your purpose is to produce clear, accurate, and professional documentation templates based on the given content.\n\nPrimary Goal: Generate a high-quality documentation template for ${templateType} that is comprehensive, logically structured, and easy for the intended audience to use.\n\nInstructions:\nYou will be given the template type to create, along with the relevant files and their contents from the user's project workspace.\nYour task is to analyze these files and generate a well-organized documentation template that thoroughly covers the subject matter implied by the template type.\nYou may use tools (retrieve_workspace_filenames, retrieve_file_content) to retrieve additional file contents if needed without user prompted.\n\nMandatory Rules:\n- Do not include private or sensitive information from the provided files. For example, API keys.\n- Clarity and Simplicity: Prioritize clarity and conciseness above all else. Use plain language, active voice, and short sentences. Avoid jargon, buzzwords, and redundant phrases unless they are essential for technical accuracy.\n- Structured Content: All templates must follow a clear, hierarchical structure using Markdown.\n- Formatting: The final output must be in markdown format. Do not include code fences, explanations, or conversational text.\n- Never return empty or placeholder content. If you determine that this project truly does not need this template, respond with a clear explanation such as: 'This project does not require a [${templateType}] template because ...' and do not generate a file.`;
								const chat2 = createChat({ apiKey: this.apiKey, maxHistoryMessages: 10, systemMessage: sys2 });
								const filesAndContentsString = filesAndContents.map(f => `File: ${f.path}\n${f.content}`).join('\n\n');
								
								// Log template generation context
								console.log('=== TEMPLATE GENERATION REQUEST ===\n' +
									`Template Type: ${templateType}\n` +
									`System Message Length: ${sys2.length} chars\n` +
									`Relevant Files Count: ${relevantFiles.length}\n` +
									`Relevant Files: ${relevantFiles.join(', ')}\n` +
									`Total Content Length: ${filesAndContentsString.length} chars\n` +
									`Files and Contents Preview (first 500 chars): ${filesAndContentsString.substring(0, 500)}...\n` +
									'====================================');
								
								templateContent = await chat2.chat(`Generate a documentation template for ${templateType} based on this project. Here are the relevant workspace files and contents:\n${filesAndContentsString}`);
								templateContent = templateContent.replace(/^```markdown\s*/i, '').replace(/^\*\*\*markdown\s*/i, '').replace(/```$/g, '').trim();
							} catch (err) {
								templateContent = `This project does not require a [${templateType}] template because no relevant content was found.`;
							}
							this._view?.webview.postMessage({
								type: 'addMessage',
								sender: 'Bot',
								message: templateContent
							});
							// Save history after message
							const activeThreadId = this.threadManager.getActiveThreadId();
							if (activeThreadId && session) {
								await this.threadManager.saveThreadHistory(activeThreadId);
							}
							this._view?.webview.postMessage({
								type: 'showSaveTemplateButtons',
								template: templateContent,
								sessionId: activeThreadId,
								templateType
							});
						} else {
							// Default: just chat as before
							
							// Log the current context that will be sent to the LLM
							const activeThreadId = this.threadManager.getActiveThreadId();
							const currentHistory = session.getHistory();
							const sessionSystemMessage = (session as any).systemMessage || 'No system message';
							const historyPreview = currentHistory.map((msg: any, index: any) => {
								const msgType = (msg as any).type || 'unknown';
								const msgContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
								const truncatedContent = msgContent.length > 200 ? msgContent.substring(0, 200) + '...' : msgContent;
								return `  [${index}] ${msgType}: ${truncatedContent}`;
							}).join('\n');
							
							console.log('=== USER MESSAGE SENT ===\n' +
								`User Message: ${userMessage}\n` +
								`Active Thread ID: ${activeThreadId}\n` +
								`Current Conversation History (${currentHistory.length} messages):\n${historyPreview}\n` +
								`System Message: ${sessionSystemMessage}\n` +
								`About to send to LLM - Total context messages: ${currentHistory.length + 1}\n` +
								'========================');
							
							const botResponse = await session.chat(userMessage);
							this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: botResponse });
							// Save history after message
							if (activeThreadId && session) {
								await this.threadManager.saveThreadHistory(activeThreadId);
							}
						}
					} catch (error: any) {
						this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: `Error: ${error.message || 'Unable to connect to LLM.'}` });
					}
					break;
				}
				case 'resetSession': {
					const activeThreadId = this.threadManager.getActiveThreadId();
					const historyBeforeReset = session ? session.getHistory() : [];
					
					console.log('=== CHAT RESET REQUESTED ===\n' +
						`Active Thread ID: ${activeThreadId}\n` +
						`Session Available: ${!!session}\n` +
						`Messages in history before reset: ${historyBeforeReset.length}\n` +
						'===========================');
					
					if (session && activeThreadId) { 
						await this.threadManager.resetSession(activeThreadId);
					}
					
					this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: '🔄 Conversation reset. Chat history cleared.' });
					
					break;
				}
				case 'switchThread': {
					const sessionId = data.sessionId as string;
					
					// Clear current conversation display
					this._view?.webview.postMessage({ type: 'clearMessages' });
					
					// Switch to the new thread
					this.threadManager.setActiveThread(sessionId);
					
					// Load and display the conversation history for the new thread
					const newSession = this.threadManager.getSession(sessionId);
					if (newSession) {
						const history = newSession.getHistory();
						
						// Send each message in the history to the webview
						for (const msg of history) {
							const sender = msg instanceof HumanMessage ? 'You' : 'Bot';
							const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
							this._view?.webview.postMessage({ 
								type: 'addMessage', 
								sender: sender, 
								message: content 
							});
						}
						
						console.log(`=== SWITCHED TO THREAD ===\n` +
							`Thread ID: ${sessionId}\n` +
							`Loaded ${history.length} messages\n` +
							`Thread Title: ${this.threadManager.getThreadTitles().get(sessionId) || 'Unknown'}\n` +
							'========================');
					} else {
						console.log(`=== SWITCHED TO NEW THREAD ===\n` +
							`Thread ID: ${sessionId}\n` +
							`No existing history found\n` +
							'============================');
					}
					
					break;
				}
				case 'showVisualizationMenu': {
					// Trigger the visualization menu via command
					await vscode.commands.executeCommand('naruhodocs.showVisualizationMenu');
					break;
				}
				case 'showNotification': {
					// Show VS Code notification with the provided message
					const message = data.message || 'Notification';
					const messageType = data.messageType || 'info';
					
					switch (messageType) {
						case 'error':
							vscode.window.showErrorMessage(message);
							break;
						case 'warning':
							vscode.window.showWarningMessage(message);
							break;
						case 'info':
						default:
							vscode.window.showInformationMessage(message);
							break;
					}
					break;
				}
				case 'openFullWindowDiagram': {
					// Create a new webview panel that covers the entire VS Code window
					this.openDiagramInFullWindow(data.mermaidCode, data.diagramId, data.title);
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

					// Use AI to suggest filename if possible, fallback to sanitized template type
					let aiFilename = '';
					let aiTried = false;
					const templateType = (data.docType || data.templateType || 'generic').toLowerCase();
					try {
						const tempChat = createChat({ apiKey: this.apiKey, maxHistoryMessages: 10 });
						const suggestedName = await tempChat.chat(`Suggest a concise, filesystem-friendly filename (with .md extension) for a ${templateType} documentation file. Do not include the word 'template' in the filename. Respond with only the filename, no explanation.`);
						aiFilename = (suggestedName || '').trim();
					} catch (e) {
						aiFilename = '';
					}
					let fileName = '';
					if (aiFilename && /^(?![. ]).+\.md$/i.test(aiFilename) && !/[\\/:*?"<>|]/.test(aiFilename)) {
						// Remove _template.md or .md and add _template.md
						fileName = aiFilename.replace(/(_template)?\.md$/i, '') + '_template.md';
					} else {
						fileName = templateType
							.trim()
							.replace(/\s+/g, '_')
							.replace(/[^\w\-]/g, '')
							+ '_template.md';
					}

					if (uri === generalThreadId || !uri) {
						// Save in workspace root
						const wsFolders = vscode.workspace.workspaceFolders;
						if (wsFolders && wsFolders.length > 0) {
							const wsUri = wsFolders[0].uri;
							const templateFileUri = vscode.Uri.joinPath(wsUri, fileName);
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
							const templateFileUri = vscode.Uri.joinPath(fileUri.with({ path: parentPaths.join('/') }), fileName);
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

	public updateLLMManager(newLLMManager: LLMProviderManager) {
		this.llmManager = newLLMManager;
		
		// Show provider update message with more details
		const currentProvider = this.llmManager.getCurrentProvider();
		if (this._view && currentProvider) {
			let providerInfo = `✅ LLM Provider updated to: ${currentProvider.name}`;
			
			// Add provider-specific info
			if (currentProvider.name === 'Local LLM') {
				// Try to get backend info for local provider
				const localProvider = currentProvider as any;
				if (localProvider.getBackendInfo) {
					const backendInfo = localProvider.getBackendInfo();
					if (backendInfo) {
						providerInfo += ` (${backendInfo.type} - ${backendInfo.defaultModel})`;
					}
				}
			} else if (currentProvider.name.includes('Gemini')) {
				// Add usage info for Gemini providers
				this.llmManager.getUsageInfo().then(usage => {
					if (usage && !usage.isUnlimited) {
						const remainingInfo = ` (${usage.requestsRemaining} requests remaining today)`;
						this._view?.webview.postMessage({ 
							type: 'addMessage', 
							sender: 'System', 
							message: providerInfo + remainingInfo 
						});
					}
				}).catch(() => {
					// Ignore usage info errors
				});
				return; // Skip the immediate message since we're doing async
			}
			
			this._view.webview.postMessage({ 
				type: 'addMessage', 
				sender: 'System', 
				message: providerInfo 
			});
		}
		
		// Update the thread manager with the new LLM manager
		this.threadManager.updateLLMManager(newLLMManager).catch(error => {
			console.error('Failed to update thread manager LLM provider:', error);
			if (this._view) {
				this._view.webview.postMessage({ 
					type: 'addMessage', 
					sender: 'System', 
					message: `❌ Failed to update LLM provider: ${error.message}` 
				});
			}
		});
	}

	// Create a new thread/session for a document
	public createThread(sessionId: string, initialContext: string, title: string) {
		this.threadManager.createThread(sessionId, initialContext, title);
	}

	// Switch active thread
	public setActiveThread(sessionId: string) {
		this.threadManager.setActiveThread(sessionId);
	}

	// Reset current active chat session
	public async resetActiveChat() {
		const activeThreadId = this.threadManager.getActiveThreadId();
		if (!activeThreadId) {
			vscode.window.showWarningMessage('No active chat session to reset.');
			return;
		}

		const session = this.threadManager.getSession(activeThreadId);
		if (session) {
			const historyBeforeReset = session.getHistory();
			
			console.log('=== CHAT RESET (Command Palette) ===\n' +
				`Active Thread ID: ${activeThreadId}\n` +
				`Session Available: ${!!session}\n` +
				`Messages in history before reset: ${historyBeforeReset.length}\n` +
				'=======================================');
			
			await this.threadManager.resetSession(activeThreadId);
			
			// Notify webview
			this.postMessage({ type: 'addMessage', sender: 'System', message: '🔄 Conversation reset. Chat history cleared.' });
			
			// Show success message
			vscode.window.showInformationMessage('Chat conversation has been reset.');
		} else {
			vscode.window.showWarningMessage('No active chat session found.');
		}
	}

	private _postThreadList() {
		if (this._view) {
			const { threads, activeThreadId } = this.threadManager.getThreadListData();
			this._view.webview.postMessage({ type: 'threadList', threads, activeThreadId });

			const isGeneralTab = activeThreadId === 'naruhodocs-general-thread';
			this._view.webview.postMessage({ type: 'toggleGeneralTabUI', visible: isGeneralTab });
		}
	}


	private _getHtmlForWebview(webview: vscode.Webview) {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
		const markdownItUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'markdown-it', 'dist', 'markdown-it.min.js'));
		const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'));
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
				
				<style>
				/* Removed reset chat icon styles */
				</style>
				
				<title>NaruhoDocs Chat</title>
			</head>
			<body>
				<div class="chat-container">
					<div class="chat-header" style="margin-bottom:12px; position:relative; display:flex; align-items:center; padding:0 8px;">
						<div style="flex:0 0 auto;">
							<span id="hamburger-menu" style="cursor:pointer; background:#f3f3f3; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.04); display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px;">
								<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<line x1="4" y1="7" x2="20" y2="7"></line>
									<line x1="4" y1="12" x2="20" y2="12"></line>
									<line x1="4" y1="17" x2="20" y2="17"></line>
								</svg>
							</span>
						</div>
						<div style="flex:1 1 auto; text-align:center;">
							<span id="current-doc-name"></span>
						</div>
						<div id="dropdown-container" style="display:none; position:absolute; left:0; top:40px; z-index:10;">
							<div id="thread-list-menu"></div>
						</div>
					</div>
					<!-- ...existing chat UI... -->
					   <!-- General buttons moved below chat messages, above chat input -->
					   <div id="general-buttons" style="display:none; margin-top:18px; justify-content:center; margin-bottom:8px;">
						   <button id="generate-doc-btn" style="margin-right:8px;">Generate Document</button>
						   <button id="suggest-template-btn" style="margin-right:8px;">Suggest Template</button>
						   <button id="visualize-btn">Visualize</button>
					   </div>
					<div id="thread-tabs" style="display:flex; gap:4px; margin-bottom:8px;"></div>
					   <div id="chat-messages" class="chat-messages"></div>
					   <!-- General buttons will be shown here above the chat input box -->
					   <div id="general-buttons-anchor"></div>
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
				<script nonce="${nonce}" src="${mermaidUri}"></script>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}

	/**
	 * Add context to the active AI session
	 * This allows other components to add relevant context to the chat history
	 */
	public addContextToActiveSession(userMessage: string, botResponse: string): void {
		try {
			const activeThreadId = this.threadManager.getActiveThreadId();
			console.log('=== ADDING CONTEXT TO ACTIVE SESSION ===\n' +
				`User Message: ${userMessage.substring(0, 100)}...\n` +
				`Bot Response: ${botResponse.substring(0, 100)}...\n` +
				`Active Thread ID: ${activeThreadId}\n` +
				'========================================');
			
			if (!activeThreadId) {
				console.warn('No active thread available to add context');
				return;
			}

			const session = this.threadManager.getSession(activeThreadId);
			if (!session) {
				console.warn('No active session found to add context');
				return;
			}

			// Get current history and build new history including the context
			const currentHistory = session.getHistory();
			console.log(`Current history length before adding context: ${currentHistory.length}`);
			
			// Build the new history array with the added context
			// Convert existing history to the format expected by setHistory
			const existingHistoryFormatted = currentHistory.map((msg: any) => ({
				type: msg instanceof HumanMessage ? 'human' : 'ai',
				text: msg.content as string
			}));
			
			// Add new context messages
			const newContextMessages = [
				{ type: 'human', text: userMessage },
				{ type: 'ai', text: botResponse }
			];
			
			const completeHistory = [...existingHistoryFormatted, ...newContextMessages];
			
			// Update the session history using the proper method
			session.setHistory(completeHistory as any);
			
			// Verify the update worked
			const updatedHistory = session.getHistory();
			console.log(`Updated history length after adding context: ${updatedHistory.length}`);
			
			// Update the workspace state with the serialized history
			this.context.workspaceState.update(`thread-history-${activeThreadId}`, completeHistory);
			
			console.log('Successfully added context to AI session history');
			
		} catch (error) {
			console.error('Error adding context to active session:', error);
		}
	}

	private openDiagramInFullWindow(mermaidCode: string, diagramId: string, title: string): void {
		// Create a new webview panel that covers the entire VS Code window
		const panel = vscode.window.createWebviewPanel(
			'naruhodocsDiagram',
			title || 'Diagram View',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);

		// Get CSS resources
		const styleResetUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
		const styleVSCodeUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
		const styleMainUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

		// Create the HTML content for the full window diagram
		panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link href="${styleResetUri}" rel="stylesheet">
	<link href="${styleVSCodeUri}" rel="stylesheet">
	<link href="${styleMainUri}" rel="stylesheet">
	<title>${title}</title>
	<script src="https://unpkg.com/mermaid@10/dist/mermaid.min.js"></script>
	<style>
		body {
			padding: 20px;
			background: var(--vscode-editor-background);
			color: var(--vscode-foreground);
			font-family: var(--vscode-font-family);
			height: 100vh;
			margin: 0;
			display: flex;
			flex-direction: column;
		}
		.diagram-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 20px;
			padding-bottom: 10px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.diagram-title {
			font-size: 18px;
			font-weight: bold;
			margin: 0;
		}
		.diagram-controls {
			display: flex;
			gap: 8px;
		}
		.control-btn {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: 1px solid var(--vscode-button-border, transparent);
			border-radius: 6px;
			padding: 8px 16px;
			cursor: pointer;
			font-size: 13px;
			font-weight: 500;
			transition: all 0.2s ease;
			user-select: none;
		}
		.control-btn:hover {
			background: var(--vscode-button-hoverBackground);
			transform: translateY(-1px);
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
		}
		.control-btn:active {
			transform: translateY(0);
		}
		.diagram-container {
			flex: 1;
			display: flex;
			justify-content: center;
			align-items: center;
			overflow: hidden;
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 6px;
			padding: 20px;
			position: relative;
			cursor: grab;
		}
		.diagram-container:active {
			cursor: grabbing;
		}
		.diagram-content {
			max-width: 100%;
			max-height: 100%;
			text-align: center;
			transition: transform 0.1s ease;
		}
		.diagram-content svg {
			max-width: none;
			height: auto;
			transform-origin: center;
			transition: transform 0.3s ease;
		}
	</style>
</head>
<body>
	<div class="diagram-header">
		<h1 class="diagram-title">${title}</h1>
		<div class="diagram-controls">
			<button class="control-btn" id="zoom-out">Zoom Out</button>
			<button class="control-btn" id="zoom-reset">100%</button>
			<button class="control-btn" id="zoom-in">Zoom In</button>
			<button class="control-btn" id="export-btn">Export</button>
			<button class="control-btn" id="close-btn">Close</button>
		</div>
	</div>
	<div class="diagram-container">
		<div class="diagram-content" id="diagram-content">
			<div id="mermaid-diagram"></div>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		
		// Initialize Mermaid
		mermaid.initialize({ 
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

		// Render the diagram
		const mermaidCode = \`${mermaidCode.replace(/`/g, '\\`')}\`;
		const diagramElement = document.getElementById('mermaid-diagram');
		
		mermaid.render('diagram-${diagramId}', mermaidCode)
			.then(({ svg }) => {
				diagramElement.innerHTML = svg;
				
				// Set up zoom and drag functionality
				const svgElement = diagramElement.querySelector('svg');
				const container = document.querySelector('.diagram-container');
				const content = document.querySelector('.diagram-content');
				let currentZoom = 1;
				const zoomStep = 0.2;
				
				// Dragging state
				let isDragging = false;
				let dragStart = { x: 0, y: 0 };
				let translateX = 0;
				let translateY = 0;
				
				function updateTransform() {
					if (content) {
						content.style.transform = \`translate(\${translateX}px, \${translateY}px)\`;
					}
					if (svgElement) {
						svgElement.style.transform = \`scale(\${currentZoom})\`;
					}
				}
				
				function updateZoom(newZoom) {
					currentZoom = Math.max(0.3, Math.min(5, newZoom));
					updateTransform();
					document.getElementById('zoom-reset').textContent = \`\${Math.round(currentZoom * 100)}%\`;
				}
				
				// Mouse drag functionality
				if (container && content) {
					container.addEventListener('mousedown', (e) => {
						isDragging = true;
						dragStart.x = e.clientX - translateX;
						dragStart.y = e.clientY - translateY;
						container.style.cursor = 'grabbing';
						e.preventDefault();
					});
					
					document.addEventListener('mousemove', (e) => {
						if (isDragging) {
							translateX = e.clientX - dragStart.x;
							translateY = e.clientY - dragStart.y;
							updateTransform();
						}
					});
					
					document.addEventListener('mouseup', () => {
						if (isDragging) {
							isDragging = false;
							container.style.cursor = 'grab';
						}
					});
					
					// Reset position on double-click
					container.addEventListener('dblclick', () => {
						translateX = 0;
						translateY = 0;
						updateTransform();
					});
				}
				
				document.getElementById('zoom-in').onclick = () => updateZoom(currentZoom + zoomStep);
				document.getElementById('zoom-out').onclick = () => updateZoom(currentZoom - zoomStep);
				document.getElementById('zoom-reset').onclick = () => {
					updateZoom(1);
					translateX = 0;
					translateY = 0;
					updateTransform();
				};
				
				// Export functionality
				document.getElementById('export-btn').onclick = () => {
					if (svgElement) {
						const svgData = new XMLSerializer().serializeToString(svgElement);
						const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
						const downloadLink = document.createElement('a');
						downloadLink.href = URL.createObjectURL(svgBlob);
						downloadLink.download = '${diagramId || 'diagram'}.svg';
						document.body.appendChild(downloadLink);
						downloadLink.click();
						document.body.removeChild(downloadLink);
						URL.revokeObjectURL(downloadLink.href);
						
						// Notify user of export location
						vscode.postMessage({
							type: 'showNotification',
							message: 'Diagram exported as ${diagramId || 'diagram'}.svg to your Downloads folder',
							messageType: 'info'
						});
					}
				};
			})
			.catch(error => {
				diagramElement.innerHTML = \`<p style="color: var(--vscode-errorForeground);">Failed to render diagram: \${error.message}</p>\`;
			});

		// Close button functionality
		document.getElementById('close-btn').onclick = () => {
			vscode.postMessage({ type: 'closeDiagramPanel' });
		};

		// Keyboard shortcuts
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				document.getElementById('close-btn').click();
			} else if (e.key === '+' || e.key === '=') {
				e.preventDefault();
				document.getElementById('zoom-in').click();
			} else if (e.key === '-') {
				e.preventDefault();
				document.getElementById('zoom-out').click();
			} else if (e.key === '0') {
				e.preventDefault();
				document.getElementById('zoom-reset').click();
			}
		});
	</script>
</body>
</html>`;

		// Handle messages from the diagram panel
		panel.webview.onDidReceiveMessage(message => {
			if (message.type === 'closeDiagramPanel') {
				panel.dispose();
			} else if (message.type === 'showNotification') {
				// Forward notification to VS Code
				switch (message.messageType) {
					case 'error':
						vscode.window.showErrorMessage(message.message);
						break;
					case 'warning':
						vscode.window.showWarningMessage(message.message);
						break;
					case 'info':
					default:
						vscode.window.showInformationMessage(message.message);
						break;
				}
			}
		});
	}
}