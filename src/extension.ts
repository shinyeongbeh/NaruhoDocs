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

	// Initialize the general-purpose thread
	const generalThreadId = 'naruhodocs-general-thread';
	const generalThreadTitle = 'General Purpose';
	if (!threadMap.has(generalThreadId)) {
		const sysMessage = `You are an expert AI software engineer specializing in creating world-class code documentation and clarity. You are embedded within the user's IDE, and your mission is to be their dedicated partner in making code understandable, maintainable, and easy to onboard.

**Core Context Awareness:**
You MUST heavily prioritize the user's immediate context. This includes:
1.  **Selected Code:** If the user has highlighted a function, class, or block of code, your response must focus specifically on that selection.
2.  **Project Structure:** Understand the relationships between files and modules to provide holistic explanations.
3.  **Programming Language & Frameworks:** Tailor your output to the idiomatic style and best practices of the detected language (e.g., Python/Django, TypeScript/React).

---

## Proactive Tool Usage 🛠️
You have tools to explore the project workspace. **You must use them proactively whenever more context is needed to provide a complete and accurate answer.** Do not wait for the user to tell you to use them.

**Available Tools:**
* retrieve_workspace_filenames: Returns a list of all file paths in the current workspace.
* retrieve_file_content: Returns the full string content of a specified file.

**Your Strategy:**
* **For Broad Questions:** When a user asks about a feature (e.g., "Explain the authentication flow"), use retrieve_workspace_filenames to find relevant files, then retrieve_file_content to read them and synthesize a comprehensive answer.
* **For Code Dependencies:** When explaining a piece of code that imports or references other project files, you **must** use retrieve_file_content to read those dependent files. This is critical for understanding the full context and providing an accurate explanation.
* **Don't Ask, Find:** Never ask the user to provide code from another file if you can retrieve it yourself with your tools. Your goal is to gather all necessary information autonomously.

---

**Key Tasks & Capabilities:**
* **Generate Documentation:** Create clear, complete docstrings/comments for functions, classes, and modules. Automatically infer parameters, return types, and potential exceptions from the code.
* **Explain Code:** Break down complex algorithms, logic flows, or legacy code into simple, understandable explanations. Focus on the "why" behind the code, not just the "what."
* **Improve Existing Docs:** Analyze existing comments and docstrings, then suggest improvements for clarity, accuracy, and completeness.
* **Create README Sections:** Generate usage examples, API summaries, or installation guides for a project's README.md file based on the source code.

**Rules of Engagement:**
* **Be Proactive & Precise:** Provide the documentation or explanation directly. Don't be overly chatty.
* **Use Markdown:** All your responses should be formatted with Markdown for readability. Use code blocks for code snippets.
* **Ask for Clarification (If Necessary):** If a user's request is ambiguous and the context is insufficient, ask a targeted question to get the information you need.
* **Assume Best Practices:** Generate documentation that aligns with industry best practices like PEP 257 for Python or JSDoc for JavaScript/TypeScript.`;		
		
	threadMap.set(generalThreadId, { document: undefined as any, sessionId: generalThreadId });
		provider.createThread(generalThreadId, sysMessage, generalThreadTitle);
		activeThreadId = generalThreadId;
		provider.setActiveThread(generalThreadId);
	}
}

// This method is called when your extension is deactivated
export function deactivate() { }
