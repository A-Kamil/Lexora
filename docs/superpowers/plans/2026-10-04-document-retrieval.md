# Document Persistence and Semantic Retrieval

**Goal:** Persist WhatsApp documents and their extracted text in PostgreSQL, index the text with Mistral embeddings in pgvector, and retrieve only the most relevant chunks for the active case and conversation.

**Scope:** TypeScript only. Keep the hackathon path synchronous and small: PostgreSQL stores the original file and chunks, the worker embeds immediately after OCR, and each analysis retrieves a maximum of six chunks. No queue, object storage, vector index, admin UI, or background retry system.

## Task 1: Add document bytes and vector chunks to PostgreSQL

- Add a migration enabling `vector`, storing document bytes/filename/indexing state, and creating `document_chunks` with a 1024-dimension embedding.
- Extend the Drizzle schema.
- Add DB functions to save a ready document with its original bytes, replace all chunks idempotently, record indexing failure, and search chunks by case and conversation.

## Task 2: Add Mistral embedding support

- Add deterministic paragraph-aware chunking (1,200 characters with 200-character overlap).
- Add a batched `mistral-embed` call and expose it through the worker AI port.

## Task 3: Connect persistence, indexing, and retrieval in the worker

- Extend document persistence so the worker saves downloaded bytes before/with OCR output.
- Embed and replace chunks immediately after extraction; retain a ready document if embedding fails and record the error.
- Before intake reply and analysis, build a query from the case title, current message, and five recent messages; retrieve the six best chunks within a 12,000-character budget.
- Feed retrieved chunks to both model calls and store their document IDs in analysis provenance.

## Task 4: Wire PostgreSQL into the API and verify the golden path

- Implement a PostgreSQL `CaseStore` adapter using the existing domain queries.
- Replace direct `MemoryStore` array access with explicit store methods used by both adapters.
- Configure the API to use PostgreSQL when `DATABASE_URL` is present while preserving the in-memory demo fallback.
- Run typecheck, lint, formatting, and a build. Do not add or run tests for this hackathon implementation.

## Completion criteria

1. A received PDF/image is represented by one database document row containing its original bytes and extracted text.
2. Its text is chunked and embedded exactly once per successful processing attempt, with replacement making retries safe.
3. Retrieval cannot return a chunk from another case or another conversation.
4. Analysis and intake receive only the top relevant chunks, not every full document.
5. The existing in-memory demo path still runs without PostgreSQL.
