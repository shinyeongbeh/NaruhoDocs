import * as vscode from 'vscode';
// import vectorStore from './vectorStoreSingleton';
import { Document } from '@langchain/core/documents';
import { LocalMemoryVectorStore } from './memory';

//to build the database from workspace files
export async function buildVectorDB(vectorStore: LocalMemoryVectorStore) {
  // Use the shared vector store instance
  const docs: Document[] = [];
  const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.next/**,**/.vercel/**}');
  const notAllowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.ico', '.exe', '.dll', '.bin', '.class', '.jar', '.war', '.zip', '.tar', '.gz', '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.pdf', '.naruhodocs'];
  for (const file of files) {
    if (notAllowedExtensions.some(ext => file.fsPath.endsWith(ext))) { continue; }
    try {
      const content = (await vscode.workspace.fs.readFile(file)).toString();
      // Skip empty or whitespace-only files
      if (!content || content.trim().length === 0 || content.trim() === '{}') {
        continue;
      }

      // Simple chunking: split content into ?-character chunks
      // const chunkSize = 10000;
      // for (let i = 0; i < content.length; i += chunkSize) {
      //   const chunk = content.slice(i, i + chunkSize);
      //   docs.push(new Document({
      //     pageContent: chunk,
      //     metadata: {
      //       filePath: file.fsPath,
      //       chunkId: `${file.fsPath}-chunk-${Math.floor(i / chunkSize)}`,
      //       startLine: 1, // Optionally improve: map char index to line number
      //       endLine: 1,
      //       lastUpdated: Date.now()
      //     }
      //   }));
      // }

      // Add whole file as single chunk
      docs.push(new Document({
        pageContent: content,
        metadata: {
          filePath: file.fsPath,
          chunkId: file.fsPath,
          startLine: 1,
          endLine: content.split('\n').length,
          lastUpdated: Date.now()
        }
      }));
    } catch (e) {
      console.warn('Failed to read file for vector DB:', file.fsPath, e);
    }
  }
  if (docs.length > 0) {
    await vectorStore.addDocuments(docs);
    vscode.window.showInformationMessage(`NaruhoDocs: Vector DB built with ${docs.length} files.`);
    console.log(vectorStore.similaritySearch('NaruhoDocs: Vector DB built! '));
  } else {
    vscode.window.showWarningMessage('NaruhoDocs: No files found for vector DB.');
  }
}