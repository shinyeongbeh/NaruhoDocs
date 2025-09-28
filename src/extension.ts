import { ChatViewProvider } from './ChatViewProvider';
import * as vscode from 'vscode';
import { SummaryCodeLensProvider } from './DocCodeLensProvider.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { SystemMessages } from './SystemMessages';
import { LocalMemoryVectorStore } from './rag/vectorstore/memory';
import { checkGrammar, GrammarIssue} from './external-tools/LanguageTool-integration';
import { lintMarkdownDocument } from './external-tools/markdownLinter';
import { LLMProviderManager } from './llm-providers/manager';
import { ModelConfigManager } from './managers/ModelConfigManager.js';
import { LLMService } from './managers/LLMService';
import { LocalProvider } from './llm-providers/local';
import { VisualizationProvider } from './VisualizationProvider';
import { VisualizationViewProvider } from './VisualizationViewProvider';
import { buildVectorDB } from './rag/vectorstore/chunking_buildVectorDB';
import { EmbeddingConfigManager } from './managers/EmbeddingConfigManager';
import { HuggingFaceEmbeddings } from './rag/embeddings/huggingfaceCloud';
import { OllamaEmbeddings } from './rag/embeddings/ollama';
import { getVectorStore, initializeVectorStore } from './rag/vectorstore/vectorStoreSingleton';
import { initializeEmbeddingModel } from './rag/embeddings/InitializeEmbeddingModel';
import { ThreadManager } from './managers/ThreadManager';

let provider: ChatViewProvider;

