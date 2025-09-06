import { ChatViewProvider } from './ChatViewProvider';
import * as vscode from 'vscode';
import { SummaryCodeLensProvider } from './SummaryCodeLensProvider.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { SystemMessages } from './SystemMessages';
import { checkGrammar } from './LanguageTool-integration';
import { lintMarkdownDocument } from './markdownLinter';
import { LLMProviderManager } from './llm-providers/manager';
import { LocalProvider } from './llm-providers/local';

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
	
	// Initialize provider from configuration
	llmManager.initializeFromConfig().catch(error => {
		console.error('Failed to initialize LLM provider:', error);
		// Fallback to legacy API key method for backward compatibility
		const settingsKey = vscode.workspace.getConfiguration('naruhodocs').get<string>('geminiApiKey');
		const apiKey = settingsKey || process.env.GOOGLE_API_KEY || '';
		if (!apiKey) {
			vscode.window.showWarningMessage('NaruhoDocs: No LLM provider configured. Please run "Configure LLM Provider" command.');
		}
	});

	// Listen for configuration changes and automatically update LLM provider
	let configChangeTimeout: NodeJS.Timeout | undefined;
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			// Check if any of our LLM settings changed
			if (event.affectsConfiguration('naruhodocs.llm.provider') ||
				event.affectsConfiguration('naruhodocs.llm.apiKey') ||
				event.affectsConfiguration('naruhodocs.llm.localBackend') ||
				event.affectsConfiguration('naruhodocs.llm.localModel') ||
				event.affectsConfiguration('naruhodocs.llm.localUrl')) {
				
				// Debounce configuration changes to avoid multiple rapid updates
				if (configChangeTimeout) {
					clearTimeout(configChangeTimeout);
				}
				
				configChangeTimeout = setTimeout(async () => {
					try {
						// Reinitialize LLM provider with new configuration
						await llmManager.initializeFromConfig();
						
						// Update the ChatViewProvider with the new manager
						provider.updateLLMManager(llmManager);
						
						// Get the current provider name for user feedback
						const currentProvider = llmManager.getCurrentProvider();
						const providerName = currentProvider?.name || 'LLM provider';
						
						// Show a subtle notification that the provider was updated
						vscode.window.setStatusBarMessage(`✅ ${providerName} updated`, 3000);
					} catch (error) {
						console.error('Failed to update LLM provider from configuration change:', error);
						vscode.window.showErrorMessage(`Failed to update LLM provider: ${error instanceof Error ? error.message : 'Unknown error'}`);
					}
				}, 500); // Wait 500ms for multiple rapid changes
			}
		})
	);

	// Multi-thread chat provider
	const provider = new ChatViewProvider(context.extensionUri, undefined, context, llmManager);
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
			}
		}
	}
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));


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

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.summarizeDocument', async (documentUri: vscode.Uri) => {
			await vscode.commands.executeCommand('naruhodocs.chatView.focus');
			vscode.workspace.openTextDocument(documentUri).then(document => {
				const sessionId = documentUri.toString();
				const prompt = `Summarize this document.`;

				// Ensure the thread exists and is active
				if (!threadMap.has(sessionId)) {
					threadMap.set(sessionId, { document, sessionId });
					provider.createThread(sessionId, document.getText(), document.fileName);
				}
				provider.setActiveThread(sessionId);

				// Send the prompt to the webview so main.js's sendMessage() handles it
				provider.sendMessageToThread(sessionId, prompt);
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.translateDocument', async (documentUri: vscode.Uri) => {
			const languages = [
				{ label: 'Malay', value: 'ms' },
				{ label: 'English', value: 'en' },
				{ label: 'Chinese', value: 'zh' },
				{ label: 'Japanese', value: 'ja' },
				{ label: 'Korean', value: 'ko' },
				{ label: 'Spanish', value: 'es' },
				{ label: 'French', value: 'fr' },
				{ label: 'German', value: 'de' },
				{ label: 'Russian', value: 'ru' },
				{ label: 'Arabic', value: 'ar' },
				{ label: 'Hindi', value: 'hi' }
			];
			const picked = await vscode.window.showQuickPick(languages.map(l => l.label), {
				placeHolder: 'Select a language to translate the document'
			});
			if (picked) {
				const selected = languages.find(l => l.label === picked);
				const response = await provider.sendMessageToThread(documentUri.toString(), `Translate this document to ${selected?.label}`);
				// Show Yes/No buttons in the sidebar via webview message
				provider.postMessage({
					type: 'showSaveTranslationButtons',
					translation: response,
					sessionId: documentUri.toString()
				});
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.start', () => {
			vscode.window.showInformationMessage('NaruhoDocs started!');
		}));

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.createFile', async () => {
			const uri = await vscode.window.showSaveDialog({ saveLabel: 'Create File' });
			if (uri) {
				await vscode.workspace.fs.writeFile(uri, new Uint8Array());
				vscode.window.showInformationMessage(`File created: ${uri.fsPath}`);
			}
		})
	);

	// Add new LLM provider commands
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.configureLLM', async () => {
			await showLLMConfigurationQuickPick(llmManager, provider);
		})
	);

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
		vscode.commands.registerCommand('naruhodocs.selectLocalModel', async () => {
			const currentProvider = llmManager.getCurrentProvider();
			if (currentProvider instanceof LocalProvider) {
				const models = await currentProvider.getAvailableModels();
				if (models.length > 0) {
					const selected = await vscode.window.showQuickPick(models, {
						placeHolder: 'Select a model to use'
					});
					if (selected) {
						const config = vscode.workspace.getConfiguration('naruhodocs');
						await config.update('llm.localModel', selected, vscode.ConfigurationTarget.Global);
						await llmManager.initializeFromConfig();
						provider.updateLLMManager(llmManager);
					}
				} else {
					vscode.window.showInformationMessage('No models found. Make sure your local LLM server is running.');
				}
			} else {
				vscode.window.showInformationMessage('This command is only available when using local LLM provider.');
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
				vscode.window.showWarningMessage('No LLM provider configured. Run "Configure LLM Provider" command.');
			}
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

	// Initialize the general-purpose thread
	const generalThreadId = 'naruhodocs-general-thread';
	const generalThreadTitle = 'General Purpose';
	if (!threadMap.has(generalThreadId)) {
		const sysMessage = SystemMessages.GENERAL_PURPOSE;

		threadMap.set(generalThreadId, { document: undefined as any, sessionId: generalThreadId });
		provider.createThread(generalThreadId, sysMessage, generalThreadTitle);
		activeThreadId = generalThreadId;
		provider.setActiveThread(generalThreadId);
	}

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

async function showLLMConfigurationQuickPick(llmManager: LLMProviderManager, provider: ChatViewProvider) {
	const items = [
		{
			label: '🚀 Out-of-the-Box',
			description: 'Built-in Gemini with daily limits',
			value: 'ootb'
		},
		{
			label: '🔑 Bring Your Own Key',
			description: 'Unlimited access with your API key',
			value: 'byok'
		},
		{
			label: '🏠 Local LLM',
			description: 'Use local models (Ollama, LM Studio, etc.)',
			value: 'local'
		}
	];

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'Choose your LLM provider'
	});

	if (selected) {
		const config = vscode.workspace.getConfiguration('naruhodocs');
		await config.update('llm.provider', selected.value, vscode.ConfigurationTarget.Global);

		if (selected.value === 'byok') {
			const apiKey = await vscode.window.showInputBox({
				prompt: 'Enter your Google Gemini API key',
				password: true
			});
			if (apiKey) {
				await config.update('llm.apiKey', apiKey, vscode.ConfigurationTarget.Global);
			}
		} else if (selected.value === 'local') {
			await configureLocalLLM(config);
		}

		// Reinitialize with new settings
		await llmManager.initializeFromConfig();
		
		// Update the existing ChatViewProvider with the new manager
		provider.updateLLMManager(llmManager);
		
		vscode.window.showInformationMessage(`LLM provider updated to: ${selected.label}`);
	}
}

