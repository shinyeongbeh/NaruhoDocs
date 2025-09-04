import * as vscode from 'vscode';

export class SummaryCodeLensProvider implements vscode.CodeLensProvider {
    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];
        const range = new vscode.Range(0, 0, 0, 0);
        // Summarize Document button
        codeLenses.push(new vscode.CodeLens(range, {
            command: 'naruhodocs.summarizeDocument',
            title: '🌟 Summarize Document',
            arguments: [document.uri]
        }));

        // Switch Mode button
        codeLenses.push(new vscode.CodeLens(range, {
            command: 'naruhodocs.translateDocument',
            title: '🌐 Translate Document',
            arguments: [document.uri]
        }));

        // Add Check Grammar button
        codeLenses.push(new vscode.CodeLens(range, {
            command: 'naruhodocs.checkGrammar',
            title: '📝 Check Grammar',
            arguments: []
        }));

        return codeLenses;
    }
}
