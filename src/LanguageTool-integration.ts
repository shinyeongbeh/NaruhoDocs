import fetch from 'node-fetch';

export interface GrammarIssue {
    message: string;
    offset: number;
    length: number;
    replacements: string[];
    ruleId: string;
    ruleDescription: string;
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
