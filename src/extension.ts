import { ChatViewProvider } from './ChatViewProvider';
import * as vscode from 'vscode';
import { SummaryCodeLensProvider } from './SummaryCodeLensProvider.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { SystemMessages } from './SystemMessages';

// Load env once
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// Helper to check if a file exists in the workspace
	async function fileExistsInWorkspace(fileName: string): Promise<string | null> {
		const wsFolders = vscode.workspace.workspaceFolders;
		if (!wsFolders || wsFolders.length === 0) return null;
		const files = await vscode.workspace.findFiles(`**/${fileName}`);
		if (files.length > 0) {
			return files[0].fsPath;
		}
		return null;
	}

	// Helper to get all filenames and contents
	async function getWorkspaceFilesAndContents() {
		const { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } = require('./langchain-backend/features');
		const filenamesTool = new RetrieveWorkspaceFilenamesTool();
		const fileListStr = await filenamesTool._call();
		const fileList = fileListStr.split('\n').filter((line: string) => line && !line.startsWith('Files in the workspace:'));
		const contentTool = new RetrieveFileContentTool();
		// Only get content for up to 20 files to avoid performance issues
		const filesAndContents: { path: string, content: string }[] = [];
 		for (let i = 0; i < fileList.length; i++) {
			const path = fileList[i];
			const content = await contentTool._call(path);
			filesAndContents.push({ path, content });
		}
		return filesAndContents;
	}

	// Example: AI suggestion function (replace with your actual LLM call)
	async function getAISuggestions(filesAndContents: { path: string; content: string }[]): Promise<Array<{ displayName: string; fileName: string; description?: string }>> {
		// Here you would call your LLM/AI backend with filesAndContents
		// For demo, return a static suggestion list
		return [
			{ displayName: 'README', fileName: 'README.md', description: 'Project overview and usage.' },
			{ displayName: 'API Reference', fileName: 'API_REFERENCE.md', description: 'Document your API endpoints.' },
			{ displayName: 'Getting Started', fileName: 'GETTING_STARTED.md', description: 'How to get started with the project.' }
		];
	}

	// Filtering and sending to webview

	async function sendAISuggestedDocs(
		aiSuggestions: Array<{ displayName: string; fileName: string; description?: string }>,
		filesAndContents: Array<{ path: string; content: string }>,
		provider: ChatViewProvider
	) {
		// Pass all AI suggestions to modal, but filter after AI generates
		provider.postMessage({ type: 'aiSuggestedDocs', suggestions: aiSuggestions, existingFiles: filesAndContents.map(f => f.path.split(/[/\\]/).pop()?.toLowerCase()) });
	}
	// Use RetrieveWorkspaceFilenamesTool for scanning workspace files
	const { RetrieveWorkspaceFilenamesTool } = require('./langchain-backend/features');
	const scanDocs = async () => {
 		// Get all filenames and contents
 		const { RetrieveWorkspaceFilenamesTool } = require('./langchain-backend/features');
 		const filenamesTool = new RetrieveWorkspaceFilenamesTool();
 		const fileListStr = await filenamesTool._call();
 		const fileList = fileListStr.split('\n').filter((line: string) => line && !line.startsWith('Files in the workspace:'));
 		// ...removed debug logging...
 		const filesAndContents = await getWorkspaceFilesAndContents();
 		// Get AI suggestions
 		const aiSuggestions = await getAISuggestions(filesAndContents);
 		// Filter and send to webview
 		await sendAISuggestedDocs(aiSuggestions, filesAndContents, provider);
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('naruhodocs.scanDocs', scanDocs)
	);

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
	const provider = new ChatViewProvider(context.extensionUri, apiKey, context);
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
}

// This method is called when your extension is deactivated
export function deactivate() { }
