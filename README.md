# NaruhoDocs
NaruhoDocs is an AI-powered VS Code extension that could help in documentation writing and reading.

## Try our extension now! [Install NaruhoDocs](https://marketplace.visualstudio.com/items?itemName=naruhodocs.naruhodocs)
## Refer to our [User Guide](https://github.com/shinyeongbeh/NaruhoDocs/blob/master/USER_GUIDE.pdf) and [Installation Guide](https://github.com/shinyeongbeh/NaruhoDocs/blob/master/INSTALLATION_GUIDE.md) for detailed guidance. 
## We need your feedback! Please fill out this [Feedback Form](https://forms.gle/ieMzRuvJyxofRmnz9) to help us improve the extension.
## Features
### 1. AI Chatbot with RAG (Retrieval-Augmented Generation) capabilities
- **Document-based chatbot**: AI assistant that understands the content of a specific document and can answer questions directly based on it.
- **General purpose chatbot**: A versatile chatbot for various queries.
- **Beginner / developer mode**: Switch between modes tailored for different user experiences.
### 2. Flexible LLM Engine Configuration
Seamlessly switch between local and cloud-based models to configure both the chat model and the embedding model (used for RAG feature).
- **Cloud**
    - **Chat models:** Users can use Google Gemini model for chat and text generation tasks.
    - **Embedding models:** Users can use Hugging Face embedding models (like `sentence-transformers/all-MiniLM-L6-v2`) via Hugging Face Inference API.
- **Local**
    - Users can use local models via **Ollama** or **LM Studio** for both chat and embedding tasks. Users can use any models supported by these local LLM frameworks, giving them flexibility and control over their AI tools.
### 3. Documentation Drift Analysis
- **Document drift detection based on Git commits**: Automatically detects and highlights when your documentation becomes outdated or inconsistent with recent code changes by analyzing Git commit history.
### 4. Smart Documentation Tools
- **Generate documentation from scratch**: Automatically create documentation for your projects.
- **Template suggestion to create documentation**: Get suggestions for documentation templates.
- **Summarize document**: Get a quick summary of your document.
- **Translate document**: Translate your documents into different languages.   
- **AI-generated visualizations**:
    - Architecture visualization
    - Folder structure visualization
### 5. Editing Helper:
- **Grammar checking**: Check and correct grammatical errors.
- **Markdown validators**: Ensure your markdown is well-formed.

## Technologies Used

*   **TypeScript**: Primary language for the extension.
*   **VS Code API**: For building the extension and integrating with the editor.
*   **LangChain & Google Gemini**: For Large Language Model (LLM) integration and RAG implementation.
*   **Vector Databases**: For storing and retrieving document embeddings efficiently.
*   **Embedding Models**: Hugging Face Transformers, Ollama, and LM Studio for semantic understanding.
*   **esbuild**: For bundling the extension.
*   **Mermaid.js, D3.js, Vis.js**: For creating visualizations.
*   **HTML/CSS/JavaScript**: For the webview-based UI components.


## About This
This is the solution for CodeNection 2025 by Team JavaMee.
- Track: Industry Collaboration
- Problem Statement: Fix the Docs: Smarter, Faster, Maintainable Documentation for the Real World by iFAST
- Team Members: Beh Shin Yeong, Chiam Huai Ren, Hoe Zhi Wan