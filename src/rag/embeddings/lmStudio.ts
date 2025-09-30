import { Embeddings } from '@langchain/core/embeddings';
import * as vscode from 'vscode';

export class LMStudioEmbeddings extends Embeddings {
  private readonly EMBEDDING_DIMENSION = 384; // Adjust based on the model used

  private LM_STUDIO_URL: string;
  private MODEL: string;

  constructor(model: string, url: string) {
    super({});
    this.MODEL = model;
    if (!url || url.trim() === '') {
      url = 'http://localhost:1234'; // Default LM Studio server URL
    }
    this.LM_STUDIO_URL = url;
  }

  async embedQuery(text: string): Promise<number[]> {
    const url = `${this.LM_STUDIO_URL}/v1/embeddings`;
    const body = {
      model: this.MODEL,
      input: text // Updated field name to 'input' as required by the server
    };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`Please make sure that the LM Studio server is running and the model '${this.MODEL}' is installed. 
            If you are running the server at localhost, you might want to check whether you start your server in LM Studio\'s Developer tab (https://lmstudio.ai/docs/app/api).`);
        } else {
          throw new Error(`LM Studio embedding request failed: ${response.status} ${response.statusText}`);
        }
      }
      const data = await response.json();
      if (!data.data[0].embedding) {
        throw new Error('LM Studio response missing embedding');
      }
      return data.data[0].embedding;
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch failed')) {
        vscode.window.showErrorMessage('Failed to connect to LM Studio server. Please ensure the server is running and accessible. If you are running the server at localhost, you might want to check whether you start your server in LM Studio\'s Developer tab (https://lmstudio.ai/docs/app/api).');
      } else {
        vscode.window.showErrorMessage(`Error during LM Studio embedding request: ${error}`);
      }
      throw error;
    }
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    // LM Studio API does not natively support batch, so embed one by one
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