import * as vscode from 'vscode';
import { SystemMessages } from '../SystemMessages';
import { ChatSession } from '../langchain-backend/llm';
export class BeginnerDevMode {
  /**
   * Switch the system message for a document-based thread to beginner mode.
   */
  async setThreadBeginnerMode(sessionId: string, sessions: Map<string, ChatSession>, threadTitles: Map<string, string>) {
    if (sessionId === 'naruhodocs-general-thread') {
      return;
    }
    console.log('BeginnerDevMode: setThreadBeginnerMode called', sessionId);
    const session = sessions.get(sessionId);
    const title = threadTitles.get(sessionId) || '';
    let initialContext = '';
    // Use sessionId as file path for document threads
    try {
      const uri = vscode.Uri.parse(sessionId);
      const doc = await vscode.workspace.openTextDocument(uri);
      initialContext = doc.getText();
    } catch (e) {
      initialContext = '';
    }
    if (session) {
      const sysMessage = SystemMessages.DOCUMENT_SPECIFIC_BEGINNER(title, initialContext);
      session.setCustomSystemMessage(sysMessage);
    }
  }

  /**
   * Switch the system message for a document-based thread to developer mode.
   */
  public async setThreadDeveloperMode(sessionId: string, sessions: Map<string, ChatSession>, threadTitles: Map<string, string>) {
    if (sessionId === 'naruhodocs-general-thread') {
      return;
    }
    console.log('BeginnerDevMode: setThreadDeveloperMode called');
    const session = sessions.get(sessionId);
    const title = threadTitles.get(sessionId) || '';
    let initialContext = '';
    // Use sessionId as file path for document threads
    try {
      const uri = vscode.Uri.parse(sessionId);
      const doc = await vscode.workspace.openTextDocument(uri);
      initialContext = doc.getText();
    } catch (e) {
      initialContext = '';
    }
    if (session) {
      const sysMessage = SystemMessages.DOCUMENT_SPECIFIC_DEVELOPER(title, initialContext);
      session.setCustomSystemMessage(sysMessage);
    }
  }
}