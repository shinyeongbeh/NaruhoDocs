import { Embeddings } from '@langchain/core/embeddings';
import * as vscode from 'vscode';

export class OllamaEmbeddings extends Embeddings {
  private readonly EMBEDDING_DIMENSION = 384; // Adjust based on the model used

  private OLLAMA_URL: string;
  private MODEL: string;

  constructor(model: string, url: string) {
    super({});
    this.MODEL = model;
    if(!url || url.trim() === '') {
      url = 'http://localhost:11434';
    } 
    this.OLLAMA_URL = url;
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
      if (response.status === 404) {
        vscode.window.showErrorMessage(`Please make sure that the Ollama server is running and the model '${this.MODEL}' is installed. `);
        throw new Error(`Please make sure that the Ollama server is running and the model '${this.MODEL}' is installed. `);
      } else {
        vscode.window.showErrorMessage(`Ollama embedding request failed: ${response.status} ${response.statusText}`);
        throw new Error(`Ollama embedding request failed: ${response.status} ${response.statusText}`);
      }
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