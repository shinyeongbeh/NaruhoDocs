import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider.js';
import { SummaryCodeLensProvider } from './SummaryCodeLensProvider.js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env once
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Resolve API key precedence: setting > env var
	const settingsKey = vscode.workspace.getConfiguration('naruhodocs').get<string>('geminiApiKey');
	const apiKey = settingsKey || process.env.GOOGLE_API_KEY || '';
	if (!apiKey) {
		vscode.window.showWarningMessage('NaruhoDocs: Gemini API key not set. Add in settings (naruhodocs.geminiApiKey) or .env (GOOGLE_API_KEY).');
	}

	const provider = new ChatViewProvider(context.extensionUri, apiKey);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));

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

	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.createFile', async () => {
			const uri = await vscode.window.showSaveDialog({ saveLabel: 'Create File' });
			if (uri) {
				await vscode.workspace.fs.writeFile(uri, new Uint8Array());
				vscode.window.showInformationMessage(`File created: ${uri.fsPath}`);
			}
		})
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