async function configureLocalLLM(config: vscode.WorkspaceConfiguration) {
	const backendItems = [
		{
			label: '🦙 Ollama',
			description: 'Easy model management (Recommended)',
			value: 'ollama',
			defaultUrl: 'http://localhost:11434',
			defaultModel: 'llama3.1:8b'
		},
		{
			label: '🎮 LM Studio',
			description: 'User-friendly GUI interface',
			value: 'lmstudio',
			defaultUrl: 'http://localhost:1234',
			defaultModel: 'local-model'
		},
		{
			label: '⚡ llama.cpp',
			description: 'Lightweight C++ implementation',
			value: 'llamacpp',
			defaultUrl: 'http://localhost:8080',
			defaultModel: 'model'
		},
		{
			label: '🌐 Text Generation WebUI',
			description: 'Advanced web interface',
			value: 'textgen',
			defaultUrl: 'http://localhost:5000',
			defaultModel: 'model'
		},
		{
			label: '🔧 Custom',
			description: 'Custom API endpoint',
			value: 'custom',
			defaultUrl: 'http://localhost:8080',
			defaultModel: 'model'
		}
	];

	const selectedBackend = await vscode.window.showQuickPick(backendItems, {
		placeHolder: 'Choose your local LLM backend'
	});

	if (selectedBackend) {
		await config.update('llm.localBackend', selectedBackend.value, vscode.ConfigurationTarget.Global);
		
		// Ask for custom URL if needed
		const customUrl = await vscode.window.showInputBox({
			prompt: `Enter the URL for ${selectedBackend.label}`,
			value: selectedBackend.defaultUrl,
			validateInput: (value) => {
				try {
					new URL(value);
					return null;
				} catch {
					return 'Please enter a valid URL';
				}
			}
		});

		if (customUrl) {
			await config.update('llm.localUrl', customUrl, vscode.ConfigurationTarget.Global);
		}

		// Ask for model name
		const modelName = await vscode.window.showInputBox({
			prompt: `Enter the model name for ${selectedBackend.label}`,
			value: selectedBackend.defaultModel,
			placeHolder: 'e.g., llama3.1:8b, codellama:7b'
		});

		if (modelName) {
			await config.update('llm.localModel', modelName, vscode.ConfigurationTarget.Global);
		}

		// Show setup instructions
		showLocalLLMSetupInstructions(selectedBackend.value);
	}
}

