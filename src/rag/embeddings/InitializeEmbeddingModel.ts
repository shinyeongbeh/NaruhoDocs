import { EmbeddingProviderConfig } from "../../managers/EmbeddingConfigManager";
import * as vscode from 'vscode';
import { OllamaEmbeddings } from "./ollama";
import { HuggingFaceEmbeddings } from "./huggingfaceCloud";
import { Embeddings } from "@langchain/core/embeddings";
import { LMStudioEmbeddings } from "./lmStudio";

// initialize embedding model based on config
export async function initializeEmbeddingModel(embeddingConfig: EmbeddingProviderConfig | undefined): Promise<Embeddings> {
  let embeddings;
  if (embeddingConfig?.type === 'local') {
    switch (embeddingConfig?.llmEngine) {
      case 'ollama':
        embeddings = new OllamaEmbeddings(embeddingConfig?.model ?? 'snowflake-arctic-embed:33m', embeddingConfig?.baseUrl ?? 'http://localhost:11434');
        break;
      case 'lmstudio':
        embeddings = new LMStudioEmbeddings(embeddingConfig?.model ?? 'all-MiniLM-L6-v2', embeddingConfig?.baseUrl ?? 'http://localhost:1234');
        break;
      default:
        const action = await vscode.window.showErrorMessage(
          `Unsupported local embedding engine: ${embeddingConfig?.llmEngine}. Supported engines are 'ollama' and 'lmstudio'. Please check your configuration in embeddings.json.`,
          'Open embeddings.json'
        );
        if(action === 'Open embeddings.json') {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0].uri || vscode.Uri.file(''), '.naruhodocs', 'embeddings.json'));
        }
        throw new Error(`Unsupported local embedding engine: ${embeddingConfig?.llmEngine}. Supported engines are 'ollama' and 'lmstudio'. Please check your configuration in embeddings.json.`);
    }
  } else if (embeddingConfig?.type === 'huggingface') {
    const hfApiKey = vscode.workspace.getConfiguration('naruhodocs').get<string>('huggingface.apiKey', '');
    if (hfApiKey === '') {
      const action = await vscode.window.showErrorMessage(
        'HuggingFace API key for RAG database embedding is not set. Please configure it in settings.',
        'Open NaruhoDocs Settings'
      );
      if (action === 'Open NaruhoDocs Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'naruhodocs');
      }
      throw new Error('HuggingFace API key for RAG database embedding is not set. Please configure it in settings.');
    }
    embeddings = new HuggingFaceEmbeddings(hfApiKey, embeddingConfig?.model ?? 'sentence-transformers/all-MiniLM-L6-v2');
  } else {
    const action = await vscode.window.showErrorMessage('Unsupported or missing embedding configuration. Please check your settings or embeddings.json file.'
      , 'Open embeddings.json'
    );
    if(action === 'Open embeddings.json') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0].uri || vscode.Uri.file(''), '.naruhodocs', 'embeddings.json'));
    }
    throw new Error('Unsupported or missing embedding configuration. Please check your settings or embeddings.json file.');
  }
  return embeddings;
}