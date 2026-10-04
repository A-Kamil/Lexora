export { mistralClient, DEFAULT_MODELS } from './client.js';
export { wrapAsData } from './prompts.js';
export {
  CaseAnalysisSchema, analyzeCase, buildContext,
  type CaseAnalysis, type AnalysisInput, type AnalysisResult, type ContextMessage, type ContextDocument, type LegalSource,
} from './analyze.js';
export { extractDocument, DocumentMetadataSchema, SUPPORTED_MIME, type DocumentMetadata } from './ocr.js';
export { transcribeVoice } from './transcribe.js';
export { converse, cleanReply, buildConversation, INTAKE_SYSTEM, type ConverseInput } from './converse.js';
export { gatherLegalContext, legalTools, runLegalTool, getEchrArticle, type LegalContextMode, type LegalAuditEntry, type LegalContextOptions } from './legal-context.js';
export { redactForExternal } from './legal/redact.js';
export { searchEchr } from './legal/echr.js';
export { findCompany, type Company } from './legal/companies.js';