function showLocalLLMSetupInstructions(backend: string) {
	const instructions: Record<string, string> = {
		ollama: `
To set up Ollama:
1. Download from: https://ollama.ai
2. Install and run: ollama pull llama3.1:8b
3. The API will be available at http://localhost:11434
		`,
		lmstudio: `
To set up LM Studio:
1. Download from: https://lmstudio.ai
2. Download a model in the app
3. Start the local server (usually on port 1234)
		`,
		llamacpp: `
To set up llama.cpp:
1. Build from: https://github.com/ggerganov/llama.cpp
2. Run: ./server -m model.gguf --port 8080
3. API will be available at http://localhost:8080
		`,
		textgen: `
To set up Text Generation WebUI:
1. Clone: https://github.com/oobabooga/text-generation-webui
2. Install and run with --api flag
3. API will be available at http://localhost:5000
		`,
		custom: `
For custom setup:
1. Ensure your API is OpenAI-compatible
2. Use the correct base URL and model name
3. Test the connection using the "Test LLM Connection" command
		`
	};

	const instruction = instructions[backend] || instructions.custom;
	
	vscode.window.showInformationMessage(
		`${backend.charAt(0).toUpperCase() + backend.slice(1)} Setup Instructions`,
		'Show Details'
	).then(selection => {
		if (selection === 'Show Details') {
			vscode.window.showInformationMessage(instruction.trim());
		}
	});
}

// This method is called when your extension is deactivated
export function deactivate() { }
