// // Local embedding provider using Hugging Face Transformers.js (MiniLM)
// // npm install @xenova/transformers
// import { BaseEmbeddings } from './base';

// export class HuggingFaceEmbeddings extends BaseEmbeddings {
// 	private model: any;
// 	private readonly EMBEDDING_DIMENSION = 384; // Typical for MiniLM

// 	constructor() {
// 		super();
// 	}

// 	async loadModel() {
// 		if (!this.model) {
// 			// Lazy load the model
// 			const { pipeline } = await import('@xenova/transformers');
// 			this.model = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
// 		}
// 	}

// 	async embedQuery(text: string): Promise<number[]> {
// 		await this.loadModel();
// 		const output = await this.model(text, { pooling: 'mean', normalize: true });
// 		return Array.from(output.data);
// 	}

// 	async embedDocuments(documents: string[]): Promise<number[][]> {
// 		await this.loadModel();
// 		const results: number[][] = [];
// 		for (const doc of documents) {
// 			const output = await this.model(doc, { pooling: 'mean', normalize: true });
// 			results.push(Array.from(output.data) as number[]);
// 		}
// 		return results;
// 	}

// 	dimension(): number {
// 		return this.EMBEDDING_DIMENSION;
// 	}
// }
