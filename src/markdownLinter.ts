import { lint } from "markdownlint/async";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

function findConfigUpwards(startDir: string, configFile: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, configFile);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function lintMarkdownDocument(document: vscode.TextDocument) {
  // Try to find .markdownlint.json starting from the markdown file's folder
  const docPath = document.uri.fsPath;
  const docDir = path.dirname(docPath);
  let configPath = findConfigUpwards(docDir, '.markdownlint.json');
  let config = null;
  if (configPath) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else {
    // Fallback: use default config bundled with extension
    const defaultConfigPath = path.resolve(__dirname, '../../.markdownlint.json');
    if (fs.existsSync(defaultConfigPath)) {
      config = JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));
    } else {
      // Hardcoded default if no config file found
      config = { "default": true, "MD013": false };
    }
  }
  const options = {
    strings: { content: document.getText() },
    config
  };
  return new Promise((resolve, reject) => {
    lint(options, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result && result.content ? result.content : []);
      }
    });
  });
}
