# stt-bench

Speech-to-text and translation bench. It exists to pick a provider for live
watch-party subtitles (host microphone only) and for translating Baú posts,
**before** any product code. It is not part of the product and nothing under
`server/src/speech/` is wired into a route yet.

```bash
pnpm stt:bench                                  # everything, resumes from results.json
pnpm stt:bench -- --stage clips                 # cut the clips (needs the party recording)
pnpm stt:bench -- --stage stt --providers groq  # one provider family
pnpm stt:bench -- --stage translate
pnpm stt:bench -- --stage report                # rebuild report.md after editing reference.json
pnpm stt:typecheck
```

Keys are read from `~/.config/pqp/stt-bench.env` (never from the repo, never
printed): `GROQ`, `OPENROUTER`, and `GROK` only with `--xai` (xAI's own API,
the only way to reach Grok Voice Transcribe 2.0; OpenRouter carries 1.0).

- Providers: Groq (`whisper-large-v3-turbo`, `whisper-large-v3`), OpenRouter
  (`openai/whisper-*`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`,
  `google/chirp-3`, `x-ai/grok-stt-1.0`) and local whisper.cpp
  (`whisper-cli`, ggml models from the official `ggerganov/whisper.cpp`
  Hugging Face repo, in `~/.cache/pqp-stt-bench/models`).
- Audio is never written into the repo. Clips go to `--clips`
  (default `~/.cache/pqp-stt-bench/clips`), the recipe is `CLIPS` in `src/media.ts`.
- Results, the consensus reference, translations and `report.md` go to `--out`
  (default `~/.config/pqp/product/stt-bench-2026-10-01/`). Put a hand-written
  `recommendation.md` there and the report prepends it.
- The reference transcript is a consensus of the providers' own output
  (`reference.draft.json`), not a human transcript. Correct it into
  `reference.json` and re-run `--stage report`.
- Paid spend (OpenRouter and xAI reported cost) is tracked across stages and new
  paid requests stop at `--cap` (default 2.5 USD).

The module under test lives in `server/src/speech/` (provider interface,
Groq / OpenRouter / xAI / whisper.cpp / replay providers, the chunker and
stitcher, an energy gate, and an OpenRouter chat translator). Its unit tests run
offline with `pnpm --filter @pqp/server exec vitest run src/speech`.
