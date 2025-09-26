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

	/** Resolve the chat view webview (restored clean implementation). */
	public resolveWebviewView(view: vscode.WebviewView): void {
		this._view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri]
		};
		view.webview.html = this._getHtmlForWebview(view.webview);

		// Send initial thread list & history (if any)
		try { this._postThreadList(); } catch { /* ignore */ }
		const activeId = this.threadManager.getActiveThreadId();
		if (activeId) { try { this._sendFullHistory(activeId); } catch { /* ignore */ } }

		view.webview.onDidReceiveMessage(async (data) => {
			try {
				switch (data.type) {
					case 'chatViewReady': {
						// Compare signature to avoid double rendering
						const active = this.threadManager.getActiveThreadId();
						if (active) {
							const session = this.threadManager.getSession(active);
							if (session) {
								const sig = this.computeHistorySignature(session);
								if (data.historySignature !== sig) {
									this._sendFullHistory(active, sig);
								}
							}
						}
						break;
					}
					case 'generateDoc': {
						this.addSystemMessage('Generating documentation...');
						try { await generateDocument(this.llmService, data); } catch (e:any) { this.addSystemMessage('Generation failed: ' + (e.message||e.toString())); }
						break;
					}
					case 'suggestTemplate': {
						try { const resp = await generateTemplate(this.llmService, data); this._view?.webview.postMessage({ type:'addMessage', sender:'Bot', message: resp}); } catch(e:any){ this._view?.webview.postMessage({ type:'addMessage', sender:'Bot', message:'Error generating template: ' + (e.message||e.toString())}); }
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
						const sessionId = 'naruhodocs-general-thread';
						const sys = (require('./SystemMessages') as any).GENERAL_BEGINNER as string;
						const session = this.threadManager.getSession(sessionId);
						if (session && typeof (session as any).setCustomSystemMessage === 'function') { try { (session as any).setCustomSystemMessage(sys); } catch {} }
						this.threadManager.setSystemMessage(sessionId, sys);
						break;
					}
					case 'setGeneralDeveloperMode': {
						const sessionId = 'naruhodocs-general-thread';
						const sys = SystemMessages.GENERAL_PURPOSE;
						const session = this.threadManager.getSession(sessionId);
						if (session && typeof (session as any).setCustomSystemMessage === 'function') { try { (session as any).setCustomSystemMessage(sys); } catch {} }
						this.threadManager.setSystemMessage(sessionId, sys);
						break;
					}
					case 'sendMessage': {
						const userMessage = data.value as string;
						let activeThreadId = this.threadManager.getActiveThreadId();
						if (!activeThreadId) {
							try { await this.threadManager.initializeGeneralThread(); activeThreadId = this.threadManager.getActiveThreadId(); } catch { /* ignore */ }
							if (!activeThreadId) { this._view?.webview.postMessage({ type:'addMessage', sender:'Bot', message:'Error: No active thread available.'}); break; }
							try { this._postThreadList(); } catch {}
							try { this._sendFullHistory(activeThreadId); } catch {}
						}
						const activeSession = this.threadManager.getSession(activeThreadId);
						try {
							if (!activeSession) { throw new Error('No active thread'); }
							// Instrumentation: capture pre-chat history length
							let preLen = 0;
							try { preLen = activeSession.getHistory().length; } catch { /* ignore */ }
							OutputLogger.history(`preChat length=${preLen} session=${activeThreadId}`);
							const systemMsg = this.threadManager.getSystemMessage(activeThreadId);
							const botResponse = await this.llmService.trackedChat({ sessionId: activeThreadId, systemMessage: systemMsg || SystemMessages.GENERAL_PURPOSE, prompt: userMessage, task:'chat' });
							// Always re-sync the ThreadManager session reference with the canonical LLMService session.
							// Root cause: after provider/model changes LLMService may recreate its session while ThreadManager
							// still points at an old (now inert) instance. This produced zero-length histories and caused
							// _sendFullHistory to clear UI messages. We now pull the canonical session every send.
							const canonicalSession = await this.llmService.getSession(activeThreadId, systemMsg || SystemMessages.GENERAL_PURPOSE, { taskType:'chat' });
							this.threadManager.setSession(activeThreadId, canonicalSession);
							// Post instrumentation
							let postLen = 0;
							try { postLen = canonicalSession.getHistory().length; } catch { /* ignore */ }
							OutputLogger.history(`postChat length=${postLen} delta=${postLen-preLen} session=${activeThreadId}`);
							// Robust fallback: if still no growth, rebuild serialized history and set explicitly.
							if (postLen === preLen) {
								OutputLogger.history(`historyDidNotGrow applying rebuild fallback session=${activeThreadId}`);
								try {
									const existing = canonicalSession.getHistory();
									const serialized = existing.map((m: any) => {
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
									serialized.push({ type:'human', text: userMessage });
									serialized.push({ type:'ai', text: botResponse });
									(canonicalSession as any).setHistory(serialized as any);
									postLen = canonicalSession.getHistory().length;
									OutputLogger.history(`afterRebuildFallback length=${postLen} session=${activeThreadId}`);
								} catch { /* ignore */ }
							}
							this._view?.webview.postMessage({ type:'addMessage', sender:'Bot', message: botResponse });
							await this.threadManager.saveThreadHistory(activeThreadId);
							this._sendFullHistory(activeThreadId);
						} catch (error:any) {
							const errMsg = `Error: ${error.message || 'Unable to connect to LLM.'}`;
							try {
								// Re-sync canonical session on error as well
								const canonicalSession = await this.llmService.getSession(activeThreadId!, this.threadManager.getSystemMessage(activeThreadId!) || SystemMessages.GENERAL_PURPOSE, { taskType:'chat' });
								this.threadManager.setSession(activeThreadId!, canonicalSession);
								const existing = canonicalSession.getHistory();
								const serialized = existing.map((m: any) => ({ type: (m.type || (typeof m._getType === 'function' ? m._getType() : 'unknown')), text: (m as any).text || (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) }));
								serialized.push({ type:'ai', text: errMsg });
								(canonicalSession as any).setHistory(serialized as any);
								await this.threadManager.saveThreadHistory(activeThreadId!);
							} catch { /* ignore */ }
							this._view?.webview.postMessage({ type:'addMessage', sender:'Bot', message: errMsg });
						}
						break;
					}
					case 'resetSession': {
						const activeThreadId = this.threadManager.getActiveThreadId();
						if (activeThreadId) { try { await this.threadManager.resetSession(activeThreadId); } catch { } }
						this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:'🔄 Conversation reset. Chat history cleared.'});
						break;
					}
					case 'clearHistory': {
						const activeThreadId = this.threadManager.getActiveThreadId();
						if (activeThreadId) { try { await this.threadManager.resetSession(activeThreadId); } catch { } }
						this._view?.webview.postMessage({ type:'clearMessages' });
						this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:'History cleared.'});
						break;
					}
					case 'switchThread': {
						const sessionId = data.sessionId as string;
						this.threadManager.setActiveThread(sessionId);
						// Force resend on thread change so UI always updates even if signature unchanged
						this._sendFullHistory(sessionId, undefined, true);
						break;
					}
					case 'showVisualizationMenu': {
						await vscode.commands.executeCommand('naruhodocs.showVisualizationMenu');
						break;
					}
					case 'showNotification': {
						const message = data.message || 'Notification';
						const messageType = data.messageType || 'info';
						switch (messageType) {
							case 'error': vscode.window.showErrorMessage(message); break;
							case 'warning': vscode.window.showWarningMessage(message); break;
							default: vscode.window.showInformationMessage(message); break;
						}
						break;
					}
					case 'openFullWindowDiagram': {
						this.openDiagramInFullWindow(data.mermaidCode, data.diagramId, data.title);
						break;
					}
					case 'createFile': {
						const wsFolders = vscode.workspace.workspaceFolders;
						if (wsFolders && wsFolders.length > 0) {
							const wsUri = wsFolders[0].uri;
							const docsUri = vscode.Uri.joinPath(wsUri, 'docs');
							let targetFolder = wsUri;
							try { const docsStat = await vscode.workspace.fs.stat(docsUri); if (docsStat.type === vscode.FileType.Directory) { targetFolder = docsUri; } } catch { }
							const fileUri = vscode.Uri.joinPath(targetFolder, 'NaruhoDocsFile.txt');
							try { await vscode.workspace.fs.writeFile(fileUri, new Uint8Array()); this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:`File created: ${fileUri.fsPath}`}); } catch (err:any) { this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:`Error creating file: ${err.message}`}); }
						} else { this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:'No workspace folder open.'}); }
						break;
					}
					case 'createAndSaveFile': {
						const text = data.text || '';
						const uri = data.uri || '';
						if (uri) {
							try {
								const fileUri = vscode.Uri.parse(uri);
								const parentPaths = fileUri.path.split('/');
								const originalFileName = parentPaths.pop() || '';
								const dotIdx = originalFileName.lastIndexOf('.');
								let translatedFileName = dotIdx > 0 ? originalFileName.slice(0, dotIdx) + '-translated' + originalFileName.slice(dotIdx) : originalFileName + '-translated';
								const translatedFileUri = vscode.Uri.joinPath(fileUri.with({ path: parentPaths.join('/') }), translatedFileName);
								const content = text ? Buffer.from(text, 'utf8') : new Uint8Array();
								await vscode.workspace.fs.writeFile(translatedFileUri, content);
								this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:`File created: ${translatedFileUri.fsPath}`});
							} catch (e:any) {
								this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:`Error creating file: ${e.message}` });
							}
						} else { this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:'No valid folder to save translated file.'}); }
						break;
					}
					case 'createAndSaveTemplateFile': {
						let text = data.text || '';
						text = text.replace(/^```markdown\s*/i, '').replace(/^\*\*\*markdown\s*/i, '').replace(/```$/g, '').trim();
						const uri = data.uri || '';
						const generalThreadId = 'naruhodocs-general-thread';
						let aiFilename = '';
						const templateType = (data.docType || data.templateType || 'generic').toLowerCase();
						try { const suggestedName = await this.llmService.trackedChat({ sessionId: 'chatview:filename-suggest', systemMessage:'You suggest concise filesystem-friendly markdown filenames.', prompt:`Suggest a concise, filesystem-friendly filename (with .md extension) for a ${templateType} documentation file. Do not include the word 'template' in the filename. Respond with only the filename, no explanation.`, task:'generate_doc', forceNew:true }); aiFilename = (suggestedName||'').trim(); } catch { aiFilename=''; }
						let fileName = '';
						if (aiFilename && /^(?![. ]).+\.md$/i.test(aiFilename) && !/[\\/:*?"<>|]/.test(aiFilename)) { fileName = aiFilename.replace(/(_template)?\.md$/i, '') + '_template.md'; }
						else { fileName = templateType.trim().replace(/\s+/g,'_').replace(/[^\w\-]/g,'') + '_template.md'; }
						const writeTemplate = async (targetFolder: vscode.Uri) => {
							const templateFileUri = vscode.Uri.joinPath(targetFolder, fileName);
							const content = text ? Buffer.from(text, 'utf8') : new Uint8Array();
							await vscode.workspace.fs.writeFile(templateFileUri, content);
							this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:`Template file created: ${templateFileUri.fsPath}`});
						};
						if (uri === generalThreadId || !uri) {
							const wsFolders = vscode.workspace.workspaceFolders;
							if (wsFolders && wsFolders.length > 0) {
								const wsUri = wsFolders[0].uri;
								const docsUri = vscode.Uri.joinPath(wsUri, 'docs');
								let targetFolder = wsUri;
								try { const docsStat = await vscode.workspace.fs.stat(docsUri); if (docsStat.type === vscode.FileType.Directory) { targetFolder = docsUri; } } catch {}
								try { await writeTemplate(targetFolder); } catch(e:any){ this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:'Error creating template file: ' + e.message }); }
							} else { this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:'No workspace folder open.'}); }
						} else {
							try { const fileUri = vscode.Uri.parse(uri); const parentPaths = fileUri.path.split('/'); const parentUri = fileUri.with({ path: parentPaths.join('/') }); let targetFolder = parentUri; const wsFolders = vscode.workspace.workspaceFolders; if (wsFolders && wsFolders.length > 0) { const wsUri = wsFolders[0].uri; const docsUri = vscode.Uri.joinPath(wsUri, 'docs'); try { const docsStat = await vscode.workspace.fs.stat(docsUri); if (docsStat.type === vscode.FileType.Directory) { targetFolder = docsUri; } } catch {} } await writeTemplate(targetFolder); } catch(e:any){ this._view?.webview.postMessage({ type:'addMessage', sender:'System', message:'Error creating template file: ' + e.message }); } }
						break;
					}
					case 'vscodeReloadWindow': {
						vscode.commands.executeCommand('workbench.action.reloadWindow');
						break;
					}
					default:
						break;
				}
			} catch (err) {
				console.error('[NaruhoDocs] Error handling webview message:', err);
			}
		});
	}

	private _detectDiagram(text: string): boolean {
		if (!text) { return false; }
		return /```mermaid/i.test(text) || /NARUHODOCS_VISUALIZATION_START/.test(text);
	}

	public addSystemMessage(message: string) {
		this._view?.webview.postMessage({ type: 'addMessage', sender: 'System', message });
	}

	/** Public API used by VisualizationProvider to inject bot messages (diagrams, etc). */
	public addBotMessage(message: string, opts?: { messageType?: string; flags?: string[] }) {
		try {
			const activeThreadId = this.threadManager.getActiveThreadId();
			if (!activeThreadId) { return; }
			const session = this.threadManager.getSession(activeThreadId);
			if (!session) { return; }
			// Rebuild history (getHistory returns a filtered copy, so pushing into it is ineffective)
			try {
				const existing = session.getHistory();
				const serialized = existing.map((m: any) => {
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
				serialized.push({ type:'ai', text: message });
				(session as any).setHistory(serialized as any);
				this.threadManager.saveThreadHistory(activeThreadId);
			} catch { /* ignore */ }
			// Send incremental add (webview will handle visualization toolbar hydration)
			this._view?.webview.postMessage({ type: 'addMessage', sender: 'Bot', message, messageType: opts?.messageType });
			// Trigger a fresh full history send so atomic state matches storage (diagram detection relies on normalized list)
			this._sendFullHistory(activeThreadId);
		} catch (e) {
			console.warn('[NaruhoDocs] addBotMessage failed:', e);
		}
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

	/** Hydrate any previously persisted threads (including general) before creating new sessions. */
	public async restorePersistedThreads(): Promise<void> {
		try {
			const keys = this.context.workspaceState.keys();
			await (this.threadManager as any).restoreThreads(keys);
			// Ensure general thread exists / hydrated
			await (this.threadManager as any).initializeGeneralThread();
			// Prefer last active if stored
			let active = this.context.globalState.get<string>('lastActiveThreadId');
			if (!active || !(this.threadManager.getSessions().has(active))) {
				active = 'naruhodocs-general-thread';
			}
			await this.threadManager.setActiveThread(active);
			this._postThreadList();
			this._sendFullHistory(active);
		} catch (e) {
			console.warn('[NaruhoDocs] restorePersistedThreads failed:', e);
		}
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

	// Placeholder for scanDocs command hook (currently implemented elsewhere / future expansion)
	public async scanDocs(): Promise<void> {
		// Intentionally minimal; real implementation can push a system message or trigger analyzer later
		try { this.addSystemMessage('Scanning docs is not yet implemented in ChatViewProvider.'); } catch { /* ignore */ }
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
	private _sendFullHistory(sessionId?: string, precomputedSignature?: string, forceResend: boolean = false) {
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
				if (!forceResend && !shouldForce && lastSig && sig === lastSig) {
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
							<!-- Buttons moved to view title toolbar (package.json menus.view/title). Retained container for layout. -->
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
		panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<link href="${styleResetUri}" rel="stylesheet" />
<link href="${styleVSCodeUri}" rel="stylesheet" />
<link href="${styleMainUri}" rel="stylesheet" />
<title>${title}</title>
<script src="https://unpkg.com/mermaid@10/dist/mermaid.min.js"></script>
<style>
body { padding:12px 16px; background:var(--vscode-editor-background); color:var(--vscode-foreground); font-family:var(--vscode-font-family); height:100vh; margin:0; display:flex; flex-direction:column; }
.diagram-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; gap:12px; }
.diagram-title { font-size:15px; font-weight:600; margin:0; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.diagram-controls { display:flex; gap:4px; align-items:center; }
.icon-btn { background:var(--vscode-button-secondaryBackground,var(--vscode-button-background)); color:var(--vscode-button-foreground); border:none; border-radius:4px; padding:4px 6px; min-width:28px; font-size:12px; cursor:pointer; line-height:1; display:inline-flex; align-items:center; justify-content:center; }
.icon-btn:hover { background:var(--vscode-button-hoverBackground); }
#zoom-badge { font-size:11px; padding:2px 6px; border:1px solid var(--vscode-editorWidget-border); border-radius:4px; opacity:.8; }
.stage-outer { flex:1; position:relative; overflow:auto; border:1px solid var(--vscode-panel-border); border-radius:6px; background:var(--vscode-editor-background); display:flex; justify-content:center; align-items:center; }
.stage-inner { transform-origin:center center; transition:transform .25s ease; display:inline-block; }
.stage-inner svg { max-width:none; height:auto; }
</style></head><body>
<div class="diagram-header">
  <h1 class="diagram-title">${title}</h1>
  <div class="diagram-controls">
    <span id="zoom-badge">100%</span>
    <button class="icon-btn" id="btn-zoom-out" title="Zoom out">−</button>
    <button class="icon-btn" id="btn-zoom-in" title="Zoom in">+</button>
    <button class="icon-btn" id="btn-fit" title="Fit to view">⤢</button>
    <button class="icon-btn" id="btn-reset" title="Reset to 100%">1:1</button>
    <button class="icon-btn" id="btn-copy" title="Copy Mermaid source">⧉</button>
    <button class="icon-btn" id="btn-close" title="Close">✖</button>
  </div>
</div>
<div class="stage-outer"><div class="stage-inner" id="stage-inner"></div></div>
<script>
const vscode = acquireVsCodeApi();
mermaid.initialize({ startOnLoad:false, theme:'dark', themeVariables:{ darkMode:true, primaryColor:'#007acc', primaryTextColor:'#ffffff', primaryBorderColor:'#007acc', lineColor:'#cccccc', secondaryColor:'#1e1e1e', tertiaryColor:'#252526' } });
const code = \`${mermaidCode.replace(/`/g, '\\`')}\`;
const inner = document.getElementById('stage-inner');
let currentScale = 1; let fitScale = 1; const MIN=0.2, MAX=4, STEP=0.2;
function updateBadge(){ document.getElementById('zoom-badge').textContent = Math.round(currentScale*100)+"%"; }
function applyScale(s){ currentScale = Math.max(MIN, Math.min(MAX, s)); inner.style.transform = 'scale('+currentScale+')'; updateBadge(); }
function computeFit(){ const svg = inner.querySelector('svg'); if(!svg) return 1; const outer = inner.parentElement; if(!outer) return 1; const availW = outer.clientWidth - 16; const availH = outer.clientHeight - 16; let w,h; if(svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width && svg.viewBox.baseVal.height){ w=svg.viewBox.baseVal.width; h=svg.viewBox.baseVal.height; } else { try { const bb = svg.getBBox(); w=bb.width||1; h=bb.height||1; } catch { w=svg.clientWidth||1; h=svg.clientHeight||1; } } if(!w||!h) return 1; const sc = Math.min(availW/w, availH/h, 1); return (sc<=0||!isFinite(sc))?1:sc; }
function copySource(){ try { navigator.clipboard.writeText(code).then(()=> postInfo('Mermaid source copied')).catch(fallback); } catch{ fallback(); } function fallback(){ const ta=document.createElement('textarea'); ta.value=code; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy'); postInfo('Mermaid source copied');}catch{} document.body.removeChild(ta);} }
function postInfo(msg){ vscode.postMessage({ type:'showNotification', message: msg, messageType:'info'}); }
mermaid.render('diagram-${diagramId}', code).then(r => { inner.innerHTML = r.svg; setTimeout(()=>{ fitScale = computeFit(); applyScale(fitScale); },0); window.addEventListener('resize', () => { const prev = currentScale; fitScale = computeFit(); if(Math.abs(prev - fitScale) < 0.01) return; applyScale(fitScale); }); }).catch(err => { inner.innerHTML = '<p style="color: var(--vscode-errorForeground); padding:12px;">Failed to render diagram: '+err.message+'</p>'; });
document.getElementById('btn-zoom-in').onclick = () => applyScale(currentScale + STEP);
document.getElementById('btn-zoom-out').onclick = () => applyScale(currentScale - STEP);
document.getElementById('btn-fit').onclick = () => { fitScale = computeFit(); applyScale(fitScale); };
document.getElementById('btn-reset').onclick = () => applyScale(1);
document.getElementById('btn-copy').onclick = () => copySource();
document.getElementById('btn-close').onclick = () => vscode.postMessage({ type:'closeDiagramPanel' });
document.addEventListener('keydown', e => { if(e.key==='Escape'){ document.getElementById('btn-close').click(); } else if(e.key==='+'|| e.key==='='){ e.preventDefault(); document.getElementById('btn-zoom-in').click(); } else if(e.key==='-'){ e.preventDefault(); document.getElementById('btn-zoom-out').click(); } else if(e.key==='0'){ e.preventDefault(); document.getElementById('btn-reset').click(); } else if(e.key.toLowerCase()==='f'){ e.preventDefault(); document.getElementById('btn-fit').click(); } });
</script></body></html>`;

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