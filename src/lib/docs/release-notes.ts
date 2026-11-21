import { APP_RELEASE_CHANNEL, APP_VERSION } from "@/lib/app-version";
import type { PdfBlock } from "@/lib/docs/simple-pdf";

export interface ReleaseNotes {
  version: string;
  date: string;
  headline: string;
  sections: { title: string; items: string[] }[];
}

/** Release notes for the current version, mirroring docs/changelog.html. */
export const CURRENT_RELEASE_NOTES: ReleaseNotes = {
  version: APP_VERSION,
  date: "2026-11-18",
  headline:
    "Version 7.4.6 adds translated voice and video calls with live captions and speech-to-speech, real-time dictation, browser alerts for incoming calls, call analytics and recording retention, a customizable landing page, and a rebuilt mobile inbox.",
  sections: [
    {
      title: "Translated calls",
      items: [
        "Call a contact from the conversation and speak your own language while they speak theirs: live captions both ways, voice or video, with the language switchable mid-call.",
        "Speech-to-speech through Azure neural voices, so each side hears the other in their own language rather than only reading it.",
        "Send the join link straight into the chat as a rich invite card with an expiry. Outside WhatsApp's 24-hour window the invite goes out as an approved template instead of failing silently.",
        "A finished call leaves a compact card in the thread with an AI summary, a downloadable transcript and a one-tap follow-up task. Calls can be recorded, and missed calls are logged.",
        "Incoming calls alert the agent in the app and through a browser push notification when the tab is closed; the ringtone can be muted per agent.",
        "A call analytics page, a retention policy that sweeps old recordings automatically, and a TURN relay for calls behind strict NATs and corporate firewalls.",
      ],
    },
    {
      title: "Dictation",
      items: [
        "Speak instead of typing in the composer and in the AI Reply Assistant, with the text appearing as you talk (Azure AI Speech).",
        "Only one microphone can be live at a time anywhere in the app.",
      ],
    },
    {
      title: "Inbox on mobile",
      items: [
        "The page-header band is gone below md — the title moved into the controls row (133px to 61px), and the conversation-list header fits one row (236px to 149px).",
        "Message-bubble actions work on touch, and outgoing bubbles use the full width available.",
        "The translated call sits in the conversation header at every width; payment, handoff (take over / resume AI / transfer) and the side panels are reachable from a phone for the first time.",
        "Dark mode rebuilt around #191c22, with a dark / light / system switch.",
      ],
    },
    {
      title: "Admin and platform",
      items: [
        "Every section of the public landing page is editable from the app.",
        "Pagination on Super Admin Users and Tenants, and a fix for the second scrollbar and the large empty gap on admin pages.",
        "Cloudflare secrets sync from .env automatically on deploy.",
      ],
    },
    {
      title: "Documentation",
      items: [
        "Rebuilt around three-level accordion navigation with a right column that follows the page you are on, the app's own brand icon and a dark palette.",
        "The cPanel / shared-hosting guide grew from 16 to 204 lines so a non-technical buyer can install and run the app, with a troubleshooting table built from the real error messages.",
        "LINE, Viber, WeChat and the comment channels are documented, and inbound email is corrected from polled to webhook.",
      ],
    },
    {
      title: "Fixes",
      items: [
        'The organization switcher labelled every user "member" — the role was never fetched.',
        "Gmail sync collected every attachment twice.",
        "A Meta template INVALID_FORMAT rejection, a stale call-room id that left both sides waiting forever, and a migration-history mismatch.",
        "Call invites could not find approved templates (status is stored lower-case), and a template's button placeholder was sent the contact's name instead of the call room.",
      ],
    },
    {
      title: "Upgrade notes",
      items: [
        "Apply all pending migrations with: npx supabase db push --include-all --yes.",
        "Set WACRM_VERSION=7.4.6 in .env if you pin the version for Docker builds.",
        "Calls and dictation need new server variables: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, optionally CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN for the relay and VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT for push alerts.",
        "Read docs/releases/v7.4.6.md for detailed changes and verification notes.",
      ],
    },
  ],
};

export function releaseNotesToPdfBlocks(notes: ReleaseNotes, brandName: string): PdfBlock[] {
  const blocks: PdfBlock[] = [
    { type: "title", text: `${brandName} v${notes.version}` },
    { type: "subtitle", text: `Release notes \u00b7 ${APP_RELEASE_CHANNEL} \u00b7 ${notes.date}` },
    { type: "rule" },
    { type: "text", text: notes.headline },
  ];
  for (const section of notes.sections) {
    blocks.push({ type: "heading", text: section.title });
    for (const item of section.items) blocks.push({ type: "bullet", text: item });
  }
  blocks.push({ type: "space", size: 14 });
  blocks.push({ type: "rule" });
  blocks.push({
    type: "subtitle",
    text: `Full history: /docs/changelog.html \u00b7 (c) 2026 ${brandName}`,
  });
  return blocks;
}
