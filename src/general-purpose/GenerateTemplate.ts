import { LLMService } from "../managers/LLMService";
import * as vscode from 'vscode';

export async function generateTemplate(
  llmService: LLMService,
  data: { templateType: string, fileName?: string }
) {
  // Suggest filename with AI if not provided
  let aiFilename = '';
  let instruction = '';
  if (!data.fileName || typeof data.fileName !== 'string' || data.fileName.trim() === '') {
    // If  no filename provided (custom prompt option), use the custom prompt to generate the filename
    instruction = data.templateType;
    aiFilename = await suggestFilename(data.templateType, llmService);
  } else {
    instruction = data.fileName;
  }

  // // Validate the suggested or provided filename
  let fileName = '';
  if (aiFilename) {
    if(/^(?![. ]).+\.MD$/i.test(aiFilename)) {
      aiFilename = aiFilename.slice(0, -3); // remove .MD extension
    }
    if(/[\\/:*?"<>|]/.test(aiFilename)) {
      // Filename contains invalid characters, sanitize it
      aiFilename = aiFilename
        .replace(/[\\/:*?"<>|]/g, '_')  // Replace invalid chars with underscores
        .trim()
        .replace(/\s+/g, '_')          // Replace spaces with underscores
        .replace(/_+/g, '_')           // Replace multiple underscores with single
        .toUpperCase();
    }
    fileName = aiFilename;
  } else if (data.fileName && typeof data.fileName === 'string' && data.fileName.trim() !== '') {
    fileName = data.fileName.trim();
    if(/^(?![. ]).+\.MD$/i.test(fileName)) {
      fileName = fileName.slice(0, -3); // remove .MD extension
    }
  } else {
    fileName = data.templateType.replace(/\s+/g, '_').toUpperCase();
  }

  // Extract template type
  // Gather workspace filenames
  const { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } = require('../langchain-backend/features');
  const filenamesTool = new RetrieveWorkspaceFilenamesTool();
  const fileListStr = await filenamesTool._call();
  const fileList = fileListStr.split('\n').filter((line: string) => line && !line.startsWith('Files in the workspace:'));

  // Always include project metadata and README/config files for richer context
  const metaFiles = ['package.json', 'tsconfig.json', 'README.md', 'readme.md', 'api_reference.md', 'API_REFERENCE.md'];
  const extraFiles = fileList.filter((f: string) => metaFiles.includes(f.split(/[/\\]/).pop()?.toLowerCase() || ''));

  // Ask AI which files are relevant for documentation
  const sys = `You are an AI assistant that helps users create project documentation templates based on the project files and contents.\nThe output should be in markdown format. Do not include code fences or explanations, just the template.\nFirst, select ALL the relevant files from this list for generating a template for '${instruction}'. You need to select as many files as needed but be concise.\nAlways include project metadata and README/config files if available. Return only a JSON array of file paths, no explanation.`;
  let relevantFiles: string[] = [];
  try {
    const aiResponse = await llmService.trackedChat({
      sessionId: 'chatview:template-select',
      systemMessage: sys,
      prompt: `Here is the list of files in the workspace:\n${fileList.join('\n')}\n\nWhich files are most relevant for generating a template for '${instruction}'? Always include project metadata and README/config files if available. Return only a JSON array of file paths.`,
      task: 'analyze',
      forceNew: true
    });
    // Try to parse the AI response as JSON array
    const matchFiles = aiResponse.match(/\[.*\]/s);
    if (matchFiles) {
      relevantFiles = JSON.parse(matchFiles[0]);
    } else {
      // fallback: use all files
      relevantFiles = fileList;
    }
  } catch (err) {
    relevantFiles = fileList;
  }
  // Ensure meta files are always included
  for (const meta of extraFiles) {
    if (!relevantFiles.includes(meta)) {
      relevantFiles.push(meta);
    }
  }
  // Now scan only relevant files
  const contentTool = new RetrieveFileContentTool();
  const filesAndContents = [];
  for (const path of relevantFiles) {
    try {
      const content = await contentTool._call(path);
      filesAndContents.push({ path, content });
    } catch (e) { }
  }
  // Use AI to generate template content
  let templateContent = '';
  try {
    const sys2 = `You are a markdown template generator. Your ONLY job is to create EMPTY SKELETON templates for documentation.

CRITICAL RULES:
- Generate ONLY a generic template structure for the requested documentation type.
- DO NOT invent, include, or mention any function, tool, or API names.
- DO NOT include any code, examples, or project-specific information.
- DO NOT analyze or reference any files or file contents.
- Use only generic section headings and placeholders (e.g., "Function Name", "Description", etc.).

Generate a template for '${instruction}' using ONLY this placeholder style. Output only the template structure.`;

    // const filesAndContentsString = filesAndContents.map(f => `File: ${f.path}\n${f.content}`).join('\n\n');
    templateContent = await llmService.trackedChat({
      sessionId: 'chatview:template-generate',
      systemMessage: sys2,
      // prompt: `Generate a documentation template for ${templateType} based on this project. Here are the relevant workspace files and contents:\n${filesAndContentsString}`,
      prompt: `Generate a documentation template for prompt '${instruction}' based on this project. Return in markdown format`,
      forceNew: true,
      temperatureOverride: 0.8
    });
    templateContent = templateContent
      .replace(/<details class="ai-reasoning">[\s\S]*?<\/details>/gi, '')
      .replace(/^```markdown\s*/i, '')
      .replace(/^\*\*\*markdown\s*/i, '')
      .replace(/```$/g, '')
      .trim();
  } catch (err) {
    templateContent = `This project does not require a [${fileName}] template because no relevant content was found.`;
  }

  //Show in new untitled document
  const newDoc = await vscode.workspace.openTextDocument({
    content: templateContent,
    language: 'markdown'
  });
  await vscode.window.showTextDocument(newDoc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  // Provide save option via notification
  vscode.window.showInformationMessage(`${fileName} Template ready. Save as new file?`, 'Save').then(async sel => {
    if (sel === 'Save') {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        // Check if /docs folder exists, if so save there, otherwise save to root
        const docsUri = vscode.Uri.joinPath(ws.uri, 'docs');
        let targetFolder = ws.uri;
        try {
          const docsStat = await vscode.workspace.fs.stat(docsUri);
          if (docsStat.type === vscode.FileType.Directory) {
            targetFolder = docsUri;
          }
        } catch {
          // /docs doesn't exist, use root folder
        }

        const targetUri = vscode.Uri.joinPath(targetFolder, `${fileName.toUpperCase()}_TEMPLATE.md`);
        let fileExists = false;
        try {
          await vscode.workspace.fs.stat(targetUri);
          fileExists = true;
        } catch {
          fileExists = false;
        }
        if (fileExists) {
          const overwrite = await vscode.window.showInformationMessage(
            `File ${targetUri.fsPath} already exists. Overwrite?`,
            'Overwrite', 'Cancel'
          );
          if (overwrite !== 'Overwrite') {
            vscode.window.showInformationMessage('Template save cancelled.');
            return;
          }
        }
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(templateContent, 'utf8'));
        vscode.window.showInformationMessage(`Saved template to ${targetUri.fsPath}`);
      }
    }
  });
}
async function suggestFilename(docType: string, llmService: LLMService): Promise<string> {
  let aiFilename = '';
  // Attempting AI filename suggestion for docType: ${docType}
  try {
    aiFilename = (await llmService.request({
      type: 'chat',
      prompt: `Suggest a concise, filesystem-friendly filename for a ${docType} documentation file. Respond with only the filename, no explanation, no extensions, no ends with .md`,
    })).content;
    aiFilename = aiFilename.replace(/<details class="ai-reasoning">[\s\S]*?<\/details>/gi, '');
    aiFilename = aiFilename.trim().replace(/\s+/g, '_').toUpperCase();
  } catch (e) {
    aiFilename = '';
  }
  return aiFilename;
}
