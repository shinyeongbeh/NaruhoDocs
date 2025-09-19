import { Tool } from '@langchain/core/tools';
import vectorStore from '../rag/vectorstore/vectorStoreSingleton';
import { Document } from '@langchain/core/documents';

// Tool to retrieve relevant context from the vector store
export class RAGretrievalTool extends Tool {
    private vectorStore = vectorStore; // Use the shared vector store instance

    name = 'RAG_retrieve_context';
    description = 'Retrieves semantically relevant document chunks from the codebase based on a query.';

    async _call(query: string): Promise<string> {
        try {
            // Ensure vector store is initialized
            if (!this.vectorStore) {
                throw new Error('Vector store not initialized');
            }

            const docs = await this.vectorStore.similaritySearch(query);

            if (docs.length === 0) {
                return 'No relevant context found in the workspace.';
            }

            // Format results with only file paths and line ranges for logging
            const logResults = docs.map((doc: Document) => {
                const metadata = doc.metadata;
                return `File: ${metadata.filePath} (Lines ${metadata.startLine}-${metadata.endLine})`;
            }).join('\n');

            // But return the full code snippets as before
            const formattedResults = docs.map((doc: Document) => {
                const metadata = doc.metadata;
                return `File: ${metadata.filePath} (Lines ${metadata.startLine}-${metadata.endLine})\n\`\`\`\n${doc.pageContent}\n\`\`\`\n`;
            }).join('\n');

            console.log(`Called TOOL retrieve_relevant_context - found ${docs.length} relevant chunks\nFiles:\n${logResults}`);
            return `Relevant code snippets:\n${formattedResults}`;

        } catch (error: any) {
            console.error('Error retrieving relevant context:', error);
            return `Error retrieving relevant context: ${error.message}`;
        }
    }
}

// Re-export existing tools along with new RAG tool
// export { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } from './features';
