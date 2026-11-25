(() => {
  "use strict";

  const DATA = window.GLOSSARY_DATA;
  if (!DATA || !Array.isArray(DATA.entries)) {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:sans-serif">データ（data/glossary-data.js）の読み込みに失敗しました。</div>';
    return;
  }

  // =========================================================================
  // 1. Normalization & Smart Real-Time Search Engine
  // =========================================================================

  function normalizeText(str) {
    if (!str) return "";
    const nfkc = str.normalize("NFKC").toLowerCase();
    let out = "";
    for (let i = 0; i < nfkc.length; i++) {
      const code = nfkc.charCodeAt(i);
      if (code >= 0x30a1 && code <= 0x30f6) {
        out += String.fromCharCode(code - 0x60);
      } else {
        out += nfkc[i];
      }
    }
    return out;
  }

  function tokenizeQuery(rawQuery) {
    const norm = normalizeText(rawQuery).trim();
    if (!norm) return [];
    return norm.split(/[\s\u3000]+/).filter(Boolean);
  }

  function stripMarkdown(md) {
    return md
      .replace(/\$\$[\s\S]*?\$\$/g, " [数式] ")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\s*\n\s*-\s+/g, " / ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Pre-index all 721 entries once at startup (< 10ms)
  const INDEXED_ENTRIES = DATA.entries.map((entry) => {
    const normTitle = normalizeText(entry.title);
    const normAliases = entry.aliases.map((a) => normalizeText(a));
    const normHeading = normalizeText(entry.heading);
    const normKeywords = entry.keywords.map((k) => normalizeText(k));
    const normDef = normalizeText(entry.definition);
    const normFeat = normalizeText(entry.features);
    const normRel = normalizeText(entry.related);
    const normPit = normalizeText(entry.pitfalls);

    const headingWordTokens = [normTitle, ...normAliases]
      .flatMap((t) => t.split(/[\s\-_/・：:()（）,、]+/))
      .filter(Boolean);

    return {
      ...entry,
      plainDef: stripMarkdown(entry.definition),
      _norm: {
        title: normTitle,
        aliases: normAliases,
        heading: normHeading,
        headingWords: headingWordTokens,
        keywords: normKeywords,
        def: normDef,
        feat: normFeat,
        rel: normRel,
        pit: normPit,
      },
    };
  });

  const INDEXED_APPENDIX = DATA.appendix.map((row) => ({
    ...row,
    _normAll: normalizeText(`${row.theme} ${row.termA} ${row.termB} ${row.termC}`),
  }));

  /**
   * Multi-tier real-time relevance scorer (C -> CN -> CNN)
   */
  function scoreEntry(entry, tokens, scope) {
    if (tokens.length === 0) {
      return { matched: true, score: 0, tier: "none", matchField: null };
    }

    const n = entry._norm;
    let totalScore = 0;
    let bestTier = "body";
    const tierOrder = { exact: 6, prefix: 5, heading: 4, kw: 3, trap: 2, body: 1 };
    let bestField = null;

    for (const tok of tokens) {
      let tokScore = 0;
      let tokTier = null;
      let tokField = null;

      const checkHeading = scope === "all" || scope === "heading";
      const checkKeywords = scope === "all" || scope === "keywords";
      const checkPitfalls = scope === "all" || scope === "pitfalls";
      const checkBody = scope === "all";

      if (checkHeading) {
        if (n.title === tok || n.aliases.includes(tok)) {
          tokScore = Math.max(tokScore, 10000);
          tokTier = "exact";
          tokField = "heading";
        } else if (n.title.startsWith(tok)) {
          tokScore = Math.max(tokScore, 7500);
          tokTier = "prefix";
          tokField = "heading";
        } else if (n.aliases.some((a) => a.startsWith(tok))) {
          tokScore = Math.max(tokScore, 6800);
          tokTier = "prefix";
          tokField = "heading";
        } else if (n.headingWords.some((w) => w === tok)) {
          tokScore = Math.max(tokScore, 6000);
          tokTier = "heading";
          tokField = "heading";
        } else if (n.headingWords.some((w) => w.startsWith(tok))) {
          tokScore = Math.max(tokScore, 5000);
          tokTier = "heading";
          tokField = "heading";
        } else if (n.heading.includes(tok)) {
          tokScore = Math.max(tokScore, 3200);
          tokTier = "heading";
          tokField = "heading";
        }
      }

      if (checkKeywords) {
        let kwHits = 0;
        let kwStarts = false;
        for (const kw of n.keywords) {
          if (kw.includes(tok)) {
            kwHits++;
            if (kw.startsWith(tok)) kwStarts = true;
          }
        }
        if (kwHits > 0) {
          const s = (kwStarts ? 2400 : 1900) + Math.min(kwHits, 4) * 180;
          if (s > tokScore) {
            tokScore = s;
            tokTier = "kw";
            tokField = "keywords";
          } else {
            tokScore += 200;
          }
        }
      }

      if (checkPitfalls && n.pit.includes(tok)) {
        const s = scope === "pitfalls" ? 2500 : 1100;
        if (s > tokScore) {
          tokScore = s;
          tokTier = "trap";
          tokField = "pitfalls";
        } else {
          tokScore += 60;
        }
      }

      if (checkBody) {
        if (n.def.includes(tok)) {
          const s = 1250;
          if (s > tokScore) {
            tokScore = s;
            tokTier = "body";
            tokField = "definition";
          } else {
            tokScore += 80;
          }
        } else if (n.feat.includes(tok)) {
          const s = 1050;
          if (s > tokScore) {
            tokScore = s;
            tokTier = "body";
            tokField = "features";
          } else {
            tokScore += 50;
          }
        } else if (n.rel.includes(tok)) {
          const s = 950;
          if (s > tokScore) {
            tokScore = s;
            tokTier = "body";
            tokField = "related";
          } else {
            tokScore += 40;
          }
        }
      }

      if (tokScore === 0) {
        return { matched: false, score: 0, tier: "none", matchField: null };
      }

      totalScore += tokScore;
      if (bestField === null || tierOrder[tokTier] > tierOrder[bestTier]) {
        bestTier = tokTier;
        bestField = tokField;
      }
    }

    totalScore += Math.max(0, 40 - entry.title.length);
    return { matched: true, score: totalScore, tier: bestTier, matchField: bestField };
  }

  // =========================================================================
  // 2. Highlighting, Markdown & KaTeX Safe Renderer
  // =========================================================================

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlightPlainText(rawText, tokens) {
    if (!rawText) return "";
    if (!tokens || tokens.length === 0) return escapeHtml(rawText);

    let normStr = "";
    const normToSrc = [];
    for (let i = 0; i < rawText.length; i++) {
      const chNorm = normalizeText(rawText[i]);
      for (let j = 0; j < chNorm.length; j++) {
        normStr += chNorm[j];
        normToSrc.push(i);
      }
    }

    const mask = new Uint8Array(rawText.length);
    for (const tok of tokens) {
      if (!tok) continue;
      let pos = 0;
      while ((pos = normStr.indexOf(tok, pos)) !== -1) {
        const startSrc = normToSrc[pos];
        const endSrc = normToSrc[pos + tok.length - 1];
        for (let k = startSrc; k <= endSrc; k++) {
          mask[k] = 1;
        }
        pos += tok.length;
      }
    }

    let html = "";
    let inMark = false;
    let buf = "";
    for (let i = 0; i < rawText.length; i++) {
      const want = mask[i] === 1;
      if (want !== inMark) {
        if (buf) {
          html += inMark ? `<mark class="hl">${escapeHtml(buf)}</mark>` : escapeHtml(buf);
          buf = "";
        }
        inMark = want;
      }
      buf += rawText[i];
    }
    if (buf) {
      html += inMark ? `<mark class="hl">${escapeHtml(buf)}</mark>` : escapeHtml(buf);
    }
    return html;
  }

  function renderLatex(expr, displayMode) {
    if (window.katex && typeof window.katex.renderToString === "function") {
      try {
        return window.katex.renderToString(expr.trim(), {
          displayMode,
          throwOnError: false,
          strict: false,
        });
      } catch (_) {}
    }
    return `<code class="inline-code">${escapeHtml(expr.trim())}</code>`;
  }

  function renderInlineRich(rawLine, tokens) {
    const placeholders = [];
    const stash = (html) => {
      const idx = placeholders.length;
      placeholders.push(html);
      return `\u0000P${idx}\u0000`;
    };

    let s = rawLine;

    s = s.replace(/`([^`]+)`/g, (_, code) =>
      stash(`<code class="inline-code">${highlightPlainText(code, tokens)}</code>`)
    );
    s = s.replace(/\\\$/g, () => stash("$"));
    s = s.replace(/\$([^$\n]+?)\$/g, (_, expr) => stash(renderLatex(expr, false)));
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_, inner) => {
      const renderedInner = inner.replace(/([^\u0000]+)|(\u0000P\d+\u0000)/g, (m, txt, ph) =>
        ph ? ph : highlightPlainText(txt, tokens)
      );
      return stash(`<strong>${renderedInner}</strong>`);
    });
    s = s.replace(/([^\u0000]+)|(\u0000P\d+\u0000)/g, (m, txt, ph) =>
      ph ? ph : highlightPlainText(txt, tokens)
    );

    for (let pass = 0; pass < 3 && s.includes("\u0000P"); pass++) {
      s = s.replace(/\u0000P(\d+)\u0000/g, (_, i) => placeholders[Number(i)]);
    }

    return s;
  }

  function renderMarkdownRich(rawText, tokens) {
    if (!rawText) return "";

    const displayBlocks = [];
    let text = rawText.replace(/\$\$([\s\S]*?)\$\$/g, (_, expr) => {
      const idx = displayBlocks.length;
      displayBlocks.push(`<div class="math-block">${renderLatex(expr, true)}</div>`);
      return `\n__MATHBLOCK_${idx}__\n`;
    });

    const lines = text.split("\n");
    const out = [];
    let listItems = [];

    const flushList = () => {
      if (listItems.length > 0) {
        out.push(`<ul class="sub-list">${listItems.join("")}</ul>`);
        listItems = [];
      }
    };

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        flushList();
        continue;
      }
      const mb = trimmed.match(/^__MATHBLOCK_(\d+)__$/);
      if (mb) {
        flushList();
        out.push(displayBlocks[Number(mb[1])]);
        continue;
      }
      const li = rawLine.match(/^\s*-\s+(.+)$/);
      if (li) {
        listItems.push(`<li>${renderInlineRich(li[1], tokens)}</li>`);
      } else {
        flushList();
        out.push(`<p>${renderInlineRich(trimmed, tokens)}</p>`);
      }
    }
    flushList();
    return out.join("");
  }

  function extractSnippet(rawField, tokens) {
    const plain = stripMarkdown(rawField);
    if (!tokens.length) return plain.slice(0, 120);
    const norm = normalizeText(plain);
    let idx = -1;
    for (const t of tokens) {
      const p = norm.indexOf(t);
      if (p !== -1 && (idx === -1 || p < idx)) idx = p;
    }
    if (idx === -1) return plain.slice(0, 120);
    let start = Math.max(0, idx - 28);
    let end = Math.min(plain.length, idx + 84);

    // Keep inline $...$ intact
    const mathRe = /\$([^$\n]+?)\$/g;
    let m;
    while ((m = mathRe.exec(plain)) !== null) {
      const ms = m.index;
      const me = m.index + m[0].length;
      if (start > ms && start < me) start = ms;
      if (end > ms && end < me) end = me;
    }

    return (start > 0 ? "…" : "") + plain.slice(start, end) + (end < plain.length ? "…" : "");
  }

  // =========================================================================
  // 3. Persistent State
  // =========================================================================

  const STORAGE_KEY = "gkentei_glossary_app_v2";
  const LEGACY_KEY = "gkentei_glossary_app_v1";

  function loadStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return {};
  }

  const saved = loadStorage();
  const validLayouts = new Set(["list", "compact", "detail"]);

  const state = {
    view: "glossary",
    query: "",
    tokens: [],
    scope: "all",
    status: "all",
    chapterId: 0,
    sort: "relevance",
    layout: validLayouts.has(saved.layout) ? saved.layout : "list",
    studyMode: Boolean(saved.studyMode),
    theme: saved.theme === "dark" ? "dark" : "light",
    bookmarks: new Set(Array.isArray(saved.bookmarks) ? saved.bookmarks : []),
    mastered: new Set(Array.isArray(saved.mastered) ? saved.mastered : []),
    results: [],
    renderedCount: 0,
    modalIndex: -1,
  };

  const PAGE_SIZE = 100;

  function persistState() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          theme: state.theme,
          layout: state.layout,
          studyMode: state.studyMode,
          bookmarks: [...state.bookmarks],
          mastered: [...state.mastered],
        })
      );
    } catch (_) {}
  }

  // =========================================================================
  // 4. DOM References
  // =========================================================================

  const $ = (id) => document.getElementById(id);

  const els = {
    metaBadge: $("metaBadge"),
    tabGlossary: $("tabGlossary"),
    tabAppendix: $("tabAppendix"),
    tabGlossaryCount: $("tabGlossaryCount"),
    tabAppendixCount: $("tabAppendixCount"),
    masteredStat: $("masteredStat"),
    masteredBar: $("masteredBar"),
    studyModeBtn: $("studyModeBtn"),
    themeToggleBtn: $("themeToggleBtn"),
    themeIcon: $("themeIcon"),

    searchInput: $("searchInput"),
    liveCountBadge: $("liveCountBadge"),
    clearSearchBtn: $("clearSearchBtn"),
    searchKbd: $("searchKbd"),
    quickQueries: $("quickQueries"),

    glossarySidebarFilters: $("glossarySidebarFilters"),
    appendixSidebarNote: $("appendixSidebarNote"),
    scopeGroup: $("scopeGroup"),
    statusGroup: $("statusGroup"),
    bookmarkCount: $("bookmarkCount"),
    chapterStrip: $("chapterStrip"),
    resetFiltersBtn: $("resetFiltersBtn"),

    glossaryView: $("glossaryView"),
    resultsSummary: $("resultsSummary"),
    sortSelect: $("sortSelect"),
    listColHeader: $("listColHeader"),
    cardsContainer: $("cardsContainer"),
    loadMoreWrap: $("loadMoreWrap"),
    loadMoreInfo: $("loadMoreInfo"),
    loadMoreBtn: $("loadMoreBtn"),
    loadAllBtn: $("loadAllBtn"),
    emptyState: $("emptyState"),
    emptyStateDesc: $("emptyStateDesc"),
    emptyResetBtn: $("emptyResetBtn"),

    appendixView: $("appendixView"),
    appendixSummary: $("appendixSummary"),
    appendixContainer: $("appendixContainer"),

    detailModal: $("detailModal"),
    modalChapter: $("modalChapter"),
    modalId: $("modalId"),
    modalMatchBadge: $("modalMatchBadge"),
    modalBookmarkBtn: $("modalBookmarkBtn"),
    modalMasteredBtn: $("modalMasteredBtn"),
    modalCopyBtn: $("modalCopyBtn"),
    modalCloseBtn: $("modalCloseBtn"),
    modalBody: $("modalBody"),
    modalTitle: $("modalTitle"),
    modalAliases: $("modalAliases"),
    modalKeywords: $("modalKeywords"),
    modalDefinition: $("modalDefinition"),
    modalFeatures: $("modalFeatures"),
    modalRelated: $("modalRelated"),
    modalPitfalls: $("modalPitfalls"),
    modalPrevBtn: $("modalPrevBtn"),
    modalNextBtn: $("modalNextBtn"),
    modalPosition: $("modalPosition"),

    toast: $("toast"),
    scrollTopBtn: $("scrollTopBtn"),
  };

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.hidden = true;
    }, 1800);
  }

  // =========================================================================
  // 5. Filtering, Counting & Rendering
  // =========================================================================

  const TIER_LABELS = {
    exact: { text: "完全一致", cls: "tier-exact" },
    prefix: { text: "前方一致", cls: "tier-exact" },
    heading: { text: "見出し", cls: "" },
    kw: { text: "キーワード", cls: "tier-kw" },
    trap: { text: "混同注意", cls: "tier-trap" },
    body: { text: "解説", cls: "" },
  };

  const FIELD_SNIPPET_LABEL = {
    definition: "定義",
    features: "特徴",
    related: "関連",
    pitfalls: "混同注意",
  };

  function updateStatsUI() {
    const total = INDEXED_ENTRIES.length;
    const mCount = state.mastered.size;
    els.masteredStat.textContent = `${mCount}/${total}`;
    els.masteredBar.style.width = `${Math.round((mCount / total) * 100)}%`;
    els.bookmarkCount.textContent = String(state.bookmarks.size);
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    els.themeIcon.textContent = state.theme === "dark" ? "☀️" : "🌙";
  }

  function applyStudyMode() {
    document.body.classList.toggle("study-mode", state.studyMode);
    els.studyModeBtn.classList.toggle("is-active", state.studyMode);
    els.studyModeBtn.setAttribute("aria-pressed", String(state.studyMode));
  }

  function applyLayout() {
    els.cardsContainer.classList.remove("layout-list", "layout-compact", "layout-detail");
    els.cardsContainer.classList.add(`layout-${state.layout}`);
    els.listColHeader.hidden = state.layout === "detail";
    document.querySelectorAll(".layout-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.layout === state.layout);
    });
  }

  function matchesStatus(entry) {
    if (state.status === "bookmarked") return state.bookmarks.has(entry.id);
    if (state.status === "mastered") return state.mastered.has(entry.id);
    if (state.status === "unmastered") return !state.mastered.has(entry.id);
    return true;
  }

  function getFilteredAppendix(tokens) {
    return tokens.length === 0
      ? INDEXED_APPENDIX
      : INDEXED_APPENDIX.filter((row) => tokens.every((t) => row._normAll.includes(t)));
  }

  function computeAndRender() {
    state.tokens = tokenizeQuery(state.query);
    const isGlossary = state.view === "glossary";
    const hasQuery = state.query.length > 0;
    els.clearSearchBtn.hidden = !hasQuery;
    els.searchKbd.hidden = hasQuery;
    els.quickQueries.hidden = !isGlossary || hasQuery;

    // Keep BOTH tab counts live-synced
    const appendixHits = getFilteredAppendix(state.tokens);
    els.tabAppendixCount.textContent = String(appendixHits.length);

    // 1. Score glossary entries
    const preChapter = [];
    const chapterCounts = new Map();
    for (const ch of DATA.chapters) chapterCounts.set(ch.id, 0);

    for (const entry of INDEXED_ENTRIES) {
      if (!matchesStatus(entry)) continue;
      const res = scoreEntry(entry, state.tokens, state.scope);
      if (!res.matched) continue;
      chapterCounts.set(entry.chapterId, (chapterCounts.get(entry.chapterId) || 0) + 1);
      preChapter.push({ entry, ...res });
    }

    // 2. Chapter filter
    let filtered =
      state.chapterId === 0
        ? preChapter
        : preChapter.filter((item) => item.entry.chapterId === state.chapterId);

    els.tabGlossaryCount.textContent = String(filtered.length);

    if (!isGlossary) {
      renderAppendix(appendixHits);
      return;
    }

    // 3. Sort
    if (state.sort === "relevance" && state.tokens.length > 0) {
      filtered.sort((a, b) => b.score - a.score || a.entry.id - b.entry.id);
    } else if (state.sort === "title") {
      filtered.sort((a, b) => a.entry.title.localeCompare(b.entry.title, "ja"));
    } else {
      filtered.sort((a, b) => a.entry.id - b.entry.id);
    }

    state.results = filtered;

    // 4. Update live counters & sidebar chapter list
    const hitCount = filtered.length;
    els.liveCountBadge.textContent = `${hitCount}語`;
    els.liveCountBadge.classList.toggle("is-zero", hitCount === 0);
    renderChapterList(preChapter.length, chapterCounts);

    const hasFilter =
      state.tokens.length > 0 || state.chapterId !== 0 || state.status !== "all" || state.scope !== "all";
    els.resetFiltersBtn.hidden = !hasFilter;

    // 5. Summary bar
    if (state.tokens.length > 0) {
      const headingHits = filtered.filter(
        (x) => x.tier === "exact" || x.tier === "prefix" || x.tier === "heading"
      ).length;
      const otherHits = hitCount - headingHits;
      els.resultsSummary.innerHTML =
        `<span class="summary-query">${escapeHtml(state.query.trim())}</span>` +
        `<strong>${hitCount}語</strong> が一致` +
        (state.scope === "all" && hitCount > 0
          ? `（見出し <strong>${headingHits}</strong> / キーワード・解説 <strong>${otherHits}</strong>）`
          : "");
    } else {
      const chObj = DATA.chapters.find((c) => c.id === state.chapterId);
      const chLabel = chObj ? `${chObj.short}：${chObj.subtitle}` : "全10章＋参考";
      els.resultsSummary.innerHTML = `${escapeHtml(chLabel)} — <strong>${hitCount}語</strong> / 全${INDEXED_ENTRIES.length}語（行クリックで詳細表示）`;
    }

    // 6. Render rows progressively
    els.cardsContainer.innerHTML = "";
    state.renderedCount = 0;

    if (hitCount === 0) {
      els.emptyState.hidden = false;
      els.loadMoreWrap.hidden = true;
      els.listColHeader.hidden = true;
      els.emptyStateDesc.textContent =
        state.tokens.length > 0
          ? `「${state.query.trim()}」に一致するワードはありませんでした。検索対象を「すべて」にするか、別の語句をお試しください。`
          : "現在のフィルタ条件に該当するワードがありません。";
      return;
    }

    els.emptyState.hidden = true;
    els.listColHeader.hidden = state.layout === "detail";
    renderNextPage(PAGE_SIZE);
  }

  function renderChapterList(totalAllChapters, chapterCounts) {
    const parts = [
      `<button type="button" class="chapter-row-btn${state.chapterId === 0 ? " is-active" : ""}" data-chapter="0">
         <span class="chapter-row-label"><span class="chapter-dot"></span><span class="chapter-row-name">全章（すべて）</span></span>
         <span class="chapter-row-count">${totalAllChapters}</span>
       </button>`,
    ];
    for (const ch of DATA.chapters) {
      const cnt = chapterCounts.get(ch.id) || 0;
      const active = state.chapterId === ch.id ? " is-active" : "";
      const zero = cnt === 0 ? " is-zero" : "";
      parts.push(
        `<button type="button" class="chapter-row-btn ch-${ch.id}${active}${zero}" data-chapter="${ch.id}" title="${escapeHtml(ch.full)}">
           <span class="chapter-row-label"><span class="chapter-dot"></span><span class="chapter-row-name">${escapeHtml(ch.short)} ${escapeHtml(ch.subtitle)}</span></span>
           <span class="chapter-row-count">${cnt}</span>
         </button>`
      );
    }
    els.chapterStrip.innerHTML = parts.join("");
  }

  function buildRowHtml(item, resultIdx) {
    const { entry, tier, matchField } = item;
    const tokens = state.tokens;
    const isBookmarked = state.bookmarks.has(entry.id);
    const isMastered = state.mastered.has(entry.id);

    const rowClasses = [
      "word-row",
      isMastered ? "is-mastered" : "",
      isBookmarked ? "is-bookmarked" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const tierInfo = tokens.length > 0 && TIER_LABELS[tier] ? TIER_LABELS[tier] : null;
    const tierBadge = tierInfo
      ? `<span class="match-tier-badge ${tierInfo.cls}">${tierInfo.text}</span>`
      : "";

    const kwHtml = entry.keywords
      .map(
        (kw) =>
          `<button type="button" class="kw-pill" data-kw="${escapeHtml(kw)}" title="「${escapeHtml(kw)}」で検索">${highlightPlainText(kw, tokens)}</button>`
      )
      .join("");

    const titleHtml = renderInlineRich(entry.title, tokens);
    const aliasHtml = entry.aliasRaw ? renderInlineRich(entry.aliasRaw, tokens) : "";

    // Full expanded inline detail layout
    if (state.layout === "detail") {
      return `
        <article class="${rowClasses}" data-index="${resultIdx}" data-id="${entry.id}">
          <div class="detail-row-head">
            <div class="detail-row-title-block">
              <div class="detail-row-meta">
                <span class="chapter-badge ch-${entry.chapterId}">${escapeHtml(entry.chapterShort)}：${escapeHtml(entry.chapterName)}</span>
                <span class="entry-id-tag">#${String(entry.id).padStart(3, "0")}</span>
                ${tierBadge}
              </div>
              <h3 class="detail-row-title">${titleHtml}</h3>
              ${aliasHtml ? `<p class="detail-row-aliases">${aliasHtml}</p>` : ""}
            </div>
            <div class="row-col-actions">
              <button type="button" class="mini-action-btn${isBookmarked ? " is-bookmarked" : ""}" data-action="bookmark" data-id="${entry.id}" title="要復習ブックマーク">${isBookmarked ? "★" : "☆"}</button>
              <button type="button" class="mini-action-btn${isMastered ? " is-mastered" : ""}" data-action="mastered" data-id="${entry.id}" title="習得済みチェック">${isMastered ? "✓" : "○"}</button>
            </div>
          </div>
          <div class="kw-pills detail-kw-wrap">${kwHtml}</div>
          <div class="detail-sections-grid">
            <div class="inline-section">
              <h4 class="inline-section-title"><span class="section-dot dot-def"></span>定義・意味</h4>
              <div class="rich-text">${renderMarkdownRich(entry.definition, tokens)}</div>
            </div>
            <div class="inline-section">
              <h4 class="inline-section-title"><span class="section-dot dot-feat"></span>主な特徴</h4>
              <div class="rich-text">${renderMarkdownRich(entry.features, tokens)}</div>
            </div>
            <div class="inline-section">
              <h4 class="inline-section-title"><span class="section-dot dot-rel"></span>関連ワード・試験ポイント</h4>
              <div class="rich-text">${renderMarkdownRich(entry.related, tokens)}</div>
            </div>
            <div class="inline-section is-pitfalls">
              <h4 class="inline-section-title"><span class="section-dot dot-trap"></span>よく間違いやすいポイント（混同注意）</h4>
              <div class="rich-text">${renderMarkdownRich(entry.pitfalls, tokens)}</div>
            </div>
          </div>
        </article>
      `;
    }

    // Dense index row ("list" & "compact")
    let snippetHtml = "";
    if (tokens.length > 0 && matchField && FIELD_SNIPPET_LABEL[matchField]) {
      const excerpt = extractSnippet(entry[matchField], tokens);
      const isTrap = matchField === "pitfalls";
      snippetHtml = `<div class="row-snippet${isTrap ? " is-trap" : ""}"><span class="snippet-label">${FIELD_SNIPPET_LABEL[matchField]}</span>${renderInlineRich(excerpt, tokens)}</div>`;
    }

    return `
      <article class="${rowClasses}" data-index="${resultIdx}" data-id="${entry.id}" tabindex="0">
        <div class="row-col-meta">
          <span class="chapter-badge ch-${entry.chapterId}">${escapeHtml(entry.chapterShort)}</span>
          <span class="entry-id-tag">#${String(entry.id).padStart(3, "0")}</span>
        </div>
        <div class="row-col-term">
          <div class="row-title-line">
            <h3 class="row-title">${titleHtml}</h3>
            ${tierBadge}
          </div>
          ${aliasHtml ? `<p class="row-aliases" title="${escapeHtml(entry.aliasRaw)}">${aliasHtml}</p>` : ""}
        </div>
        <div class="row-col-content">
          <div class="kw-pills">${kwHtml}</div>
          ${snippetHtml}
        </div>
        <div class="row-col-actions">
          <button type="button" class="mini-action-btn${isBookmarked ? " is-bookmarked" : ""}" data-action="bookmark" data-id="${entry.id}" title="要復習ブックマーク">${isBookmarked ? "★" : "☆"}</button>
          <button type="button" class="mini-action-btn${isMastered ? " is-mastered" : ""}" data-action="mastered" data-id="${entry.id}" title="習得済みチェック">${isMastered ? "✓" : "○"}</button>
          <span class="row-chevron" aria-hidden="true">›</span>
        </div>
      </article>
    `;
  }

  function renderNextPage(count) {
    const total = state.results.length;
    if (state.renderedCount >= total) {
      els.loadMoreWrap.hidden = true;
      return;
    }
    const end = Math.min(total, state.renderedCount + count);
    const fragHtml = [];
    for (let i = state.renderedCount; i < end; i++) {
      fragHtml.push(buildRowHtml(state.results[i], i));
    }
    els.cardsContainer.insertAdjacentHTML("beforeend", fragHtml.join(""));
    state.renderedCount = end;

    if (state.renderedCount < total) {
      els.loadMoreWrap.hidden = false;
      els.loadMoreInfo.textContent = `${state.renderedCount} / ${total}語 を表示中`;
    } else {
      els.loadMoreWrap.hidden = true;
    }
  }

  function renderAppendix(precomputedHits) {
    const tokens = state.tokens;
    const hits = precomputedHits || getFilteredAppendix(tokens);

    els.liveCountBadge.textContent = `${hits.length}件`;
    els.liveCountBadge.classList.toggle("is-zero", hits.length === 0);
    els.tabAppendixCount.textContent = String(hits.length);

    els.appendixSummary.innerHTML =
      tokens.length > 0
        ? `<span class="summary-query">${escapeHtml(state.query.trim())}</span><strong>${hits.length}テーマ</strong> が一致（全${INDEXED_APPENDIX.length}テーマ）`
        : `試験直前用・混同しやすい重要比較早見表 — <strong>全${INDEXED_APPENDIX.length}テーマ</strong>`;

    if (hits.length === 0) {
      els.appendixContainer.innerHTML =
        '<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--text-muted)">一致する比較テーマが見つかりませんでした</td></tr>';
      return;
    }

    els.appendixContainer.innerHTML = hits
      .map(
        (row) => `
      <tr>
        <td class="td-num">${String(row.id).padStart(2, "0")}</td>
        <td class="td-theme">${highlightPlainText(row.theme, tokens)}</td>
        <td>${renderInlineRich(row.termA, tokens)}</td>
        <td>${renderInlineRich(row.termB, tokens)}</td>
        <td>${row.termC ? renderInlineRich(row.termC, tokens) : "—"}</td>
      </tr>
    `
      )
      .join("");
  }

  // =========================================================================
  // 6. Term Detail Modal
  // =========================================================================

  function openModalAt(resultIdx) {
    if (resultIdx < 0 || resultIdx >= state.results.length) return;
    state.modalIndex = resultIdx;
    const { entry, tier } = state.results[resultIdx];
    const tokens = state.tokens;

    els.modalChapter.className = `chapter-badge ch-${entry.chapterId}`;
    els.modalChapter.textContent = `${entry.chapterShort}：${entry.chapterName}`;
    els.modalId.textContent = `#${String(entry.id).padStart(3, "0")}`;

    const tierInfo = tokens.length > 0 && TIER_LABELS[tier] ? TIER_LABELS[tier] : null;
    if (tierInfo) {
      els.modalMatchBadge.hidden = false;
      els.modalMatchBadge.className = `match-tier-badge ${tierInfo.cls}`;
      els.modalMatchBadge.textContent = tierInfo.text;
    } else {
      els.modalMatchBadge.hidden = true;
    }

    syncModalActionButtons(entry.id);

    els.modalTitle.innerHTML = renderInlineRich(entry.title, tokens);
    if (entry.aliasRaw) {
      els.modalAliases.hidden = false;
      els.modalAliases.innerHTML = `別名・表記: ${renderInlineRich(entry.aliasRaw, tokens)}`;
    } else {
      els.modalAliases.hidden = true;
    }

    els.modalKeywords.innerHTML = entry.keywords
      .map(
        (kw) =>
          `<button type="button" class="kw-pill" data-kw="${escapeHtml(kw)}">${highlightPlainText(kw, tokens)}</button>`
      )
      .join("");

    els.modalDefinition.innerHTML = renderMarkdownRich(entry.definition, tokens);
    els.modalFeatures.innerHTML = renderMarkdownRich(entry.features, tokens);
    els.modalRelated.innerHTML = renderMarkdownRich(entry.related, tokens);
    els.modalPitfalls.innerHTML = renderMarkdownRich(entry.pitfalls, tokens);

    els.modalPrevBtn.disabled = resultIdx <= 0;
    els.modalNextBtn.disabled = resultIdx >= state.results.length - 1;
    els.modalPosition.textContent = `${resultIdx + 1} / ${state.results.length}`;

    els.detailModal.hidden = false;
    document.body.style.overflow = "hidden";
    els.modalBody.scrollTop = 0;
  }

  function syncModalActionButtons(entryId) {
    const bm = state.bookmarks.has(entryId);
    const ms = state.mastered.has(entryId);
    els.modalBookmarkBtn.classList.toggle("is-bookmarked", bm);
    els.modalBookmarkBtn.textContent = bm ? "★ 要復習済" : "☆ 要復習";
    els.modalMasteredBtn.classList.toggle("is-mastered", ms);
    els.modalMasteredBtn.textContent = ms ? "✓ 習得済み" : "○ 習得";
  }

  function closeModal() {
    els.detailModal.hidden = true;
    document.body.style.overflow = "";
    state.modalIndex = -1;
  }

  function toggleBookmark(entryId) {
    if (state.bookmarks.has(entryId)) {
      state.bookmarks.delete(entryId);
    } else {
      state.bookmarks.add(entryId);
    }
    persistState();
    updateStatsUI();
    refreshRowFlagsInDom(entryId);
    if (state.modalIndex >= 0 && state.results[state.modalIndex]?.entry.id === entryId) {
      syncModalActionButtons(entryId);
    }
    if (state.status === "bookmarked") computeAndRender();
  }

  function toggleMastered(entryId) {
    if (state.mastered.has(entryId)) {
      state.mastered.delete(entryId);
    } else {
      state.mastered.add(entryId);
    }
    persistState();
    updateStatsUI();
    refreshRowFlagsInDom(entryId);
    if (state.modalIndex >= 0 && state.results[state.modalIndex]?.entry.id === entryId) {
      syncModalActionButtons(entryId);
    }
    if (state.status === "mastered" || state.status === "unmastered") computeAndRender();
  }

  function refreshRowFlagsInDom(entryId) {
    const row = els.cardsContainer.querySelector(`.word-row[data-id="${entryId}"]`);
    if (!row) return;
    const bm = state.bookmarks.has(entryId);
    const ms = state.mastered.has(entryId);
    row.classList.toggle("is-bookmarked", bm);
    row.classList.toggle("is-mastered", ms);
    const bmBtn = row.querySelector('[data-action="bookmark"]');
    const msBtn = row.querySelector('[data-action="mastered"]');
    if (bmBtn) {
      bmBtn.classList.toggle("is-bookmarked", bm);
      bmBtn.textContent = bm ? "★" : "☆";
    }
    if (msBtn) {
      msBtn.classList.toggle("is-mastered", ms);
      msBtn.textContent = ms ? "✓" : "○";
    }
  }

  // =========================================================================
  // 7. Events & Real-Time Wiring
  // =========================================================================

  function setSearchQuery(q, focusInput = false) {
    state.query = q;
    els.searchInput.value = q;
    computeAndRender();
    if (focusInput) els.searchInput.focus();
  }

  // Real-time tracking on EVERY keystroke (C -> CN -> CNN)
  els.searchInput.addEventListener("input", (e) => {
    state.query = e.target.value;
    computeAndRender();
  });

  els.clearSearchBtn.addEventListener("click", () => {
    setSearchQuery("", true);
  });

  els.quickQueries.addEventListener("click", (e) => {
    const chip = e.target.closest(".quick-chip");
    if (!chip) return;
    setSearchQuery(chip.dataset.query || "", true);
  });

  // View Tabs
  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      document.querySelectorAll(".view-tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      const isGlossary = state.view === "glossary";
      els.glossaryView.hidden = !isGlossary;
      els.appendixView.hidden = isGlossary;
      els.glossarySidebarFilters.hidden = !isGlossary;
      els.appendixSidebarNote.hidden = isGlossary;
      computeAndRender();
    });
  });

  // Sidebar Scope & Status controls
  els.scopeGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-scope]");
    if (!btn) return;
    state.scope = btn.dataset.scope;
    els.scopeGroup.querySelectorAll("[data-scope]").forEach((b) =>
      b.classList.toggle("is-active", b === btn)
    );
    computeAndRender();
  });

  els.statusGroup.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-status]");
    if (!btn) return;
    state.status = btn.dataset.status;
    els.statusGroup.querySelectorAll("[data-status]").forEach((b) =>
      b.classList.toggle("is-active", b === btn)
    );
    computeAndRender();
  });

  // Layout density toggle (list / compact / detail)
  document.querySelectorAll(".layout-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.layout = btn.dataset.layout;
      persistState();
      applyLayout();
      computeAndRender();
    });
  });

  els.sortSelect.addEventListener("change", (e) => {
    state.sort = e.target.value;
    computeAndRender();
  });

  // Sidebar Chapter list
  els.chapterStrip.addEventListener("click", (e) => {
    const btn = e.target.closest(".chapter-row-btn");
    if (!btn) return;
    state.chapterId = Number(btn.dataset.chapter);
    computeAndRender();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  function resetAllFilters() {
    state.query = "";
    state.scope = "all";
    state.status = "all";
    state.chapterId = 0;
    state.sort = "relevance";
    els.searchInput.value = "";
    els.sortSelect.value = "relevance";
    els.scopeGroup.querySelectorAll("[data-scope]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.scope === "all")
    );
    els.statusGroup.querySelectorAll("[data-status]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.status === "all")
    );
    computeAndRender();
  }

  els.resetFiltersBtn.addEventListener("click", resetAllFilters);
  els.emptyResetBtn.addEventListener("click", resetAllFilters);

  // Row interactions (delegated)
  els.cardsContainer.addEventListener("click", (e) => {
    const actionBtn = e.target.closest("[data-action]");
    if (actionBtn) {
      e.stopPropagation();
      const id = Number(actionBtn.dataset.id);
      if (actionBtn.dataset.action === "bookmark") toggleBookmark(id);
      if (actionBtn.dataset.action === "mastered") toggleMastered(id);
      return;
    }

    const kwBtn = e.target.closest(".kw-pill");
    if (kwBtn) {
      e.stopPropagation();
      const rawKw = kwBtn.dataset.kw || "";
      const cleanKw = rawKw.split(/[（(・：:]/)[0].trim() || rawKw;
      setSearchQuery(cleanKw, false);
      window.scrollTo({ top: 0, behavior: "smooth" });
      showToast(`「${cleanKw}」で絞り込みました`);
      return;
    }

    const row = e.target.closest(".word-row");
    if (!row) return;
    if (state.layout === "detail") {
      if (state.studyMode) row.classList.toggle("is-revealed");
      return;
    }
    openModalAt(Number(row.dataset.index));
  });

  els.cardsContainer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      const row = e.target.closest(".word-row");
      if (row && e.target === row && state.layout !== "detail") {
        e.preventDefault();
        openModalAt(Number(row.dataset.index));
      }
    }
  });

  // Load more & infinite scroll
  els.loadMoreBtn.addEventListener("click", () => renderNextPage(PAGE_SIZE));
  els.loadAllBtn.addEventListener("click", () => renderNextPage(state.results.length));

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && state.view === "glossary" && state.renderedCount < state.results.length) {
          renderNextPage(PAGE_SIZE);
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(els.loadMoreWrap);
  }

  // Modal controls
  els.modalCloseBtn.addEventListener("click", closeModal);
  els.detailModal.addEventListener("click", (e) => {
    if (e.target === els.detailModal) closeModal();
  });
  els.modalPrevBtn.addEventListener("click", () => openModalAt(state.modalIndex - 1));
  els.modalNextBtn.addEventListener("click", () => openModalAt(state.modalIndex + 1));

  els.modalBookmarkBtn.addEventListener("click", () => {
    const cur = state.results[state.modalIndex];
    if (cur) toggleBookmark(cur.entry.id);
  });

  els.modalMasteredBtn.addEventListener("click", () => {
    const cur = state.results[state.modalIndex];
    if (cur) toggleMastered(cur.entry.id);
  });

  els.modalCopyBtn.addEventListener("click", async () => {
    const cur = state.results[state.modalIndex];
    if (!cur) return;
    const e = cur.entry;
    const text = [
      `■ ${e.heading}`,
      `【ポイントキーワード】 ${e.keywords.join(" / ")}`,
      `【定義・意味】 ${e.definition}`,
      `【主な特徴】 ${e.features}`,
      `【関連ワード・試験ポイント】 ${e.related}`,
      `【よく間違いやすいポイント（混同注意）】 ${e.pitfalls}`,
    ].join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      showToast("解説テキストをコピーしました");
    } catch (_) {
      showToast("コピーに失敗しました");
    }
  });

  els.modalKeywords.addEventListener("click", (e) => {
    const kwBtn = e.target.closest(".kw-pill");
    if (!kwBtn) return;
    const rawKw = kwBtn.dataset.kw || "";
    const cleanKw = rawKw.split(/[（(・：:]/)[0].trim() || rawKw;
    closeModal();
    setSearchQuery(cleanKw, false);
    window.scrollTo({ top: 0, behavior: "smooth" });
    showToast(`「${cleanKw}」で絞り込みました`);
  });

  // Theme & Study mode
  els.themeToggleBtn.addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    persistState();
    applyTheme();
  });

  els.studyModeBtn.addEventListener("click", () => {
    state.studyMode = !state.studyMode;
    persistState();
    applyStudyMode();
    showToast(state.studyMode ? "暗記モードON（行ホバーでキーワード表示）" : "暗記モードOFF");
  });

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (!els.detailModal.hidden) {
      if (e.key === "Escape") {
        closeModal();
      } else if (e.key === "ArrowLeft") {
        openModalAt(state.modalIndex - 1);
      } else if (e.key === "ArrowRight") {
        openModalAt(state.modalIndex + 1);
      }
      return;
    }

    if (e.key === "/" && document.activeElement !== els.searchInput && document.activeElement.tagName !== "SELECT") {
      e.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    } else if (e.key === "Escape" && document.activeElement === els.searchInput && state.query) {
      setSearchQuery("", true);
    }
  });

  // Scroll to top
  window.addEventListener(
    "scroll",
    () => {
      els.scrollTopBtn.hidden = window.scrollY < 450;
    },
    { passive: true }
  );
  els.scrollTopBtn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // =========================================================================
  // 8. Initialize & Re-render once KaTeX finishes deferred load
  // =========================================================================

  els.metaBadge.textContent = `${DATA.meta.version}・全${DATA.meta.totalEntries}語`;
  els.tabGlossaryCount.textContent = String(DATA.meta.totalEntries);
  els.tabAppendixCount.textContent = String(DATA.meta.totalAppendix);

  applyTheme();
  applyStudyMode();
  applyLayout();
  updateStatsUI();
  computeAndRender();

  window.addEventListener("load", () => {
    if (window.katex) {
      computeAndRender();
      if (state.modalIndex >= 0) openModalAt(state.modalIndex);
    }
  });
})();
