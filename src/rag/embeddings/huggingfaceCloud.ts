import { Embeddings } from '@langchain/core/embeddings';
import { HuggingFaceInferenceEmbeddings } from '@langchain/community/embeddings/hf';

export class HuggingFaceEmbeddings extends Embeddings {
    private embeddings: HuggingFaceInferenceEmbeddings;
    private readonly EMBEDDING_DIMENSION = 384; // Adjust based on the model used

    constructor(apiKey: string, model: string) {
        super({});
        this.embeddings = new HuggingFaceInferenceEmbeddings({
            apiKey: apiKey,
            model: model
        });
        if(apiKey==='' ||!apiKey) {
            throw new Error('HuggingFace API key is required.');
        }
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