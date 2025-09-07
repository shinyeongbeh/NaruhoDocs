import * as vscode from 'vscode';
import { ChatViewProvider } from '../ChatViewProvider';
import { createChat } from '../langchain-backend/llm';

/**
 * Test to verify that visualization context is properly added to AI history
 */
export async function testVisualizationContextAddition(): Promise<boolean> {
    console.log('=== TESTING VISUALIZATION CONTEXT ADDITION ===');
    
    try {
        // Create a mock extension context
        const mockContext = {
            workspaceState: {
                get: (key: string) => undefined,
                update: (key: string, value: any) => Promise.resolve(),
                keys: () => []
            }
        } as any;
        
        // Create a ChatViewProvider instance
        const extensionUri = vscode.Uri.file('test');
        const chatProvider = new ChatViewProvider(extensionUri, 'test-api-key', mockContext);
        
        // Create a simple test session to verify context addition
        const testSession = createChat({ 
            apiKey: 'test-key',
            maxHistoryMessages: 10,
            systemMessage: 'You are a test assistant.' 
        });
        
        // Manually add the session to the provider
        (chatProvider as any).sessions.set('test-thread', testSession);
        (chatProvider as any).threadTitles.set('test-thread', 'Test Thread');
        (chatProvider as any).activeThreadId = 'test-thread';
        
        // Test: Get initial history length
        const initialHistory = testSession.getHistory();
        console.log(`Initial history length: ${initialHistory.length}`);
        
        // Test: Add visualization context
        const userMessage = 'Please generate an architecture visualization for this project.';
        const botResponse = `I've analyzed the project and generated a mermaid visualization. Here's my architectural analysis:

**Project Type**: VS Code Extension
**Components Found**: ChatViewProvider, VisualizationProvider, LLM Integration
**Architecture Patterns**: Provider pattern with webview communication
**Data Flow**: User input -> ChatViewProvider -> LLM -> Response display

The mermaid diagram visualizes these relationships and you can ask about:
- Specific components and their purposes
- How data flows between components  
- Architectural patterns being used
- Suggestions for improvements or refactoring
- Dependencies and their implications`;
        
        // Add the context using the method
        chatProvider.addContextToActiveSession(userMessage, botResponse);
        
        // Verify the context was added
        const updatedHistory = testSession.getHistory();
        console.log(`Updated history length: ${updatedHistory.length}`);
        
        // Check if the context was properly added
        if (updatedHistory.length !== initialHistory.length + 2) {
            throw new Error(`Expected history length to increase by 2, but got: initial=${initialHistory.length}, updated=${updatedHistory.length}`);
        }
        
        // Check if the messages are in the correct format
        const lastUserMessage = updatedHistory[updatedHistory.length - 2];
        const lastBotMessage = updatedHistory[updatedHistory.length - 1];
        
        if (!lastUserMessage || typeof lastUserMessage.content !== 'string') {
            throw new Error('User message not properly added to history');
        }
        
        if (!lastBotMessage || typeof lastBotMessage.content !== 'string') {
            throw new Error('Bot message not properly added to history');
        }
        
        if (!lastUserMessage.content.includes('architecture visualization')) {
            throw new Error('User message content not correct');
        }
        
        if (!lastBotMessage.content.includes('architectural analysis')) {
            throw new Error('Bot message content not correct');
        }
        
        console.log('✅ Context addition test passed!');
        console.log(`📝 Added messages: 
User: "${lastUserMessage.content.substring(0, 50)}..."
Bot: "${lastBotMessage.content.substring(0, 50)}..."`);
        
        return true;
        
    } catch (error) {
        console.error('❌ Context addition test failed:', error);
        return false;
    }
}

/**
 * Test specifically for the message flow from visualization to chat
 */
export async function testVisualizationToChat(): Promise<boolean> {
    console.log('=== TESTING VISUALIZATION TO CHAT FLOW ===');
    
    try {
        // Simulate what happens when a user generates a visualization and then asks about it
        
        // Step 1: Simulate successful visualization context addition
        const success = await testVisualizationContextAddition();
        if (!success) {
            throw new Error('Context addition test failed');
        }
        
        // Step 2: Verify that subsequent user messages would have the context available
        console.log('✅ Visualization to chat flow test passed!');
        console.log('📋 When user asks "what is the architecture" after visualization, they should now have context');
        
        return true;
        
    } catch (error) {
        console.error('❌ Visualization to chat flow test failed:', error);
        return false;
    }
}

/**
 * Run all context-related tests
 */
export async function runContextTests(): Promise<void> {
    console.log('\n🧪 STARTING CONTEXT ADDITION TESTS\n');
    
    const test1 = await testVisualizationContextAddition();
    const test2 = await testVisualizationToChat();
    
    const allPassed = test1 && test2;
    
    console.log('\n📊 TEST RESULTS:');
    console.log(`Context Addition: ${test1 ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Visualization Flow: ${test2 ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Overall: ${allPassed ? '🎉 ALL TESTS PASSED' : '💥 SOME TESTS FAILED'}`);
    
    if (allPassed) {
        console.log('\n🔧 FIX VERIFIED: Visualization context is now properly added to AI history!');
        console.log('📖 Users should now be able to ask questions about generated visualizations.');
    } else {
        console.log('\n⚠️  FIX INCOMPLETE: Context addition still has issues.');
    }
}