// Load env once
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	const RAGstatus = vscode.workspace.getConfiguration('naruhodocs').get<boolean>('rag.enabled', true);
	const embeddingConfigManager = new EmbeddingConfigManager(context);

	// Initialize embedding model config and build vector database
	(async () => {
		if (RAGstatus) {
			await embeddingConfigManager.scaffoldIfMissing();
			await embeddingConfigManager.load();

			// Select embedding provider
			const providerName = vscode.workspace.getConfiguration('naruhodocs').get<string>('embedding.provider', 'local');
			const embeddingConfig = embeddingConfigManager.resolveProvider(providerName);

			// Initialize embedding model
			const embeddings = await initializeEmbeddingModel(embeddingConfig);
			// Initialize vector store with embeddings
			initializeVectorStore(embeddings);
			// Build vector database from workspace files
			buildVectorDB(getVectorStore());
		}
	})();

	// Command to switch embedding provider interactively
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.changeEmbeddingProvider', async () => {
			const config = vscode.workspace.getConfiguration('naruhodocs');
			const current = config.get<string>('embedding.provider', 'local');
			const items: Array<{ label: string; value: string; description?: string }> = [
				{ label: 'Local (Ollama/LM Studio)', value: 'local', description: 'Use local embedding models via Ollama / LM Studio' },
				{ label: 'Cloud (Hugging Face Inference Provider)', value: 'cloudHuggingface', description: 'Use Hugging Face cloud embeddings' },
				{ label: 'Built-in Hugging Face by NaruhoDocs', value: 'builtInHFApi', description: 'Use Hugging Face cloud embeddings - No API key needed.' },
				{ label: '— Open model configuration (embeddings.json)…', value: '__open_models__' }
			];
			const pick = await vscode.window.showQuickPick(
				items.map(i => ({ label: i.label, description: i.description })),
				{ placeHolder: 'Select embedding provider for your RAG system', ignoreFocusOut: true }
			);
			if (!pick) { return; }
			const chosen = items.find(i => i.label === pick.label);
			if (!chosen) { return; }
			if (!RAGstatus) {
				vscode.window.showWarningMessage('RAG is currently disabled in settings. Please enable it to change embedding provider.');
				return;
			}
			if (chosen.value === '__open_models__') {
				try {
					const ws = vscode.workspace.workspaceFolders?.[0];
					if (ws) {
						// Scaffold embeddings.json if missing
						await embeddingConfigManager.scaffoldIfMissing();
						const file = vscode.Uri.joinPath(ws.uri, '.naruhodocs', 'embeddings.json');
						await vscode.window.showTextDocument(file, { preview: false });
					} else {
						vscode.window.showWarningMessage('No workspace folder found.');
					}
				} catch (e) {
					vscode.window.showErrorMessage('Failed to open embeddings.json: ' + (e instanceof Error ? e.message : String(e)));
				}
				return;
			}
			if (chosen.value === current) {
				vscode.window.showInformationMessage(`Embedding provider already set to ${pick.label}.`);
				return;
			}
			await config.update('embedding.provider', chosen.value, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`Embedding provider changed to ${pick.label}.`);
			// Optionally reinitialize vector store here if needed
			// You may want to trigger a reload or rebuild of the vector DB
		})
	);
	// // Register scanDocs command to call provider.scanDocs()
	// context.subscriptions.push(
	// 	vscode.commands.registerCommand('naruhodocs.scanDocs', async () => {
	// 		await provider.scanDocs();
	// 	})
	// );

	// Rebuild Vector DB command
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.rebuildVectorDB', async () => {
			const ragEnabled = vscode.workspace.getConfiguration('naruhodocs').get<boolean>('rag.enabled', true);
			if (!ragEnabled) {
				vscode.window.showWarningMessage('RAG is disabled in settings. Enable it then run Rebuild to trigger a full reload.');
				return;
			}
			// Instead of manually rebuilding (which can miss edge initialization cases),
			// perform a full window reload so the standard activation flow reliably
			// re-runs embedding + vector store initialization.
			try {
				vscode.window.showInformationMessage('Reloading window to rebuild NaruhoDocs RAG vector database...');
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			} catch (e: any) {
				vscode.window.showErrorMessage('Failed to reload window for vector DB rebuild: ' + (e?.message || String(e)));
			}
		})
	);

	// Thread management: map document URI to thread info
	const threadMap: Map<string, { document: vscode.TextDocument, sessionId: string }> = new Map();
	let activeThreadId: string | undefined;

	// Initialize LLM Provider Manager
	const llmManager = new LLMProviderManager();
	const llmService = LLMService.getOrCreate(llmManager);
	llmService.initializePersistence(context);
	// Create dedicated output channel for verbose LLM logging
	const llmOutput = vscode.window.createOutputChannel('NaruhoDocs LLM');
	llmService.setOutputChannel(llmOutput);
	llmService.refreshConfig();

	// Status bar: Provider & Model
	const providerModelStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	providerModelStatus.command = 'naruhodocs.changeProvider';
	context.subscriptions.push(providerModelStatus);

	function updateProviderModelStatus(sessionId: string = 'naruhodocs-general-thread') {
		try {
			const provider = llmManager.getCurrentProvider();
			const providerType = vscode.workspace.getConfiguration('naruhodocs').get<string>('llm.provider', 'ootb');
			const svcAny = llmService as any;
			let model: string | undefined = svcAny.sessionModelHints?.get(sessionId) || svcAny.sessionModelHints?.get('general');
			let trace: string[] = [];
			if (!model) {
				if (modelConfigManager.isActive()) {
					const resolved = modelConfigManager.resolveModel(providerType, 'chat', undefined, providerType === 'local' ? 'gemma3:1b' : 'gemini-2.0-flash');
					model = resolved.model;
					trace = ['file-active', ...resolved.trace];
				} else {
					if (providerType === 'local') {
						const cfg = vscode.workspace.getConfiguration('naruhodocs');
						model = cfg.get<string>('llm.localModel') || 'gemma3:1b';
						trace = ['settings-or-fallback'];
					} else {
						model = 'gemini-2.0-flash';
						trace = ['default-flash'];
					}
				}
			} else {
				trace = ['session-hint'];
			}
			const icon = providerType === 'local' ? 'server-environment' : (providerType === 'byok' ? 'key' : 'robot');
			providerModelStatus.text = `$(${icon}) NaruhoDocs: ${model}`;
			providerModelStatus.tooltip = `Provider: ${provider?.name || providerType}\nModel: ${model}\nTrace: ${trace.join(' > ')}`;
			providerModelStatus.show();
		} catch {
			providerModelStatus.text = '$(robot) NaruhoDocs: unknown';
			providerModelStatus.show();
		}
	}

	provider = new ChatViewProvider(context.extensionUri, undefined, context, llmManager);
	// Attempt early hydration of any previously persisted threads (including general) so we do not
	// overwrite an existing restored general history with a fresh empty session later in activation.
	(async () => { try { await (provider as any).restorePersistedThreads(); } catch { /* non-fatal */ } })();

	// Model config manager (per-repo JSON) - instantiate now, load inside activation async block
	const modelConfigManager = new ModelConfigManager(context);
	llmService.setModelConfigManager(modelConfigManager);
	// Also supply to provider manager so local init can respect models.json
	try { (llmManager as any).setModelConfigManager?.(modelConfigManager); } catch { /* optional */ }

	// Provider profile memory removed (deprecated). Models now fully governed by .naruhodocs/models.json and runtime hints.
	let currentProviderType = vscode.workspace.getConfiguration('naruhodocs').get<string>('llm.provider', 'ootb');

	// Initialize Visualization Provider
	const visualizationProvider = new VisualizationProvider(context, llmManager);

	// Register the visualization sidebar view (if not already)
	const visualizationViewProvider = new VisualizationViewProvider(context.extensionUri, visualizationProvider);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VisualizationViewProvider.viewType, visualizationViewProvider)
	);
	// Link back so visualization provider can send results to view
	visualizationProvider.setVisualizationView(visualizationViewProvider);

	// Initialize the LLM provider and then create initial threads only after provider is ready
	(async () => {
		// Load model config file early
		await modelConfigManager.load();
		llmService.logEvent(modelConfigManager.isActive() ? 'model_config_loaded' : 'model_config_missing');
		// Watch for config file changes once workspace ready
		const ws = vscode.workspace.workspaceFolders?.[0];
		if (ws) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(ws, '.naruhodocs/models.json'));
			context.subscriptions.push(watcher);
			const reload = async () => {
				await modelConfigManager.load();
				llmService.setModelConfigManager(modelConfigManager);
				llmService.clearAllSessions();
				llmService.logEvent('model_config_reloaded');
				updateProviderModelStatus(activeThreadId);
			};
			watcher.onDidChange(reload, undefined, context.subscriptions);
			watcher.onDidCreate(reload, undefined, context.subscriptions);
			watcher.onDidDelete(async () => { await modelConfigManager.load(); llmService.setModelConfigManager(modelConfigManager); llmService.clearAllSessions(); llmService.logEvent('model_config_deleted'); updateProviderModelStatus(activeThreadId); });
		}
	try {
		console.log('[NaruhoDocs] Extension activation: Initializing LLM manager from config');
		const config = vscode.workspace.getConfiguration('naruhodocs');
		const providerType = config.get<string>('llm.provider', 'ootb');
		console.log('[NaruhoDocs] Extension activation: LLM config provider type:', providerType);
		
		// Add retry logic for packaged extensions where initialization might fail on first try
		let retryCount = 0;
		const maxRetries = 3;
		while (retryCount < maxRetries) {
			try {
				await llmManager.initializeFromConfig();
				console.log('[NaruhoDocs] Extension activation: LLM manager initialized successfully');
				llmService.logEvent('provider_init', { provider: llmManager.getCurrentProvider()?.name });
				break;
			} catch (initError) {
				retryCount++;
				console.warn(`[NaruhoDocs] LLM initialization attempt ${retryCount} failed:`, initError);
				if (retryCount >= maxRetries) {
					throw initError;
				}
				// Wait before retry (exponential backoff)
				await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
			}
		} 		// Initialize the general-purpose thread AFTER provider is confirmed (only if not already restored)
			const generalThreadId = 'naruhodocs-general-thread';
			// If restorePersistedThreads ran earlier and hydrated general thread, skip recreation
			const existingGeneral = (provider as any)?.threadManager?.getSession?.(generalThreadId);
			if (!existingGeneral) {
				const generalThreadTitle = 'General Purpose';
				await llmService.getSession(generalThreadId, SystemMessages.GENERAL_PURPOSE, { taskType: 'chat', forceNew: true });
				provider.createThread(generalThreadId, SystemMessages.GENERAL_PURPOSE, generalThreadTitle);
				activeThreadId = generalThreadId;
				provider.setActiveThread(generalThreadId);
			} else {
				activeThreadId = generalThreadId;
				provider.setActiveThread(generalThreadId);
			}

			updateProviderModelStatus(activeThreadId);

			// For already-open documents, create threads now that provider is ready
			const openDocs = vscode.workspace.textDocuments;
			for (const document of openDocs) {
				const fileName = document.fileName.toLowerCase();
				if (fileName.endsWith('.md') || fileName.endsWith('.txt')) {
					const uriStr = document.uri.toString();
					if (!threadMap.has(uriStr)) {
						const sessionId = uriStr;
						threadMap.set(uriStr, { document, sessionId });
						provider.createThread(sessionId, document.getText(), document.fileName);
						activeThreadId = sessionId;
						provider.setActiveThread(sessionId);
						updateProviderModelStatus(sessionId);
					}
				}
			}
		} catch (error) {
			console.error('Failed to initialize LLM provider:', error);
			const settingsKey = vscode.workspace.getConfiguration('naruhodocs').get<string>('geminiApiKey');
			const apiKey = settingsKey || process.env.GOOGLE_API_KEY || '';
			if (!apiKey) {
				vscode.window.showWarningMessage('NaruhoDocs: No LLM provider configured. Set provider in settings (naruhodocs.llm.provider) or edit .naruhodocs/models.json.');
			}
		}
	})();

	// Listen for configuration changes and automatically update LLM provider
	let configChangeTimeout: NodeJS.Timeout | undefined;
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			// Check if any of our LLM settings changed
			if (event.affectsConfiguration('naruhodocs.llm.provider') ||
				event.affectsConfiguration('naruhodocs.llm.apiKey') ||
				event.affectsConfiguration('naruhodocs.logging.verbose')) {

				// Debounce configuration changes to avoid multiple rapid updates
				if (configChangeTimeout) {
					clearTimeout(configChangeTimeout);
				}

				configChangeTimeout = setTimeout(async () => {
					try {
						const config = vscode.workspace.getConfiguration('naruhodocs');
						const newProviderType = config.get<string>('llm.provider', 'ootb');
						const providerChanged = newProviderType !== currentProviderType;
						if (providerChanged || event.affectsConfiguration('naruhodocs.llm.apiKey')) {
							await llmManager.initializeFromConfig();
							llmService.clearAllSessions();
							llmService.logEvent('provider_reload', { provider: llmManager.getCurrentProvider()?.name, changed: providerChanged });
							currentProviderType = newProviderType;
							if (providerChanged) {
								// Post system message to chat view (if loaded) instead of a user-level chat message
								const provName = llmManager.getCurrentProvider()?.name || newProviderType;
								try { (provider as any)?.addSystemMessage?.(`Provider changed to ${provName}`); } catch { /* ignore */ }
							}
						}
						llmService.refreshConfig();
						provider.updateLLMManager(llmManager);
						updateProviderModelStatus(activeThreadId);
					} catch (error) {
						console.error('Failed to update LLM provider from configuration change:', error);
						vscode.window.showErrorMessage(`Failed to update LLM provider: ${error instanceof Error ? error.message : 'Unknown error'}`);
					}
				}, 500); // Wait 500ms for multiple rapid changes
			}
		})
	);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));

	// Connect visualization provider to chat provider
	visualizationProvider.setChatProvider(provider);

	// Listen for document open events to create threads
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((document) => {
			const fileName = document.fileName.toLowerCase();
			if (!(fileName.endsWith('.md') || fileName.endsWith('.txt'))) {
				return;
			}
			const uriStr = document.uri.toString();
			if (!threadMap.has(uriStr)) {
				const sessionId = uriStr; // Use URI as session/thread id
				threadMap.set(uriStr, { document, sessionId });
				provider.createThread(sessionId, document.getText(), document.fileName);
				activeThreadId = sessionId;
				provider.setActiveThread(sessionId);
			}
		})
	);

	// Allow switching threads from UI
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.switchThread', (sessionId: string) => {
			if (threadMap.has(sessionId)) {
				activeThreadId = sessionId;
				provider.setActiveThread(sessionId);
			}
		})
	);

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			{ language: 'markdown' },
			new SummaryCodeLensProvider()
		)
	);

	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			{ language: 'plaintext' },
			new SummaryCodeLensProvider()
		)
	);

	// New summarize command using centralized LLMService
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.summarizeDocument', async (documentUri: vscode.Uri) => {
			const doc = await vscode.workspace.openTextDocument(documentUri);
			const resp = await llmService.request({
				type: 'summarize',
				content: doc.getText(),
				targetId: documentUri.toString(),
				systemMessage: 'You produce concise technical summaries with key points and clarity.'
			});
			// Show summary in a new ephemeral document
			const summaryContent = `# Summary of ${path.basename(doc.fileName)}\n\n${resp.content}`;
			const summaryDoc = await vscode.workspace.openTextDocument({
				content: summaryContent,
				language: 'markdown'
			});
			await vscode.window.showTextDocument(summaryDoc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
			// Provide save option similar to translation command
			vscode.window.showInformationMessage('Summary ready. Save as new file?', 'Save').then(async sel => {
				if (sel === 'Save') {
					const ws = vscode.workspace.workspaceFolders?.[0];
					if (ws) {
						try {
							// Check if /docs folder exists, if so save there, otherwise save to root
							const docsUri = vscode.Uri.joinPath(ws.uri, 'docs');
							let targetFolder = ws.uri;
							try {
								const docsStat = await vscode.workspace.fs.stat(docsUri);
								if (docsStat.type === vscode.FileType.Directory) {
									targetFolder = docsUri;
								}
							} catch {
								// /docs doesn't exist, use root folder
							}

							const targetUri = vscode.Uri.joinPath(targetFolder, `${path.basename(doc.fileName).replace(/\.[^.]+$/, '')}.summary.md`);
							let fileExists = false;
							try {
								await vscode.workspace.fs.stat(targetUri);
								fileExists = true;
							} catch {
								fileExists = false;
							}
							if (fileExists) {
								const overwrite = await vscode.window.showInformationMessage(
									`File ${targetUri.fsPath} already exists. Overwrite?`,
									'Overwrite', 'Cancel'
								);
								if (overwrite !== 'Overwrite') {
									vscode.window.showInformationMessage('Template save cancelled.');
									return;
								}
							}
							await vscode.workspace.fs.writeFile(targetUri, Buffer.from(summaryContent, 'utf8'));
							vscode.window.showInformationMessage(`Saved summary to ${targetUri.fsPath}`);
						} catch (e) {
							vscode.window.showErrorMessage('Failed to save summary: ' + (e instanceof Error ? e.message : String(e)));
						}
					} else {
						vscode.window.showWarningMessage('No workspace folder available to save summary.');
					}
				}
			});
		})
	);

	// New translate command using LLMService
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.translateDocument', async (documentUri: vscode.Uri) => {
			const doc = await vscode.workspace.openTextDocument(documentUri);
			const languages = [
				{ label: 'Malay', value: 'Malay' },
				{ label: 'English', value: 'English' },
				{ label: 'Chinese', value: 'Chinese' },
				{ label: 'Japanese', value: 'Japanese' },
				{ label: 'Korean', value: 'Korean' },
				{ label: 'Spanish', value: 'Spanish' },
				{ label: 'French', value: 'French' },
				{ label: 'German', value: 'German' },
				{ label: 'Russian', value: 'Russian' },
				{ label: 'Arabic', value: 'Arabic' },
				{ label: 'Hindi', value: 'Hindi' }
			];
			const picked = await vscode.window.showQuickPick(languages.map(l => l.label), { placeHolder: 'Select target language' });
			if (!picked) { return; }
			const resp = await llmService.request({
				type: 'translate',
				content: doc.getText(),
				targetLanguage: picked,
				systemMessage: 'You are a professional technical translator. Preserve code blocks and formatting.'
			});
			// Show LLM stats command
			context.subscriptions.push(
				vscode.commands.registerCommand('naruhodocs.showLLMStats', async () => {
					const stats = llmService.getStats();
					const lines = [
						`Day: ${stats.day}`,
						`Requests: ${stats.requests}`,
						`Estimated Tokens (in/out): ${stats.estimatedInputTokens}/${stats.estimatedOutputTokens}`,
						'Per Task:'
					];
					for (const k of Object.keys(stats.perTask)) {
						lines.push(`  - ${k}: ${stats.perTask[k as keyof typeof stats.perTask]}`);
					}
					vscode.window.showInformationMessage(lines.join('\n'), { modal: false });
				})
			);
			// Open translation in a side-by-side editor
			const translationDoc = await vscode.workspace.openTextDocument({
				content: `# Translation (${picked}) of ${path.basename(doc.fileName)}\n\n${resp.content}`,
				language: 'markdown'
			});
			await vscode.window.showTextDocument(translationDoc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
			// Provide save option via notification
			vscode.window.showInformationMessage('Translation ready. Save as new file?', 'Save').then(async sel => {
				if (sel === 'Save') {
					const ws = vscode.workspace.workspaceFolders?.[0];
					if (ws) {
						// Check if /docs folder exists, if so save there, otherwise save to root
						const docsUri = vscode.Uri.joinPath(ws.uri, 'docs');
						let targetFolder = ws.uri;
						try {
							const docsStat = await vscode.workspace.fs.stat(docsUri);
							if (docsStat.type === vscode.FileType.Directory) {
								targetFolder = docsUri;
							}
						} catch {
							// /docs doesn't exist, use root folder
						}

						const targetUri = vscode.Uri.joinPath(targetFolder, `${path.basename(doc.fileName).replace(/\.[^.]+$/, '')}.${picked.toLowerCase()}.md`);
						let fileExists = false;
						try {
							await vscode.workspace.fs.stat(targetUri);
							fileExists = true;
						} catch {
							fileExists = false;
						}
						if (fileExists) {
							const overwrite = await vscode.window.showInformationMessage(
								`File ${targetUri.fsPath} already exists. Overwrite?`,
								'Overwrite', 'Cancel'
							);
							if (overwrite !== 'Overwrite') {
								vscode.window.showInformationMessage('Template save cancelled.');
								return;
							}
						}
						await vscode.workspace.fs.writeFile(targetUri, Buffer.from(resp.content, 'utf8'));
						vscode.window.showInformationMessage(`Saved translation to ${targetUri.fsPath}`);
					}
				}
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.start', () => {
			vscode.window.showInformationMessage('NaruhoDocs started!');
		}));

	// Command to open / scaffold model config file
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.openModelConfig', async () => {
			try {
				await modelConfigManager.scaffoldIfMissing();
				const ws2 = vscode.workspace.workspaceFolders?.[0];
				if (!ws2) { return; }
				const file = vscode.Uri.joinPath(ws2.uri, '.naruhodocs', 'models.json');
				await vscode.window.showTextDocument(file, { preview: false });
			} catch (e) {
				vscode.window.showErrorMessage('Failed to open model config: ' + (e instanceof Error ? e.message : String(e)));
			}
		})
	);

	// Command: add per-task override via QuickPick
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.addModelTaskOverride', async () => {
			try {
				await modelConfigManager.scaffoldIfMissing();
				await modelConfigManager.load();
				const provider = await vscode.window.showQuickPick(['ootb', 'byok', 'local'], { placeHolder: 'Select provider' });
				if (!provider) { return; }
				const task = await vscode.window.showQuickPick([
					'chat', 'summarize', 'read_files', 'analyze', 'translate', 'generate_doc', 'visualization_context'
				], { placeHolder: 'Select task to override' });
				if (!task) { return; }
				const model = await vscode.window.showInputBox({ prompt: `Enter model name for ${provider}:${task}` });
				if (!model) { return; }
				await modelConfigManager.upsertTaskOverride(provider, task, model.trim());
				await modelConfigManager.load();
				llmService.clearAllSessions();
				llmService.logEvent('model_task_override', { provider, task, model });
				vscode.window.showInformationMessage(`Set ${provider}:${task} -> ${model}`);
			} catch (e) {
				vscode.window.showErrorMessage('Failed to set task override: ' + (e instanceof Error ? e.message : String(e)));
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.createFile', async () => {
			const uri = await vscode.window.showSaveDialog({ saveLabel: 'Create File' });
			if (uri) {
				await vscode.workspace.fs.writeFile(uri, new Uint8Array());
				vscode.window.showInformationMessage(`File created: ${uri.fsPath}`);
			}
		})
	);

	// Removed configureLLM and selectLocalModel commands; model/provider selection now via settings + models.json.

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.testLLMConnection', async () => {
			const isConnected = await llmManager.testConnection();
			const provider = llmManager.getCurrentProvider();
			if (isConnected) {
				vscode.window.showInformationMessage(`✅ ${provider?.name} connection successful`);
			} else {
				vscode.window.showErrorMessage(`❌ ${provider?.name || 'LLM'} connection failed`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.reinitializeLLMProvider', async () => {
			try {
				vscode.window.showInformationMessage('🔄 Reinitializing LLM provider...');
				await llmManager.initializeFromConfig();
				llmService.clearAllSessions();
				provider.updateLLMManager(llmManager);
				updateProviderModelStatus(activeThreadId);
				const providerName = llmManager.getCurrentProvider()?.name || 'Unknown';
				vscode.window.showInformationMessage(`✅ LLM provider reinitialized: ${providerName}`);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : 'Unknown error';
				vscode.window.showErrorMessage(`❌ Failed to reinitialize LLM provider: ${errorMsg}`);
				console.error('[NaruhoDocs] Manual reinitialize failed:', error);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.showProviderStatus', async () => {
			const currentProvider = llmManager.getCurrentProvider();
			if (currentProvider) {
				const usageInfo = await llmManager.getUsageInfo();
				const statusMessage = `
Current Provider: ${currentProvider.name}
Available: ${currentProvider.isAvailable ? '✅ Yes' : '❌ No'}
${usageInfo ? `Requests Today: ${usageInfo.requestsToday}${!usageInfo.isUnlimited ? `/${usageInfo.requestsToday + usageInfo.requestsRemaining}` : ' (Unlimited)'}` : ''}
				`.trim();
				vscode.window.showInformationMessage(statusMessage);
			} else {
				vscode.window.showWarningMessage('No LLM provider configured. Set provider in settings or models.json.');
			}
		})
	);

	// Command to change provider (status bar click target)
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.changeProvider', async () => {
			const runPicker = async (): Promise<void> => {
				try {
					const config = vscode.workspace.getConfiguration('naruhodocs');
					const current = config.get<string>('llm.provider', 'ootb');
					const items: Array<{ label: string; value: string; description?: string }> = [
						{ label: 'Out-of-the-box (Gemini)', value: 'ootb', description: 'Built-in, limited usage' },
						{ label: 'Bring Your Own Key', value: 'byok', description: 'Use your own API key' },
						{ label: 'Local (Ollama / compatible)', value: 'local', description: 'Local runtime models' },
						{ label: '— Open model configuration (models.json)…', value: '__open_models__' }
					];
					const pick = await vscode.window.showQuickPick(
						items.map(i => ({ label: i.label, description: i.description })),
						{ placeHolder: 'Select LLM provider or open model configuration', ignoreFocusOut: true }
					);
					if (!pick) { return; }
					const chosen = items.find(i => i.label === pick.label);
					if (!chosen) { return; }
					if (chosen.value === '__open_models__') {
						try {
							await modelConfigManager.scaffoldIfMissing();
							const ws = vscode.workspace.workspaceFolders?.[0];
							if (ws) {
								const file = vscode.Uri.joinPath(ws.uri, '.naruhodocs', 'models.json');
								await vscode.window.showTextDocument(file, { preview: false });
							}
						} catch (err) {
							vscode.window.showErrorMessage('Failed to open model config: ' + (err instanceof Error ? err.message : String(err)));
						}
						// loop back to provider selection
						setTimeout(() => { runPicker(); }, 50);
						return;
					}
					if (chosen.value === current) {
						vscode.window.showInformationMessage(`Provider already set to ${pick.label}.`);
						return;
					}
					await config.update('llm.provider', chosen.value, vscode.ConfigurationTarget.Global);
					if (chosen.value === 'byok') {
						let key = config.get<string>('llm.apiKey') || '';
						if (!key) {
							key = await vscode.window.showInputBox({ prompt: 'Enter API key for BYOK provider', password: true }) || '';
							if (key) {
								await config.update('llm.apiKey', key, vscode.ConfigurationTarget.Global);
							}
						}
					}
					// Config change listener will handle reload & status bar update.
				} catch (e) {
					vscode.window.showErrorMessage('Failed to change provider: ' + (e instanceof Error ? e.message : String(e)));
				}
			};
			runPicker();
		})
	);

	// Add visualization commands
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.showVisualizationMenu', async (documentUri?: vscode.Uri) => {
			await visualizationProvider.showVisualizationMenu(documentUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.visualizeArchitecture', async () => {
			await visualizationProvider.visualizeArchitecture();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.visualizeFolderStructure', async () => {
			await visualizationProvider.visualizeFolderStructure();
		})
	);


	// Add reset chat command
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.resetChat', async () => {
			await provider.resetActiveChat();
		})
	);

	const grammarDiagnostics = vscode.languages.createDiagnosticCollection('naruhodocs-grammar');
	context.subscriptions.push(grammarDiagnostics);

	const runGrammarCheck = async (document: vscode.TextDocument) => {
        const fileName = document.fileName.toLowerCase();
        if (!(fileName.endsWith('.md') || fileName.endsWith('.txt'))) {
            return; // Silently ignore non-doc files
        }

        try {
            const text = document.getText();
            const issues = await checkGrammar(text, 'en-US');
            
            if (issues.length === 0) {
                grammarDiagnostics.delete(document.uri);
                return;
            }

            const diagnostics: vscode.Diagnostic[] = issues.map(issue => {
                const start = document.positionAt(issue.offset);
                const end = document.positionAt(issue.offset + issue.length);
                const range = new vscode.Range(start, end);
                const message = `${issue.message}${issue.replacements.length ? ` (Suggestion: ${issue.replacements.join(', ')})` : ''}`;
                const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
                diagnostic.source = 'naruhodocs-grammar'; // Identify the source
                // Store original issue data for the CodeActionProvider
                (diagnostic as any)._naruhodocs = { issue };
                return diagnostic;
            });

            grammarDiagnostics.set(document.uri, diagnostics);

        } catch (e: any) {
            vscode.window.showErrorMessage('Grammar check failed: ' + e.message);
        }
    };

	context.subscriptions.push(
        vscode.commands.registerCommand('naruhodocs.checkGrammar', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                await runGrammarCheck(editor.document);
                vscode.window.showInformationMessage('Grammar check complete.');
            } else {
                vscode.window.showInformationMessage('No active editor to check.');
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('naruhodocs.ignoreGrammarIssue', async (docUri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
            const currentDiagnostics = grammarDiagnostics.get(docUri) || [];
            const newDiagnostics = currentDiagnostics.filter(d => d !== diagnostic);
            grammarDiagnostics.set(docUri, newDiagnostics);
        })
    );

    // New command to ignore all grammar issues of the same type (ruleId)
    context.subscriptions.push(
        vscode.commands.registerCommand('naruhodocs.ignoreAllGrammarIssuesOfType', async (docUri: vscode.Uri, ruleId: string) => {
            const currentDiagnostics = grammarDiagnostics.get(docUri) || [];
            if (!ruleId) { return; }

            const newDiagnostics = currentDiagnostics.filter(d => {
                const issueRuleId = (d as any)._naruhodocs?.issue?.ruleId;
                return issueRuleId !== ruleId;
            });

            grammarDiagnostics.set(docUri, newDiagnostics);
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(['markdown', 'plaintext'], {
            provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
                const actions: vscode.CodeAction[] = [];
                const relevantDiagnostics = context.diagnostics.filter(
                    diag => diag.source === 'naruhodocs-grammar' && diag.range.intersection(range)
                );

                for (const diagnostic of relevantDiagnostics) {
                    const issue = (diagnostic as any)._naruhodocs?.issue as GrammarIssue | undefined;

                    const ignoreAction = new vscode.CodeAction('Ignore this issue', vscode.CodeActionKind.QuickFix);
                    ignoreAction.command = {
                        command: 'naruhodocs.ignoreGrammarIssue',
                        title: 'Ignore Grammar Issue',
                        arguments: [document.uri, diagnostic]
                    };
                    ignoreAction.diagnostics = [diagnostic];
                    actions.push(ignoreAction);

                    // Action to ignore all issues of the same type
                    if (issue?.ruleId) {
                        const ignoreAllAction = new vscode.CodeAction(`Ignore all issues of type '${issue.ruleId}'`, vscode.CodeActionKind.QuickFix);
                        ignoreAllAction.command = {
                            command: 'naruhodocs.ignoreAllGrammarIssuesOfType',
                            title: `Ignore All '${issue.ruleId}' Issues`,
                            arguments: [document.uri, issue.ruleId]
                        };
                        ignoreAllAction.diagnostics = [diagnostic];
                        actions.push(ignoreAllAction);
                    }
                }
                return actions;
            }
        })
    );

    // Optionally clear diagnostics when document is closed
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => {
			grammarDiagnostics.delete(doc.uri);
		})
	);

	context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            const config = vscode.workspace.getConfiguration('naruhodocs');
            const checkOnSave = config.get<boolean>('grammar.checkOnSave', false);
            if (checkOnSave) {
                await runGrammarCheck(document);
            }
        })
    );

	// Markdownlint diagnostics
	const markdownDiagnostics = vscode.languages.createDiagnosticCollection('naruhodocs-markdown');
    context.subscriptions.push(markdownDiagnostics);

	const lintAndReport = async (document: vscode.TextDocument) => {
		const errors = await lintMarkdownDocument(document);
		if (!Array.isArray(errors)) {
			markdownDiagnostics.set(document.uri, []);
			return;
		}
		const diagnostics: vscode.Diagnostic[] = errors.map(error => {
			const line = error.lineNumber - 1;
			// Default to the full line if no column is specified
			const startColumn = (error.errorRange ? error.errorRange[0] : 1) - 1;
			const endColumn = error.errorRange ? startColumn + error.errorRange[1] : 100;
			const range = new vscode.Range(line, startColumn, line, endColumn);
			
			const ruleName = error.ruleNames[0];
			const message = `${error.ruleDescription} (${ruleName})`;
			const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
			diagnostic.source = 'naruhodocs-markdown';
			// Attach rule name for the CodeActionProvider
			(diagnostic as any)._naruhodocs = { ruleName: ruleName };
			return diagnostic;
		});
		markdownDiagnostics.set(document.uri, diagnostics);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.lintMarkdown', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showInformationMessage('No active editor.');
				return;
			}
			const document = editor.document;
			const fileName = document.fileName.toLowerCase();
			if (!fileName.endsWith('.md')) {
				vscode.window.showInformationMessage('Markdown linting is only available for .md files.');
				return;
			}
			await lintAndReport(document);
		})
	);

	context.subscriptions.push(
        vscode.commands.registerCommand('naruhodocs.ignoreMarkdownIssue', async (docUri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
            const currentDiagnostics = markdownDiagnostics.get(docUri) || [];
            const newDiagnostics = currentDiagnostics.filter(d => d !== diagnostic);
            markdownDiagnostics.set(docUri, newDiagnostics);
        })
    );

    // Command to ignore all markdown issues of the same type (ruleName)
    context.subscriptions.push(
        vscode.commands.registerCommand('naruhodocs.ignoreAllMarkdownRules', async (docUri: vscode.Uri, ruleName: string) => {
            const currentDiagnostics = markdownDiagnostics.get(docUri) || [];
            if (!ruleName) { return; }

            const newDiagnostics = currentDiagnostics.filter(d => {
                const issueRuleName = (d as any)._naruhodocs?.ruleName;
                return issueRuleName !== ruleName;
            });

            markdownDiagnostics.set(docUri, newDiagnostics);
        })
    );

	context.subscriptions.push(
        vscode.commands.registerCommand('naruhodocs.ignoreAllIssues', async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const docUri = editor.document.uri;
                grammarDiagnostics.delete(docUri);
                markdownDiagnostics.delete(docUri);
                vscode.window.showInformationMessage('All current grammar and markdown issues have been ignored for this file.');
            } else {
                vscode.window.showInformationMessage('No active editor to clear issues from.');
            }
        })
    );

	// Lint on save for markdown files
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(async (document) => {
			if (document.languageId === 'markdown' || document.fileName.toLowerCase().endsWith('.md')) {
				await lintAndReport(document);
			}
		})
	);

	// Register a code action provider for markdownlint quick fixes (placeholder)
	context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider('markdown', {
            provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
                const actions: vscode.CodeAction[] = [];
                const relevantDiagnostics = context.diagnostics.filter(
                    diag => diag.source === 'naruhodocs-markdown' && diag.range.intersection(range)
                );

                for (const diagnostic of relevantDiagnostics) {
                    const ruleName = (diagnostic as any)._naruhodocs?.ruleName as string | undefined;

                    // Action to ignore the single issue
                    const ignoreAction = new vscode.CodeAction('Ignore this issue', vscode.CodeActionKind.QuickFix);
                    ignoreAction.command = {
                        command: 'naruhodocs.ignoreMarkdownIssue',
                        title: 'Ignore Markdown Issue',
                        arguments: [document.uri, diagnostic]
                    };
                    ignoreAction.diagnostics = [diagnostic];
                    actions.push(ignoreAction);

                    // Action to ignore all issues of the same type
                    if (ruleName) {
                        const ignoreAllAction = new vscode.CodeAction(`Ignore all issues of type '${ruleName}'`, vscode.CodeActionKind.QuickFix);
                        ignoreAllAction.command = {
                            command: 'naruhodocs.ignoreAllMarkdownRules',
                            title: `Ignore All '${ruleName}' Issues`,
                            arguments: [document.uri, ruleName]
                        };
                        ignoreAllAction.diagnostics = [diagnostic];
                        actions.push(ignoreAllAction);
                    }
                }
                return actions;
            }
        }, {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        })
    );
	// Optionally clear markdownlint diagnostics when document is closed
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => {
			markdownDiagnostics.delete(doc.uri);
		})
	);

	// Status bar item for linting
	const lintStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	lintStatusBar.text = '$(check) Markdownlint';
	lintStatusBar.tooltip = 'Markdownlint: No issues';
	lintStatusBar.hide();
	context.subscriptions.push(lintStatusBar);

	const gitHeadWatcher = vscode.workspace.createFileSystemWatcher('**/.git/logs/HEAD');
	context.subscriptions.push(gitHeadWatcher);

	gitHeadWatcher.onDidChange(async (uri) => {
		const DocDriftEnabled = vscode.workspace.getConfiguration('naruhodocs').get<boolean>('git.docDriftDetection', true);
		if (!DocDriftEnabled) {
			return;
		}
		console.log('.git/logs/HEAD changed, checking for doc drift...');
		try {
			const content = await vscode.workspace.fs.readFile(uri);
			const lines = Buffer.from(content).toString('utf8').trim().split('\n');
			const lastLine = lines[lines.length - 1];
			const parts = lastLine.split(' ');
			const newCommitHash = parts[1];

			const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceFolder) {
				return;
			}

			const { exec } = require('child_process');
			exec(`git diff-tree --no-commit-id --name-only -r ${newCommitHash}`, { cwd: workspaceFolder, maxBuffer: 10 * 1024 * 1024 }, async (err: any, stdout: string) => {
				if (err) {
					console.error('Failed to get changed files:', err);
					return;
				}
				const changedFiles = stdout.trim().split('\n').filter(f => !!f);

				const codeChanged = changedFiles.length > 0;
				const docChanged = changedFiles.some(f => f.endsWith('.md') || f.endsWith('.txt'));

				console.log(`Workspace folder: ${workspaceFolder}`);
				console.log(`Node cwd:`, process.cwd());
				console.log(`Changed files in commit ${newCommitHash}:`, changedFiles);
				console.log(`Code changed: ${codeChanged}, Docs changed: ${docChanged}`);

				// Show exact changed lines using git diff -U0, but skip for first commit
				exec(`git rev-list --parents -n 1 ${newCommitHash}`, { cwd: workspaceFolder, maxBuffer: 10 * 1024 * 1024 }, (revErr: any, revStdout: any) => {
					if (revErr) {
						return;
					}
					const revParts = revStdout.trim().split(' ');
					const isFirstCommit = revParts.length === 1;
					if (isFirstCommit) {
						// Do nothing for the first commit
						return;
					}

					const diffCmd = `git show --no-color --format= --unified=0 ${newCommitHash}`;
					exec(diffCmd, { cwd: workspaceFolder, maxBuffer: 10 * 1024 * 1024 }, async (diffErr: any, diffStdout: any) => {
						if (diffErr) {
							console.error('Failed to get git diff:', diffErr);
						}
						if (!diffErr && diffStdout) {
							const diffMsg = diffStdout.toString();
							console.log('Git diff output:\n', diffMsg);
							try {
								const response = await llmService.trackedChat({
									sessionId: 'naruhodocs-doc-drift',
									systemMessage: `You are a Documentation Drift Detector AI. Your task is to analyze a set of code changes and the corresponding project documentation. You must identify any inconsistencies or points where the documentation no longer accurately reflects the code. Be precise and provide specific line numbers or sections of the documentation that need to be updated. Your output should be a clear, actionable report.`,
									prompt: `
									Given that the following code changes were made in commit ${newCommitHash}:\n\n${diffMsg}
									\n\nBased on the code changes, look for current .md and .txt files in the workspace, retrieve their content of these documents, see whether any of them are likely to be affected by the code changes.
									You may use retrieveFilenames, retrieveFileContent tools to help you. Actively use them without waiting for user confirmation.
									Provide a concise list of files (with paths) that likely need documentation updates based on these changes and
									explain why briefly for each file and what is the context to be updated in each file.
									If there are no doc files likely affected, just say "No documentation drift detected". Do not make up any file names that do not exist.
									\nRespond in plain text, NO markdown formatting. You may use dash (-) for represent bullet points
									`,
									temperatureOverride: 0.2
								});
								console.log('Doc drift analysis response:\n', response);
								vscode.window.showInformationMessage(`NaruhoDocs: Documentation drift analysis for new git commit shown. You can turn off this feature in the settings.`, { modal: false });
								const formattedMessage = `Documentation Drift Analysis for Commit ${newCommitHash}`;
								vscode.window.showInformationMessage(formattedMessage, {
									modal: true,
									detail: response
								});
							} catch (e) {
								console.error('Doc drift analysis failed:', e);
							}
						}
					});
				});

				// 1. Auto-open documentation for editing if code changed but docs did not
				// if (codeChanged && !docChanged) {
				// 	// Auto-open related docs (.md/.txt) for each changed file
				// 	for (const file of changedFiles) {
				// 		const base = file.replace(/\.[^/.]+$/, '');
				// 		for (const ext of ['.md', '.txt']) {
				// 			const docPath = require('path').join(workspaceFolder, base + ext);
				// 			try {
				// 				await vscode.workspace.fs.stat(vscode.Uri.file(docPath));
				// 				const doc = await vscode.workspace.openTextDocument(docPath);
				// 				await vscode.window.showTextDocument(doc, { preview: false });
				// 			} catch {
				// 				// File does not exist, skip
				// 			}
				// 		}
				// 	}

				// Build a detailed message
				// 	const changedList = changedFiles.length > 5
				// 		? changedFiles.slice(0, 5).join('\n  ') + `\n  ...and ${changedFiles.length - 5} more`
				// 		: changedFiles.join('\n  ');

				// 	const author = parts.slice(2, parts.length - 3).join(' ');

				// 	vscode.window.showWarningMessage(
				// 		`⚠️ Code changed without documentation update!\n` +
				// 		`Commit: ${newCommitHash}\n` +
				// 		`Changed files:\n${changedList}\n` +
				// 		`Docs may be stale! Related docs opened for editing.`
				// 	);
				// }

				// 2. Integrate with doc threads: post a message to the thread if code changes
				// if (codeChanged) {
				// 	for (const file of changedFiles) {
				// 		const uriStr = vscode.Uri.file(require('path').join(workspaceFolder, file)).toString();
				// 		if (threadMap.has(uriStr)) {
				// 			provider.sendMessageToThread(uriStr, `Heads up: ${file} was just changed in commit ${newCommitHash}. Please review documentation for drift.`);
				// 		}
				// 	}
				// }

				// 3. Notify about dependent components (simple example: check for imports)
				// for (const file of changedFiles) {
				// 	if (file.endsWith('.js') || file.endsWith('.ts')) {
				// 		const filePath = require('path').join(workspaceFolder, file);
				// 		const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath)).then(buf => buf.toString(), () => '');
				// 		const importMatches = fileContent.match(/import\s+.*?from\s+['"](.*?)['"]/g) || [];
				// 		for (const match of importMatches) {
				// 			const dep = match.match(/['"](.*?)['"]/);
				// 			if (dep && dep[1]) {
				// 				vscode.window.showInformationMessage(`Dependency "${dep[1]}" in ${file} may be affected by recent changes.`);
				// 			}
				// 		}
				// 	}
				// }
			});
		} catch (e: any) {
			console.error('Doc drift detection failed:', e.message);
		}
	});

	// Register the clear thread history command
	const clearHistoryCommand = vscode.commands.registerCommand('naruhodocs.clearAllThreadHistory', async () => {
		try {
			// Call the STATIC method with context parameter
			await ThreadManager.clearAllThreadHistoryOnce(context);
			// Also clear visualization dedup hashes so user can immediately regenerate diagrams
			try {
				await context.workspaceState.update('visualization:lastHash:architecture', undefined);
				await context.workspaceState.update('visualization:lastHash:folder structure', undefined);
				await context.workspaceState.update('visualization:lastHash:project', undefined);
			} catch { /* ignore */ }
			vscode.window.showInformationMessage('Thread history cleared successfully! Extension will reload.');

			// Optionally auto-reload the window
			setTimeout(() => {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			}, 1000);

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to clear thread history: ${error}`);
		}
	});

	context.subscriptions.push(clearHistoryCommand);

	// Per-thread clear (toolbar) with confirmation
	const clearCurrentThreadCommand = vscode.commands.registerCommand('naruhodocs.clearCurrentThreadHistory', async () => {
		try {
			const activeThreadId = (provider as any)?.threadManager?.getActiveThreadId?.();
			if (!activeThreadId) {
				vscode.window.showWarningMessage('No active thread to clear.');
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Clear history for this thread only? This cannot be undone.`,
				{ modal: true },
				'Clear'
			);
			if (confirm !== 'Clear') { return; }
			await (provider as any)?.threadManager?.resetSession?.(activeThreadId);
			// Tell webview to clear its rendered messages & add system note
			provider?.postMessage({ type: 'clearMessages' });
			provider?.addSystemMessage('History cleared for current thread.');
			// Clear visualization dedup so user can regenerate without content change
			try {
				await context.workspaceState.update('visualization:lastHash:architecture', undefined);
				await context.workspaceState.update('visualization:lastHash:folder structure', undefined);
				await context.workspaceState.update('visualization:lastHash:project', undefined);
			} catch { /* ignore */ }
		} catch (e:any) {
			vscode.window.showErrorMessage('Failed to clear current thread history: ' + (e?.message || String(e)));
		}
	});
	context.subscriptions.push(clearCurrentThreadCommand);
}
// Removed legacy interactive configuration helpers (showLLMConfigurationQuickPick, configureLocalLLM, showLocalLLMSetupInstructions).

// This method is called when your extension is deactivated
export async function deactivate() {
	try {
		// Get the ThreadManager instance from the ChatViewProvider to save state
		const threadManager = (provider as any)?.threadManager as ThreadManager | undefined;
		if (threadManager) {
			await threadManager.saveState();
		}
	} catch (e) {
		console.warn('Failed to persist thread state on deactivate', e);
	}
}