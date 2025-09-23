// /**
//  * Base interface for embeddings providers.
//  * Implementations should handle both cloud (Gemini) and local (Ollama) options.
//  */
// export abstract class BaseEmbeddings {
//     /**
//      * Embed a single text query
//      * @param text The text to embed
//      * @returns Promise<number[]> The embedding vector
//      */
//     abstract embedQuery(text: string): Promise<number[]>;

//     /**
//      * Embed multiple documents
//      * @param documents Array of text documents to embed
//      * @returns Promise<number[][]> Array of embedding vectors
//      */
//     abstract embedDocuments(documents: string[]): Promise<number[][]>;

//     /**
//      * Returns the dimensionality of the embeddings
//      */
//     abstract dimension(): number;

//     /**
//      * Clean up any resources (if needed)
//      */
//     async cleanup(): Promise<void> {
//         // Default implementation - no cleanup needed
//     }
// }
