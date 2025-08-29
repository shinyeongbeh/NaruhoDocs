import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
import { SummaryCodeLensProvider } from './SummaryCodeLensProvider';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const provider = new ChatViewProvider(context.extensionUri);

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
}

// This method is called when your extension is deactivated
export function deactivate() {}
