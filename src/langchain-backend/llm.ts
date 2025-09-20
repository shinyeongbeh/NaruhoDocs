// Factory for creating a reusable Gemini chat session with in-memory conversation history.
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { AIMessage, HumanMessage, BaseMessage, SystemMessage } from '@langchain/core/messages';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { RetrieveWorkspaceFilenamesTool, RetrieveFileContentTool } from './features';

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
  const apiKey = opts.apiKey || process.env.GOOGLE_API_KEY || '';
  if (!apiKey) {
    throw new Error('Gemini API key missing. Set naruhodocs.geminiApiKey in settings or GOOGLE_API_KEY env var.');
  }
  const model = opts.chatModel || new ChatGoogleGenerativeAI({
    apiKey,
    model: opts.model || 'gemini-2.0-flash',
    temperature: opts.temperature ?? 0,
  });

  const maxHistory = opts.maxHistoryMessages ?? 20;
  let history: BaseMessage[] = [];

  // Add initial SystemMessage if provided
  if (opts.systemMessage) {
    history.push(new SystemMessage(opts.systemMessage));
  }

  // Define tools using LangGraph.js
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
        filePath: z.string().describe('The path of the file to read.'),
      }),
    }
  );

  // Create LangGraph agent
  const agent = createReactAgent({
    llm: model,
    tools: [retrieveFilenames, retrieveFileContent],
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

      // Use LangGraph agent to process the user message
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

      // Save AI response to history
      const aiMessage = new AIMessage(aiText);
      history.push(aiMessage);

      prune();

      aiText = aiText.replace(/^\s*<think>([\s\S]*?)<\/think>\s*/i, '');
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