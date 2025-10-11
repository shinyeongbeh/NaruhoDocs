// Factory for creating a reusable Gemini chat session with in-memory conversation history.
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { AIMessage, HumanMessage, BaseMessage, SystemMessage } from '@langchain/core/messages';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } from './features';
import { RAGretrievalTool } from './tools';
import { SystemMessages } from '../SystemMessages';
import * as vscode from 'vscode';

export interface CreateChatOptions {
  apiKey?: string;           // Gemini / Google API key
  model?: string;            // Model name
  temperature?: number;      // Sampling temperature
  maxHistoryMessages?: number; // Cap stored message pairs (human+ai counts as 2)
  systemMessage?: string;    // Optional initial system message for context
  chatModel?: BaseChatModel; // Optional custom chat model instance
}

export interface ChatSession {
  chat(userMessage: string): Promise<string>;
  reset(): void;
  getHistory(): BaseMessage[]; // optional accessor
  setHistory(historyArr: BaseMessage[]): void; // new method for restoring history
  setCustomSystemMessage(msg: string): void;
}

export function createChat(opts: CreateChatOptions = {}): ChatSession {
  let model: BaseChatModel;
  
  if (opts.chatModel) {
    // Use provided custom chat model (e.g., local LLM)
    model = opts.chatModel;
  } else {
    // Use Gemini - require API key
    const apiKey = opts.apiKey || process.env.GOOGLE_API_KEY || '';
    if (!apiKey) {
      throw new Error('Gemini API key missing. Set naruhodocs.geminiApiKey in settings or GOOGLE_API_KEY env var.');
    }
    model = new ChatGoogleGenerativeAI({
      apiKey,
      model: opts.model || 'gemini-2.0-flash',
      temperature: opts.temperature ?? 0,
    });
  }

  const maxHistory = opts.maxHistoryMessages ?? 20;
  let history: BaseMessage[] = [];

  // Add initial SystemMessage if provided, or use default RAG-optimized prompt
  const defaultSystemMessage = `You are a technical documentation assistant that helps answer questions about code and documentation.
  
For each user query, you will receive:
1. The original question
2. Retrieved relevant code snippets and documentation
3. Additional context from the conversation history

Your task is to:
1. Analyze the retrieved context thoroughly
2. Provide accurate, concise answers based primarily on the retrieved information
3. If the context is insufficient, you can use additional tools to gather more information
4. Always cite specific files/locations when referencing code or documentation

Keep responses focused and technical, using the retrieved context as your primary source of information.`;

  history.push(new SystemMessage(opts.systemMessage || defaultSystemMessage));


  // Initialize RAG tools
  const RAGretrieval = tool(
    async ({ query }) => {
      console.log('Tool used: retrieveContext with query:', query);
      // Step 1: Let the LLM act as a prompt engineer for the RAG tool
      const promptEngineeringMessage = `Rewrite the following user question to maximize retrieval of the most relevant code or documentation snippets from the project. Be specific and include keywords, file types, or function names if possible. Only return the rewritten query, nothing else.\n\nUser question: ${query}`;

      // Use the base model (not the agent) to generate the focused RAG query
      const peResponse = await model.invoke([
        new HumanMessage(promptEngineeringMessage)
      ]);
      let ragQuery = '';
      if (typeof peResponse.content === 'string') {
        ragQuery = peResponse.content.trim();
      } else if (Array.isArray(peResponse.content)) {
        ragQuery = peResponse.content.map((c: any) => typeof c === 'string' ? c : JSON.stringify(c)).join(' ').trim();
      } else {
        ragQuery = JSON.stringify(peResponse.content);
      }

      // Step 2: Use the LLM-generated query for RAG retrieval
      const contextTool = new RAGretrievalTool();
      const relevantContext = await contextTool._call(ragQuery);

      // Step 3: Construct the enhanced prompt for the main agent
      const enhancedMessage = `\nQuery: ${query}\n\nPrompt-engineered RAG Query: ${ragQuery}\n\nRetrieved Context:\n${relevantContext}\n\nBased on the above context, please provide a response.`;

      history.push(new HumanMessage(enhancedMessage));
      prune();
      return enhancedMessage;
    },
    {
      name: 'RAGretrieveContext',
      description: 'Retrieve semantically relevant code snippets based on the query.',
      schema: z.object({
        query: z.string().describe('The query to find relevant code snippets for.'),
      }),
    }
  );

  const retrieveFilenames = tool(
    async () => {
      // Tool used: retrieveFilenames
      const toolInstance = new RetrieveWorkspaceFilenamesTool();
      return await toolInstance._call();
    },
    {
      name: 'retrieveFilenames',
      description: 'Retrieve all filenames in the workspace.',
    }
  );

  const retrieveFileContent = tool(
    async ({ filePath }) => {
      // Tool used: retrieveFileContent with filePath=${filePath}
      const toolInstance = new RetrieveFileContentTool();
      return await toolInstance._call(filePath);
    },
    {
      name: 'retrieveFileContent',
      description: 'Retrieve the content of a specific file.',
      schema: z.object({
        filePath: z.string().describe('The path to the file to retrieve content from.'),
        query: z.string().describe('The query to find relevant code snippets for.'),
      }),
    }
  );

  let tools: any[] = [];
  // check the settings if user enabled RAG or not
  let RAGstatus = vscode.workspace.getConfiguration('naruhodocs').get<boolean>('rag.enabled', );
  if(RAGstatus) {
    tools = [retrieveFilenames, retrieveFileContent, RAGretrieval];
  } else {
    tools = [retrieveFilenames, retrieveFileContent];
  }


  // Create LangGraph agent with RAG capabilities
  const agent = createReactAgent({
    llm: model,
    tools: tools
  });

  function prune() {
    if (history.length > maxHistory) {
      history = history.slice(history.length - maxHistory);
    }
  }

  return {
    async chat(userMessage: string): Promise<string> {
      history.push(new HumanMessage(userMessage));
      prune();

      // Use LangGraph agent for additional tool usage if needed
      const response = await agent.invoke({
        messages: history.map(msg => ({
          role: msg instanceof HumanMessage ? 'user' : 'assistant',
          content: msg.text,
        })),
      });

      const lastMessage = response.messages[response.messages.length - 1];

      // Safely extract text/content
      let aiText = '';
      if (typeof lastMessage.content === 'string') {
        aiText = lastMessage.content;
      } else if (Array.isArray(lastMessage.content)) {
        aiText = lastMessage.content.map((c: any) =>
          typeof c === 'string' ? c : JSON.stringify(c)
        ).join(' ');
      } else {
        aiText = JSON.stringify(lastMessage.content);
      }

      // Extract all <think> blocks (Gemini style reasoning) before storing final answer
      const thinkBlocks: string[] = [];
      aiText = aiText.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
        const cleaned = String(inner).trim();
        if (cleaned) { thinkBlocks.push(cleaned); }
        return ''; // remove from visible answer
      }).trim();

      // Build collapsible reasoning section if any think blocks were present
      const showReasoning = vscode.workspace.getConfiguration('naruhodocs').get<boolean>('llm.showReasoning', true);
      if (thinkBlocks.length && showReasoning) {
        const joined = thinkBlocks.join('\n---\n');
        // Replace literal \n with actual newlines for proper formatting
        const normalized = joined.replace(/\\n/g, '\n');
        // Escape HTML entities to avoid accidental rendering inside code fence
        const escaped = normalized
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        const reasoningSection = `\n\n<details class="ai-reasoning">\n<summary>Show reasoning</summary>\n\n\`\`\`text\n${escaped}\n\`\`\`\n\n</details>\n\n`;
        aiText = aiText + reasoningSection;
      }

      // Save AI response (with optional collapsible reasoning) to history
      const aiMessage = new AIMessage(aiText);
      history.push(aiMessage);
      prune();
      return aiText;
    },
    reset() {
      history = [];
      // Re-add system message after reset if provided
      if (opts.systemMessage) {
        history.push(new SystemMessage(opts.systemMessage));
      }
    },
    getHistory() {
      // Filter out SystemMessage from history for UI display
      return history.filter(msg => !(msg instanceof SystemMessage));
    },
    setHistory(historyArr: BaseMessage[]) {
      // Restore history directly (excluding system message)
      history = [];
      if (opts.systemMessage) {
        history.push(new SystemMessage(opts.systemMessage));
      }
      for (const msg of historyArr) {
        const type = (msg as any).type;
        const text = (msg as any).text;
        if (type === 'human') { history.push(new HumanMessage(text)); }
        if (type === 'ai') { history.push(new AIMessage(text)); }
      }
    },
    setCustomSystemMessage(msg: string) {
      // Remove any existing SystemMessage
      history = history.filter(m => !(m instanceof SystemMessage));
      // Add new SystemMessage at the start
      history.unshift(new SystemMessage(msg));
    }
  };
}

export const llm = {
  createChat,
};