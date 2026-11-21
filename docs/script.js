/* WACRM Documentation Portal — v7.0.1 */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------- Theme ----------
     Three states rather than two: "system" follows the operating system and
     keeps following it, which a plain light/dark toggle cannot express once it
     has been clicked. Icons are Lucide, like the rest of the page. */
  const THEME_KEY = "docs-theme";
  const THEMES = [
    {
      mode: "system",
      label: "Theme: match system",
      icon: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    },
    {
      mode: "light",
      label: "Theme: light",
      icon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    },
    {
      mode: "dark",
      label: "Theme: dark",
      icon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
    },
  ];

  const themeBtn = $("#themeBtn");
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  let themeMode = "system";
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (THEMES.some((t) => t.mode === saved)) themeMode = saved;
  } catch {
    /* storage unavailable */
  }

  const applyTheme = () => {
    const entry = THEMES.find((t) => t.mode === themeMode) ?? THEMES[0];
    const resolved = entry.mode === "system" ? (darkQuery.matches ? "dark" : "light") : entry.mode;
    document.documentElement.setAttribute("data-theme", resolved);
    if (!themeBtn) return;
    themeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      entry.icon +
      "</svg>";
    themeBtn.title = entry.label;
    themeBtn.setAttribute("aria-label", entry.label + " (click to change)");
  };

  applyTheme();
  darkQuery.addEventListener("change", () => {
    if (themeMode === "system") applyTheme();
  });
  themeBtn?.addEventListener("click", () => {
    const i = THEMES.findIndex((t) => t.mode === themeMode);
    themeMode = THEMES[(i + 1) % THEMES.length].mode;
    try {
      localStorage.setItem(THEME_KEY, themeMode);
    } catch {
      /* storage unavailable */
    }
    applyTheme();
  });

  /* ---------- Mobile sidebar ---------- */
  const sidebar = $("#sidebar");
  const menuBtn = $("#menuBtn");
  const backdrop = $("#backdrop");
  const toggleSidebar = (open) => {
    const isOpen = open ?? !sidebar.classList.contains("mobile-open");
    sidebar.classList.toggle("mobile-open", isOpen);
    backdrop.classList.toggle("show", isOpen);
  };
  menuBtn?.addEventListener("click", () => toggleSidebar());
  backdrop?.addEventListener("click", () => toggleSidebar(false));
  sidebar?.addEventListener("click", (e) => {
    if (e.target.closest('a[href^="#"]') && window.innerWidth <= 780) toggleSidebar(false);
  });

  /* ---------- Sections & nav index ---------- */
  const contentRoot = $("#content");
  const sections = $$(".content section[id]");
  const navLinks = $$('.sidebar a[href^="#"]');
  const tocBox = $("#toc");

  /* ---------- Sidebar tree ----------
     Three levels: section -> sub-group -> topic, each level collapsed by
     default. The page carries ~80 topics; listing them all at once is what
     made the old sidebar unreadable, so only the branch being read is open.
     The group name moves onto data-group because the headings gain markup. */
  const navSecs = $$(".nav-sec", sidebar);
  const navGroups = $$(".nav-group", sidebar);
  const BRANCH_KEY = "docs-nav-branch";

  /* Lucide icon per section, copied from the set the app itself draws
     (lucide-react, ISC). Inline because this page has no bundler. */
  const NAV_ICONS = {
    "Get started":
      '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"/><path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"/>',
    "Set up & deploy":
      '<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>',
    Channels:
      '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>',
    Customize:
      '<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>',
    Administer:
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    Help: '<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/><circle cx="12" cy="12" r="4"/>',
    "Developer reference": '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  };
  const iconSvg = (name) =>
    NAV_ICONS[name]
      ? '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        NAV_ICONS[name] +
        "</svg>"
      : "";

  const headButton = (cls, name, count, controls) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.setAttribute("aria-expanded", "false");
    if (controls) btn.setAttribute("aria-controls", controls);
    btn.innerHTML =
      '<span class="nav-chevron" aria-hidden="true"></span>' +
      (cls === "nav-sec-head" ? iconSvg(name) : "") +
      '<span class="nav-head-title"></span>' +
      '<span class="nav-count"></span>';
    btn.querySelector(".nav-head-title").textContent = name;
    btn.querySelector(".nav-count").textContent = count;
    return btn;
  };

  navSecs.forEach((sec, si) => {
    const groups = $$(".nav-group", sec);
    const h3 = sec.querySelector("h3");
    const name = h3 ? h3.textContent.trim() : "";
    sec.dataset.sec = name;
    sec.id = "nav-sec-" + si;
    /* A section with one sub-group needs no middle row: its topics sit
       directly under the section heading. */
    if (groups.length === 1) sec.classList.add("flat");

    groups.forEach((group, gi) => {
      const h4 = group.querySelector("h4");
      if (!h4) return;
      group.dataset.group = h4.textContent.trim();
      const list = group.querySelector("ul");
      const listId = `nav-list-${si}-${gi}`;
      if (list) list.id = listId;
      const count = list ? $$("li", list).length : 0;
      h4.textContent = "";
      h4.appendChild(headButton("nav-group-head", group.dataset.group, count, listId));
    });

    if (h3) {
      const total = $$('a[href^="#"]', sec).length;
      h3.textContent = "";
      h3.appendChild(headButton("nav-sec-head", name, total, sec.id));
    }
  });

  const setOpen = (el, open) => {
    el.classList.toggle("open", open);
    el.querySelector(":scope > h3 > .nav-sec-head, :scope > h4 > .nav-group-head")?.setAttribute(
      "aria-expanded",
      String(open),
    );
  };
  /* One open branch per level keeps the whole menu inside one screen. */
  const openSection = (sec) => navSecs.forEach((s) => setOpen(s, s === sec));
  const openGroup = (group) => {
    const sec = group.closest(".nav-sec");
    $$(".nav-group", sec).forEach((g) => setOpen(g, g === group));
  };

  sidebar?.addEventListener("click", (e) => {
    const secHead = e.target.closest(".nav-sec-head");
    if (secHead) {
      const sec = secHead.closest(".nav-sec");
      const willOpen = !sec.classList.contains("open");
      if (willOpen) {
        openSection(sec);
        /* Opening a section shows its sub-groups; a flat one shows its topics. */
        const groups = $$(".nav-group", sec);
        if (groups.length === 1) setOpen(groups[0], true);
      } else {
        setOpen(sec, false);
      }
      remember(willOpen ? sec : null, null);
      return;
    }
    const groupHead = e.target.closest(".nav-group-head");
    if (groupHead) {
      const group = groupHead.closest(".nav-group");
      const willOpen = !group.classList.contains("open");
      if (willOpen) openGroup(group);
      else setOpen(group, false);
      remember(group.closest(".nav-sec"), willOpen ? group : null);
    }
  });

  const remember = (sec, group) => {
    try {
      localStorage.setItem(
        BRANCH_KEY,
        JSON.stringify({
          sec: sec?.dataset.sec ?? "",
          group: group?.dataset.group ?? "",
        }),
      );
    } catch {
      /* storage unavailable */
    }
  };

  const linkFor = (id) => navLinks.find((a) => a.getAttribute("href") === "#" + id);
  const groupElFor = (id) => linkFor(id)?.closest(".nav-group") ?? null;

  const titleFor = (id) => {
    const link = linkFor(id);
    if (link) return link.textContent.trim();
    const el = document.getElementById(id);
    const h = el && el.querySelector("h1, h2, h3");
    return h ? h.textContent.trim() : id;
  };

  const topics = sections.map((s, i) => {
    const group = groupElFor(s.id);
    return {
      id: s.id,
      el: s,
      index: i,
      title: titleFor(s.id),
      group: group?.dataset.group ?? "",
      section: group?.closest(".nav-sec")?.dataset.sec ?? "",
    };
  });
  const indexById = new Map(topics.map((t) => [t.id, t.index]));
  const linkById = new Map(navLinks.map((a) => [a.getAttribute("href").slice(1), a]));

  /* Reveal the branch holding a topic, so the active link is never buried in
     a collapsed group. */
  const revealTopic = (id) => {
    const group = groupElFor(id);
    if (!group) return;
    const sec = group.closest(".nav-sec");
    if (sec && !sec.classList.contains("open")) openSection(sec);
    if (!group.classList.contains("open")) openGroup(group);
  };

  const setActive = (id) => {
    navLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + id));
    revealTopic(id);
  };

  /* ---------- Pager UI ---------- */
  const pager = document.createElement("nav");
  pager.className = "pager";
  pager.setAttribute("aria-label", "Topic pagination");
  pager.innerHTML = `
    <div class="pager-progress"><span id="pagerBar"></span></div>
    <div class="pager-meta">
      <span id="pagerCount"></span>
      <span class="pager-hint">Use <kbd>←</kbd> <kbd>→</kbd> to move between topics</span>
    </div>
    <div class="pager-links">
      <a class="pager-link prev" id="pagerPrev" href="#">
        <span class="pager-dir">← Previous</span>
        <span class="pager-title"></span>
      </a>
      <a class="pager-link next" id="pagerNext" href="#">
        <span class="pager-dir">Next →</span>
        <span class="pager-title"></span>
      </a>
    </div>
    <button class="pager-top" id="pagerTop" type="button">↑ Back to top</button>
  `;
  const contentFooter = contentRoot.querySelector("footer, .footer");
  if (contentFooter) contentRoot.insertBefore(pager, contentFooter);
  else contentRoot.appendChild(pager);

  const pagerPrev = $("#pagerPrev");
  const pagerNext = $("#pagerNext");
  const pagerCount = $("#pagerCount");
  const pagerBar = $("#pagerBar");
  $("#pagerTop").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  let current = 0;
  let searching = false;

  const renderPager = () => {
    const prev = topics[current - 1];
    const next = topics[current + 1];
    const fill = (el, topic) => {
      if (!topic) {
        el.classList.add("disabled");
        el.removeAttribute("href");
        el.querySelector(".pager-title").textContent = "—";
        return;
      }
      el.classList.remove("disabled");
      el.setAttribute("href", "#" + topic.id);
      el.querySelector(".pager-title").textContent = topic.title;
    };
    fill(pagerPrev, prev);
    fill(pagerNext, next);
    const trail = [topics[current].section, topics[current].group]
      .filter((v, i, a) => v && a.indexOf(v) === i)
      .join(" › ");
    pagerCount.textContent = `${trail ? trail + " · " : ""}topic ${current + 1} of ${topics.length}`;
    pagerBar.style.width = (((current + 1) / topics.length) * 100).toFixed(2) + "%";
  };

  /* ---------- Lazy topic content ---------- */
  /* Every topic's markup is parked in memory at boot and only mounted into the
     DOM when it is shown (or prefetched), keeping the live document small. */
  const rawHTML = new Map();
  const textIndex = new Map();
  const mounted = new Set();

  topics.forEach((t) => {
    rawHTML.set(t.id, t.el.innerHTML);
    textIndex.set(t.id, t.el.textContent.toLowerCase());
    t.el.innerHTML = "";
  });

  const idle =
    window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 200));

  const prepMedia = (root) => {
    $$("img", root).forEach((img) => {
      if (!img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
      if (!img.hasAttribute("decoding")) img.setAttribute("decoding", "async");
    });
    $$("iframe", root).forEach((f) => {
      if (!f.hasAttribute("loading")) f.setAttribute("loading", "lazy");
    });
  };

  const highlight = (root) => {
    if (!window.hljs) return;
    $$("pre code", root).forEach((b) => {
      if (!b.dataset.highlighted) window.hljs.highlightElement(b);
    });
  };

  /* Headings need ids before the right-hand column can link to them. */
  const slug = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
  const idHeadings = (t) => {
    const used = new Set();
    $$("h2, h3", t.el).forEach((h, i) => {
      if (!h.id) {
        let base = `${t.id}--${slug(h.textContent) || "section"}`;
        while (used.has(base) || document.getElementById(base)) base += "-" + i;
        h.id = base;
      }
      used.add(h.id);
    });
  };

  const mountTopic = (t, opts = {}) => {
    if (!t || mounted.has(t.id)) return;
    t.el.innerHTML = rawHTML.get(t.id) || "";
    mounted.add(t.id);
    prepMedia(t.el);
    idHeadings(t);
    if (opts.highlight !== false) highlight(t.el);
  };

  const unmountTopic = (t) => {
    if (!t || !mounted.has(t.id)) return;
    t.el.innerHTML = "";
    mounted.delete(t.id);
  };

  /* Keep a small window of mounted topics around the current one */
  const MOUNT_BUDGET = 6;
  const trimMounted = (keepIds) => {
    if (mounted.size <= MOUNT_BUDGET) return;
    for (const id of Array.from(mounted)) {
      if (mounted.size <= MOUNT_BUDGET) break;
      if (keepIds.has(id)) continue;
      unmountTopic(topics[indexById.get(id)]);
    }
  };

  /* Prefetch the neighbours so Prev/Next paints instantly */
  const prefetchNeighbours = () => {
    const next = topics[current + 1];
    const prev = topics[current - 1];
    const keep = new Set([topics[current].id, next?.id, prev?.id].filter(Boolean));
    idle(() => {
      mountTopic(next);
      idle(() => {
        mountTopic(prev);
        trimMounted(keep);
      });
    });
  };

  /* ---------- Right column (follows the open topic) ----------
     It used to be a fixed list of links, which told a reader nothing about
     where they already were. Now it is built from the topic on screen: its
     own headings, its siblings in the same group, and the next topic. */
  let tocHeadingLinks = [];

  const renderToc = () => {
    if (!tocBox) return;
    const t = topics[current];
    tocBox.innerHTML = "";
    tocHeadingLinks = [];

    const block = (label) => {
      const h5 = document.createElement("h5");
      h5.textContent = label;
      tocBox.appendChild(h5);
      const ul = document.createElement("ul");
      tocBox.appendChild(ul);
      return ul;
    };
    const item = (ul, href, text, cls) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = href;
      a.textContent = text;
      if (cls) a.className = cls;
      li.appendChild(a);
      ul.appendChild(li);
      return a;
    };

    const headings = $$("h2, h3", t.el).filter((h) => h.textContent.trim());
    if (headings.length > 1) {
      const ul = block("On this page");
      headings.forEach((h) => {
        const a = item(ul, "#" + h.id, h.textContent.trim(), h.tagName === "H3" ? "sub" : "");
        tocHeadingLinks.push({ a, el: h });
      });
    }

    const group = groupElFor(t.id);
    const siblings = group
      ? $$('a[href^="#"]', group).filter((a) => a.getAttribute("href") !== "#" + t.id)
      : [];
    if (siblings.length) {
      const ul = block(t.group ? `More in ${t.group}` : "Related");
      siblings.slice(0, 10).forEach((a) => item(ul, a.getAttribute("href"), a.textContent.trim()));
    }

    const next = topics[current + 1];
    if (next) {
      const ul = block("Next");
      item(ul, "#" + next.id, next.title, "toc-next");
    }
  };

  /* Mark the heading being read, so the right column shows reading position. */
  let tocTick = 0;
  const syncTocActive = () => {
    if (!tocHeadingLinks.length) return;
    const line = window.scrollY + 120;
    let active = tocHeadingLinks[0];
    for (const entry of tocHeadingLinks) {
      if (entry.el.offsetTop <= line) active = entry;
      else break;
    }
    tocHeadingLinks.forEach((e) => e.a.classList.toggle("active", e === active));
  };
  window.addEventListener(
    "scroll",
    () => {
      if (tocTick) return;
      tocTick = requestAnimationFrame(() => {
        tocTick = 0;
        syncTocActive();
      });
    },
    { passive: true },
  );

  const showTopic = (idOrIndex, opts = {}) => {
    const idx = typeof idOrIndex === "number" ? idOrIndex : indexById.get(idOrIndex);
    if (idx == null || idx < 0 || idx >= topics.length) return;
    current = idx;
    mountTopic(topics[idx]);
    topics.forEach((t, i) => t.el.classList.toggle("pg-hidden", i !== idx));
    pager.classList.remove("hidden");
    tocBox?.classList.remove("hidden");
    setActive(topics[idx].id);
    renderPager();
    renderToc();
    document.title = `${topics[idx].title} — WACRM Docs v7.0.1`;
    if (opts.scroll !== false)
      window.scrollTo({ top: 0, behavior: opts.smooth === false ? "auto" : "smooth" });
    prefetchNeighbours();
  };

  /* Sidebar / TOC / pager clicks stay on-page */
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || a.classList.contains("disabled")) return;
    const id = a.getAttribute("href").slice(1);
    if (!indexById.has(id)) return;
    e.preventDefault();
    if (searching && $("#search")) {
      $("#search").value = "";
      runSearch("");
    }
    history.replaceState(null, "", "#" + id);
    showTopic(id);
  });

  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (indexById.has(id)) showTopic(id);
  });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey
    )
      return;
    if (searching) return;
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const target = e.key === "ArrowRight" ? topics[current + 1] : topics[current - 1];
    if (!target) return;
    history.replaceState(null, "", "#" + target.id);
    showTopic(target.index);
  });

  /* ---------- Search ----------
     This replaces the old group/tag filter box: one field, and the sidebar
     narrows to the branches that hold a match, so the menu answers "where
     does this live?" at the same time as the results answer "what is it?". */
  const searchInput = $("#search");
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const clearNavFilter = () => {
    $$("li", sidebar).forEach((li) => li.classList.remove("nav-hidden"));
    navGroups.forEach((g) => {
      g.classList.remove("nav-hidden");
      const n = $$("li", g).length;
      const c = g.querySelector(".nav-count");
      if (c) c.textContent = n;
    });
    navSecs.forEach((s) => {
      s.classList.remove("nav-hidden");
      const c = s.querySelector(".nav-sec-head .nav-count");
      if (c) c.textContent = $$('a[href^="#"]', s).length;
    });
  };

  function runSearch(q) {
    const query = q.trim();
    if (!query) {
      searching = false;
      // Drop search-rendered markup; topics remount lazily on demand.
      topics.forEach((t) => {
        t.el.classList.remove("hidden");
        if (mounted.has(t.id)) {
          t.el.innerHTML = "";
          mounted.delete(t.id);
        }
      });
      clearNavFilter();
      showTopic(current, { scroll: false });
      $("#searchEmpty")?.classList.add("hidden");
      return;
    }
    searching = true;
    pager.classList.add("hidden");
    tocBox?.classList.add("hidden");
    const re = new RegExp(escapeRegex(query), "gi");
    const needle = query.toLowerCase();
    let matches = 0;
    topics.forEach((t) => {
      const s = t.el;
      const hit = (textIndex.get(t.id) || "").includes(needle);
      linkById.get(t.id)?.closest("li")?.classList.toggle("nav-hidden", !hit);
      if (!hit) {
        s.classList.add("hidden");
        unmountTopic(t);
        return;
      }
      s.classList.remove("hidden");
      s.classList.remove("pg-hidden");
      // Re-render from the pristine copy so previous highlights don't stack
      s.innerHTML = rawHTML.get(t.id) || "";
      mounted.add(t.id);
      prepMedia(s);
      const walker = document.createTreeWalker(s, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest("pre, code, script, style")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const targets = [];
      while (walker.nextNode()) targets.push(walker.currentNode);
      targets.forEach((node) => {
        if (!re.test(node.nodeValue)) return;
        re.lastIndex = 0;
        const span = document.createElement("span");
        span.innerHTML = node.nodeValue.replace(re, (m) => `<mark>${m}</mark>`);
        node.parentNode.replaceChild(span, node);
      });
      matches++;
    });

    /* Branches holding a hit open and count their hits; the rest collapse. */
    navGroups.forEach((g) => {
      const items = $$("li", g);
      const hits = items.filter((li) => !li.classList.contains("nav-hidden")).length;
      g.classList.toggle("nav-hidden", items.length > 0 && hits === 0);
      setOpen(g, hits > 0);
      const c = g.querySelector(".nav-count");
      if (c) c.textContent = hits || items.length;
    });
    navSecs.forEach((s) => {
      const hits = $$("li", s).filter((li) => !li.classList.contains("nav-hidden")).length;
      s.classList.toggle("nav-hidden", hits === 0);
      setOpen(s, hits > 0);
      const c = s.querySelector(".nav-sec-head .nav-count");
      if (c) c.textContent = hits || $$('a[href^="#"]', s).length;
    });

    $("#searchEmpty")?.classList.toggle("hidden", matches > 0);
  }

  let searchTimer;
  searchInput?.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 120);
  });
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      runSearch("");
      searchInput.blur();
    }
  });

  /* ---------- Hover / focus prefetch ---------- */
  const prefetchById = (id) => {
    const i = indexById.get(id);
    if (i != null) idle(() => mountTopic(topics[i]));
  };
  const hoverPrefetch = (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (a) prefetchById(a.getAttribute("href").slice(1));
  };
  document.addEventListener("pointerover", hoverPrefetch, { passive: true });
  document.addEventListener("focusin", hoverPrefetch);

  /* ---------- Boot ---------- */
  const startId = location.hash.slice(1);
  const hasStart = indexById.has(startId);
  if (!hasStart) {
    /* No deep link: reopen the branch last used, else the first section. */
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(BRANCH_KEY) || "null");
    } catch {
      /* ignore */
    }
    const sec = navSecs.find((s) => s.dataset.sec === saved?.sec) || navSecs[0];
    if (sec) {
      openSection(sec);
      const groups = $$(".nav-group", sec);
      const group =
        groups.find((g) => g.dataset.group === saved?.group) ||
        (groups.length === 1 ? groups[0] : null);
      if (group) setOpen(group, true);
    }
  }
  showTopic(hasStart ? startId : 0, { smooth: false });
})();
