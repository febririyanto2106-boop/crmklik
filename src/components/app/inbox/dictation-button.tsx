/**
 * Record-and-transcribe button.
 *
 * Two states: idle → listening (and briefly "connecting" while a token is
 * fetched and the recognizer spins up). All the actual speech-to-text work
 * is Azure AI Speech's real-time continuous recognition, via the shared
 * `useAzureDictation` hook — see that file for why.
 *
 * Shared by the AI reply assistant's custom instruction (the composer has
 * its own dictation mic wired to the same hook, alongside its separate
 * voice-note recording UI).
 */
import { Loader2, Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAzureDictation } from "@/hooks/use-azure-dictation";

export function DictationButton({
  value,
  onText,
  disabled,
  size = "iconSM",
  variant = "ghost",
  className,
  title = "Dictate — speak in any language and it is typed for you",
}: {
  /** The field's current text, so dictation knows what it's appending to. */
  value: string;
  /** Called with the full resulting text (base + transcript) — replace, not append. */
  onText: (text: string) => void;
  disabled?: boolean;
  size?: "icon" | "iconSM";
  variant?: "ghost" | "outline" | "secondary";
  className?: string;
  title?: string;
}) {
  const { active, connecting, toggle } = useAzureDictation({
    value,
    onChange: onText,
    onError: (message) => toast.error(message),
    onNoSpeech: () => toast.info("No speech was recognised"),
  });

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={cn(
        "shrink-0",
        variant === "ghost" && "rounded-full",
        active && "bg-destructive/10 text-destructive hover:text-destructive",
        className,
      )}
      disabled={disabled || connecting}
      onClick={toggle}
      aria-label={active ? "Stop dictation" : "Dictate"}
      aria-pressed={active}
      title={connecting ? "Connecting…" : active ? "Stop dictation" : title}
    >
      {connecting ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : active ? (
        <Square className="h-4 w-4" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </Button>
  );
}
