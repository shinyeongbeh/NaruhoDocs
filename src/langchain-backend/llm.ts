// Factory for creating a reusable Gemini chat session with in-memory conversation history.
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { AIMessage, HumanMessage, BaseMessage, SystemMessage } from '@langchain/core/messages';

export interface CreateChatOptions {
  apiKey?: string;           // Gemini / Google API key
  model?: string;            // Model name
  temperature?: number;      // Sampling temperature
  maxHistoryMessages?: number; // Cap stored message pairs (human+ai counts as 2)
  systemMessage?: string;    // Optional initial system message for context
}

export interface ChatSession {
  chat(userMessage: string): Promise<string>;
  reset(): void;
  getHistory(): BaseMessage[]; // optional accessor
  setHistory(historyArr: BaseMessage[]): void; // new method for restoring history
}

export function createChat(opts: CreateChatOptions = {}): ChatSession {
  const apiKey = opts.apiKey || process.env.GOOGLE_API_KEY || '';
  if (!apiKey) {
    throw new Error('Gemini API key missing. Set naruhodocs.geminiApiKey in settings or GOOGLE_API_KEY env var.');
  }
  const model = new ChatGoogleGenerativeAI({
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

  function prune() {
    if (history.length > maxHistory) {
      history = history.slice(history.length - maxHistory);
    }
  }

  return {
    async chat(userMessage: string): Promise<string> {
      history.push(new HumanMessage(userMessage));
      prune();
      const response = await model.invoke(history);
      history.push(new AIMessage(response.text || ''));
      prune();
      return response.text || '';
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
    }
  };
}

export const llm = {
  createChat,
};