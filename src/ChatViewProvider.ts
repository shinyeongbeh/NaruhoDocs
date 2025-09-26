import * as vscode from 'vscode';
import { ChatSession } from './langchain-backend/llm';
import { LLMService } from './managers/LLMService';
import { SystemMessages } from './SystemMessages';
import { LLMProviderManager } from './llm-providers/manager';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { DocumentSuggestion } from './general-purpose/DocumentSuggestion';
import { generateDocument } from './general-purpose/GenerateDocument';
import { BeginnerDevMode } from './document-based/BeginnerDevMode';
import { getNonce } from './utils/utils';
import { ThreadManager } from './managers/ThreadManager';
import * as path from 'path';
import * as fs from 'fs';
import { OutputLogger } from './utils/OutputLogger';
import { generateTemplate } from './general-purpose/GenerateTemplate';

export class ChatViewProvider implements vscode.WebviewViewProvider {
	private documentSuggestion = new DocumentSuggestion();
	private setBeginnerDevMode = new BeginnerDevMode();

	private existingDocFiles: string[] = [];
	private didDevCleanupOnce: boolean = false;
	private fileWatcher?: vscode.FileSystemWatcher;
	private isInitializing: boolean = true;
	// Track last sent normalized history signature per thread to suppress redundant redraws
	private lastSentHistorySignatures: Map<string, string> = new Map();
	// Track last sent diagram count per thread so we can force resend when diagrams appear/disappear
	private lastSentDiagramCounts: Map<string, number> = new Map();

	// Compute a simple signature of a session's current normalized history
	private computeHistorySignature(session: ChatSession): string {
		try {
			const raw = session.getHistory();
			return raw.map((msg: any) => {
				let role: string | undefined = msg.type || (typeof msg._getType === 'function' ? msg._getType() : undefined);
				if (!role || role === 'unknown') {
					const ctor = msg.constructor?.name?.toLowerCase?.() || '';
					if (ctor.includes('human')) { role = 'human'; }
					else if (ctor.includes('ai')) { role = 'ai'; }
				}
				if (role === 'user') { role = 'human'; }
				if (role === 'assistant' || role === 'bot') { role = 'ai'; }
				const text = typeof msg.content === 'string' ? msg.content : msg.text || JSON.stringify(msg.content);
				return (role || 'unknown') + '::' + text;
			}).join('\u0001');
		} catch { return ''; }
	}

	public static readonly viewType = 'naruhodocs.chatView';

	private _view?: vscode.WebviewView;

	private static instance: LLMService;
	private threadManager: ThreadManager;
	private llmService!: LLMService;

