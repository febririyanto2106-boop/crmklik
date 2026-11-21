/**
 * Mints a short-lived Azure Speech token for the browser's Speech SDK.
 *
 * The Speech SDK itself only ever runs client-side (it needs the
 * microphone), so the browser needs *some* credential to open a connection —
 * but it must never see AZURE_SPEECH_KEY directly. This exchanges that
 * server-held key for a ~10-minute JWT via Azure's STS endpoint and hands
 * back only the token, the region and the v2 endpoint.
 *
 * Dictation mints a fresh token per session and never renews (a dictation
 * session comfortably outlasts well within the 10-minute lifetime). Calls can
 * run far longer, so `use-translated-call` re-calls this every 8 minutes and
 * hot-swaps `authorizationToken` on the live recognizers.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AzureSpeechCredentials = {
  token: string;
  region: string;
  /**
   * Azure's universal v2 endpoint. Live Interpreter (speech-to-speech with
   * open-range language detection) only works against this endpoint — the
   * region form of SpeechTranslationConfig cannot reach it.
   */
  endpoint: string;
  /** Whether calls should try Live Interpreter before the classic chain. */
  liveInterpreter: boolean;
};

/**
 * Builds the universal v2 endpoint.
 *
 * Prefers an explicit AZURE_SPEECH_ENDPOINT (the resource-name form,
 * `wss://<name>.cognitiveservices.azure.com/stt/speech/universal/v2`, which is
 * what Microsoft's own samples use). Falls back to the regional form, which
 * needs nothing beyond the region already configured — so Live Interpreter can
 * be switched on without adding a second secret.
 *
 * `?setfeature=llm` selects Azure's LLM-based translation model, which
 * translates while the speaker is still talking instead of waiting for a
 * phrase boundary. That is the whole point of moving to Live Interpreter, so
 * it is on unless explicitly disabled.
 */
function buildV2Endpoint(region: string): string {
  const explicit = process.env.AZURE_SPEECH_ENDPOINT?.trim();
  const base = explicit || `wss://${region}.stt.speech.microsoft.com/speech/universal/v2`;
  if (process.env.AZURE_SPEECH_LLM_MODE?.trim() === "0") return base;
  return base.includes("?") ? `${base}&setfeature=llm` : `${base}?setfeature=llm`;
}

export const getAzureSpeechToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({}).parse(input ?? {}))
  .handler(async (): Promise<AzureSpeechCredentials> => {
    const key = process.env.AZURE_SPEECH_KEY?.trim();
    const region = process.env.AZURE_SPEECH_REGION?.trim();
    if (!key || !region) {
      throw new Error("Dictation needs AZURE_SPEECH_KEY and AZURE_SPEECH_REGION on the server.");
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15_000);

    let res: Response;
    try {
      res = await fetch(`https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": key },
        signal: controller.signal,
      });
    } catch (e) {
      const err = e as Error;
      throw new Error(
        err.name === "AbortError" && timedOut
          ? "Azure Speech token request timed out."
          : `Could not reach Azure Speech (${err.message}).`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`Could not get a dictation token (Azure said ${res.status}).`);
    }

    const token = (await res.text()).trim();
    return {
      token,
      region,
      endpoint: buildV2Endpoint(region),
      // Off unless switched on: Live Interpreter is a newer Azure feature and
      // is not enabled on every resource or region. The client also falls back
      // on its own if the recognizer fails to start, so this flag only decides
      // what is tried first.
      liveInterpreter: process.env.AZURE_LIVE_INTERPRETER?.trim() === "1",
    };
  });
