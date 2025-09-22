import * as vscode from 'vscode';
import { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } from '../langchain-backend/features';
import { LLMService } from '../managers/LLMService';
export async function generateDocument(llmService: LLMService, data: { docType: any; fileName?: any }): Promise<{ type: String; sender: String; message: String }> {
  // Suggest filename with AI if not provided
  let aiFilename = '';
  if (!data.fileName || typeof data.fileName !== 'string' || data.fileName.trim() === '') {
    aiFilename = await suggestFilename(data.docType, llmService);
  }

  // Validate the suggested or provided filename
  let fileName = '';
  if (aiFilename && /^(?![. ]).+\.md$/i.test(aiFilename) && !/[\\/:*?"<>|]/.test(aiFilename)) {
    fileName = aiFilename;
  } else if (data.fileName && typeof data.fileName === 'string' && data.fileName.trim() !== '') {
    fileName = data.fileName.trim();
  } else {
    fileName = `${data.docType.replace(/\s+/g, '_').toUpperCase()}.md`;
  }

  // Read files in workspace to see if the file already exists
  const wsFolders = vscode.workspace.workspaceFolders;
  if (wsFolders && wsFolders.length > 0) {
    const wsUri = wsFolders[0].uri;
    const foundFiles = await vscode.workspace.findFiles(`**/${fileName}`);
    if (foundFiles.length > 0) {
      return { type: 'addMessage', sender: 'System', message: `This file already exists at: ${foundFiles[0].fsPath}` };
    } else {
      // Gather workspace filenames
      const filenamesTool = new RetrieveWorkspaceFilenamesTool();
      const fileListStr = await filenamesTool._call();
      const fileList = fileListStr.split('\n').filter((line: string) => line && !line.startsWith('Files in the workspace:'));
      const metaFiles = ['package.json', 'tsconfig.json', 'README.md', 'readme.md', 'api_reference.md', 'API_REFERENCE.md'];
      const extraFiles = fileList.filter((f: string) => metaFiles.includes(f.split(/[/\\]/).pop()?.toLowerCase() || ''));

      // Ask AI which files are relevant for documentation
      const sys = `You are an AI assistant that helps users create project documentation files based on the project files and contents. \nThe output should be in markdown format. Do not include code fences or explanations, just the documentation. \nFirst, select ALL the relevant files from this list for generating documentation for ${fileName}. You need to select as many files as needed but be concise.\nAlways include project metadata and README/config files if available. Return only a JSON array of file paths, no explanation.`;
      let relevantFiles = [];
      try {
        const prompt = `Here is the list of files in the workspace:\n${fileList.join('\n')}\n\nWhich files are most relevant for generating documentation for ${fileName}? Always include project metadata and README/config files if available. Return only a JSON array of file paths.`;
        const aiSuggestRelatedFile = await llmService.trackedChat({
          sessionId: 'read_files',
          systemMessage: sys,
          prompt: prompt,
          task: 'read_files',
          forceNew: true
        });
        // Try to parse the AI response as JSON array
        const match = aiSuggestRelatedFile?.match(/\[.*\]/s);
        if (match) {
          relevantFiles = JSON.parse(match[0]);
        }
      } catch (e) {
        relevantFiles = [];
      }
      // Always include meta files
      relevantFiles = Array.isArray(relevantFiles) ? Array.from(new Set([...relevantFiles, ...extraFiles])) : extraFiles;

      // Get file contents for relevant files
      const contentTool = new RetrieveFileContentTool();
      const filesAndContents = [];
      for (const relPath of relevantFiles) {
        try {
          const content = await contentTool._call(relPath);
          filesAndContents.push({ path: relPath, content });
        } catch { }
      }

      // Generate the documentation using the general thread session
      let aiGeneratedDoc = '';
      try {
        const sys2 = `\nYou are an impeccable and meticulous technical documentation specialist. 
                Your purpose is to produce clear, accurate, and professional technical documents based on the given content.
                \n\nPrimary Goal: Generate high-quality technical documentation that is comprehensive, logically structured, and easy for the intended audience to understand.
                \n\nInstructions:\nYou will be given the file name of the documentation to create, along with the relevant files and their contents from the user's project workspace.
                \nYour task is to analyze these files and generate a well-organized documentation file that thoroughly covers the subject matter implied by the file name.
                \nYou may use tools (retrieve_workspace_filenames, retrieve_file_content) to retrieve additional file contents if needed without user prompted.
                \n\nMandatory Rules:\nDo not include private or sensitive information from the provided files. For example, API keys.
                \nHandling Ambiguity: If a user request is vague or missing critical information (e.g., a technical name, a specific version, or the document's purpose), you must respond by asking for the necessary details. 
                Never make assumptions or generate generic content.
                \nClarity and Simplicity: Prioritize clarity and conciseness above all else. 
                Use plain language, active voice, and short sentences. 
                Avoid jargon, buzzwords, and redundant phrases unless they are essential for technical accuracy.
                \nStructured Content: All documents must follow a clear, hierarchical structure using Markdown.
                \nActionable and Factual: Documents must be useful. For guides, provide clear, step-by-step instructions. 
                For concepts, provide accurate, verifiable information. Do not include opinions or subjective statements.
                \nReview and Refine: Before finalizing, internally review the document for consistency, accuracy, and adherence to these rules. 
                Ensure all headings are descriptive and the flow is logical.
                \nFormatting: The final output must be in markdown format. 
                Do not include code fences, explanations, or conversational text.`;

        const filesAndContentsString = filesAndContents.map(f => `File: ${f.path}\n${f.content}`).join('\n\n');
        const prompt2 = (`Generate a starter documentation for ${fileName} based on this project. Refer to the relevant workspace files and contents:\n${filesAndContentsString}. If you are unable to generate the file based on information given, do not make up generic content yourself`) || '';;
        aiGeneratedDoc = (await llmService.request({
          type: 'generate_doc',
          title: fileName,
          sourceContent: filesAndContentsString,
          systemMessage: sys2
        })).content;

        // AI doc generation response captured
        aiGeneratedDoc = aiGeneratedDoc.replace(/^```markdown\s*/i, '').replace(/^\*\*\*markdown\s*/i, '').replace(/```$/g, '').trim();
      } catch (err) {
        aiGeneratedDoc = `# ${data.docType}\n\nDescribe your documentation needs here.`;
      }
      const fileUri = vscode.Uri.joinPath(wsUri, fileName);
      try {
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(aiGeneratedDoc, 'utf8'));
        // Trigger a fresh scan to update modal choices
        await vscode.commands.executeCommand('naruhodocs.scanDocs');
        // scanDocs triggered after doc creation

        return { type: 'addMessage', sender: 'System', message: `Document created: ${fileUri.fsPath}` };

      } catch (err) {
        const errorMsg = typeof err === 'object' && err !== null && 'message' in err ? (err as any).message : String(err);
        return { type: 'addMessage', sender: 'System', message: `Error creating doc: ${errorMsg}` };
      }
    }
  } else {
    return { type: 'addMessage', sender: 'System', message: 'No workspace folder open.' };
  }
}
async function suggestFilename(docType: string, llmService: LLMService): Promise<string> {
  let aiFilename = '';
  // Attempting AI filename suggestion for docType: ${docType}
  try {    
    aiFilename = (await llmService.request({
      type: 'chat', 
      prompt: `Suggest a concise, filesystem-friendly filename (with .md extension) for a ${docType} documentation file. Respond with only the filename, no explanation.`,
    })).content;
    aiFilename = aiFilename.trim().replace(/\s+/g, '_').toUpperCase();
  } catch (e) {
    aiFilename = '';
  }
  return aiFilename;
}
