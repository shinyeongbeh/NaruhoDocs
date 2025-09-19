//////// delete api keyyyyyyyyyy before committtttt
import { Embeddings } from '@langchain/core/embeddings';
import { HuggingFaceInferenceEmbeddings } from '@langchain/community/embeddings/hf';

export class HuggingFaceEmbeddings extends Embeddings {
    private embeddings: HuggingFaceInferenceEmbeddings;
    private readonly EMBEDDING_DIMENSION = 384; // Adjust based on the model used

    constructor() {
        super({});
        this.embeddings = new HuggingFaceInferenceEmbeddings({
            apiKey: "",
            model: 'sentence-transformers/all-MiniLM-L6-v2'
        });
    }

    async embedQuery(text: string): Promise<number[]> {
        const response = await this.embeddings.embedQuery(text);
        return response;
    }

    async embedDocuments(documents: string[]): Promise<number[][]> {
        const response = await this.embeddings.embedDocuments(documents);
        return response;
    }

    dimension(): number {
        return this.EMBEDDING_DIMENSION;
    }
}