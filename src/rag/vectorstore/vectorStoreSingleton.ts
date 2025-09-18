import { LocalMemoryVectorStore } from './memory';
import { HuggingFaceEmbeddings } from '../embeddings/huggingfaceCloud';

// Initialize the vector store once and export it
const embeddings = new HuggingFaceEmbeddings();
const vectorStore = new LocalMemoryVectorStore(embeddings);

export default vectorStore;