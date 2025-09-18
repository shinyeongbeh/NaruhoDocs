import { ChatViewProvider } from './ChatViewProvider';
import * as vscode from 'vscode';
import { SummaryCodeLensProvider } from './DocCodeLensProvider.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { SystemMessages } from './SystemMessages';
import { checkGrammar } from './external-tools/LanguageTool-integration';
import { lintMarkdownDocument } from './external-tools/markdownLinter';
import { LLMProviderManager } from './llm-providers/manager';
import { ModelConfigManager } from './managers/ModelConfigManager.js';
import { LLMService } from './managers/LLMService';
import { LocalProvider } from './llm-providers/local';
import { VisualizationProvider } from './VisualizationProvider';

// Load env once
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// Register scanDocs command to call provider.scanDocs()
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.scanDocs', async () => {
			await provider.scanDocs();
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
			const providerType = vscode.workspace.getConfiguration('naruhodocs').get<string>('llm.provider','ootb');
			const svcAny = llmService as any;
			let model: string | undefined = svcAny.sessionModelHints?.get(sessionId) || svcAny.sessionModelHints?.get('general');
			let trace: string[] = [];
			if (!model) {
				if (modelConfigManager.isActive()) {
					const resolved = modelConfigManager.resolveModel(providerType, 'chat', undefined, providerType === 'local' ? 'gemma3:1b' : 'gemini-2.0-flash');
					model = resolved.model;
					trace = ['file-active', ...resolved.trace];
				} else {
					model = providerType === 'local' ? 'gemma3:1b' : 'gemini-2.0-flash';
					trace = ['default-fallback'];
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

	const provider = new ChatViewProvider(context.extensionUri, undefined, context, llmManager);

	// Model config manager (per-repo JSON) - instantiate now, load inside activation async block
	const modelConfigManager = new ModelConfigManager(context);
	llmService.setModelConfigManager(modelConfigManager);

	// Provider profile memory removed (deprecated). Models now fully governed by .naruhodocs/models.json and runtime hints.
	let currentProviderType = vscode.workspace.getConfiguration('naruhodocs').get<string>('llm.provider','ootb');
	
	// Initialize Visualization Provider
	const visualizationProvider = new VisualizationProvider(context, llmManager);
	
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
			await llmManager.initializeFromConfig();
			llmService.logEvent('provider_init', { provider: llmManager.getCurrentProvider()?.name });
			// Clear any pre-existing sessions created via fallback before provider ready
			llmService.clearAllSessions();
			await llmService.restoreState();

			// Initialize the general-purpose thread AFTER provider is confirmed
			const generalThreadId = 'naruhodocs-general-thread';
			const generalThreadTitle = 'General Purpose';
			if (!threadMap.has(generalThreadId)) {
				threadMap.set(generalThreadId, { document: undefined as any, sessionId: generalThreadId });
				// Ensure backing LLM session is created through LLMService so logging + provider attribution work
				await llmService.getSession(generalThreadId, SystemMessages.GENERAL_PURPOSE, { taskType: 'chat', forceNew: true });
				provider.createThread(generalThreadId, SystemMessages.GENERAL_PURPOSE, generalThreadTitle);
				activeThreadId = generalThreadId;
				provider.setActiveThread(generalThreadId);
			}
			updateProviderModelStatus(generalThreadId);

			// For already-open documents, create threads now that provider is ready
			const openDocs = vscode.workspace.textDocuments;
			for (const document of openDocs) {
				const fileName = document.fileName.toLowerCase();
				if (fileName.endsWith('.md') || fileName.endsWith('.txt')) {
					const uriStr = document.uri.toString();
					if (!threadMap.has(uriStr)) {
						const sessionId = uriStr;
						threadMap.set(uriStr, { document, sessionId });
						await llmService.getSession(sessionId, SystemMessages.GENERAL_PURPOSE, { taskType: 'chat', forceNew: true });
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
						const newProviderType = config.get<string>('llm.provider','ootb');
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
			const summaryDoc = await vscode.workspace.openTextDocument({
				content: `# Summary of ${path.basename(doc.fileName)}\n\n${resp.content}`,
				language: 'markdown'
			});
			await vscode.window.showTextDocument(summaryDoc, { preview: true });
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
						const targetUri = vscode.Uri.joinPath(ws.uri, `${path.basename(doc.fileName).replace(/\.[^.]+$/, '')}.${picked.toLowerCase()}.md`);
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
				const provider = await vscode.window.showQuickPick(['ootb','byok','local'], { placeHolder: 'Select provider' });
				if (!provider) { return; }
				const task = await vscode.window.showQuickPick([
					'chat','summarize','read_files','analyze','translate','generate_doc','visualization_context'
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
					const current = config.get<string>('llm.provider','ootb');
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

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.visualizeDocRelations', async () => {
			await visualizationProvider.visualizeDocRelations();
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

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.checkGrammar', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showInformationMessage('No active editor.');
				return;
			}
			const document = editor.document;
			const fileName = document.fileName.toLowerCase();
			if (!(fileName.endsWith('.md') || fileName.endsWith('.txt'))) {
				vscode.window.showInformationMessage('Grammar checking is only available for document files (.md, .txt).');
				return;
			}
			const text = document.getText();
			let issues: any[] = [];
			try {
				issues = await checkGrammar(text, 'en-US');
			} catch (e: any) {
				vscode.window.showErrorMessage('Grammar check failed: ' + e.message);
				return;
			}
			// Clear previous diagnostics for this document
			grammarDiagnostics.delete(document.uri);

			if (issues.length === 0) {
				vscode.window.showInformationMessage('No grammar issues found!');
				return;
			}

			const diagnostics: vscode.Diagnostic[] = issues.map(issue => {
				const start = document.positionAt(issue.offset);
				const end = document.positionAt(issue.offset + issue.length);
				const range = new vscode.Range(start, end);
				const message = `${issue.message}${issue.replacements.length ? ' Suggestion: ' + issue.replacements.join(', ') : ''}`;
				return new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning);
			});
			grammarDiagnostics.set(document.uri, diagnostics);
			vscode.window.showInformationMessage(`Grammar issues found: ${issues.length}. See inline warnings.`);
		})
	);

	// Optionally clear diagnostics when document is closed
	context.subscriptions.push(
		vscode.workspace.onDidCloseTextDocument(doc => {
			grammarDiagnostics.delete(doc.uri);
		})
	);

    // (Removed early general thread creation; now happens after provider init)

	// Markdownlint diagnostics
	const markdownDiagnostics = vscode.languages.createDiagnosticCollection('naruhodocs-markdownlint');
	context.subscriptions.push(markdownDiagnostics);

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
			provideCodeActions(document, range, context, token) {
				// Placeholder: In a real implementation, you would check diagnostics and offer fixes
				// For now, just show a sample quick fix for demonstration
				const fixes: vscode.CodeAction[] = [];
				for (const diag of context.diagnostics) {
					if ((diag as any).ruleName === 'MD009') { // Example: No trailing spaces
						const fix = new vscode.CodeAction('Remove trailing spaces', vscode.CodeActionKind.QuickFix);
						fix.edit = new vscode.WorkspaceEdit();
						// Remove trailing spaces in the affected line
						const line = document.lineAt(range.start.line);
						const trimmed = line.text.replace(/\s+$/g, '');
						fix.edit.replace(document.uri, line.range, trimmed);
						fix.diagnostics = [diag];
						fixes.push(fix);
					}
				}
				return fixes;
			}
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
	// Helper to lint and show diagnostics (used by command and on save)
	async function lintAndReport(document: vscode.TextDocument) {
		if (!document.fileName.toLowerCase().endsWith('.md')) { return; }
		let issues: any[] = [];
		try {
			issues = await lintMarkdownDocument(document) as any[];
		} catch (e: any) {
			vscode.window.showErrorMessage('Markdown lint failed: ' + e.message);
			lintStatusBar.text = '$(error) Markdownlint';
			lintStatusBar.tooltip = 'Markdownlint: Error';
			lintStatusBar.show();
			return;
		}
		markdownDiagnostics.delete(document.uri);
		if (!issues || issues.length === 0) {
			lintStatusBar.text = '$(check) Markdownlint';
			lintStatusBar.tooltip = 'Markdownlint: No issues';
			lintStatusBar.show();
			return;
		}
		const diagnostics: vscode.Diagnostic[] = issues.map(issue => {
			const start = new vscode.Position((issue.lineNumber || 1) - 1, 0);
			const end = new vscode.Position((issue.lineNumber || 1) - 1, 1000);
			const message = `${issue.ruleNames ? issue.ruleNames.join(', ') + ': ' : ''}${issue.ruleDescription || issue.ruleName}` + (issue.errorDetail ? ` [${issue.errorDetail}]` : '');
			const diag = new vscode.Diagnostic(new vscode.Range(start, end), message, vscode.DiagnosticSeverity.Warning);
			// Attach rule name for quick fix
			(diag as any).ruleName = issue.ruleNames ? issue.ruleNames[0] : '';
			return diag;
		});
		markdownDiagnostics.set(document.uri, diagnostics);
		lintStatusBar.text = `$(alert) Markdownlint: ${issues.length} issue${issues.length > 1 ? 's' : ''}`;
		lintStatusBar.tooltip = `Markdownlint: ${issues.length} issue${issues.length > 1 ? 's' : ''}`;
		lintStatusBar.show();
	}
}

// Removed legacy interactive configuration helpers (showLLMConfigurationQuickPick, configureLocalLLM, showLocalLLMSetupInstructions).

// This method is called when your extension is deactivated
export async function deactivate() {
	try {
		const existing = (LLMService as any).instance as LLMService | undefined;
		if (existing) {
			await existing.saveState();
		}
	} catch (e) {
		console.warn('Failed to persist LLMService state on deactivate', e);
	}
}
