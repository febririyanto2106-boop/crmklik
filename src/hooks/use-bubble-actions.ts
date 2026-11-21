import { useSyncExternalStore } from "react";

/**
 * Pointer capability and "which bubble has its actions open" for the message
 * list.
 *
 * Both live in module scope rather than in each bubble: a thread renders
 * hundreds of bubbles, and one shared media-query listener plus one shared
 * selection beats one of each per message. Keeping the open bubble here also
 * means tapping a second message closes the first, which is what a reader
 * expects from a toolbar that overlays the bubble.
 */

const COARSE_QUERY = "(hover: none)";

const pointerListeners = new Set<() => void>();
let pointerQuery: MediaQueryList | null = null;

const notifyPointer = () => {
  for (const listener of pointerListeners) listener();
};

const subscribePointer = (onChange: () => void) => {
  pointerListeners.add(onChange);
  if (!pointerQuery && typeof window !== "undefined") {
    pointerQuery = window.matchMedia(COARSE_QUERY);
    pointerQuery.addEventListener("change", notifyPointer);
  }
  return () => {
    pointerListeners.delete(onChange);
    if (pointerListeners.size === 0 && pointerQuery) {
      pointerQuery.removeEventListener("change", notifyPointer);
      pointerQuery = null;
    }
  };
};

const pointerSnapshot = () => {
  if (pointerQuery) return pointerQuery.matches;
  if (typeof window === "undefined") return false;
  return window.matchMedia(COARSE_QUERY).matches;
};

/** True where the device cannot hover, so actions need a tap to appear. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribePointer, pointerSnapshot, () => false);
}

let openBubbleId: string | null = null;
const openListeners = new Set<() => void>();

const subscribeOpen = (onChange: () => void) => {
  openListeners.add(onChange);
  return () => {
    openListeners.delete(onChange);
  };
};

const openSnapshot = () => openBubbleId;

/** Open this message's action bar, or close it if it is already open. */
export function toggleBubbleActions(id: string): void {
  openBubbleId = openBubbleId === id ? null : id;
  for (const listener of openListeners) listener();
}

export function closeBubbleActions(): void {
  if (openBubbleId === null) return;
  openBubbleId = null;
  for (const listener of openListeners) listener();
}

export function useBubbleActionsOpen(id: string): boolean {
  return useSyncExternalStore(subscribeOpen, openSnapshot, () => null) === id;
}
