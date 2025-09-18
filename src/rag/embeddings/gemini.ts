// import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
// import { BaseEmbeddings } from './base';

// export class GeminiEmbeddings extends BaseEmbeddings {
//     private model: GenerativeModel;
//     private readonly EMBEDDING_DIMENSION = 768; // Gemini's embedding dimension

//     constructor(apiKey: string) {
//         super();
//         if (!apiKey) {
//             throw new Error('Gemini API key is required.');
//         }
//         const genAI = new GoogleGenerativeAI(apiKey);
//         this.model = genAI.getGenerativeModel({ model: 'embedding-001' });
//     }

//     async embedQuery(text: string): Promise<number[]> {
//         try {
//             const result = await this.model.embedContent(text);
//             const embedding = await result.embedding;
//             return embedding.values;
//         } catch (error) {
//             console.error('Error getting embedding from Gemini:', error);
//             throw error;
//         }
//     }

//     async embedDocuments(documents: string[]): Promise<number[][]> {
//         // Process in parallel with rate limiting
//         const batchSize = 5; // Process 5 documents at a time
//         const embeddings: number[][] = [];

//         for (let i = 0; i < documents.length; i += batchSize) {
//             const batch = documents.slice(i, i + batchSize);
//             const batchPromises = batch.map(doc => this.embedQuery(doc));
            
//             try {
//                 const batchResults = await Promise.all(batchPromises);
//                 embeddings.push(...batchResults);
//             } catch (error) {
//                 console.error(`Error embedding batch starting at index ${i}:`, error);
//                 throw error;
//             }

//             // Rate limiting - wait 1s between batches if there are more to process
//             if (i + batchSize < documents.length) {
//                 await new Promise(resolve => setTimeout(resolve, 1000));
//             }
//         }

//         return embeddings;
//     }

//     dimension(): number {
//         return this.EMBEDDING_DIMENSION;
//     }
// }
