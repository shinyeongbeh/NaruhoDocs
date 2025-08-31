import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
import { SummaryCodeLensProvider } from './SummaryCodeLensProvider';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env once
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Thread management: map document URI to thread info
	const threadMap: Map<string, { document: vscode.TextDocument, sessionId: string }> = new Map();
	let activeThreadId: string | undefined;

	// API key resolution
	const settingsKey = vscode.workspace.getConfiguration('naruhodocs').get<string>('geminiApiKey');
	const apiKey = settingsKey || process.env.GOOGLE_API_KEY || '';
	if (!apiKey) {
		vscode.window.showWarningMessage('NaruhoDocs: Gemini API key not set. Add in settings (naruhodocs.geminiApiKey) or .env (GOOGLE_API_KEY).');
	}

	// Multi-thread chat provider
	const provider = new ChatViewProvider(context.extensionUri, apiKey);
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
				const summary = `This is a summary of the document: ${document.fileName}. It has ${document.lineCount} lines.`;
				provider.postMessage({ type: 'addMessage', sender: 'Bot', message: summary });
			});
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.start', () => {
			vscode.window.showInformationMessage('NaruhoDocs started!');
		}));
}

// This method is called when your extension is deactivated
export function deactivate() {}
