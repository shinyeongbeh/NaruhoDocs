import { LLMService } from "../managers/LLMService";
import * as vscode from 'vscode';

export async function generateTemplate(
  llmService: LLMService,
  templateType: string,
) {
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
  const sys = `You are an AI assistant that helps users create project documentation templates based on the project files and contents.\nThe output should be in markdown format. Do not include code fences or explanations, just the template.\nFirst, select ALL the relevant files from this list for generating a ${templateType} template. You need to select as many files as needed but be concise.\nAlways include project metadata and README/config files if available. Return only a JSON array of file paths, no explanation.`;
  let relevantFiles: string[] = [];
  try {
    const aiResponse = await llmService.trackedChat({
      sessionId: 'chatview:template-select',
      systemMessage: sys,
      prompt: `Here is the list of files in the workspace:\n${fileList.join('\n')}\n\nWhich files are most relevant for generating a ${templateType} template? Always include project metadata and README/config files if available. Return only a JSON array of file paths.`,
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

Generate a ${templateType} template using ONLY this placeholder style. Output only the template structure.`;

    // const filesAndContentsString = filesAndContents.map(f => `File: ${f.path}\n${f.content}`).join('\n\n');
    templateContent = await llmService.trackedChat({
      sessionId: 'chatview:template-generate',
      systemMessage: sys2,
      // prompt: `Generate a documentation template for ${templateType} based on this project. Here are the relevant workspace files and contents:\n${filesAndContentsString}`,
      prompt: `Generate a documentation template for ${templateType} based on this project. Return in markdown format`,
      forceNew: true,
      temperatureOverride: 0.8
    });
    templateContent = templateContent.replace(/^```markdown\s*/i, '').replace(/^\*\*\*markdown\s*/i, '').replace(/```$/g, '').trim();
  } catch (err) {
    templateContent = `This project does not require a [${templateType}] template because no relevant content was found.`;
  }
  
  //Show in new untitled document
  const newDoc = await vscode.workspace.openTextDocument({
    content: templateContent,
    language: 'markdown'
  });
  await vscode.window.showTextDocument(newDoc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  // Provide save option via notification
  vscode.window.showInformationMessage(`${templateType} Template ready. Save as new file?`, 'Save').then(async sel => {
    if (sel === 'Save') {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) {
        const targetUri = vscode.Uri.joinPath(ws.uri, `${templateType.toUpperCase()}_TEMPLATE.md`);
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(templateContent, 'utf8'));
        vscode.window.showInformationMessage(`Saved template to ${targetUri.fsPath}`);
      }
    }
  });
}
  