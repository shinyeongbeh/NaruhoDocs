import { LocalMemoryVectorStore } from './memory';
// import { HuggingFaceEmbeddings } from '../embeddings/huggingfaceCloud';
import { OllamaEmbeddings } from '../embeddings/ollama';

// Initialize the vector store once and export it
// const embeddings = new HuggingFaceEmbeddings();
const embeddings = new OllamaEmbeddings();
const vectorStore = new LocalMemoryVectorStore(embeddings);

export default vectorStore;