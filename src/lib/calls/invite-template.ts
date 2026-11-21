/**
 * Mapping a call invite onto an approved WhatsApp template.
 *
 * Two shapes carry a link, and they are filled differently:
 *
 *  - **Dynamic URL button** — Meta fixes the URL prefix at approval time and
 *    only lets the *suffix* vary. So the parameter is the part of our call
 *    link that follows the button's base, not the whole URL.
 *  - **Body placeholders** — the link goes in as plain text. Filled
 *    positionally: {{1}} the contact's name, {{2}} the link, the rest blank.
 *    Guessing further would be worse than letting the agent see the preview.
 */
import type { CallInviteTemplate } from "@/lib/calls/invite-window.functions";

export type InviteFill = {
  /** Body/header values keyed by placeholder number. */
  values: Record<string, string>;
  /**
   * URL-button values, kept apart from the body's. A template numbers the two
   * independently — `call_invite_link` has {{1}} in its body (the contact's
   * name) *and* {{1}} in its button URL (the room) — so one map would have the
   * body overwrite the button and send the customer to /call/<their own name>.
   */
  buttonValues: Record<string, string>;
  /** The body as the customer will read it. */
  preview: string;
  /** Set when the template cannot actually deliver the link. */
  problem: string | null;
  /**
   * The URL the customer will actually receive. Same as the call link for a
   * body-placeholder template; for a URL button it is the query-free form
   * (see below), so the stored message and the invite card do not claim to
   * have sent something different.
   */
  deliveredLink: string;
};

/** `www.` is not a different site, and host casing is not meaningful. */
function sameHost(a: string, b: string): boolean {
  const norm = (h: string) => h.toLowerCase().replace(/^www./, "");
  return norm(a) === norm(b);
}

/**
 * Returns the suffix of `link` relative to `base`, or null when the template's
 * button points somewhere else entirely — in which case sending it would show
 * the customer a button that goes to the wrong place.
 *
 * Meta builds the final URL as base + parameter, so the suffix has to be the
 * piece that completes the template's own URL. Matching the two as **parsed
 * URLs** rather than as strings is what keeps this configuration-free: a
 * template approved for `https://www.example.com/call/` still works when the
 * app is served from `https://example.com`, and vice versa, and `http` vs
 * `https` does not matter either — the customer always receives the
 * template's own (approved) prefix. The host itself must still match, so a
 * template pointing at someone else's domain is still refused.
 */
export function urlSuffixFor(link: string, base: string): string | null {
  const b = base.trim();
  if (!b) return null;
  // Exact string prefix: the common case, and the only one that needs no
  // assumptions at all.
  if (link.startsWith(b)) {
    const suffix = link.slice(b.length);
    return `${b}${suffix}` === link ? suffix : null;
  }
  try {
    const target = new URL(link);
    const prefix = new URL(b);
    if (!sameHost(target.host, prefix.host)) return null;
    // Compare the path only; the query/hash of our link follows it verbatim.
    const targetPath = `${target.pathname}${target.search}${target.hash}`;
    if (!targetPath.startsWith(prefix.pathname)) return null;
    return targetPath.slice(prefix.pathname.length);
  } catch {
    // A base that is not a parsable URL cannot be reasoned about safely.
    return null;
  }
}

export function fillInviteTemplate(
  template: CallInviteTemplate,
  link: string,
  contactName: string,
): InviteFill {
  const values: Record<string, string> = {};
  const buttonValues: Record<string, string> = {};
  let problem: string | null = null;
  /*
   * A dynamic URL button carries only the suffix, and Meta treats that value
   * as a path segment — a "?exp=..." query inside it is not something to
   * gamble a customer-facing link on. The expiry is advisory anyway (the room
   * id is the credential, see callRoomUrl), so the button gets the query-free
   * link and the body keeps the full one.
   */
  const buttonLink = link.split("?")[0] ?? link;
  let deliveredLink = link;

  if (template.urlButtonIndex !== null && template.urlButtonBase) {
    const suffix = urlSuffixFor(buttonLink, template.urlButtonBase);
    if (suffix === null) {
      problem =
        `This template's button links to ${template.urlButtonBase}, which is a different ` +
        `site from this call link. (www and non-www count as the same site.) Pick a ` +
        `template whose button points at your own app, or one with a placeholder in the ` +
        `message body.`;
    } else {
      buttonValues[template.urlButtonVariable ?? "1"] = suffix;
      deliveredLink = buttonLink;
    }
  }

  // Body placeholders are numbered independently of the button's.
  const bodyVars = template.bodyVariables;
  if (bodyVars.length > 0) {
    const hasButton = template.urlButtonIndex !== null && !problem;
    bodyVars.forEach((n, i) => {
      if (i === 0) values[n] = contactName;
      // Without a working button the link has to go in the body, so it needs
      // a second placeholder to live in.
      else if (i === 1) values[n] = hasButton ? "" : link;
      else values[n] = "";
    });
    if (!hasButton && bodyVars.length < 2 && !problem) {
      // Only one placeholder: spend it on the link rather than the name —
      // a call invite with no way to join is useless.
      values[bodyVars[0]!] = link;
    }
  } else if (template.urlButtonIndex === null) {
    problem = "This template has nowhere to put the call link.";
  }

  const preview = template.bodyText.replace(
    /\{\{\s*(\d+)\s*\}\}/g,
    (_m, n: string) => values[n] || `{{${n}}}`,
  );

  return { values, buttonValues, preview, problem, deliveredLink };
}

/** Plain-text record of what was sent, stored as the message body. */
export function inviteTemplateBody(preview: string, link: string): string {
  return preview.includes(link) ? preview : `${preview}\n${link}`;
}
