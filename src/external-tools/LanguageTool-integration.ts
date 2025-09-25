import fetch from 'node-fetch';
import { LLMService } from '../managers/LLMService';
import { SystemMessages } from '../SystemMessages';

export interface GrammarIssue {
    message: string;
    offset: number;
    length: number;
    replacements: string[];
    ruleId: string;
    ruleDescription: string;
}

export async function runAISecondPass(llmService: LLMService, documentText: string, issues: GrammarIssue[]): Promise<string> {
    const CONTEXT_CHARACTERS = 200; // Number of characters to include before and after the issue

    // Create a list of issues, each with its own local context snippet
    const issuesWithContext = issues.map(issue => {
        const start = Math.max(0, issue.offset - CONTEXT_CHARACTERS);
        const end = Math.min(documentText.length, issue.offset + issue.length + CONTEXT_CHARACTERS);
        const context = documentText.substring(start, end);
        return {
            message: issue.message,
            context: `...${context}...`
        };
    });

    // Safely stringify the array of objects to create the prompt content
    const issueSummary = JSON.stringify(issuesWithContext, null, 2);

    const prompt = `
A grammar tool found potential issues in a document. Each issue below includes the rule message and the local text context where it was found.

Many issues might be false positives due to technical jargon (e.g., 'BaseDashboard').
Review each issue within its provided context and identify which ones are **valid**.

Issues to review:
${issueSummary}

Your response MUST be a valid JSON array of strings. Each string in the array must be the exact 'message' of an issue you have identified as valid.
DO NOT wrap the JSON in markdown code fences.
DO NOT include any other text or explanations. Your entire output must be parseable as JSON.
`;

    const response = await llmService.request({
        type: 'grammar_check',
        prompt: prompt,
        systemMessage: SystemMessages.AI_SECOND_PASS_REVIEWER,
        sessionId: 'grammar-check-session'
    });

    // Defensively clean the response to remove markdown fences before returning.
    const cleanedContent = response.content
        .trim()
        .replace(/^```json\s*/, '')
        .replace(/^```\s*/, '')
        .replace(/```$/, '');

    return cleanedContent;
}


export async function checkGrammar(text: string, lang: string = 'en-US'): Promise<GrammarIssue[]> {
    const url = 'https://api.languagetool.org/v2/check';
    const params = new URLSearchParams();
    params.append('text', text);
    params.append('language', lang);

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });
    if (!res.ok) {
        throw new Error('LanguageTool API error');
    }
    const data = await res.json() as any;

    return (data.matches || []).map((m: any) => ({
        message: m.message,
        offset: m.offset,
        length: m.length,
        replacements: m.replacements.map((r: any) => r.value),
        ruleId: m.rule.id,
        ruleDescription: m.rule.description
    }));
}
