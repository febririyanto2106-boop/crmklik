/**
 * Editable landing-page content.
 *
 * The landing page's LAYOUT is fixed code; its words and pictures are not.
 * Super Admin → Platform Settings → Landing Page stores overrides in
 * `public.settings` (scope='platform', key='landing') as a flat
 * `{ [fieldKey]: string }` map. An empty/absent value means "use the
 * built-in default", so a fresh install renders exactly the page that
 * shipped. This registry is the single source of truth: the admin form is
 * generated from it, and the landing page reads text through it.
 *
 * Adding a new editable slot = one entry here + one `text(...)`/`image(...)`
 * call at the spot in `src/routes/index.tsx`.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";

export type LandingFieldKind = "text" | "textarea" | "image";

export type LandingField = {
  key: string;
  label: string;
  kind: LandingFieldKind;
  /** The built-in copy this field replaces (shown as the form placeholder). */
  fallback?: string;
  hint?: string;
};

export type LandingSection = { id: string; title: string; fields: LandingField[] };

export const LANDING_SECTIONS: LandingSection[] = [
  {
    id: "hero",
    title: "Hero",
    fields: [
      {
        key: "hero_badge",
        label: "Badge line",
        kind: "text",
        fallback: "WhatsApp, Messenger & Instagram APIs · Self-hosted",
      },
      {
        key: "hero_title_1",
        label: "Title — first line",
        kind: "text",
        fallback: "Every conversation.",
      },
      {
        key: "hero_title_2",
        label: "Title — highlighted line",
        kind: "text",
        fallback: "One unified workspace.",
      },
      {
        key: "hero_subtitle",
        label: "Subtitle",
        kind: "textarea",
        fallback:
          "unifies WhatsApp, Messenger, Instagram, Telegram and email into one CRM workspace — with sales pipelines, AI chatbots, broadcast campaigns and automation, on infrastructure you own.",
        hint: "Rendered after the brand name.",
      },
      {
        key: "hero_cta_primary",
        label: "Primary button",
        kind: "text",
        fallback: "Start free trial",
      },
      {
        key: "hero_cta_secondary",
        label: "Secondary button",
        kind: "text",
        fallback: "See the product",
      },
    ],
  },
  {
    id: "features",
    title: "Features section",
    fields: [
      { key: "features_eyebrow", label: "Eyebrow", kind: "text", fallback: "Platform Featues" },
      {
        key: "features_title",
        label: "Heading",
        kind: "text",
        fallback: "Everything you need to run omnichannel support at scale.",
      },
      {
        key: "features_subtitle",
        label: "Subheading",
        kind: "textarea",
        fallback:
          "Forty-plus modules share one contact graph, so a chatbot, a campaign and a sales rep all see the same customer.",
      },
    ],
  },
  {
    id: "feature_cards",
    title: "Feature cards (left column)",
    fields: [
      { key: "feature1_title", label: "Card 1 — title", kind: "text", fallback: "Shared Inbox" },
      {
        key: "feature1_desc",
        label: "Card 1 — description",
        kind: "textarea",
        fallback:
          "Every channel, one queue — assign, tag, snooze and hand off between bot and human without losing a message.",
      },
      { key: "feature1_image", label: "Card 1 — image", kind: "image" },
      { key: "feature2_title", label: "Card 2 — title", kind: "text", fallback: "AI Studio" },
      {
        key: "feature2_desc",
        label: "Card 2 — description",
        kind: "textarea",
        fallback:
          "Reply suggestions, summaries and sentiment — powered by Gemini, OpenAI, Anthropic or Groq.",
      },
      { key: "feature2_image", label: "Card 2 — image", kind: "image" },
      { key: "feature3_title", label: "Card 3 — title", kind: "text", fallback: "Automations" },
      {
        key: "feature3_desc",
        label: "Card 3 — description",
        kind: "textarea",
        fallback:
          "Trigger-based workflows for welcome messages, tagging, escalation and off-hours auto-reply.",
      },
      { key: "feature3_image", label: "Card 3 — image", kind: "image" },
    ],
  },
  {
    id: "feature_cards_right",
    title: "Feature cards (right column)",
    fields: [
      {
        key: "feature4_title",
        label: "Card 4 — title",
        kind: "text",
        fallback: "Broadcast Campaigns",
      },
      {
        key: "feature4_desc",
        label: "Card 4 — description",
        kind: "textarea",
        fallback:
          "Approved templates, segmented lists and throttled sending with per-message delivery reporting.",
      },
      { key: "feature4_image", label: "Card 4 — image", kind: "image" },
      { key: "feature5_title", label: "Card 5 — title", kind: "text", fallback: "Analytics" },
      {
        key: "feature5_desc",
        label: "Card 5 — description",
        kind: "textarea",
        fallback:
          "Delivery, read, response and CSAT metrics with team-level performance breakdowns.",
      },
      { key: "feature5_image", label: "Card 5 — image", kind: "image" },
      { key: "feature6_title", label: "Card 6 — title", kind: "text", fallback: "Helpdesk & SLA" },
      {
        key: "feature6_desc",
        label: "Card 6 — description",
        kind: "textarea",
        fallback:
          "Tickets, priorities, business hours and automatic breach alerts on every thread.",
      },
      { key: "feature6_image", label: "Card 6 — image", kind: "image" },
    ],
  },
  {
    id: "pillars",
    title: "Four pillars",
    fields: [
      {
        key: "pillar1_title",
        label: "Pillar 1 — title",
        kind: "text",
        fallback: "Omnichannel Messaging",
      },
      {
        key: "pillar1_desc",
        label: "Pillar 1 — description",
        kind: "textarea",
        fallback:
          "Manage WhatsApp, Messenger, Instagram, Telegram and Email from one unified inbox.",
      },
      {
        key: "pillar2_title",
        label: "Pillar 2 — title",
        kind: "text",
        fallback: "Team Collaboration",
      },
      {
        key: "pillar2_desc",
        label: "Pillar 2 — description",
        kind: "textarea",
        fallback: "Assign conversations, share context and keep every team member aligned.",
      },
      { key: "pillar3_title", label: "Pillar 3 — title", kind: "text", fallback: "CRM & Sales" },
      {
        key: "pillar3_desc",
        label: "Pillar 3 — description",
        kind: "textarea",
        fallback: "Turn conversations into leads, customers and stronger business relationships.",
      },
      {
        key: "pillar4_title",
        label: "Pillar 4 — title",
        kind: "text",
        fallback: "Automation & Bots",
      },
      {
        key: "pillar4_desc",
        label: "Pillar 4 — description",
        kind: "textarea",
        fallback: "Automate repetitive tasks with workflows, chatbots and smart routing.",
      },
    ],
  },
  {
    id: "stack",
    title: "Why-us section",
    fields: [
      {
        key: "stack_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Why WACRM",
      },
      {
        key: "stack_title",
        label: "Title",
        kind: "textarea",
        fallback: "Stop juggling four tools.\nOne platform does it all.",
      },
      {
        key: "stack_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Most teams bolt a chatbot onto a helpdesk, export contacts into a CRM, then pay a fourth vendor to send campaigns. WACRM collapses that into one platform with one shared database.",
      },
      {
        key: "stack_cta",
        label: "Link label",
        kind: "text",
        fallback: "View all modules",
      },
    ],
  },
  {
    id: "channel_strip",
    title: "Channel strip",
    fields: [
      {
        key: "channel_strip_title",
        label: "Heading",
        kind: "textarea",
        fallback: "One timeline for every conversation your customers start",
      },
    ],
  },
  {
    id: "industries",
    title: "Industry use cases",
    fields: [
      {
        key: "industries_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Built for every industry",
      },
      {
        key: "industries_title",
        label: "Title",
        kind: "textarea",
        fallback: "One platform. Endless possibilities.",
      },
      {
        key: "industries_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "From growing businesses to established teams, WACRM brings customer conversations, sales and automation together.",
      },
    ],
  },
  {
    id: "inbox_spot",
    title: "Spotlight — Unified Inbox",
    fields: [
      {
        key: "inbox_spot_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Unified Omnichannel Inbox",
      },
      {
        key: "inbox_spot_title",
        label: "Title",
        kind: "textarea",
        fallback: "Every channel.\nOne powerful inbox.",
      },
      {
        key: "inbox_spot_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Bring WhatsApp, Messenger, Instagram, Telegram, and Email conversations together in one shared workspace. Respond faster, collaborate effortlessly, and keep every customer interaction organized.",
      },
      {
        key: "inbox_spot_cta",
        label: "Link label",
        kind: "text",
        fallback: "Omnichannel Inbox",
      },
    ],
  },
  {
    id: "crm_spot",
    title: "Spotlight — CRM & Sales",
    fields: [
      {
        key: "crm_spot_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "CRM & Sales",
      },
      {
        key: "crm_spot_title",
        label: "Title",
        kind: "textarea",
        fallback: "Turn conversations into customer relationships.",
      },
      {
        key: "crm_spot_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Manage leads, organize contacts, track sales opportunities, and build stronger customer relationships — all within your connected CRM workspace.",
      },
      {
        key: "crm_spot_cta",
        label: "Link label",
        kind: "text",
        fallback: "CRM & Sales",
      },
    ],
  },
  {
    id: "automation_spot",
    title: "Spotlight — Automation & Bots",
    fields: [
      {
        key: "automation_spot_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Automation & Bots",
      },
      {
        key: "automation_spot_title",
        label: "Title",
        kind: "textarea",
        fallback: "Automate conversations.\nFocus on what matters.",
      },
      {
        key: "automation_spot_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Build powerful workflows, automate customer interactions, and let intelligent chatbots handle repetitive conversations — all from one connected workspace.",
      },
      {
        key: "automation_spot_cta",
        label: "Link label",
        kind: "text",
        fallback: "Automation & Bots",
      },
    ],
  },
  {
    id: "campaigns_spot",
    title: "Spotlight — Marketing Campaigns",
    fields: [
      {
        key: "campaigns_spot_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Marketing Campaigns",
      },
      {
        key: "campaigns_spot_title",
        label: "Title",
        kind: "textarea",
        fallback: "Reach the right audience. Make every message count.",
      },
      {
        key: "campaigns_spot_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Plan, manage, and track customer messaging campaigns from one connected workspace. Keep your outreach organized and gain clearer visibility into campaign activity.",
      },
      {
        key: "campaigns_spot_cta",
        label: "Link label",
        kind: "text",
        fallback: "Marketing Campaigns",
      },
    ],
  },
  {
    id: "ecosystem_spot",
    title: "Spotlight — Platform Ecosystem",
    fields: [
      {
        key: "ecosystem_spot_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Platform Ecosystem",
      },
      {
        key: "ecosystem_spot_title",
        label: "Title",
        kind: "textarea",
        fallback: "Connect. Integrate.\nGrow without limits.",
      },
      {
        key: "ecosystem_spot_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Bring your communication channels, CRM, automation, and business workflows together. WACRM gives your team one connected platform to manage customer engagement and streamline operations.",
      },
      {
        key: "ecosystem_spot_cta",
        label: "Link label",
        kind: "text",
        fallback: "Platform Ecosystem",
      },
    ],
  },
  {
    id: "workspace_spot",
    title: "Spotlight — Workspace Management",
    fields: [
      {
        key: "workspace_spot_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Multi-Tenant & Workspace Management",
      },
      {
        key: "workspace_spot_title",
        label: "Title",
        kind: "textarea",
        fallback: "Multiple workspaces.\nOne powerful platform.",
      },
      {
        key: "workspace_spot_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Organize your businesses, manage teams, and control workspace operations from one connected platform. Keep customer conversations, team access, and business settings organized as you grow.",
      },
      {
        key: "workspace_spot_cta",
        label: "Link label",
        kind: "text",
        fallback: "Workspace Management",
      },
    ],
  },
  {
    id: "overview",
    title: "Platform overview",
    fields: [
      {
        key: "overview_title",
        label: "Title",
        kind: "textarea",
        fallback: "One powerful platform.\nEverything working together.",
      },
      {
        key: "overview_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "From customer conversations to sales, marketing, and automation, WACRM brings your essential business tools into one connected workspace.",
      },
    ],
  },
  {
    id: "workflow",
    title: "How it works",
    fields: [
      {
        key: "workflow_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "The workflow",
      },
      {
        key: "workflow_title",
        label: "Title",
        kind: "textarea",
        fallback: "From first message to fully automated revenue.",
      },
    ],
  },
  {
    id: "roles",
    title: "Roles section",
    fields: [
      {
        key: "roles_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Multi-role System",
      },
      {
        key: "roles_title",
        label: "Title",
        kind: "textarea",
        fallback: "One platform. Seven purpose-built experiences.",
      },
      {
        key: "roles_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Give every teammate a focused workspace with the right tools, context, and level of access — from platform administration to customer-facing work.",
      },
    ],
  },
  {
    id: "security",
    title: "Security section",
    fields: [
      {
        key: "security_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Security by design",
      },
      {
        key: "security_title",
        label: "Title",
        kind: "textarea",
        fallback: "Enterprise controls baked into the schema, not bolted on.",
      },
      {
        key: "security_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Workspace-scoped RLS, dedicated role tables, and audited security functions make access explicit across every tenant—without recursive policies or privilege escalation.",
      },
    ],
  },
  {
    id: "integrations",
    title: "Integrations section",
    fields: [
      {
        key: "integrations_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Connect your stack",
      },
      {
        key: "integrations_title",
        label: "Title",
        kind: "textarea",
        fallback: "Plug into everything your business already runs on.",
      },
      {
        key: "integrations_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Connect customer channels, AI providers, payments, and operational tools while keeping customer context inside one unified workspace.",
      },
    ],
  },
  {
    id: "cta",
    title: "Book-a-demo banner",
    fields: [
      {
        key: "cta_badge",
        label: "Badge",
        kind: "text",
        fallback: "Book a demo",
      },
      {
        key: "cta_title",
        label: "Title",
        kind: "textarea",
        fallback: "Ship your omnichannel CRM this week.",
      },
      {
        key: "cta_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Tell us how your team works today and we'll map the inbox, CRM, automation, and deployment setup around your real channels and customer journey.",
      },
    ],
  },
  {
    id: "pricing",
    title: "Pricing section",
    fields: [
      {
        key: "pricing_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Fair, flexible pricing",
      },
      {
        key: "pricing_title",
        label: "Title",
        kind: "textarea",
        fallback: "Simple pricing. No per-agent tax.",
      },
      {
        key: "pricing_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Every plan includes the full platform — inbox, automations, templates and CRM. You only choose how much volume and how many seats you need.",
      },
    ],
  },
  {
    id: "faq",
    title: "FAQ section",
    fields: [
      {
        key: "faq_eyebrow",
        label: "Eyebrow",
        kind: "text",
        fallback: "Answers without friction",
      },
      {
        key: "faq_title",
        label: "Title",
        kind: "textarea",
        fallback: "Answers before you ask.",
      },
    ],
  },
  {
    id: "download",
    title: "Download section",
    fields: [
      {
        key: "download_badge",
        label: "Badge",
        kind: "text",
        fallback: "Production-ready omnichannel SaaS",
      },
      {
        key: "download_title",
        label: "Title",
        kind: "textarea",
        fallback: "Launch your own omnichannel CRM today.",
      },
      {
        key: "download_lede",
        label: "Lede",
        kind: "textarea",
        fallback: "Download the complete WACRM platform and start with a unified inbox, CRM, AI automation, helpdesk, commerce, billing, and multi-tenant administration already connected.",
      },
    ],
  },
  {
    id: "footer",
    title: "Footer",
    fields: [
      {
        key: "footer_tagline",
        label: "Tagline",
        kind: "textarea",
        fallback: "The self-hosted omnichannel CRM for sales, support and marketing teams.",
      },
      {
        key: "footer_cta",
        label: "Button label",
        kind: "text",
        fallback: "Start free trial",
      },
      {
        key: "footer_col1_title",
        label: "Column 1 — heading",
        kind: "text",
        fallback: "Product",
      },
      {
        key: "footer_link_features",
        label: "Column 1 — link 1",
        kind: "text",
        fallback: "Features",
      },
      {
        key: "footer_link_tour",
        label: "Column 1 — link 2",
        kind: "text",
        fallback: "Product tour",
      },
      {
        key: "footer_link_solutions",
        label: "Column 1 — link 3",
        kind: "text",
        fallback: "Solutions",
      },
      {
        key: "footer_link_pricing",
        label: "Column 1 — link 4",
        kind: "text",
        fallback: "Pricing",
      },
      {
        key: "footer_col2_title",
        label: "Column 2 — heading",
        kind: "text",
        fallback: "Resources",
      },
      {
        key: "footer_link_docs",
        label: "Column 2 — link 1",
        kind: "text",
        fallback: "Documentation",
      },
      {
        key: "footer_link_install",
        label: "Column 2 — link 2",
        kind: "text",
        fallback: "Install guide",
      },
      {
        key: "footer_link_about",
        label: "Column 2 — link 3",
        kind: "text",
        fallback: "About",
      },
      {
        key: "footer_link_contact",
        label: "Column 2 — link 4",
        kind: "text",
        fallback: "Contact",
      },
      {
        key: "footer_col3_title",
        label: "Column 3 — heading",
        kind: "text",
        fallback: "Legal",
      },
      {
        key: "footer_link_privacy",
        label: "Column 3 — link 1",
        kind: "text",
        fallback: "Privacy policy",
      },
      {
        key: "footer_link_terms",
        label: "Column 3 — link 2",
        kind: "text",
        fallback: "Terms of service",
      },
      {
        key: "footer_link_cookies",
        label: "Column 3 — link 3",
        kind: "text",
        fallback: "Cookie policy",
      },
      {
        key: "footer_link_dpa",
        label: "Column 3 — link 4",
        kind: "text",
        fallback: "DPA",
      },
      {
        key: "footer_rights",
        label: "Copyright line",
        kind: "text",
        fallback: "All rights reserved.",
      },
      {
        key: "footer_bottom_docs",
        label: "Bottom bar — docs link",
        kind: "text",
        fallback: "Docs",
      },
      {
        key: "footer_bottom_selfhost",
        label: "Bottom bar — self-host link",
        kind: "text",
        fallback: "Self-host",
      },
    ],
  },
];

