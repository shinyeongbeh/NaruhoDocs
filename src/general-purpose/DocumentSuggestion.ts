import { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } from '../langchain-backend/features';
import { createChat } from '../langchain-backend/llm.js';

// Suggest the documents that are not existing yet
export class DocumentSuggestion {
  private ongoingSuggestionPromise: Promise<Array<{ displayName: string; fileName: string; description?: string }>> | null = null;
  private suggestionCallId = 0;
  private lastNonEmptySuggestions: Array<{ displayName: string; fileName: string; description?: string }> = [];

  private docGeneratorAI = createChat({ maxHistoryMessages: 30 });

  async getWorkspaceFilesAndContents() {
    const filenamesTool = new RetrieveWorkspaceFilenamesTool();
    const fileListStr = await filenamesTool._call();
    const fileList = fileListStr.split('\n').filter((line: string) => line && !line.startsWith('Files in the workspace:'));
    const contentTool = new RetrieveFileContentTool();
    const filesAndContents: { path: string, content: string }[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const path = fileList[i];
      const content = await contentTool._call(path);
      filesAndContents.push({ path, content });
    }
    return filesAndContents;
  }

  async getAISuggestions(filesAndContents: { path: string; content: string }[]): Promise<Array<{ displayName: string; fileName: string; description?: string }>> {
    // If there's already an ongoing call, wait for it and return its result
    if (this.ongoingSuggestionPromise) {
      console.log('Waiting for ongoing suggestion call...');
      return await this.ongoingSuggestionPromise;
    }

    // Increment call ID to track this specific call
    const currentCallId = ++this.suggestionCallId;
    console.log('Starting new suggestion call ID:', currentCallId);

    // Create and store the promise for this call
    this.ongoingSuggestionPromise = this.performAISuggestion(filesAndContents, currentCallId);

    try {
      const result = await this.ongoingSuggestionPromise;
      return result;
    } finally {
      // Clear the ongoing promise when done
      this.ongoingSuggestionPromise = null;
    }
  }

  async performAISuggestion(filesAndContents: { path: string; content: string }[], currentCallId: number): Promise<Array<{ displayName: string; fileName: string; description?: string }>> {
    // const fileList = filesAndContents.map(f => f.path.split(/[/\\]/).pop()).filter(Boolean).join(', ');
    const prompt = `You are an expert technical writer and project analyst.

				For each file, you may also be given its content. Your task is to suggest a list of important documentation files (with .md extension) that are missing from this project but would be valuable for maintainability, onboarding, or API reference. For each suggestion, provide:
				- displayName: A human-friendly name (e.g., "API Reference")
				- fileName: The recommended filename (e.g., "API_REFERENCE.md")
				- description: A short description of what this document should contain.

				**You need to make sure that for the suggestion files you suggested, you have enough information to generate the documents as well.**
				Respond with a JSON array of objects with keys displayName, fileName, and description. Only suggest files that are not already present in the workspace. Do not include explanations or extra text.`;

    // const contextFiles = filesAndContents.slice(0, 3).map(f => `File: ${f.path}\n${f.content.substring(0, 1000)}`).join('\n\n');
    let llmResponse = '';
    try {
      llmResponse = await this.docGeneratorAI.chat(prompt);
      // llmResponse = await this.docGeneratorAI.chat(`${prompt}\n\nHere are some file contents for context:\n${contextFiles}`);
      const match = llmResponse.match(/\[.*\]/s);
      if (match) {
        console.log('JSON	found: ', match);
        const suggestions = JSON.parse(match[0]);
        const filteredSuggestions = Array.isArray(suggestions)
          ? suggestions.filter(s => s.displayName && s.fileName && s.fileName.endsWith('.md'))
          : [];

        // Always update with the latest successful suggestions
        if (filteredSuggestions.length > 0) {
          this.lastNonEmptySuggestions = filteredSuggestions;
          console.log('Updated lastNonEmptySuggestions:', filteredSuggestions.length, 'items');
        }

        // Return the current suggestions or last known good ones
        return filteredSuggestions.length > 0 ? filteredSuggestions : this.lastNonEmptySuggestions;
      } else {
        console.log('No JSON array found in LLM response');
      }
    } catch (e) {
      console.warn('LLM suggestion failed:', e, llmResponse);
    }

    // Return last known good suggestions or fallback
    return this.lastNonEmptySuggestions.length > 0 ? this.lastNonEmptySuggestions : [
      { displayName: 'README', fileName: 'README.md', description: 'Project overview and usage.' },
      { displayName: 'API Reference', fileName: 'API_REFERENCE.md', description: 'Document your API endpoints.' },
      { displayName: 'Getting Started', fileName: 'GETTING_STARTED.md', description: 'How to get started with the project.' }
    ];
  }
}