	private context: vscode.ExtensionContext;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private apiKey?: string, // Keep for backward compatibility
		context?: vscode.ExtensionContext,
		private llmManager?: LLMProviderManager
	) {
		this.context = context!;
		this.llmService = LLMService.getOrCreate(this.llmManager!);

		// Initialize thread manager
		this.threadManager = new ThreadManager(
			this.context,
			this.apiKey,
			this.llmManager,
			() => this._postThreadList() // Callback for thread list changes
		);

		this.llmService.setThreadManager(this.threadManager);

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
	public async scanDocs() {
		try {
			const filesAndContents = await this.documentSuggestion.getWorkspaceFilesAndContents();
			const aiSuggestions = await this.documentSuggestion.getAISuggestions(this.llmService, filesAndContents);
			this.postMessage({
				type: 'aiSuggestedDocs',
				suggestions: aiSuggestions,
				existingFiles: filesAndContents.map(f => f.path.split(/[/\\]/).pop()?.toLowerCase())
			});
		} catch (e: any) {
			this.postMessage({ type: 'addMessage', sender: 'System', message: `Error scanning docs: ${e.message || e}` });
		}
	}

	private _detectDiagram(text: string | undefined): boolean {
		return typeof text === 'string' && /```mermaid[\s\S]*?```/i.test(text);
	}

	/**
	 * Send a message to a specific thread and display the bot response.
	 */
	public async sendMessageToThread(sessionId: string, prompt: string) {
		await this.threadManager.setActiveThread(sessionId);
		const session = this.threadManager.getSession(sessionId);
		if (!session) {
			this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: 'No active thread.' });
			return Promise.resolve('No active thread.');
		}
		// Immediately show user message (with diagram tagging if applicable)
		this._view?.webview.postMessage({ type: 'addMessage', sender: 'You', message: prompt, messageType: this._detectDiagram(prompt) ? 'diagram' : undefined });

		try {
			const botResponse = await this.llmService.trackedChat({
				sessionId,
				systemMessage: this.threadManager.getSystemMessage(sessionId) || SystemMessages.GENERAL_PURPOSE,
				prompt,
				task: 'chat'
			});
			// session.chat already appended Human + AI messages; do NOT duplicate.
			this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: botResponse, messageType: this._detectDiagram(botResponse) ? 'diagram' : undefined });
			await this.threadManager.saveThreadHistory(sessionId);
			return botResponse;
		} catch (error: any) {
			const errorMsg = `Error: ${error.message || 'Unable to connect to LLM.'}`;
			// Persist the error as an AI message so saved history matches displayed conversation
			try { session.getHistory().push(new AIMessage(errorMsg)); await this.threadManager.saveThreadHistory(sessionId); } catch { /* ignore */ }
			this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: errorMsg });
			return errorMsg;
		}
	}

	/**
	 * Post a system-level message to the webview (non-user/non-bot semantic).
	 * Use for lifecycle events like provider changes, resets, or configuration notices.
	 */
	public addSystemMessage(message: string) {
		this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message });
	}

	/**
	 * Append a bot (AI) message directly to the active session history without creating a paired user message.
	 * Used for internally generated context like visualizations so they appear as bot output only.
	 */
	public async addBotMessage(message: string, meta?: { messageType?: string; flags?: string[] }): Promise<void> {
		try {
			const activeThreadId = this.threadManager.getActiveThreadId();
			if (!activeThreadId) { return; }
			const session = this.threadManager.getSession(activeThreadId);
			if (!session) { return; }
			// IMPORTANT: session.getHistory() returns a filtered COPY (system message removed), so pushing
			// to it does NOT mutate the underlying chat session history. We must reconstruct and call setHistory.
			const existing = session.getHistory().map((m: any) => {
				let role: string | undefined = m.type || (typeof m._getType === 'function' ? m._getType() : undefined);
				if (!role || role === 'unknown') {
					const ctor = m.constructor?.name?.toLowerCase?.() || '';
					if (ctor.includes('human')) { role = 'human'; }
					else if (ctor.includes('ai')) { role = 'ai'; }
				}
				if (role === 'user') { role = 'human'; }
				if (role === 'assistant' || role === 'bot') { role = 'ai'; }
				const text = (m as any).text || (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
				return { type: role, text };
			});
			const updated = [...existing, { type: 'ai', text: message }];
			(session as any).setHistory(updated as any);
			await this.threadManager.saveThreadHistory(activeThreadId);
			// Also push to UI immediately
			const inferredType = this._detectDiagram(message) ? 'diagram' : undefined;
			this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message, messageType: meta?.messageType || inferredType, flags: meta?.flags });
		} catch (e) {
			console.warn('[NaruhoDocs] Failed to add bot message:', e);
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

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				setTimeout(() => {
					try { this._postThreadList(); } catch (e) { console.warn('[NaruhoDocs] postThreadList on visibility:', e); }
					try {
						const activeId = this.threadManager.getActiveThreadId();
						if (activeId) {
							const session = this.threadManager.getSession(activeId);
							if (session) {
								const sig = this.computeHistorySignature(session);
								const last = this.lastSentHistorySignatures.get(activeId);
								if (sig !== last) { this._sendFullHistory(activeId, sig); }
							}
						}
					} catch (e) { console.warn('[NaruhoDocs] conditional sendFullHistory on visibility failed:', e); }
				}, 200);
			}
		});

		// Also ensure we resend when the view is first resolved (in case it wasn't sent earlier)
		try {
			setTimeout(() => {
				try { this._postThreadList(); } catch (e) { /* noop */ }
				try { this._sendFullHistory(); } catch (e) { /* noop */ }
			}, 50);
		} catch (e) {
			console.warn('[NaruhoDocs] Failed to populate view on resolve:', e);
		}

		webviewView.webview.onDidReceiveMessage(async data => {
			if (data.type === 'vscodeReloadWindow') {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
				return;
			}
			if (data.type === 'chatViewReady') {
				const webviewSignature: string | undefined = data.historySignature;
				(webviewView as any)._naruhodocsReady = true;

				const sendAllHistories = () => {
					try {
						const all: Record<string, Array<{ sender: string; message: string }>> = {};
						for (const [id, session] of this.threadManager.getSessions()) {
							const raw = session.getHistory();
							const normalized = raw.map((msg: any) => {
								let role: string | undefined = msg.type || (typeof msg._getType === 'function' ? msg._getType() : undefined);
								if (!role || role === 'unknown') {
									const ctor = msg.constructor?.name?.toLowerCase?.() || '';
									if (ctor.includes('human')) { role = 'human'; }
									else if (ctor.includes('ai')) { role = 'ai'; }
								}
								if (role === 'user') { role = 'human'; }
								if (role === 'assistant' || role === 'bot') { role = 'ai'; }
								const sender = role === 'human' ? 'You' : 'Bot';
								const text = typeof msg.content === 'string' ? msg.content : msg.text || JSON.stringify(msg.content);
								return { sender, message: text };
							});
							all[id] = normalized;
						}
						this._view?.webview.postMessage({ type: 'allThreadHistories', histories: all });
					} catch (e) {
						console.warn('[NaruhoDocs] Failed to send allThreadHistories:', e);
					}
				};

				// This logic should only run ONCE when the extension first starts
				if (this.isInitializing) {
					this.isInitializing = false;

					// Correctly initialize and restore all threads
					await this.threadManager.restoreThreads(this.context.workspaceState.keys());
					await this.threadManager.initializeGeneralThread();
					this._postThreadList();

					const lastActiveId = this.context.globalState.get<string>('lastActiveThreadId');
					const finalActiveId = (lastActiveId && this.threadManager.hasSession(lastActiveId))
						? lastActiveId
						: 'naruhodocs-general-thread';

					this.setActiveThread(finalActiveId);
					await new Promise(resolve => setTimeout(resolve, 100));
					try {
						this._postThreadList();
						// Avoid clearing messages; cached HTML may already be present.
						this._sendFullHistory(finalActiveId);
						sendAllHistories();
					} catch (e) {
						console.warn('[NaruhoDocs] Failed to populate restored history on init:', e);
					}
				} else {
					// Subsequent webview (re)creation after sidebar close/reopen.
					// Always re-send thread list and history so general thread is not blank if initial
					// setFullHistory was missed due to timing.
					const activeId = this.threadManager.getActiveThreadId() || 'naruhodocs-general-thread';
					setTimeout(() => {
						try { this._postThreadList(); } catch (e) { console.warn('[NaruhoDocs] postThreadList on re-ready failed:', e); }
						// Do not clear existing messages; just refresh active thread history.
						try { this._sendFullHistory(activeId); } catch (e) { console.warn('[NaruhoDocs] sendFullHistory on re-ready failed:', e); }
						try { sendAllHistories(); } catch (e) { /* ignore */ }
					}, 60);
				}
				return;
			}
			// Webview received message
			if (data.type === 'scanDocs') {
				// scanDocs triggered from webview
				await vscode.commands.executeCommand('naruhodocs.scanDocs');
				return;
			}
			if (data.type === 'existingDocs') {
				this.existingDocFiles = Array.isArray(data.files) ? data.files : [];
				return;
			}
			if (data.type === 'clearHistory') {
				const activeThreadId = this.threadManager.getActiveThreadId();
				if (activeThreadId) {
					await this.threadManager.resetSession(activeThreadId);
					this._view?.webview.postMessage({ type: 'historyCleared' });
					this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: 'Chat history for this tab has been cleared.' });
				}
				// --- END: CORRECTED CLEAR HISTORY LOGIC ---
			}
			if (data.type === 'generateTemplate') {
				this.addSystemMessage('Generating template...');
				generateTemplate(this.llmService, data.templateType);
			}

			const session = this.threadManager.getActiveSession();
			switch (data.type) {
				// case 'refreshThread': {
				// 	const activeThreadId = this.threadManager.getActiveThreadId();
				// 	if (activeThreadId) {
				// 		try {
				// 			// Reinitialize the LLM service
				// 			await this.llmService.clearAllSessions();
				// 			await this.llmManager?.initializeFromConfig();
				// 			// Reinitialize the active thread
				// 			const session = this.threadManager.getSession(activeThreadId);
				// 			if (session) {
				// 				await this.threadManager.reinitializeSessions(this.llmService);
				// 				this._sendFullHistory(activeThreadId);
				// 				this._view?.webview.postMessage({
				// 					type: 'addMessage',
				// 					sender: 'System',
				// 					message: '🔄 Chat session refreshed successfully.'
				// 				});
				// 			}
				// 		} catch (error) {
				// 			this._view?.webview.postMessage({
				// 				type: 'addMessage',
				// 				sender: 'System',
				// 				message: `❌ Failed to refresh chat session: ${error}`
				// 			});
				// 		}
				// 	}
				// 	break;
				// }
				case 'generateDoc': {
					// generateDoc triggered (doc-generate thread)
					this.addSystemMessage('Generating documentation...');
					await generateDocument(this.llmService, data);
					break;
				}
                case 'setThreadBeginnerMode': {
                    const sys = await this.setBeginnerDevMode.setThreadBeginnerMode(data.sessionId, this.threadManager.getSessions(), this.threadManager.getThreadTitles());
                    if (sys) { this.threadManager.setSystemMessage(data.sessionId, sys); }
                    break;
                }
                case 'setThreadDeveloperMode': {
                    const sys = await this.setBeginnerDevMode.setThreadDeveloperMode(data.sessionId, this.threadManager.getSessions(), this.threadManager.getThreadTitles());
                    if (sys) { this.threadManager.setSystemMessage(data.sessionId, sys); }
                    break;
                }
				case 'setGeneralBeginnerMode': {
					// Apply beginner system message for General thread only
					const sessionId = 'naruhodocs-general-thread';
					const sys = (require('./SystemMessages') as any).GENERAL_BEGINNER as string;
					const session = this.threadManager.getSession(sessionId);
					if (session && typeof (session as any).setCustomSystemMessage === 'function') {
						try { (session as any).setCustomSystemMessage(sys); } catch {}
					}
					this.threadManager.setSystemMessage(sessionId, sys);
					break;
				}
				case 'setGeneralDeveloperMode': {
					// Developer mode for General reverts to GENERAL_PURPOSE
					const sessionId = 'naruhodocs-general-thread';
					const sys = SystemMessages.GENERAL_PURPOSE;
					const session = this.threadManager.getSession(sessionId);
					if (session && typeof (session as any).setCustomSystemMessage === 'function') {
						try { (session as any).setCustomSystemMessage(sys); } catch {}
					}
					this.threadManager.setSystemMessage(sessionId, sys);
					break;
				}
				case 'sendMessage': {
					const userMessage = data.value as string;
					console.log('[NaruhoDocs] Backend received sendMessage:', userMessage);
					let activeThreadId = this.threadManager.getActiveThreadId();
					if (!activeThreadId) {
						// Graceful fallback: auto-initialize general thread if somehow missing
						try {
							await this.threadManager.initializeGeneralThread();
							activeThreadId = this.threadManager.getActiveThreadId();
						} catch (e) {
							this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: 'Error: Unable to initialize general thread.' });
							break;
						}
						if (!activeThreadId) {
							this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: 'Error: No active thread available.' });
							break;
						}
						// Also refresh thread list and history so UI catches up
						try { this._postThreadList(); } catch { /* ignore */ }
						try { this._sendFullHistory(activeThreadId); } catch { /* ignore */ }
					}
					const activeSession = this.threadManager.getSession(activeThreadId);
					try {
						if (!activeSession) { throw new Error('No active thread'); }
						this._view?.webview.postMessage({ type: 'addMessage', sender: 'You', message: userMessage });
						const systemMsg = this.threadManager.getSystemMessage(activeThreadId);
						const botResponse = await this.llmService.trackedChat({
							sessionId: activeThreadId,
							systemMessage: systemMsg || SystemMessages.GENERAL_PURPOSE,
							prompt: userMessage,
							task: 'chat'
						});
						// Append to in-memory history
						// session.chat already added messages; only display & persist
						this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: botResponse });
						
						await this.threadManager.saveThreadHistory(activeThreadId);
					} catch (error: any) {
						const errMsg = `Error: ${error.message || 'Unable to connect to LLM.'}`;
						try { activeSession?.getHistory().push(new AIMessage(errMsg)); await this.threadManager.saveThreadHistory(activeThreadId); } catch { /* ignore */ }
						this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message: errMsg });
					}
					break;
				}
				case 'resetSession': {
					const activeThreadId = this.threadManager.getActiveThreadId();
					const historyBeforeReset = session ? session.getHistory() : [];

					// Chat reset requested verbose log removed

					if (session && activeThreadId) {
						await this.threadManager.resetSession(activeThreadId);
					}

					this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message: '🔄 Conversation reset. Chat history cleared.' });

					break;
				}
				case 'switchThread': {
					const sessionId = data.sessionId as string;
					this.threadManager.setActiveThread(sessionId);
					this._sendFullHistory(sessionId);
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
					// Create a default file in the workspace root or docs folder
					const wsFolders = vscode.workspace.workspaceFolders;
					if (wsFolders && wsFolders.length > 0) {
						const wsUri = wsFolders[0].uri;
						// Check if /docs folder exists, if so save there, otherwise save to root
						const docsUri = vscode.Uri.joinPath(wsUri, 'docs');
						let targetFolder = wsUri;
						try {
							const docsStat = await vscode.workspace.fs.stat(docsUri);
							if (docsStat.type === vscode.FileType.Directory) {
								targetFolder = docsUri;
							}
						} catch {
							// /docs doesn't exist, use root folder
						}
						
						const fileUri = vscode.Uri.joinPath(targetFolder, 'NaruhoDocsFile.txt');
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
						const suggestedName = await this.llmService.trackedChat({
							sessionId: 'chatview:filename-suggest',
							systemMessage: 'You suggest concise filesystem-friendly markdown filenames.',
							prompt: `Suggest a concise, filesystem-friendly filename (with .md extension) for a ${templateType} documentation file. Do not include the word 'template' in the filename. Respond with only the filename, no explanation.`,
							task: 'generate_doc',
							forceNew: true
						});
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
						// Save in workspace root or docs folder if it exists
						const wsFolders = vscode.workspace.workspaceFolders;
						if (wsFolders && wsFolders.length > 0) {
							const wsUri = wsFolders[0].uri;
							// Check if /docs folder exists, if so save there, otherwise save to root
							const docsUri = vscode.Uri.joinPath(wsUri, 'docs');
							let targetFolder = wsUri;
							try {
								const docsStat = await vscode.workspace.fs.stat(docsUri);
								if (docsStat.type === vscode.FileType.Directory) {
									targetFolder = docsUri;
								}
							} catch {
								// /docs doesn't exist, use root folder
							}
							
							const templateFileUri = vscode.Uri.joinPath(targetFolder, fileName);
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
							const parentUri = fileUri.with({ path: parentPaths.join('/') });
							
							// Check if /docs folder exists in the workspace, if so save there, otherwise use the parent URI
							const wsFolders = vscode.workspace.workspaceFolders;
							let targetFolder = parentUri;
							if (wsFolders && wsFolders.length > 0) {
								const wsUri = wsFolders[0].uri;
								const docsUri = vscode.Uri.joinPath(wsUri, 'docs');
								try {
									const docsStat = await vscode.workspace.fs.stat(docsUri);
									if (docsStat.type === vscode.FileType.Directory) {
										targetFolder = docsUri;
									}
								} catch {
									// /docs doesn't exist, use parent URI
								}
							}
							
							const templateFileUri = vscode.Uri.joinPath(targetFolder, fileName);
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

		// Legacy provider update chat message removed. Provider change is now announced
		// exclusively via extension.ts calling addSystemMessage("Provider changed to ...").

		// Recreate the general purpose session with the new provider
		// Recreate ALL sessions so that history is preserved across provider changes.
		// LLMService.clearAllSessions() is invoked externally (extension.ts) before this call.
		// We now obtain a fresh LLMService instance and ask ThreadManager to reinitialize its sessions.
		if (this.llmManager) {
			this.llmService = LLMService.getOrCreate(this.llmManager);
			this.threadManager.reinitializeSessions(this.llmService)
				.catch(err => {
					console.error('Failed to reinitialize sessions after provider change:', err);
					if (this._view) {
						this._view.webview.postMessage({
							type: 'addMessage',
							sender: 'System',
							message: `❌ Failed to reinitialize sessions after provider change: ${err.message}`
						});
					}
				});
		}
	}

	// Create a new thread/session for a document
	public createThread(sessionId: string, initialContext: string, title: string) {
		this.threadManager.createThread(sessionId, initialContext, title);
	}

	// ...existing code...
	public async setActiveThread(sessionId: string) {
		await this.threadManager.setActiveThread(sessionId);
		// Update UI thread list immediately
		try {
			this._postThreadList();
		} catch (e) {
			console.warn('[NaruhoDocs] Failed to post thread list after setActiveThread:', e);
		}
		// Send the full normalized history for the newly active thread to the webview
		try {
			this._sendFullHistory(sessionId);
		} catch (e) {
			console.warn('[NaruhoDocs] Failed to send full history after setActiveThread:', e);
		}
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

			// Chat reset (command palette) verbose log removed

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

	/**
	 * Normalize and send entire history for the active thread in one atomic message to avoid
	 * flicker and race conditions with iterative addMessage calls after webview recreation.
	 */
	private _sendFullHistory(sessionId?: string, precomputedSignature?: string) {
		if (!this._view) { return; }
		const activeId = sessionId || this.threadManager.getActiveThreadId();
		if (!activeId) { return; }
		const session = this.threadManager.getSession(activeId);
		if (!session) { return; }
		try {
			const raw = session.getHistory();
			if (this.context.extensionMode === vscode.ExtensionMode.Development) {
				console.log('[NaruhoDocs][History] Raw history length:', raw.length, 'for session', activeId);
			}
				const normalized: Array<{ sender: string; message: string; messageType?: string; rawMermaid?: string }> = raw
				.filter((msg: any) => {
					// Filter out RAG Query system/context messages
					// You can adjust this filter as needed for your app
					// Example: skip if message contains 'Prompt-engineered RAG Query' or 'Retrieved Context:'
					const text = typeof msg.content === 'string' ? msg.content : msg.text || JSON.stringify(msg.content);
					if (typeof text === 'string' && (
						text.includes('Prompt-engineered RAG Query') &&
						text.includes('Retrieved Context:') &&
						text.startsWith('\nQuery:')
					)) {
						return false;
					}
					return true;
				})
				.map((msg: any) => {
					let role: string | undefined = msg.type || (typeof msg._getType === 'function' ? msg._getType() : undefined);
					if (!role || role === 'unknown') {
						const ctor = msg.constructor?.name?.toLowerCase?.() || '';
						if (ctor.includes('human')) { role = 'human'; }
						else if (ctor.includes('ai')) { role = 'ai'; }
					}
					if (role === 'user') { role = 'human'; }
					if (role === 'assistant' || role === 'bot') { role = 'ai'; }
					const sender = role === 'human' ? 'You' : 'Bot';
					const text = typeof msg.content === 'string' ? msg.content : msg.text || JSON.stringify(msg.content);
					const isDiagram = this._detectDiagram(text);
					let rawMermaid: string | undefined;
					if (isDiagram) {
						const match = text.match(/```mermaid\s*([\s\S]*?)```/i);
						if (match) { rawMermaid = match[1].trim(); }
					}
					return { sender, message: text, messageType: isDiagram ? 'diagram' : undefined, rawMermaid };
				});
			if (this.context.extensionMode === vscode.ExtensionMode.Development) {
				console.log('[NaruhoDocs][History] Normalized history length:', normalized.length);
			}
			// Logging stats
			try {
				const diagramCount = normalized.filter(n => !!n.rawMermaid || /```mermaid/.test(n.message)).length;
				OutputLogger.history(`_sendFullHistory thread=${activeId} messages=${normalized.length} diagrams=${diagramCount}`);
				// Force resend logic: if diagram count changed or diagrams present but signature suppression would skip, we'll bypass
				const lastDiagramCount = this.lastSentDiagramCounts.get(activeId);
				const sig = precomputedSignature || this.computeHistorySignature(session);
				const lastSig = this.lastSentHistorySignatures.get(activeId);
				const diagramCountChanged = lastDiagramCount === undefined || lastDiagramCount !== diagramCount;
				const shouldForce = diagramCount > 0 && diagramCountChanged;
				if (shouldForce) {
					OutputLogger.history(`Forcing history resend (diagramCountChanged) thread=${activeId} old=${lastDiagramCount} new=${diagramCount}`);
					// Intentionally do not early-return on signature match below.
					this.lastSentHistorySignatures.delete(activeId); // clear to ensure send
				}
				// Update counts now
				this.lastSentDiagramCounts.set(activeId, diagramCount);
				// If signature unchanged and not forced, skip
				if (!shouldForce && lastSig && sig === lastSig) {
					OutputLogger.history(`Suppressing resend (signature unchanged) thread=${activeId} sig=${sig.slice(0,24)}... diagrams=${diagramCount}`);
					return; // Skip sending to avoid flicker
				}
				// Proceed to send and record signature below
				precomputedSignature = sig;
			} catch {/* ignore */}
			// Fallback: if raw has items but normalized becomes empty (unexpected), replay manually
			if (raw.length > 0 && normalized.length === 0) {
				if (this._isVerbose()) { console.warn('[NaruhoDocs][History] Normalized empty; falling back to manual replay'); }
				this._view.webview.postMessage({ type: 'clearMessages' });
				for (const msg of raw) {
					let role: string | undefined = (msg as any).type || (typeof (msg as any)._getType === 'function' ? (msg as any)._getType() : undefined);
					if (!role || role === 'unknown') {
						const ctor = msg.constructor?.name?.toLowerCase?.() || '';
						if (ctor.includes('human')) { role = 'human'; }
						else if (ctor.includes('ai')) { role = 'ai'; }
					}
					if (role === 'user') { role = 'human'; }
					if (role === 'assistant' || role === 'bot') { role = 'ai'; }
					const sender = role === 'human' ? 'You' : 'Bot';
					const content = typeof (msg as any).content === 'string' ? (msg as any).content : (msg as any).text || JSON.stringify((msg as any).content);
					this._view.webview.postMessage({ type: 'addMessage', sender, message: content });
				}
				return;
			}
			this._view.webview.postMessage({ type: 'setFullHistory', history: normalized });
			// Record signature so we can suppress redundant redraws later
			try {
				const sigFinal = precomputedSignature || this.computeHistorySignature(session);
				this.lastSentHistorySignatures.set(activeId, sigFinal);
			} catch { /* ignore */ }
		} catch (e) {
			console.warn('Failed to send full history:', e);
			OutputLogger.error(`_sendFullHistory failed thread=${sessionId || 'active'}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private _isVerbose(): boolean {
		try {
			if (this.context.extensionMode === vscode.ExtensionMode.Development) { return true; }
			const cfg = vscode.workspace.getConfiguration('naruhodocs');
			return !!cfg.get<boolean>('logging.verbose');
		} catch { return false; }
	}


	private _getHtmlForWebview(webview: vscode.Webview) {
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
		const markdownItUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'markdown-it.min.js'));
		const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'mermaid.min.js'));
		const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
		const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
		const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));
		const styleMarkdownUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'markdown.css'));
		const sendIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'send.svg'));
		const hamburgerIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'hamburger.svg'));
		const refreshIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'refresh.svg'));
		const closeIconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'close.svg'));
		const nonce = getNonce();


		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
					Use a content security policy to only allow loading images from https or from our extension directory,
					and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">

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
					<div class="chat-header">
						<div class="menu-div">
							<span id="hamburger-menu" class="hamburger-menu-class">
								<img src="${hamburgerIconUri}" width="20" height="20" alt="Menu" class="hamburger-icon">
								<img src="${closeIconUri}" width="20" height="20" alt="Close" class="close-icon" style="display: none;">
							</span>
						</div>
						<div class="current-doc">
							<span id="current-doc-name"></span>
						</div>
						<div class="chat-header-right-buttons">
							<button class="refresh-vectordb" id="refresh-vectordb" title="Rebuild the database for RAG" >
								<img src="${refreshIconUri}" width="16" height="16" alt="Refresh">
							</button>
							<button id="clear-history" title="Clear all chat history">Clear History</button>
						</div>
						<div id="dropdown-container" class="dropdown-container-class">
							<div id="thread-list-menu"></div>
						</div>
					</div>
					<!-- ...existing chat UI... -->
					   <!-- General buttons moved below chat messages, above chat input -->
					   <div id="general-buttons" class="general-buttons-class">
						   <button id="generate-doc-btn" class="generate-doc-btn-class">Generate Document</button>
						   <button id="suggest-template-btn" class="suggest-template-btn-class">Suggest Template</button>
						   <button id="visualize-btn">Visualize</button>
					   </div>
					<div id="thread-tabs" class="thread-tabs-class"></div>
					   <div id="chat-messages" class="chat-messages"></div>
					   <!-- General buttons will be shown here above the chat input box -->
					   <div id="general-buttons-anchor"></div>
					   <div class="chat-input-container">
						<div class="chat-input-wrapper">
							<textarea id="chat-input" class="chat-input" placeholder="How can I help?"></textarea>
							<span id="send-icon" class="send-icon-class">
								<img src="${sendIconUri}" width="18" height="18" alt="Send">
							</span>
						</div>
						<!--<button id="create-file-btn">Create Default File</button>-->
					</div>
				</div>

				<script nonce="${nonce}" src="${markdownItUri}"></script>
				<script nonce="${nonce}" src="${mermaidUri}"></script>
				<script nonce="${nonce}" src="${scriptUri}"></script>
				<script nonce="${nonce}">
					console.log("[Webview] Inline sanity check script ran ✅");
				</script>
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
			if (!activeThreadId) {
				console.warn('No active thread available to add context');
				return;
			}

			const session = this.threadManager.getSession(activeThreadId);
			if (!session) {
				console.warn('No active session found to add context');
				return;
			}

			// --- START: FIX ---
			// Get current history and add the new context correctly
			const history = session.getHistory();
			history.push(new HumanMessage(userMessage));
			history.push(new AIMessage(botResponse));

			// Save the updated history using the thread manager's method
			this.threadManager.saveThreadHistory(activeThreadId);
			// --- END: FIX ---

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