const ALL_FIELDS: LandingField[] = LANDING_SECTIONS.flatMap((s) => s.fields);
const FIELD_BY_KEY = new Map(ALL_FIELDS.map((f) => [f.key, f]));

/**
 * Public, read-only, sanitized overrides. Everyone (signed out included)
 * sees the landing page, so this must not require auth — it exposes only
 * the strings an admin chose to show on the public page anyway.
 */
export const getLandingOverrides = createServerFn({ method: "GET" }).handler(
  async (): Promise<Record<string, string>> => {
    const { supabaseAdmin } = await import("@/lib/demo/admin-write-guard.server");
    const { safeAssetUrl } = await import("@/lib/admin/platform-branding.functions");
    const { data, error } = await supabaseAdmin
      .from("settings")
      .select("value")
      .eq("scope", "platform")
      .eq("key", "landing")
      .maybeSingle();
    if (error || !data?.value) return {};
    const raw = data.value as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(raw)) {
      const field = FIELD_BY_KEY.get(key);
      if (!field || typeof v !== "string") continue;
      if (field.kind === "image") {
        const url = safeAssetUrl(v);
        if (url) out[key] = url;
      } else {
        const s = v.trim().slice(0, 600);
        if (s) out[key] = s;
      }
    }
    return out;
  },
);

export function landingOverridesQueryOptions() {
  return queryOptions({
    queryKey: ["landing-overrides"],
    queryFn: () => getLandingOverrides(),
    staleTime: 60_000,
  });
}

/**
 * The landing page's content accessors: `text(key)` returns the override or
 * the registry fallback; `image(key, fallbackSrc)` the override or the
 * bundled asset. Both are plain lookups — no loading states leak into the
 * page; until the query resolves, the defaults render (and for a fresh
 * install they are also the final state).
 */
export function useLandingContent() {
  const { data } = useQuery(landingOverridesQueryOptions());
  const overrides = data ?? {};
  return {
    text: (key: string): string => overrides[key] ?? FIELD_BY_KEY.get(key)?.fallback ?? "",
    image: (key: string, fallbackSrc: string): string => overrides[key] ?? fallbackSrc,
    /**
     * True only when an admin has actually set this field. Call sites whose
     * default copy is JSX rather than a plain string (brand name inline, a
     * line break, a link) render their own markup until then.
     */
    has: (key: string): boolean => Boolean(overrides[key]),
  };
}
