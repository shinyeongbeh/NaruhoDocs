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

    try {
      const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      
      // Provide both absolute and relative paths for better compatibility
      const fileList = files.map(file => {
        const absolutePath = file.fsPath;
        const relativePath = vscode.workspace.asRelativePath(file);
        return `${relativePath} (${absolutePath})`;
      }).join('\n');
      
  // Called TOOL retrieve_workspace_filenames - found ${files.length} files
      console.log(`Called TOOL retrieve_workspace_filenames - found ${files.length} files`);
      if (files.length === 0) {
        return 'No files found in the workspace (excluding node_modules).';
      }
      
      return `Files in the workspace (${files.length} total):\n${fileList}`;
    } catch (error: any) {
      console.error('Error retrieving workspace filenames:', error);
      return `Error retrieving workspace files: ${error.message || 'Unknown error'}`;
    }
  }
}

// Tool to retrieve the content of a specific file
export class RetrieveFileContentTool extends Tool {
  name = 'retrieve_file_content';
  description = 'Retrieves the content of a specific file given its path.';

  async _call(filePath: string): Promise<string> {
    try {
      // Handle both absolute and relative paths
      let fileUri: vscode.Uri;
      
      if (filePath.startsWith('/') || filePath.includes(':')) {
        // Absolute path
        fileUri = vscode.Uri.file(filePath);
      } else {
        // Relative path - resolve against workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          return `Error: No workspace folder is open to resolve relative path: ${filePath}`;
        }
        fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath);
      }
      
  // Called TOOL retrieve_file_content for ${filePath}
      console.log(`Called TOOL retrieve_file_content for ${filePath}`); 
      const content = await vscode.workspace.fs.readFile(fileUri);
      const text = content.toString();
      
      // Verify content was read successfully
      if (text.length === 0) {
        return `Content of ${filePath}: [File exists but is empty]`;
      }
      
      return `Content of ${filePath}:\n${text}`;
    } catch (error: any) {
      console.error(`Error reading file ${filePath}:`, error);
      
      // Provide more detailed error information
      let errorMessage = `Error reading file ${filePath}: `;
      
      if (error.code === 'FileNotFound' || error.message?.includes('not exist')) {
        errorMessage += 'File not found. Please check the file path.';
      } else if (error.code === 'NoPermissions') {
        errorMessage += 'Permission denied. Cannot read this file.';
      } else {
        errorMessage += error.message || 'Unknown error occurred.';
      }
      
      return errorMessage;
    }
  }
}