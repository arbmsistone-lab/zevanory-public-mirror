# Catalog voice cache correction

Catalog price, delivery and refund voice uses the deterministic approved answer, while written AI responses remain unchanged. The manual warm manifest contains 15 product/intent pairs. Shared delivery and refund policies produce seven unique cache keys, avoiding redundant Gemini calls. Cache keys and 30-day TTL match production.

The Render endpoint is live at `ed7392f3afc92c6e233e6b5339955028fd5a6ba9` (deploy `dep-db1fc98u01pc73e6l50g`). WhatsApp synthesis uses one lite model and one HTTP request; transport failures and quota never trigger a second synthesis. The temporary #377 fallback is removed. Legacy chunks and PCM modules remain because provider routing, operational audit and internal encoding routes still reference them.

## Evidence preserved from unmerged #378

Run `37249761141`, artifact `11320467528`, delivered two signed inbound OGG proofs to the verified owner ending 4023. Both were cache misses because AI speech differed. First outbound audio: `wamid.HBgNNTU4ODkyMTkyNDAyMxUCABEYEkJERjRCOUJCQ0VDMzI4MUZCRgA=`; Worker CPU 32 ms. Second: `wamid.HBgNNTU4ODkyMTkyNDAyMxUCABEYEjEzMzM1N0U5NTMwRTk4NTA5OAA=`; Worker CPU 20 ms. These are historical diagnostics, not evidence of a successful cache hit. The old primary/lite fallback attempted four Gemini calls and must not be repeated.

## New proof safeguards

The production deploy whose commit carries `[voice-cache-cycle-20261005]` authorizes one proof cycle only. No automatic rerun can synthesize. Manual proof dispatch is cache-only. The signed inbound repeat carries a cache-only flag enforced by the Worker before contacting Render, even if KV propagation lags. Missing cache stops the proof. The cache warm workflow is manual only and is not executed in this cycle.
