import * as vscode from 'vscode';

/**
 * Centralized output logging utility for NaruhoDocs.
 * Provides lightweight category tagging and a dedicated output channel.
 */
export class OutputLogger {
    private static channel: vscode.OutputChannel | undefined;

    private static getChannel(): vscode.OutputChannel {
        if (!this.channel) {
            this.channel = vscode.window.createOutputChannel('NaruhoDocs');
        }
        return this.channel;
    }

    private static format(section: string, message: string): string {
        const ts = new Date().toISOString();
        return `[${ts}][${section}] ${message}`;
    }

    public static log(section: string, message: string): void {
        try {
            this.getChannel().appendLine(this.format(section, message));
        } catch {/* ignore */}
    }

    // Convenience category helpers
    public static viz(message: string): void { this.log('Visualization', message); }
    public static history(message: string): void { this.log('History', message); }
    public static analyzer(message: string): void { this.log('Analyzer', message); }
    public static error(message: string): void { this.log('Error', message); }
}
