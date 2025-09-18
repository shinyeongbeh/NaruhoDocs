// MemoryVectorStore wrapper for hackathon-ready RAG
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import { Embeddings } from "@langchain/core/embeddings";

export class LocalMemoryVectorStore {
  private store: MemoryVectorStore;
  private embeddingsProvider: Embeddings;

  constructor(embeddingsProvider: Embeddings) {
    this.embeddingsProvider = embeddingsProvider;
    this.store = new MemoryVectorStore(embeddingsProvider);
  }

  async addDocuments(documents: Document[]): Promise<void> {
    await this.store.addDocuments(documents);
  }

  async similaritySearch(query: string, k: number = 3): Promise<Document[]> {
    return this.store.similaritySearch(query, k);
  }

  count(): number {
    return this.store.memoryVectors.length;
  }
}
