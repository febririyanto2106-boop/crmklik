/**
 * Guards the documentation page's structure.
 *
 * `docs/index.html` shows one topic at a time and derives everything — the
 * topic list, each topic's group, the Previous/Next pager, the group filter —
 * from the sidebar markup. A link pointing at a section that no longer exists,
 * or a section with no link, silently drops a page out of the navigation
 * without breaking anything visibly. This checks the invariants instead.
 *
 *   node scripts/check-docs-nav.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

const PAGE = "docs/index.html";
const html = fs.readFileSync(PAGE, "utf8");

const parseErrors = [];
const virtualConsole = new VirtualConsole().on("jsdomError", (e) => parseErrors.push(String(e)));
const doc = new JSDOM(html, { virtualConsole }).window.document;

const sections = [...doc.querySelectorAll(".content section[id]")];
const navLinks = [...doc.querySelectorAll(".sidebar a[href^='#']")];
const groups = [...doc.querySelectorAll(".sidebar .nav-group")];
const navSections = [...doc.querySelectorAll(".sidebar .nav-sec")];

const ids = new Set([...doc.querySelectorAll("[id]")].map((e) => e.id));
const dangling = [
  ...new Set(
    [...doc.querySelectorAll("a[href^='#']")]
      .map((a) => a.getAttribute("href").slice(1))
      .filter((id) => id && !ids.has(id)),
  ),
];

// Relative links point at files that ship next to the page; a rename leaves
// them pointing nowhere, and nothing in the browser complains.
const docsDir = path.dirname(PAGE);
const relative = [
  ...new Set(
    [...doc.querySelectorAll("a[href], link[href], script[src]")]
      .map((e) => e.getAttribute("href") ?? e.getAttribute("src"))
      .filter((href) => href && !/^(#|[a-z]+:|\/\/|\/)/i.test(href))
      .map((href) => href.split(/[?#]/)[0])
      .filter(Boolean),
  ),
].filter((href) => !fs.existsSync(path.join(docsDir, href)));

const navOrder = navLinks.map((a) => a.getAttribute("href").slice(1));
const docOrder = sections.map((s) => s.id);

const noLink = docOrder.filter((id) => !navOrder.includes(id));
const noSection = navOrder.filter((id) => !docOrder.includes(id));
const duplicateLinks = navOrder.filter((id, i) => navOrder.indexOf(id) !== i);

// The group label comes from the <h4>; two groups sharing one makes the filter
// ambiguous and the sidebar unreadable.
const groupNames = groups.map((g) => g.querySelector("h4")?.textContent.trim() ?? "");
const duplicateGroups = groupNames.filter((g, i) => groupNames.indexOf(g) !== i);

// The sidebar is a three-level tree: .nav-sec > .nav-group > li > a. The
// script builds the accordion from exactly that shape, so a group outside a
// section, or a section without its <h3>, silently loses its toggle.
const orphanGroups = groups.filter((g) => !g.closest(".nav-sec")).length;
const sectionNames = navSections.map((s) => s.querySelector(":scope > h3")?.textContent.trim() ?? "");
const namelessSections = sectionNames.filter((n) => !n).length;
const duplicateSections = sectionNames.filter((n, i) => n && sectionNames.indexOf(n) !== i);
const emptySections = navSections.filter((s) => !s.querySelector(".nav-group")).length;

// A section with no heading shows up in the pager as a raw id.
const headingless = sections.filter((s) => !s.querySelector("h1,h2,h3")).map((s) => s.id);

// Document order is the reading order the pager hands the visitor, so it has
// to agree with the order the menu promises.
const orderMatches = navOrder.join(",") === docOrder.join(",");

const problems = [];
if (parseErrors.length) problems.push(`HTML parse errors: ${parseErrors.join("; ")}`);
if (dangling.length) problems.push(`links to missing ids: ${dangling.join(", ")}`);
if (noSection.length) problems.push(`nav links with no section: ${noSection.join(", ")}`);
if (noLink.length) problems.push(`sections missing from the nav: ${noLink.join(", ")}`);
if (duplicateLinks.length) problems.push(`duplicate nav links: ${duplicateLinks.join(", ")}`);
if (duplicateGroups.length) problems.push(`duplicate group names: ${duplicateGroups.join(", ")}`);
if (headingless.length) problems.push(`sections with no heading: ${headingless.join(", ")}`);
if (!orderMatches) problems.push("sidebar order does not match document order");
if (relative.length) problems.push(`links to missing files: ${relative.join(", ")}`);
if (orphanGroups) problems.push(`${orphanGroups} nav group(s) outside a .nav-sec`);
if (namelessSections) problems.push(`${namelessSections} nav section(s) with no <h3> heading`);
if (emptySections) problems.push(`${emptySections} nav section(s) with no group`);
if (duplicateSections.length) problems.push(`duplicate section names: ${duplicateSections.join(", ")}`);

console.log(
  `${PAGE}: ${sections.length} topics in ${groups.length} groups across ${navSections.length} menu sections, ` +
    `${doc.querySelectorAll("pre code").length} code blocks, ` +
    `${doc.querySelectorAll("table.tbl").length} tables, ` +
    `${doc.querySelectorAll(".callout").length} callouts.`,
);

if (problems.length) {
  console.error("\nDocumentation navigation problems:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log("Navigation is consistent.");
}
