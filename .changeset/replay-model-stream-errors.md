---
"@statelyai/agent": patch
---

Record model stream-iteration failures separately from request-stage failures. JSON recordings and translated model answers can carry an optional `streamError`; replay yields the saved chunks before raising it, rather than ending successfully or rejecting before returning the stream. This applies to AI SDK streams and both OpenAI client methods. Comparisons distinguish iteration failure, successful EOF and request failure, while ordinary streams and early cancellation retain their behavior.
