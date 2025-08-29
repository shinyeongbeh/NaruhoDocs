import * as vscode from 'vscode';

export class SummaryCodeLensProvider implements vscode.CodeLensProvider {
    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];
        const range = new vscode.Range(0, 0, 0, 0);
        const command: vscode.Command = {
            command: 'naruhodocs.summarizeDocument',
            title: '🌟 Summarize Document',
            arguments: [document.uri]
        };
        codeLenses.push(new vscode.CodeLens(range, command));
        return codeLenses;
    }
}
