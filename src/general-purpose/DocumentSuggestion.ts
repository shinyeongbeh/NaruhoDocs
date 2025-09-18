import { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } from '../langchain-backend/features';
import { LLMService } from '../managers/LLMService';
// Suggest the documents that are not existing yet
export class DocumentSuggestion {
  private ongoingSuggestionPromise: Promise<Array<{ displayName: string; fileName: string; description?: string }>> | null = null;
  private suggestionCallId = 0;
  private lastNonEmptySuggestions: Array<{ displayName: string; fileName: string; description?: string }> = [];

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

  async getAISuggestions(llmService: LLMService, filesAndContents: { path: string; content: string }[]): Promise<Array<{ displayName: string; fileName: string; description?: string }>> {
    // If there's already an ongoing call, wait for it and return its result
    if (this.ongoingSuggestionPromise) {
      // Waiting for ongoing suggestion call
      return await this.ongoingSuggestionPromise;
    }

    // Increment call ID to track this specific call
    const currentCallId = ++this.suggestionCallId;
  // Starting new suggestion call ID

    // Create and store the promise for this call
    this.ongoingSuggestionPromise = this.performAISuggestion(llmService, filesAndContents, currentCallId);

    try {
      const result = await this.ongoingSuggestionPromise;
      return result;
    } finally {
      // Clear the ongoing promise when done
      this.ongoingSuggestionPromise = null;
    }
  }

  async performAISuggestion(llmService: LLMService, filesAndContents: { path: string; content: string }[], currentCallId: number): Promise<Array<{ displayName: string; fileName: string; description?: string }>> {
    const sys = `You are an expert technical writer and project analyst.
    Your task is to suggest a list of important documentation files (with .md extension) that are missing from this project but would be valuable for maintainability, onboarding, or API reference. 
    You may want to use tools like "RetrieveWorkspaceFilenamesTool" and "RetrieveFileContentTool" to read the project files and contents.
    **You need to make sure that for the suggestion files you suggested, you have enough information to generate the documents as well.**
    `;
    const prompt = `
				Your task is to suggest a list of important documentation files (with .md extension) that are missing from this project but would be valuable for maintainability, onboarding, or API reference. For each suggestion, provide:
				- displayName: A human-friendly name (e.g., "API Reference")
				- fileName: The recommended filename (e.g., "API_REFERENCE.md")
				- description: A short description of what this document should contain.

				Respond with a JSON array of objects with keys displayName, fileName, and description. Only suggest files that are not already present in the workspace. Do not include explanations or extra text.`;

    let llmResponse = '';
    try {
      llmResponse = await llmService.trackedChat({
        sessionId: 'doc-suggestion',
        systemMessage: sys,
        prompt: prompt,
        task:'chat',
        forceNew: true
      });
      const match = llmResponse.match(/\[.*\]/s);
      if (match) {
        // JSON array found in response
        const suggestions = JSON.parse(match[0]);
        const filteredSuggestions = Array.isArray(suggestions)
          ? suggestions.filter(s => s.displayName && s.fileName && s.fileName.endsWith('.md'))
          : [];

        // Always update with the latest successful suggestions
        if (filteredSuggestions.length > 0) {
          this.lastNonEmptySuggestions = filteredSuggestions;
          // Updated lastNonEmptySuggestions
        }

        // Return the current suggestions or last known good ones
        return filteredSuggestions.length > 0 ? filteredSuggestions : this.lastNonEmptySuggestions;
      } else {
        // No JSON array found in LLM response
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
