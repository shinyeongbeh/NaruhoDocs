import { LocalMemoryVectorStore } from './memory';
import { Embeddings } from '@langchain/core/embeddings';

let vectorStore: LocalMemoryVectorStore;
export function initializeVectorStore(embeddings: Embeddings) {
    vectorStore = new LocalMemoryVectorStore(embeddings);
}

export function getVectorStore(): LocalMemoryVectorStore {
    if (!vectorStore) {
        throw new Error('Vector store not initialized');
    }
    return vectorStore;
}