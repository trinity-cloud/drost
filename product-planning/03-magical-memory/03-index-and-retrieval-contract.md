# Index And Retrieval Contract

## Goal

Extend Drost's current SQLite memory system from transcript-only search into a unified memory index over:

- transcripts
- `MEMORY.md`
- daily memory files
- entity memory files

The product behavior should be:

- ambient prompt-time recall from the best memory sources
- directed recall through `memory_search`
- exact inspection through `memory_get`

## Current Drost State

Today the index primarily serves transcript chunks through `drost/storage/database.py`, with hybrid FTS plus vector retrieval and chunk IDs returned to tools.

That is a good engine, but the data model is too narrow.

## Embedding Model Choice

Drost should use Google's Gemini embeddings API for the unified memory index.

Chosen configuration:

- provider: Gemini
- model: `gemini-embedding-001`
- auth: `GEMINI_API_KEY`
- output dimensionality: full default `3072`

Google's current docs also make two details important:

- the model supports retrieval-specific task types
- the default output is `3072`, and lower dimensions are optional truncation rather than the native full representation

For Drost, that means we should use the full vector size and avoid `output_dimensionality` reduction in this pass.

## Required Source Kinds

Every indexed row should declare its origin.

Recommended `source_kind` values:

- `transcript_message`
- `transcript_tool`
- `workspace_memory`
- `daily_memory`
- `entity_item`
- `entity_summary`
- `workspace_profile`

`workspace_profile` covers files like `SOUL.md`, `IDENTITY.md`, and `USER.md` if we decide to index them later. That is optional for the first pass.

## Required Metadata Per Indexed Item

Each row should retain enough provenance to support stable recall.

Minimum metadata:

- `memory_id`
- `source_kind`
- `path`
- `session_key`
- `line_start`
- `line_end`
- `title`
- `created_at`
- `updated_at`
- `derived_from`
- `text_raw`
- `text_search`
- `embedding_model`
- `embedding_dims`

`derived_from` should point back to the originating transcript file or session when the indexed memory was synthesized from chat.

## Indexing Strategy

### Transcript Sources

Keep indexing transcripts, but make the source explicit.

Recommended split:

- user/assistant JSONL for conversational memory
- `.full.jsonl` for tool artifacts and operational detail

That means extraction and retrieval can prefer the right source class instead of mixing everything together.

### Workspace Memory Sources

Index these files directly:

- `MEMORY.md`
- `memory/daily/*.md`
- `memory/entities/*/*/items.md`
- `memory/entities/*/*/summary.md`

Chunking guidance:

- `MEMORY.md`: chunk by heading or fixed window
- daily files: small heading-aware windows or whole-file if tiny
- `items.md`: chunk by fact block, not arbitrary token windows
- `summary.md`: usually whole-file

This preserves semantic boundaries.

Gemini-specific indexing rules:

- use `RETRIEVAL_DOCUMENT` for all indexed memory chunks
- set `title` for document-style chunks when a stable title exists
- keep chunk sizes below Gemini's `2048` input-token limit
- treat full-size `3072` outputs as already normalized vectors

Recommended titles:

- `MEMORY.md`: `MEMORY.md`
- daily files: `daily/YYYY-MM-DD`
- entity summaries: `<entity_type>/<entity_id>`
- entity item blocks: `<entity_type>/<entity_id>`

The `title` field matters because Google documents better retrieval quality for `RETRIEVAL_DOCUMENT` embeddings when a title is supplied.

## Search Contract

### `memory_search`

`memory_search` should stop returning only opaque chunk IDs.

It should return results shaped like:

```json
{
  "id": "mem_01...",
  "source_kind": "entity_summary",
  "path": "memory/entities/projects/drost/summary.md",
  "session_key": null,
  "line_start": 1,
  "line_end": 8,
  "score": 0.91,
  "title": "projects/drost",
  "snippet": "Drost is Migel's open-source personal agent runtime...",
  "derived_from": "sessions/main_telegram_8271705169__s_2026-03-06_21-40-24.full.jsonl"
}
```

The result must be understandable without reading internal code.

### Ranking

Use reciprocal rank fusion across:

- keyword results
- vector results
- literal exact-match results

Prefer literal matching more strongly for:

- names
- dates
- handles
- identifiers
- quoted phrases
- codes or exact short strings

This matters because personal memory often hinges on exact terms.

Vector lane specifics:

- document vectors should be generated with `gemini-embedding-001` + `RETRIEVAL_DOCUMENT`
- query vectors should be generated with `gemini-embedding-001` + `RETRIEVAL_QUERY`
- vector column sizing in SQLite should be fixed at `3072`

This split should be treated as part of the retrieval contract, not as an implementation detail.

## `memory_get` Contract

`memory_get` should evolve from chunk-id fetch to exact-source fetch.

Recommended input modes:

1. by indexed `id`
2. by `path` plus optional line range
3. by `session_key` plus line range for transcript recall

Recommended output:

- raw text excerpt
- source metadata
- line numbers when available

If `path` points at a workspace memory file, `memory_get` should read exactly that file slice.
If it points at a transcript source, it should reconstruct the message slice from stored JSONL reference data.

## Ambient Retrieval vs Directed Retrieval

### Ambient Retrieval

For each turn, build a small memory capsule before the model runs.

Candidate sources:

- top excerpt from `MEMORY.md`
- today and yesterday daily files
- most relevant entity summaries
- fresh continuity summary if present

This is deterministic and bounded.

### Directed Retrieval

If the model needs more, it should call:

1. `memory_search`
2. `memory_get`

That is the right contract:

- capsule for cheap ambient continuity
- tools for exact inspection

## Secret Handling

Before sending text to third-party embedding providers, add a redaction pass for likely secrets and credentials.

This does not need to block Phase 1 of the build, but it should be part of the retrieval contract and schema from the start.

## Reindexing

The index must be rebuildable.

That implies:

- no canonical meaning stored only in SQLite
- file-derived rows can be deleted and recreated
- transcript-derived rows can be replayed from JSONL
- derived memory rows retain provenance back to source

## Throughput Notes

For interactive query embedding, use the normal Gemini embedding API path.

For larger reindex or backfill jobs, evaluate Gemini's batch embedding path later, but do not block the first implementation on batch support. Correctness and provenance matter more than indexing throughput in the initial pass.

## What Success Looks Like

A memory query like "what have we decided about Drost memory architecture" should be able to return:

- a recent transcript decision
- the relevant daily note
- the `projects/drost/summary.md` entry if it exists
- the exact entity fact block that captured the decision

That is when the index becomes a real memory engine instead of a transcript search utility.
