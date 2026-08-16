/** Structured, panel-editable alternative to hand-writing GMAIL_RULES JSON. */
export interface EmailClassificationConfig {
    vipSenders: string[];
    urgentKeywords: string[];
    normalKeywords: string[];
}

export const DEFAULT_EMAIL_CLASSIFICATION: EmailClassificationConfig = {
    vipSenders: [],
    urgentKeywords: [],
    normalKeywords: [],
};
