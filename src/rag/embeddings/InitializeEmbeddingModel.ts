import { EmbeddingProviderConfig } from "../../managers/EmbeddingConfigManager";
import * as vscode from 'vscode';
import { OllamaEmbeddings } from "./ollama";
import { HuggingFaceEmbeddings } from "./huggingfaceCloud";
import { Embeddings } from "@langchain/core/embeddings";

// initialize embedding model based on config
export async function initializeEmbeddingModel(embeddingConfig: EmbeddingProviderConfig | undefined): Promise<Embeddings> {
  let embeddings;
  if (embeddingConfig?.type === 'local') {
    switch (embeddingConfig?.llmEngine) {
      case 'ollama':
        embeddings = new OllamaEmbeddings(embeddingConfig?.model ?? 'snowflake-arctic-embed:33m', embeddingConfig?.baseUrl ?? 'http://localhost:11434');
        break;
      default:
        throw new Error(`Unsupported local embedding engine: ${embeddingConfig?.llmEngine}`);
    }
  } else if (embeddingConfig?.type === 'huggingface') {
    const hfApiKey = vscode.workspace.getConfiguration('naruhodocs').get<string>('huggingface.apiKey', '');
    if (hfApiKey === '') {
      vscode.window.showErrorMessage('HuggingFace API key for RAG database embedding is not set. Please configure it in settings.');
    }
    embeddings = new HuggingFaceEmbeddings(hfApiKey, embeddingConfig?.model ?? 'sentence-transformers/all-MiniLM-L6-v2');
  } else {
    vscode.window.showErrorMessage('Unsupported or missing embedding configuration. Please check your settings or embeddings.json file.');   
    throw new Error('Unsupported or missing embedding configuration. Please check your settings or embeddings.json file.');
  }
  return embeddings;
}