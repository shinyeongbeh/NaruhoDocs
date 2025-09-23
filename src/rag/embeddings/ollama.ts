import { Embeddings } from '@langchain/core/embeddings';

export class OllamaEmbeddings extends Embeddings {
  private readonly EMBEDDING_DIMENSION = 384; // Adjust based on the model used


  private readonly OLLAMA_URL = 'http://localhost:11434';
  private readonly MODEL = 'snowflake-arctic-embed:33m';

  constructor() {
    super({});
  }

  async embedQuery(text: string): Promise<number[]> {
    const url = `${this.OLLAMA_URL}/api/embeddings`;
    const body = {
      model: this.MODEL,
      prompt: text
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Ollama embedding request failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!data.embedding) {
      throw new Error('Ollama response missing embedding');
    }
    return data.embedding;
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    // Ollama API does not natively support batch, so embed one by one
    const results: number[][] = [];
    for (const doc of documents) {
      results.push(await this.embedQuery(doc));
    }
    return results;
  }

  dimension(): number {
    return this.EMBEDDING_DIMENSION;
  }
}