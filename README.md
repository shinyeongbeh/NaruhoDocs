# NaruhoDocs

This is the solution for CodeNection 2025 by Team JavaMee.
- Track: Industry Collaboration
- Problem Statement: Fix the Docs: Smarter, Faster, Maintainable Documentation for the Real World by iFAST

- Demo Video Link: https://youtu.be/rfUmCF43YKQ
- Presentation Slides: https://drive.google.com/file/d/1tFBbk_pSKgqsaI_AQzWGRXcjQ_s2oSiv/view?usp=sharing

NaruhoDocs is a AI-powered VSCode extension that could help in documentation writing and reading.

## Features

*   **Separate AI conversations for different documents**
    *   **Document-based chatbot**: AI assistant that understands the content of a specific document and can answer questions directly based on it. 
    *   **General purpose chatbot**: A versatile chatbot for various queries.
*   **Beginner / developer mode**: Switch between modes tailored for different user experiences.
*   **Generate documentation from scratch**: Automatically create documentation for your projects.
*   **Template suggestion to create documentation**: Get suggestions for documentation templates.
*   **Summarize document**: Get a quick summary of your document.
*   **Translate document**: Translate your documents into different languages.
*   **Editing helper:**
    *   **Grammar Checking**: Check and correct grammatical errors.
    *   **Markdown validators**: Ensure your markdown is well-formed.
*   **AI-generated Visualizations**:
    *   Architecture visualization
    *   Folder structure visualization
    *   Document relations visualization
*   **LLM Integration**:
    *   Use out-of-the-box LLM providers.
    *   Bring your own key (BYOK).
    *   Use local LLMs.

## Technologies Used

*   **TypeScript**: Primary language for the extension.
*   **VS Code API**: For building the extension and integrating with the editor.
*   **LangChain & Google Gemini**: For Large Language Model (LLM) integration and AI features.
*   **esbuild**: For bundling the extension.
*   **Mermaid.js, D3.js, Vis.js**: For creating visualizations.
*   **HTML/CSS/JavaScript**: For the webview-based UI components.

## Usage

Once installed, you can use the following commands from the command palette (`Ctrl+Shift+P`):

*   `NaruhoDocs: Start NaruhoDocs`: Starts the extension.
*   `NaruhoDocs: Configure LLM Provider`: Configures the LLM provider.
*   `NaruhoDocs: Test LLM Connection`: Tests the connection to the LLM provider.
*   `NaruhoDocs: Select Local Model`: Selects a local model.
*   `NaruhoDocs: Show Provider Status`: Shows the status of the LLM provider.
*   `NaruhoDocs: 🏗️ Visualize Architecture`: Visualizes the project architecture.
*   `NaruhoDocs: 📁 Visualize Folder Structure`: Visualizes the folder structure.
*   `NaruhoDocs: 🔗 Visualize Document Relations`: Visualizes the document relations.
*   `NaruhoDocs: 📊 Show Visualization Menu`: Shows the visualization menu.
*   `NaruhoDocs: 🔄 Reset Chat Conversation`: Resets the chat conversation.

## Configuration

You can configure the extension by going to **File > Preferences > Settings** and searching for **NaruhoDocs**.

*   `naruhodocs.llm.provider`: LLM provider option to use (`ootb`, `byok`, `local`).
*   `naruhodocs.llm.apiKey`: API key for BYOK mode.
*   `naruhodocs.llm.localBackend`: Local LLM backend to use (`ollama`, `lmstudio`, `llamacpp`, `textgen`, `custom`).
*   `naruhodocs.llm.localModel`: Local model name for local LLM.
*   `naruhodocs.llm.localUrl`: Local LLM server URL.
*   `naruhodocs.visualization.defaultLibrary`: Default visualization library to use (`mermaid`, `d3`, `vis`).
*   `naruhodocs.visualization.enableInteractive`: Enable interactive visualization features.
*   `naruhodocs.visualization.maxFileAnalysis`: Maximum number of files to analyze for large projects.
*   `naruhodocs.logging.verbose`: When `true`, writes structured LLM request/response log lines (with provider, task, timing, token estimates) to the dedicated `NaruhoDocs LLM` Output panel. Default: `false`.

## Installation

### Prerequisites

*   [Node.js](https://nodejs.org/)
*   [npm](https://www.npmjs.com/)

### Setup

1.  Clone the repository:
    ```bash
    git clone https://github.com/shinyeongbeh/NaruhoDocs.git
    ```
2.  Install dependencies:
    ```bash
    cd naruhodocs
    npm install --legacy-peer-deps
    ```

### Environment Variables

To use the "Out-of-the-box" (OOTB) feature with Google's Gemini, you need to set up your API key in an environment file.

1.  Create a file named `.env` in the root directory of the project.
2.  Add your Google API key to the `.env` file as follows:

    ```
    GOOGLE_API_KEY="YOUR_API_KEY_HERE"
    ```

    Replace `"YOUR_API_KEY_HERE"` with your actual Google API key.

### Build

```bash
npm run compile
```

### Watch

```bash
npm run watch
```

### Run Tests

```bash
npm run test
```


