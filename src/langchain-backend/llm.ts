// Factory for creating a reusable Gemini chat session with in-memory conversation history.
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { AIMessage, HumanMessage, BaseMessage } from '@langchain/core/messages';

export interface CreateChatOptions {
  apiKey?: string;           // Gemini / Google API key
  model?: string;            // Model name
  temperature?: number;      // Sampling temperature
  maxHistoryMessages?: number; // Cap stored message pairs (human+ai counts as 2)
}

export interface ChatSession {
  chat(userMessage: string): Promise<string>;
  reset(): void;
  getHistory(): BaseMessage[]; // optional accessor
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

  function prune() {
    if (history.length > maxHistory) {
      // Remove oldest messages while preserving last maxHistory entries
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
    },
    getHistory() {
      return [...history];
    }
  };
}