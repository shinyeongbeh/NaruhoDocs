import * as vscode from 'vscode';
import { Tool } from '@langchain/core/tools';

// Tool to retrieve all filenames in the current workspace
export class RetrieveWorkspaceFilenamesTool extends Tool {
  name = 'retrieve_workspace_filenames';
  description = 'Retrieves all filenames in the current workspace folder.';

  async _call(): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return 'No workspace folder is currently open.';
    }

    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
    const fileList = files.map(file => file.fsPath).join('\n');
    console.log('Called TOOL retrieve_workspace_filenames');
    return `Files in the workspace:\n${fileList}`;
  }
}

// Tool to retrieve the content of a specific file
export class RetrieveFileContentTool extends Tool {
  name = 'retrieve_file_content';
  description = 'Retrieves the content of a specific file given its path.';

  async _call(filePath: string): Promise<string> {
    try {
      const fileUri = vscode.Uri.file(filePath);
      const content = await vscode.workspace.fs.readFile(fileUri);
      console.log(`Called TOOL retrieve_file_content for ${filePath}`);
      return `Content of ${filePath}:\n${content.toString()}`;
    } catch (error: any) {
      return `Error reading file ${filePath}: ${error.message}`;
    }
  }
}