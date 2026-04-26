import { Compartment, EditorState, StateField, StateEffect, Transaction, EditorSelection, ChangeSet } from "@codemirror/state";
import {
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  keymap,
  drawSelection
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  indentOnInput,
  bracketMatching,
  foldKeymap,
  HighlightStyle
} from "@codemirror/language";
import {
  SearchQuery,
  search,
  getSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  setSearchQuery,
  searchKeymap,
  openSearchPanel as cmOpenSearchPanel,
  closeSearchPanel as cmCloseSearchPanel,
  highlightSelectionMatches
} from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { GFM, Subscript, Superscript } from "@lezer/markdown";
import { tags, classHighlighter } from "@lezer/highlight";
import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";

/***
 * This file purposefully mirrors Obsidian's CM6 live preview behaviour:
 *  - Raw markdown is still editable.
 *  - Formatting markers are visually hidden.
 *  - Task list checkboxes are interactive.
 *  - Blocks render to HTML when the caret isn't inside them.
 */

/* ---------- Markdown renderer ---------- */
let cachedMd = null;
const renderedMarkdownCache = new Map();
const RENDERED_MARKDOWN_CACHE_LIMIT = 24;
const NOTE_REFERENCE_SCHEME = "noto-note://";
const HEADING_REFERENCE_PREFIX = "#";
const BRACKET_LINK_WIDGET_CLASS = "cm-bracket-link-widget";
const activeEditorViews = new Set();
let bracketReferenceResolver = null;
let bracketReferenceResolverVersion = 0;

function shouldCacheRenderedMarkdown(kind, raw) {
  const normalizedKind = String(kind || "").toLowerCase();
  const text = String(raw || "");
  return normalizedKind === "table" || text.length >= 2000;
}

function getRenderedMarkdownCacheKey(kind, raw) {
  return `${bracketReferenceResolverVersion}\u0000${String(kind || "").toLowerCase()}\u0000${String(raw || "")}`;
}

function normalizeBracketReferenceResult(result, fallbackLabel = "") {
  if (!result || typeof result !== "object") return null;
  const kind = String(result.kind || "").trim().toLowerCase();
  if (kind === "heading") {
    const headingRef = String(result.headingRef || result.slug || result.label || fallbackLabel).trim();
    if (!headingRef) return null;
    return {
      kind: "heading",
      href: `${HEADING_REFERENCE_PREFIX}${encodeURIComponent(headingRef)}`,
      headingRef
    };
  }
  if (kind === "note") {
    const noteRef = String(result.noteRef || result.label || fallbackLabel).trim();
    if (!noteRef) return null;
    return {
      kind: "note",
      href: `${NOTE_REFERENCE_SCHEME}${encodeURIComponent(noteRef)}`,
      noteRef
    };
  }
  if (kind === "external") {
    const href = String(result.href || "").trim();
    if (!href) return null;
    return {
      kind: "external",
      href
    };
  }
  return null;
}

function resolveBracketReference(label) {
  if (typeof bracketReferenceResolver !== "function") return null;
  try {
    return normalizeBracketReferenceResult(bracketReferenceResolver(label), label);
  } catch (_) {
    return null;
  }
}

const refreshBracketRenderingEffect = StateEffect.define();

function setBracketReferenceResolver(resolver) {
  bracketReferenceResolver = typeof resolver === "function" ? resolver : null;
  bracketReferenceResolverVersion += 1;
  renderedMarkdownCache.clear();
  for (const view of activeEditorViews) {
    try {
      view.dispatch({
        effects: refreshBracketRenderingEffect.of(bracketReferenceResolverVersion),
        annotations: Transaction.addToHistory.of(false)
      });
    } catch (_) {}
  }
}

function normalizeHeadingReferenceName(value) {
  return slugifyHeadingId(value);
}

function buildHeadingReferenceIndexFromText(source) {
  const byName = new Map();
  const slugCounts = new Map();
  const lines = String(source || "").split(/\r?\n/);
  lines.forEach((line) => {
    const match = String(line || '').match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!match) return;
    const headingText = String(match[2] || '').trim();
    if (!headingText) return;
    const baseSlug = slugifyHeadingId(headingText);
    const seen = slugCounts.get(baseSlug) || 0;
    const slug = seen > 0 ? `${baseSlug}-${seen}` : baseSlug;
    slugCounts.set(baseSlug, seen + 1);
    const key = normalizeHeadingReferenceName(headingText);
    if (!key || byName.has(key)) return;
    byName.set(key, {
      kind: "heading",
      headingRef: slug,
      headingText
    });
  });
  return byName;
}

function resolveHeadingReference(label, headingReferenceIndex) {
  const key = normalizeHeadingReferenceName(label);
  if (!key || !(headingReferenceIndex instanceof Map)) return null;
  const match = headingReferenceIndex.get(key);
  return normalizeBracketReferenceResult(match, label);
}

function getCachedRenderedMarkdown(kind, raw) {
  if (!shouldCacheRenderedMarkdown(kind, raw)) return null;
  const key = getRenderedMarkdownCacheKey(kind, raw);
  if (!renderedMarkdownCache.has(key)) return null;
  const value = renderedMarkdownCache.get(key);
  renderedMarkdownCache.delete(key);
  renderedMarkdownCache.set(key, value);
  return typeof value === "string" ? value : null;
}

function setCachedRenderedMarkdown(kind, raw, html) {
  if (!shouldCacheRenderedMarkdown(kind, raw)) return html;
  const key = getRenderedMarkdownCacheKey(kind, raw);
  renderedMarkdownCache.delete(key);
  renderedMarkdownCache.set(key, html);
  while (renderedMarkdownCache.size > RENDERED_MARKDOWN_CACHE_LIMIT) {
    const firstKey = renderedMarkdownCache.keys().next();
    if (firstKey.done) break;
    renderedMarkdownCache.delete(firstKey.value);
  }
  return html;
}

function installNoteReferenceSyntax(md) {
  if (!md || !md.inline || !md.inline.ruler) return;
  md.inline.ruler.before("emphasis", "note_reference_link", (state, silent) => {
    const src = state.src || "";
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5B) return false; // [
    if (src.charCodeAt(start + 1) === 0x5B) return false; // [[...]]
    if (start > 0) {
      const prev = src.charCodeAt(start - 1);
      if (prev === 0x21 || prev === 0x5C || prev === 0x5B) return false; // ! or \ or [
    }

    let end = start + 1;
    while (end < src.length) {
      const code = src.charCodeAt(end);
      if (code === 0x0A) return false; // newline
      if (code === 0x5D) break; // ]
      end += 1;
    }
    if (end >= src.length || src.charCodeAt(end) !== 0x5D) return false;
    if (end + 1 < src.length) {
      const nextChar = src.charCodeAt(end + 1);
      if (nextChar === 0x28 || nextChar === 0x5B || nextChar === 0x3A || nextChar === 0x5D) return false; // (...) or [...] or [ref]: or ]]
    }

    const rawLabel = src.slice(start + 1, end);
    const label = rawLabel.trim();
    if (!label) return false;
    if (/^[xX ]$/.test(label)) return false; // task list marker [ ] / [x]
    const resolved = resolveBracketReference(label);
    if (!resolved) return false;

    if (silent) return true;

    const open = state.push("link_open", "a", 1);
    open.attrSet("href", resolved.href);
    open.attrSet(
      "class",
      resolved.kind === "note"
        ? "bracket-link note-ref-link"
        : "bracket-link external-bracket-link"
    );
    if (resolved.kind === "note") open.attrSet("data-note-ref", resolved.noteRef);

    const text = state.push("text", "", 0);
    text.content = rawLabel;

    state.push("link_close", "a", -1);
    state.pos = end + 1;
    return true;
  });
}

function installHeadingReferenceSyntax(md) {
  if (!md || !md.inline || !md.inline.ruler) return;
  md.inline.ruler.before("note_reference_link", "heading_reference_link", (state, silent) => {
    const src = state.src || "";
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5B || src.charCodeAt(start + 1) !== 0x5B) return false; // [[
    if (start > 0) {
      const prev = src.charCodeAt(start - 1);
      if (prev === 0x21 || prev === 0x5C) return false; // ! or \
    }

    let end = start + 2;
    while (end < src.length - 1) {
      const code = src.charCodeAt(end);
      if (code === 0x0A) return false; // newline
      if (code === 0x5D && src.charCodeAt(end + 1) === 0x5D) break; // ]]
      end += 1;
    }
    if (end >= src.length - 1) return false;

    const rawLabel = src.slice(start + 2, end);
    const label = rawLabel.trim();
    if (!label) return false;

    const headingReferenceIndex = state.env && state.env.headingReferenceIndex instanceof Map
      ? state.env.headingReferenceIndex
      : null;
    const resolved = resolveHeadingReference(label, headingReferenceIndex);
    if (!resolved) return false;

    if (silent) return true;

    const open = state.push("link_open", "a", 1);
    open.attrSet("href", resolved.href);
    open.attrSet("class", "bracket-link heading-bracket-link");
    open.attrSet("data-heading-ref", resolved.headingRef);

    const text = state.push("text", "", 0);
    text.content = rawLabel;

    state.push("link_close", "a", -1);
    state.pos = end + 2;
    return true;
  });
}

function installHtmlRenderSafeguards(md) {
  if (!md || !md.renderer || !md.renderer.rules) return;
  const defaultHtmlBlock = md.renderer.rules.html_block;
  const defaultHtmlInline = md.renderer.rules.html_inline;

  md.renderer.rules.html_block = (tokens, idx, options, env, self) => {
    const raw = String(tokens[idx] && tokens[idx].content || "");
    if (isImportedImageHtml(raw)) {
      if (typeof defaultHtmlBlock === "function") return defaultHtmlBlock(tokens, idx, options, env, self);
      return raw;
    }
    return `<div class="md-raw-html-block">${escapeHtml(raw).replace(/\n/g, "<br>")}</div>`;
  };

  md.renderer.rules.html_inline = (tokens, idx, options, env, self) => {
    const raw = String(tokens[idx] && tokens[idx].content || "");
    if (isImportedImageHtml(raw)) {
      if (typeof defaultHtmlInline === "function") return defaultHtmlInline(tokens, idx, options, env, self);
      return raw;
    }
    return escapeHtml(raw);
  };
}

function installHighlightSyntax(md) {
  if (!md || !md.inline || !md.inline.ruler) return;
  md.inline.ruler.before("emphasis", "noto_highlight", (state, silent) => {
    const src = state.src || "";
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x3D || src.charCodeAt(start + 1) !== 0x3D) return false;
    if (start > 0 && src.charCodeAt(start - 1) === 0x5C) return false;

    let end = start + 2;
    while (end < src.length - 1) {
      const code = src.charCodeAt(end);
      if (code === 0x0A) return false;
      if (code === 0x3D && src.charCodeAt(end + 1) === 0x3D && src.charCodeAt(end - 1) !== 0x5C) {
        break;
      }
      end += 1;
    }
    if (end >= src.length - 1) return false;

    const rawContent = src.slice(start + 2, end);
    if (!rawContent.trim()) return false;
    if (silent) return true;

    state.push("mark_open", "mark", 1);
    const text = state.push("text", "", 0);
    text.content = rawContent;
    state.push("mark_close", "mark", -1);
    state.pos = end + 2;
    return true;
  });
}

function slugifyHeadingId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "section";
}

function getHeadingInlineText(token) {
  if (!token) return "";
  if (typeof token.content === "string" && token.content) return token.content;
  if (!Array.isArray(token.children) || token.children.length === 0) return "";
  let text = "";
  for (const child of token.children) {
    if (!child || typeof child.type !== "string") continue;
    if (
      child.type === "text" ||
      child.type === "code_inline" ||
      child.type === "html_inline"
    ) {
      text += child.content || "";
    }
  }
  return text;
}

function installHeadingIds(md) {
  if (!md || !md.core || !md.core.ruler) return;
  md.core.ruler.push("noto_heading_ids", (state) => {
    const slugCounts = new Map();
    for (let i = 0; i < state.tokens.length; i += 1) {
      const token = state.tokens[i];
      if (!token || token.type !== "heading_open") continue;
      if (typeof token.attrIndex === "function" && token.attrIndex("id") >= 0) continue;
      const textToken = state.tokens[i + 1];
      const rawText = getHeadingInlineText(textToken);
      const base = slugifyHeadingId(rawText);
      const existingCount = slugCounts.get(base) || 0;
      const slug = existingCount > 0 ? `${base}-${existingCount}` : base;
      slugCounts.set(base, existingCount + 1);
      token.attrSet("id", slug);
    }
  });
}

function getMd() {
  if (cachedMd) return cachedMd;
  const ctor =
    typeof MarkdownIt === "function"
      ? MarkdownIt
      : MarkdownIt && typeof MarkdownIt.default === "function"
      ? MarkdownIt.default
      : null;
  const md = new ctor({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false,
    highlight: (code, lang) => renderHighlightedCode(code, lang)
  });
  const taskLists =
    typeof markdownItTaskLists === "function"
      ? markdownItTaskLists
      : markdownItTaskLists &&
        typeof markdownItTaskLists.default === "function" &&
        markdownItTaskLists.default;
  if (taskLists) md.use(taskLists, { label: true, labelAfter: true });
  installNoteReferenceSyntax(md);
  installHeadingReferenceSyntax(md);
  installHighlightSyntax(md);
  installHeadingIds(md);
  installHtmlRenderSafeguards(md);
  cachedMd = md;
  return md;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KATEX_ENVIRONMENT_NAMES = [
  "equation",
  "equation*",
  "align",
  "align*",
  "alignat",
  "alignat*",
  "aligned",
  "alignedat",
  "gather",
  "gather*",
  "gathered",
  "multline",
  "multline*",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "cases",
  "array",
  "split",
  "subarray",
  "smallmatrix",
  "CD"
];

function getKatexRenderOptions(displayMode, macros = {}) {
  return {
    displayMode: Boolean(displayMode),
    throwOnError: false,
    strict: "ignore",
    trust: false,
    macros
  };
}

function getKatexAutoRenderDelimiters() {
  return [
    { left: "$$", right: "$$", display: true },
    { left: "\\[", right: "\\]", display: true },
    ...KATEX_ENVIRONMENT_NAMES.map((name) => ({
      left: `\\begin{${name}}`,
      right: `\\end{${name}}`,
      display: true
    })),
    { left: "\\(", right: "\\)", display: false },
    { left: "$", right: "$", display: false }
  ];
}

function renderHighlightedCode(code, rawLang) {
  const w = typeof window !== "undefined" ? window : globalThis;
  const lang = String(rawLang || "").trim().split(/\s+/)[0].toLowerCase();
  const normalizedCode = String(code || "").replace(/\r?\n$/, "");
  let highlighted = escapeHtml(normalizedCode);
  let languageClass = lang || "plaintext";
  if (w && w.hljs) {
    try {
      if (lang && w.hljs.getLanguage(lang)) {
        highlighted = w.hljs.highlight(normalizedCode, {
          language: lang,
          ignoreIllegals: true
        }).value;
        languageClass = lang;
      } else {
        const auto = w.hljs.highlightAuto(normalizedCode);
        highlighted = auto.value || highlighted;
        if (auto.language) languageClass = auto.language;
      }
    } catch (_) {}
  }
  return `<pre><code class="hljs language-${languageClass}">${highlighted}</code></pre>`;
}

function renderKatexWithRegexFallback(htmlSource) {
  const w = typeof window !== "undefined" ? window : globalThis;
  if (!w || !w.katex || typeof w.katex.renderToString !== "function") {
    const plainHtml = String(htmlSource || "").trim();
    if (typeof document === "undefined") return plainHtml;
    try {
      const container = document.createElement("div");
      container.innerHTML = plainHtml;
      unwrapStandaloneMathParagraphs(container);
      wrapOverflowTables(container);
      return container.innerHTML.trim();
    } catch (_) {
      return plainHtml;
    }
  }
  const macros = {};
  const fallbackHtml = String(htmlSource || "")
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, expr) => {
      try {
        return `<div class="math-block">${w.katex.renderToString(expr, getKatexRenderOptions(true, macros))}</div>`;
      } catch (_) {
        return `<div class="math-block">${escapeHtml(expr)}</div>`;
      }
    })
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, expr) => {
      try {
        return `<div class="math-block">${w.katex.renderToString(expr, getKatexRenderOptions(true, macros))}</div>`;
      } catch (_) {
        return `<div class="math-block">${escapeHtml(expr)}</div>`;
      }
    })
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, expr) => {
      try {
        return `<span class="math-inline">${w.katex.renderToString(expr, getKatexRenderOptions(false, macros))}</span>`;
      } catch (_) {
        return `<span class="math-inline">${escapeHtml(expr)}</span>`;
      }
    })
    .replace(/\$([^\$\n]+?)\$/g, (_, expr) => {
      try {
        return `<span class="math-inline">${w.katex.renderToString(expr, getKatexRenderOptions(false, macros))}</span>`;
      } catch (_) {
        return `<span class="math-inline">${escapeHtml(expr)}</span>`;
      }
    })
    .replace(/<p>\s*(<[^>]+class="[^"]*math-block[^"]*"[\s\S]*?<\/[^>]+>)\s*<\/p>/g, "$1")
    .trim();
  if (typeof document === "undefined") return fallbackHtml;
  try {
    const container = document.createElement("div");
    container.innerHTML = fallbackHtml;
    unwrapStandaloneMathParagraphs(container);
    wrapOverflowTables(container);
    return container.innerHTML.trim();
  } catch (_) {
    return fallbackHtml;
  }
}

function unwrapStandaloneMathParagraphs(container) {
  if (!(container instanceof Element)) return;
  const paragraphs = Array.from(container.querySelectorAll("p"));
  paragraphs.forEach((p) => {
    const nonWhitespaceNodes = Array.from(p.childNodes).filter((node) => {
      return !(node.nodeType === 3 && !(node.textContent || "").trim());
    });
    if (nonWhitespaceNodes.length !== 1) return;
    const only = nonWhitespaceNodes[0];
    if (!(only instanceof Element)) return;
    if (!only.classList.contains("katex-display")) return;
    p.replaceWith(only);
  });
}

const TABLE_EDIT_ICON_SVG = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 20h4.2l9.9-9.9a1.9 1.9 0 0 0 0-2.7l-1.5-1.5a1.9 1.9 0 0 0-2.7 0L4 15.8Z"></path>
    <path d="m12.8 7.2 4 4"></path>
  </svg>
`;

function clampTableNumber(value, min, max, fallback = min) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function getTableCellRangesFromText(text, offset = 0) {
  if (typeof text !== "string" || !/\|/.test(text)) return [];
  const separators = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "|" && !isEscapedAt(text, index)) separators.push(index);
  }
  if (separators.length === 0) return [];
  const boundaries = [-1, ...separators, text.length];
  const cells = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const rawStart = boundaries[index] + 1;
    const rawEnd = boundaries[index + 1];
    const leadingEmpty = index === 0 && text.startsWith("|") && rawStart === 0 && rawEnd === 0;
    const trailingEmpty = index === boundaries.length - 2 && text.endsWith("|") && rawStart === rawEnd;
    if (leadingEmpty || trailingEmpty) continue;
    let start = rawStart;
    let end = rawEnd;
    while (start < rawEnd && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    cells.push({
      from: offset + start,
      to: offset + Math.max(start, end),
      rawFrom: offset + rawStart,
      rawTo: offset + rawEnd,
      raw: text.slice(rawStart, rawEnd),
      text: text.slice(start, Math.max(start, end))
    });
  }
  return cells;
}

function normalizeTableEditableText(value) {
  return String(value || "")
    .replace(/\u200b/g, "")
    .replace(/\r?\n+/g, " ")
    .replace(/&(nbsp|#160|#xa0);/gi, " ")
    .replace(/\u00a0/g, " ");
}

function encodeTableEditableTextForMarkdown(value) {
  const normalized = normalizeTableEditableText(value);
  const leadingMatch = normalized.match(/^ +/);
  const leadingCount = leadingMatch ? leadingMatch[0].length : 0;
  const trailingMatch = normalized.match(/ +$/);
  const trailingCountRaw = trailingMatch ? trailingMatch[0].length : 0;
  const trailingCount = Math.max(0, Math.min(trailingCountRaw, normalized.length - leadingCount));
  const coreEnd = Math.max(leadingCount, normalized.length - trailingCount);
  const core = normalized.slice(leadingCount, coreEnd).replace(/\|/g, "\\|");
  return `${"&nbsp;".repeat(leadingCount)}${core}${"&nbsp;".repeat(trailingCount)}`;
}

function escapePlainTextForMarkdownTable(value) {
  return encodeTableEditableTextForMarkdown(value);
}

function parseTableDividerAlignment(value) {
  const trimmed = String(value || "").trim();
  if (!/^:?-{3,}:?$/.test(trimmed)) return null;
  const hasLeft = trimmed.startsWith(":");
  const hasRight = trimmed.endsWith(":");
  if (hasLeft && hasRight) return "center";
  if (hasLeft) return "left";
  if (hasRight) return "right";
  return "default";
}

function buildTableDividerCell(alignment) {
  switch (String(alignment || "").toLowerCase()) {
    case "left":
      return ":---";
    case "right":
      return "---:";
    case "center":
      return ":---:";
    default:
      return "---";
  }
}

function findCodeMirrorViewFromElement(element) {
  let current = element instanceof Node ? element : null;
  while (current) {
    if (current.__cmView && current.__cmView.state) return current.__cmView;
    current = current.parentNode;
  }
  return null;
}

function canUseRichTableEdit(container) {
  if (!(container instanceof Element)) return false;
  const host = container.closest(".live-markdown-editor.live-rich-editor");
  if (!host) return false;
  if (host.closest(".tab-mini-md, .presentation-container, .version-history-diff, .custom-tooltip, .tab-hover-preview, .tab-drag-ghost")) {
    return false;
  }
  if (host.closest(".collab-readonly")) return false;
  return true;
}

function getContenteditableSelectionOffset(element) {
  if (!(element instanceof HTMLElement)) return 0;
  const selection = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
  if (!selection || selection.rangeCount === 0) return 0;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return 0;
  const probe = range.cloneRange();
  probe.selectNodeContents(element);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length;
}

function setContenteditableSelectionOffset(element, offset = 0) {
  if (!(element instanceof HTMLElement)) return;
  const selection = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
  if (!selection || typeof document === "undefined") return;
  const safeOffset = clampTableNumber(offset, 0, String(element.textContent || "").length, 0);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = safeOffset;
  let node = walker.nextNode();
  while (node) {
    const text = String(node.textContent || "");
    if (remaining <= text.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= text.length;
    node = walker.nextNode();
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function isContenteditableSelectionCollapsed(element) {
  if (!(element instanceof HTMLElement)) return false;
  const selection = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  return range.collapsed && element.contains(range.startContainer) && element.contains(range.endContainer);
}

function getRenderedTableShellScrollLeft(shell) {
  if (!(shell instanceof Element)) return 0;
  const scroll = shell.querySelector(".noto-table-scroll");
  return scroll instanceof HTMLElement && Number.isFinite(scroll.scrollLeft) ? Math.max(0, scroll.scrollLeft) : 0;
}

function restoreRenderedTableShellScrollLeft(shell, scrollLeft) {
  if (!(shell instanceof Element) || !Number.isFinite(scrollLeft)) return;
  const scroll = shell.querySelector(".noto-table-scroll");
  if (!(scroll instanceof HTMLElement)) return;
  const safeScrollLeft = Math.max(0, scrollLeft);
  scroll.scrollLeft = safeScrollLeft;
  requestAnimationFrame(() => {
    if (!scroll.isConnected) return;
    scroll.scrollLeft = safeScrollLeft;
  });
}

function findRenderedTableShell(view, descriptor) {
  if (!view || !descriptor) return null;
  const block = view.dom.querySelector(
    `.cm-block-render[data-from="${descriptor.from}"][data-to="${descriptor.to}"][data-kind="table"]`
  );
  const shell = block ? block.querySelector(".noto-table-shell") : null;
  return shell instanceof HTMLElement ? shell : null;
}

function getRenderedTableScrollLeftForDescriptor(view, descriptor) {
  return getRenderedTableShellScrollLeft(findRenderedTableShell(view, descriptor));
}

function wrapOverflowTables(container) {
  if (!(container instanceof Element)) return;
  const tables = Array.from(container.querySelectorAll("table"));
  tables.forEach((table) => {
    if (!(table instanceof HTMLTableElement)) return;
    if (table.closest(".noto-table-shell")) return;
    const shell = document.createElement("div");
    shell.className = "noto-table-shell";

    const scroll = document.createElement("div");
    scroll.className = "noto-table-scroll";

    const inner = document.createElement("div");
    inner.className = "noto-table-scroll-inner";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "noto-table-edit-btn";
    editButton.setAttribute("aria-label", "Edit formatted table");
    editButton.setAttribute("title", "Edit formatted table");
    editButton.innerHTML = TABLE_EDIT_ICON_SVG;

    const parent = table.parentNode;
    if (!parent) return;
    parent.insertBefore(shell, table);
    inner.appendChild(table);
    scroll.appendChild(inner);
    shell.append(scroll, editButton);
  });
}

function bindOverflowTableInteractions(container) {
  if (!(container instanceof Element)) return;
  const shells = Array.from(container.querySelectorAll(".noto-table-shell"));
  shells.forEach((shell) => {
    const button = shell.querySelector(".noto-table-edit-btn");
    const refreshEditableState = () => {
      const editable = canUseRichTableEdit(container);
      shell.setAttribute("data-table-editable", editable ? "true" : "false");
      if (button instanceof HTMLButtonElement) {
        button.disabled = !editable;
        button.hidden = !editable;
      }
    };
    refreshEditableState();
    requestAnimationFrame(refreshEditableState);
    if (shell.__notoTableBindingsInstalled) return;
    shell.__notoTableBindingsInstalled = true;

    const stopRenderedTableInputEventPropagation = (event) => {
      const input = event.target instanceof Element ? event.target.closest(".noto-table-cell-input") : null;
      if (!(input instanceof HTMLInputElement)) return;
      event.stopPropagation();
    };

    shell.addEventListener("mousedown", (event) => {
      const editButton = event.target instanceof Element ? event.target.closest(".noto-table-edit-btn") : null;
      if (editButton) return;
      if (!shell.classList.contains("is-editing")) return;
      const input = event.target instanceof Element ? event.target.closest(".noto-table-cell-input") : null;
      const cell = event.target instanceof Element ? event.target.closest("th.is-table-edit-cell, td.is-table-edit-cell") : null;
      if (input instanceof HTMLInputElement) return;
      if (!(cell instanceof HTMLElement)) return;
      const block = shell.closest(".cm-block-render");
      const view = findCodeMirrorViewFromElement(shell);
      if (!block || !view) return;
      const descriptor = getRenderedTableBlockDescriptor(view.state, block);
      if (!descriptor) return;
      const row = clampTableNumber(
        cell.getAttribute("data-row"),
        0,
        Math.max(0, descriptor.rows.length - 1),
        0
      );
      const col = clampTableNumber(
        cell.getAttribute("data-col"),
        0,
        Math.max(0, descriptor.columnCount - 1),
        0
      );
      const current = view.state.field(activeTableEditField, false);
      const isSameActiveCell =
        current &&
        current.from === descriptor.from &&
        current.to === descriptor.to &&
        current.row === row &&
        current.col === col;
      const activeInput = getRenderedTableActiveInput(shell);
      if (isSameActiveCell && activeInput) {
        const { start, end } = getRenderedTableInputSelection(activeInput);
        event.preventDefault();
        event.stopPropagation();
        focusRenderedTableCellInput(activeInput, start, end);
        return;
      }
      const selectionEnd = getRenderedTableCellTextLength(descriptor, row, col);
      event.preventDefault();
      event.stopPropagation();
      dispatchRenderedTableFocus(view, descriptor, row, col, {
        selectionStart: selectionEnd,
        selectionEnd,
        scrollLeft: getRenderedTableShellScrollLeft(shell),
        scrollTop: getRenderedTableViewScrollTop(view)
      });
    }, true);

    shell.addEventListener("mousedown", (event) => {
      const input = event.target instanceof Element ? event.target.closest(".noto-table-cell-input") : null;
      if (!(input instanceof HTMLInputElement)) return;
      event.stopPropagation();
    });

    shell.addEventListener("click", (event) => {
      const editButton = event.target instanceof Element ? event.target.closest(".noto-table-edit-btn") : null;
      const input = event.target instanceof Element ? event.target.closest(".noto-table-cell-input") : null;
      const cell = event.target instanceof Element ? event.target.closest("th.is-table-edit-cell, td.is-table-edit-cell") : null;
      const block = shell.closest(".cm-block-render");
      const view = findCodeMirrorViewFromElement(shell);
      if (!block || !view) return;
      const from = Number.parseInt(block.getAttribute("data-from") || "", 10);
      const to = Number.parseInt(block.getAttribute("data-to") || "", 10);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;

      if (editButton) {
        event.preventDefault();
        event.stopPropagation();
        if (!canUseRichTableEdit(block)) return;
        const descriptor = getRenderedTableBlockDescriptor(view.state, block);
        if (!descriptor) return;
        const current = view.state.field(activeTableEditField, false);
        const isSameTable = current && current.from === from && current.to === to;
        const initialSelectionEnd = getRenderedTableCellTextLength(descriptor, 0, 0);
        dispatchRenderedTableViewUpdate(view, {
          effects: setActiveTableEditEffect.of(
            isSameTable
              ? null
              : buildActiveTableEditValue(view, descriptor, 0, 0, {
                  selectionStart: initialSelectionEnd,
                  selectionEnd: initialSelectionEnd,
                  scrollLeft: getRenderedTableShellScrollLeft(shell),
                  scrollTop: getRenderedTableViewScrollTop(view)
                })
          ),
          annotations: Transaction.addToHistory.of(false)
        }, getRenderedTableViewScrollTop(view));
        view.focus();
        return;
      }

      if (input instanceof HTMLInputElement) {
        return;
      }

      if (cell instanceof HTMLElement) {
        return;
      }
    }, true);

    shell.addEventListener("click", (event) => {
      const input = event.target instanceof Element ? event.target.closest(".noto-table-cell-input") : null;
      if (!(input instanceof HTMLInputElement)) return;
      event.stopPropagation();
    });

    shell.addEventListener("beforeinput", stopRenderedTableInputEventPropagation);
    shell.addEventListener("keydown", stopRenderedTableInputEventPropagation);
    shell.addEventListener("keypress", stopRenderedTableInputEventPropagation);
    shell.addEventListener("keyup", stopRenderedTableInputEventPropagation);
    shell.addEventListener("paste", stopRenderedTableInputEventPropagation);
    shell.addEventListener("cut", stopRenderedTableInputEventPropagation);
    shell.addEventListener("copy", stopRenderedTableInputEventPropagation);
    shell.addEventListener("compositionstart", stopRenderedTableInputEventPropagation);
    shell.addEventListener("compositionupdate", stopRenderedTableInputEventPropagation);
    shell.addEventListener("compositionend", stopRenderedTableInputEventPropagation);

    shell.addEventListener("focusin", (event) => {
      const input = event.target instanceof Element ? event.target.closest(".noto-table-cell-input") : null;
      if (!(input instanceof HTMLInputElement)) return;
      if (input.__notoSuppressFocusSync) return;
      const block = shell.closest(".cm-block-render");
      const view = findCodeMirrorViewFromElement(shell);
      if (!block || !view) return;
      const descriptor = getRenderedTableBlockDescriptor(view.state, block);
      if (!descriptor) return;
      const row = clampTableNumber(input.getAttribute("data-row"), 0, Math.max(0, descriptor.rows.length - 1), 0);
      const col = clampTableNumber(input.getAttribute("data-col"), 0, Math.max(0, descriptor.columnCount - 1), 0);
      const cursorPos = getRenderedTableCellDocPos(descriptor, row, col);
      const current = view.state.field(activeTableEditField, false);
      const { start, end } = getRenderedTableInputSelection(input);
      const scrollLeft = getRenderedTableShellScrollLeft(shell);
      const scrollTop = getRenderedTableViewScrollTop(view);
      const shouldUpdateState =
        !current ||
        current.from !== descriptor.from ||
        current.to !== descriptor.to ||
        current.row !== row ||
        current.col !== col ||
        current.offset !== start ||
        current.selectionEnd !== end ||
        current.scrollLeft !== scrollLeft ||
        current.scrollTop !== scrollTop;
      const selectionHead = view.state.selection.main ? view.state.selection.main.head : -1;
      if (!shouldUpdateState && selectionHead === cursorPos) return;
      const effectValue = buildActiveTableEditValue(view, descriptor, row, col, {
        selectionStart: start,
        selectionEnd: end,
        focusSeq: current && Number.isFinite(current.focusSeq) ? current.focusSeq : getNextActiveTableEditFocusSeq(view.state),
        scrollLeft,
        scrollTop
      });
      if (!effectValue) return;
      dispatchRenderedTableViewUpdate(view, {
        selection: EditorSelection.cursor(cursorPos, 1),
        effects: shouldUpdateState
          ? setActiveTableEditEffect.of(effectValue)
          : [],
        annotations: Transaction.addToHistory.of(false),
        userEvent: "select"
      }, effectValue.scrollTop);
    }, true);

    shell.addEventListener("keydown", (event) => {
      const input = event.target instanceof Element ? event.target.closest(".noto-table-cell-input") : null;
      if (!(input instanceof HTMLInputElement)) return;
      const block = shell.closest(".cm-block-render");
      const view = findCodeMirrorViewFromElement(shell);
      if (!block || !view) return;
      const descriptor = getRenderedTableBlockDescriptor(view.state, block);
      if (!descriptor) return;
      const row = clampTableNumber(input.getAttribute("data-row"), 0, Math.max(0, descriptor.rows.length - 1), 0);
      const col = clampTableNumber(input.getAttribute("data-col"), 0, Math.max(0, descriptor.columnCount - 1), 0);
      const { start, end } = getRenderedTableInputSelection(input);
      const currentValueLength = String(input.value || "").length;
      const canHandleHorizontalBoundaryJump =
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        start === end;
      if (canHandleHorizontalBoundaryJump) {
        if (event.key === "ArrowLeft" && start <= 0) {
          event.preventDefault();
          event.stopPropagation();
          if (col > 0) {
            const nextCol = col - 1;
            dispatchRenderedTableFocus(
              view,
              descriptor,
              row,
              nextCol,
              {
                selectionStart: getRenderedTableCellTextLength(descriptor, row, nextCol),
                selectionEnd: getRenderedTableCellTextLength(descriptor, row, nextCol),
                scrollLeft: getRenderedTableShellScrollLeft(shell),
                scrollTop: getRenderedTableViewScrollTop(view)
              }
            );
          }
          return;
        }
        if (event.key === "ArrowRight" && start >= currentValueLength) {
          event.preventDefault();
          event.stopPropagation();
          if (col < descriptor.columnCount - 1) {
            dispatchRenderedTableFocus(
              view,
              descriptor,
              row,
              col + 1,
              {
                selectionStart: 0,
                selectionEnd: 0,
                scrollLeft: getRenderedTableShellScrollLeft(shell),
                scrollTop: getRenderedTableViewScrollTop(view)
              }
            );
          }
          return;
        }
      }
      if (!event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (row > 0) {
          const nextOffset = Math.min(start, getRenderedTableCellTextLength(descriptor, row - 1, col));
          dispatchRenderedTableFocus(
            view,
            descriptor,
            row - 1,
            col,
            {
              selectionStart: nextOffset,
              selectionEnd: nextOffset,
              scrollLeft: getRenderedTableShellScrollLeft(shell),
              scrollTop: getRenderedTableViewScrollTop(view)
            }
          );
        }
        return;
      }
      if (!event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        if (row < descriptor.rows.length - 1) {
          const nextOffset = Math.min(start, getRenderedTableCellTextLength(descriptor, row + 1, col));
          dispatchRenderedTableFocus(
            view,
            descriptor,
            row + 1,
            col,
            {
              selectionStart: nextOffset,
              selectionEnd: nextOffset,
              scrollLeft: getRenderedTableShellScrollLeft(shell),
              scrollTop: getRenderedTableViewScrollTop(view)
            }
          );
        }
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        const next = event.shiftKey
          ? getPreviousRenderedTableCellTarget(descriptor, row, col)
          : getNextRenderedTableCellTarget(descriptor, row, col);
        if (!next) return;
        dispatchRenderedTableFocus(view, descriptor, next.row, next.col, {
          selectionStart: 0,
          selectionEnd: 0,
          scrollLeft: getRenderedTableShellScrollLeft(shell),
          scrollTop: getRenderedTableViewScrollTop(view)
        });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          if (col === descriptor.columnCount - 1) {
            insertRenderedTableColumn(view, descriptor, row);
          }
          return;
        }
        if (row < descriptor.rows.length - 1) {
          const nextOffset = Math.min(start, getRenderedTableCellTextLength(descriptor, row + 1, col));
          dispatchRenderedTableFocus(view, descriptor, row + 1, col, {
            selectionStart: nextOffset,
            selectionEnd: nextOffset,
            scrollLeft: getRenderedTableShellScrollLeft(shell),
            scrollTop: getRenderedTableViewScrollTop(view)
          });
          return;
        }
        insertRenderedTableRow(view, descriptor, row, col);
      }
    }, true);

    shell.addEventListener("input", (event) => {
      const input = event.target instanceof Element ? event.target.closest(".noto-table-cell-input") : null;
      if (!(input instanceof HTMLInputElement)) return;
      const block = shell.closest(".cm-block-render");
      const view = findCodeMirrorViewFromElement(shell);
      if (!block || !view) return;
      const descriptor = getRenderedTableBlockDescriptor(view.state, block);
      if (!descriptor) return;
      const row = clampTableNumber(input.getAttribute("data-row"), 0, Math.max(0, descriptor.rows.length - 1), 0);
      const col = clampTableNumber(input.getAttribute("data-col"), 0, Math.max(0, descriptor.columnCount - 1), 0);
      syncRenderedTableCellChange(view, descriptor, row, col, input);
      event.stopPropagation();
    }, true);
  });

  if (container.getAttribute("data-table-edit-active") === "true") {
    requestAnimationFrame(() => activateRenderedTableEditMode(container));
  }
}

function getRenderedTableBlockRange(target) {
  if (target instanceof Element) {
    const from = Number.parseInt(target.getAttribute("data-from") || "", 10);
    const to = Number.parseInt(target.getAttribute("data-to") || "", 10);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) return { from, to };
    return null;
  }
  if (target && typeof target === "object") {
    const from = Number.parseInt(target.from, 10);
    const to = Number.parseInt(target.to, 10);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) return { from, to };
  }
  return null;
}

function getRenderedTableBlockDescriptor(state, target) {
  if (!state || !state.doc) return null;
  const range = getRenderedTableBlockRange(target);
  if (!range) return null;
  const { from, to } = range;
  const raw = state.doc.sliceString(from, to);
  const hasTrailingLineBreak = raw.endsWith("\n");
  const endProbe = Math.max(from, Math.min(state.doc.length, to > from ? to - 1 : to));
  const startLineNumber = state.doc.lineAt(from).number;
  const endLineNumber = state.doc.lineAt(endProbe).number;
  const lines = [];
  for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    lines.push({
      number: line.number,
      from: line.from,
      to: line.to,
      text: line.text,
      cells: getTableCellRangesFromText(line.text, line.from)
    });
  }
  if (lines.length < 2) return null;
  const headerLine = lines[0];
  const dividerLine = lines.find((line, index) => index > 0 && SMART_TABLE_DIVIDER_PATTERN.test(line.text));
  if (!headerLine || !dividerLine) return null;
  const dividerIndex = lines.findIndex((line) => line.number === dividerLine.number);
  if (dividerIndex < 1) return null;
  const bodyLines = lines.slice(dividerIndex + 1).filter((line) => {
    return /\|/.test(line.text) && !SMART_TABLE_DIVIDER_PATTERN.test(line.text);
  });
  const rowLines = [headerLine, ...bodyLines];
  const columnCount = Math.max(
    1,
    headerLine.cells.length,
    dividerLine.cells.length,
    ...bodyLines.map((line) => line.cells.length)
  );
  const alignments = Array.from({ length: columnCount }, (_, index) => {
    const cell = dividerLine.cells[index];
    return parseTableDividerAlignment(cell ? cell.text || cell.raw : "") || "default";
  });
  const rows = rowLines.map((line, rowIndex) => {
    const cells = Array.from({ length: columnCount }, (_, colIndex) => {
      const cell = line.cells[colIndex];
      return cell
        ? {
            from: cell.from,
            to: cell.to,
            rawFrom: cell.rawFrom,
            rawTo: cell.rawTo,
            raw: cell.raw,
            text: cell.text
          }
        : null;
    });
    const values = Array.from({ length: columnCount }, (_, colIndex) => {
      return normalizeTableEditableText(line.cells[colIndex] ? line.cells[colIndex].text : "");
    });
    return {
      index: rowIndex,
      isHeader: rowIndex === 0,
      lineNumber: line.number,
      lineFrom: line.from,
      lineTo: line.to,
      cells,
      values
    };
  });
  return {
    from,
    to,
    raw,
    rows,
    lines,
    headerLine,
    dividerLine,
    bodyLines,
    columnCount,
    alignments,
    indent: (headerLine.text.match(/^\s*/) || [""])[0],
    hasTrailingLineBreak
  };
}

function getRenderedTableDisplayRows(table, descriptor) {
  if (!(table instanceof HTMLTableElement)) return [];
  const rows = [];
  const pushRows = (sourceRows, isHeader) => {
    Array.from(sourceRows || []).forEach((row) => {
      if (!(row instanceof HTMLTableRowElement)) return;
      if (rows.some((entry) => entry.row === row)) return;
      rows.push({ row, isHeader });
    });
  };
  if (table.tHead) pushRows(table.tHead.rows, true);
  Array.from(table.tBodies || []).forEach((body) => pushRows(body.rows, false));
  if (!rows.length) pushRows(table.rows, false);

  const expectedRows = Math.max(1, descriptor && descriptor.rows ? descriptor.rows.length : rows.length || 1);
  while (rows.length < expectedRows) {
    const isHeader = rows.length === 0;
    const section = isHeader
      ? (table.tHead || table.createTHead())
      : (table.tBodies[0] || table.createTBody());
    const row = section.insertRow(-1);
    rows.push({ row, isHeader });
  }

  const expectedColumns = Math.max(
    1,
    descriptor && Number.isFinite(descriptor.columnCount) ? descriptor.columnCount : 1
  );

  return rows.map((entry, rowIndex) => {
    const preferredTag = rowIndex === 0 ? "TH" : "TD";
    let cells = Array.from(entry.row.cells || []);
    while (cells.length < expectedColumns) {
      const cell = document.createElement(preferredTag.toLowerCase());
      entry.row.appendChild(cell);
      cells = Array.from(entry.row.cells || []);
    }
    if (cells.length > expectedColumns) {
      for (let index = cells.length - 1; index >= expectedColumns; index -= 1) {
        cells[index].remove();
      }
      cells = Array.from(entry.row.cells || []);
    }
    return {
      row: entry.row,
      isHeader: rowIndex === 0,
      cells
    };
  });
}

function getRenderedTableValueFromCell(cell, fallback = "") {
  if (!(cell instanceof HTMLElement)) return normalizeTableEditableText(fallback);
  const input = cell.querySelector(".noto-table-cell-input");
  const source = input instanceof HTMLInputElement ? input.value : cell.textContent;
  return normalizeTableEditableText(source == null ? fallback : source);
}

function readRenderedTableEditableRows(shell, descriptor) {
  if (!(shell instanceof Element) || !descriptor) {
    return [Array(Math.max(1, descriptor && descriptor.columnCount ? descriptor.columnCount : 1)).fill("")];
  }
  const table = shell.querySelector("table");
  const displayRows = getRenderedTableDisplayRows(table, descriptor);
  const rowCount = Math.max(1, descriptor.rows.length, displayRows.length);
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const fallbackValues = descriptor.rows[rowIndex] ? descriptor.rows[rowIndex].values : [];
    const displayRow = displayRows[rowIndex];
    return Array.from({ length: descriptor.columnCount }, (_, colIndex) => {
      const cell = displayRow && displayRow.cells ? displayRow.cells[colIndex] : null;
      return getRenderedTableValueFromCell(cell, fallbackValues[colIndex] || "");
    });
  });
}

function buildSizedTableDividerCell(alignment, width) {
  const dashCount = Math.max(3, Number(width) || 3);
  switch (String(alignment || "").toLowerCase()) {
    case "left":
      return `:${"-".repeat(dashCount)}`;
    case "right":
      return `${"-".repeat(dashCount)}:`;
    case "center":
      return `:${"-".repeat(dashCount)}:`;
    default:
      return "-".repeat(dashCount);
  }
}

function buildFormattedMarkdownTableRow(values, widths) {
  const safeValues = Array.isArray(values) ? values : [];
  const safeWidths = Array.isArray(widths) ? widths : [];
  let text = "|";
  const cellOffsets = [];
  for (let index = 0; index < safeWidths.length; index += 1) {
    text += " ";
    cellOffsets.push(text.length);
    const value = String(safeValues[index] || "");
    text += value.padEnd(safeWidths[index], " ");
    text += " |";
  }
  return { text, cellOffsets };
}

function buildFormattedMarkdownDividerRow(alignments, widths) {
  const values = Array.from({ length: widths.length }, (_, index) => {
    return buildSizedTableDividerCell(alignments[index], widths[index]);
  });
  return buildFormattedMarkdownTableRow(values, widths);
}

function buildFormattedMarkdownTableBlock(descriptor, valueRows) {
  const fallbackRows = descriptor && Array.isArray(descriptor.rows)
    ? descriptor.rows.map((row) => row.values)
    : [];
  const columnCount = Math.max(
    1,
    descriptor && Number.isFinite(descriptor.columnCount) ? descriptor.columnCount : 1,
    ...fallbackRows.map((row) => Array.isArray(row) ? row.length : 0),
    ...((Array.isArray(valueRows) ? valueRows : []).map((row) => Array.isArray(row) ? row.length : 0))
  );
  const normalizedRows = (Array.isArray(valueRows) ? valueRows : fallbackRows).map((row) => {
    return Array.from({ length: columnCount }, (_, index) => {
      return normalizeTableEditableText(Array.isArray(row) ? row[index] : "");
    });
  });
  if (!normalizedRows.length) {
    normalizedRows.push(Array.from({ length: columnCount }, () => ""));
  }
  const escapedRows = normalizedRows.map((row) => row.map((value) => escapePlainTextForMarkdownTable(value)));
  const dividerCells = Array.from({ length: columnCount }, (_, index) => {
    return buildSizedTableDividerCell(
      descriptor && Array.isArray(descriptor.alignments) ? descriptor.alignments[index] : "default",
      3
    );
  });
  const widths = Array.from({ length: columnCount }, (_, index) => {
    return Math.max(
      3,
      dividerCells[index].length,
      ...escapedRows.map((row) => String(row[index] || "").length)
    );
  });

  const indent = descriptor && typeof descriptor.indent === "string" ? descriptor.indent : "";
  const lineRecords = [];

  const headerLine = buildFormattedMarkdownTableRow(escapedRows[0], widths);
  lineRecords.push({
    text: `${indent}${headerLine.text}`,
    editableRow: 0,
    cellOffsets: headerLine.cellOffsets.map((offset) => indent.length + offset)
  });

  const dividerLine = buildFormattedMarkdownDividerRow(
    descriptor && Array.isArray(descriptor.alignments) ? descriptor.alignments : [],
    widths
  );
  lineRecords.push({
    text: `${indent}${dividerLine.text}`,
    editableRow: null,
    cellOffsets: []
  });

  for (let rowIndex = 1; rowIndex < escapedRows.length; rowIndex += 1) {
    const rowLine = buildFormattedMarkdownTableRow(escapedRows[rowIndex], widths);
    lineRecords.push({
      text: `${indent}${rowLine.text}`,
      editableRow: rowIndex,
      cellOffsets: rowLine.cellOffsets.map((offset) => indent.length + offset)
    });
  }

  let runningOffset = 0;
  const cellDocPositions = [];
  lineRecords.forEach((record, index) => {
    if (record.editableRow !== null) {
      cellDocPositions[record.editableRow] = record.cellOffsets.map((offset) => descriptor.from + runningOffset + offset);
    }
    runningOffset += record.text.length;
    if (index < lineRecords.length - 1 || (descriptor && descriptor.hasTrailingLineBreak)) {
      runningOffset += 1;
    }
  });

  const text = `${lineRecords.map((record) => record.text).join("\n")}${descriptor && descriptor.hasTrailingLineBreak ? "\n" : ""}`;
  return {
    text,
    rows: normalizedRows,
    columnCount,
    cellDocPositions
  };
}

function buildTableBlockWithAppendedLastColumn(descriptor, valueRows) {
  const baseRows = Array.isArray(valueRows)
    ? valueRows
    : (descriptor && Array.isArray(descriptor.rows) ? descriptor.rows.map((row) => row.values) : []);
  const normalizedRows = baseRows.map((row) => {
    const nextRow = Array.from(
      { length: Math.max(1, descriptor && Number.isFinite(descriptor.columnCount) ? descriptor.columnCount : 1) },
      (_, index) => normalizeTableEditableText(Array.isArray(row) ? row[index] : "")
    );
    nextRow.push("");
    return nextRow;
  });
  if (!normalizedRows.length) {
    normalizedRows.push(["", ""]);
  }
  return buildFormattedMarkdownTableBlock(descriptor, normalizedRows);
}

function getRenderedTableCellDocPos(descriptor, row, col) {
  if (!descriptor || !Array.isArray(descriptor.rows) || !descriptor.rows.length) return 0;
  const safeRow = clampTableNumber(row, 0, Math.max(0, descriptor.rows.length - 1), 0);
  const safeCol = clampTableNumber(col, 0, Math.max(0, descriptor.columnCount - 1), 0);
  const rowInfo = descriptor.rows[safeRow];
  if (!rowInfo) return descriptor.from;
  const exactCell = rowInfo.cells[safeCol];
  if (exactCell && Number.isFinite(exactCell.from)) return exactCell.from;
  const previousCell = rowInfo.cells
    .slice(0, safeCol)
    .reverse()
    .find((cell) => cell && Number.isFinite(cell.to));
  if (previousCell) return previousCell.to;
  const afterIndent = rowInfo.lineFrom + (descriptor.indent ? descriptor.indent.length : 0);
  return Math.max(rowInfo.lineFrom, Math.min(rowInfo.lineTo, afterIndent + 2));
}

function getRenderedTableCellTextLength(descriptor, row, col) {
  if (!descriptor || !Array.isArray(descriptor.rows) || !descriptor.rows.length) return 0;
  const safeRow = clampTableNumber(row, 0, Math.max(0, descriptor.rows.length - 1), 0);
  const safeCol = clampTableNumber(col, 0, Math.max(0, descriptor.columnCount - 1), 0);
  const rowInfo = descriptor.rows[safeRow];
  const value = rowInfo && Array.isArray(rowInfo.values) ? rowInfo.values[safeCol] : "";
  return String(value || "").length;
}

function getRenderedTableInputSelection(input) {
  if (!(input instanceof HTMLInputElement)) return { start: 0, end: 0 };
  const valueLength = String(input.value || "").length;
  const start = clampTableNumber(input.selectionStart, 0, valueLength, 0);
  const end = clampTableNumber(input.selectionEnd, start, valueLength, start);
  return { start, end };
}

function setRenderedTableInputSelection(input, start = 0, end = start) {
  if (!(input instanceof HTMLInputElement)) return;
  const valueLength = String(input.value || "").length;
  const safeStart = clampTableNumber(start, 0, valueLength, 0);
  const safeEnd = clampTableNumber(end, safeStart, valueLength, safeStart);
  try {
    input.setSelectionRange(safeStart, safeEnd);
  } catch (_) {}
}

function focusRenderedTableCellInput(input, selectionStart = 0, selectionEnd = selectionStart) {
  if (!(input instanceof HTMLInputElement)) return;
  input.__notoSuppressFocusSync = true;
  try {
    input.focus({ preventScroll: true });
  } catch (_) {
    input.focus();
  }
  setRenderedTableInputSelection(input, selectionStart, selectionEnd);
  requestAnimationFrame(() => {
    if (input instanceof HTMLInputElement) {
      input.__notoSuppressFocusSync = false;
    }
  });
}

function getRenderedTableActiveInput(shell) {
  if (!(shell instanceof Element)) return null;
  const input = shell.querySelector(".noto-table-cell-input");
  return input instanceof HTMLInputElement ? input : null;
}

function getRenderedTableViewScrollTop(view) {
  return view && view.scrollDOM && Number.isFinite(view.scrollDOM.scrollTop)
    ? Math.max(0, view.scrollDOM.scrollTop)
    : 0;
}

function restoreRenderedTableViewScrollTop(view, scrollTop) {
  if (!view || !view.scrollDOM || !Number.isFinite(scrollTop)) return;
  const safeScrollTop = Math.max(0, scrollTop);
  view.scrollDOM.scrollTop = safeScrollTop;
  requestAnimationFrame(() => {
    if (!view.scrollDOM || !view.scrollDOM.isConnected) return;
    view.scrollDOM.scrollTop = safeScrollTop;
  });
}

function dispatchRenderedTableViewUpdate(view, spec, scrollTop = null) {
  if (!view || !spec) return;
  const preservedScrollTop = Number.isFinite(scrollTop)
    ? Math.max(0, scrollTop)
    : getRenderedTableViewScrollTop(view);
  view.dispatch({
    ...spec,
    scrollIntoView: false
  });
  restoreRenderedTableViewScrollTop(view, preservedScrollTop);
}

function buildActiveTableEditValue(view, descriptor, row, col, options = {}) {
  if (!view || !descriptor) return null;
  const safeRow = clampTableNumber(row, 0, Math.max(0, descriptor.rows.length - 1), 0);
  const safeCol = clampTableNumber(col, 0, Math.max(0, descriptor.columnCount - 1), 0);
  const maxSelectionLength = Math.max(
    0,
    Number.isFinite(options.maxSelectionLength)
      ? Number(options.maxSelectionLength)
      : getRenderedTableCellTextLength(descriptor, safeRow, safeCol)
  );
  const startRaw = Number.isFinite(options.selectionStart)
    ? Number(options.selectionStart)
    : (Number.isFinite(options.offset) ? Number(options.offset) : 0);
  const safeStart = clampTableNumber(startRaw, 0, maxSelectionLength, 0);
  const endRaw = Number.isFinite(options.selectionEnd) ? Number(options.selectionEnd) : safeStart;
  const safeEnd = clampTableNumber(endRaw, safeStart, maxSelectionLength, safeStart);
  return {
    from: descriptor.from,
    to: descriptor.to,
    row: safeRow,
    col: safeCol,
    offset: safeStart,
    selectionEnd: safeEnd,
    focusSeq: Number.isFinite(options.focusSeq)
      ? Math.max(0, Math.floor(options.focusSeq))
      : getNextActiveTableEditFocusSeq(view.state),
    scrollLeft: Number.isFinite(options.scrollLeft)
      ? Math.max(0, Number(options.scrollLeft))
      : getRenderedTableScrollLeftForDescriptor(view, descriptor),
    scrollTop: Number.isFinite(options.scrollTop)
      ? Math.max(0, Number(options.scrollTop))
      : getRenderedTableViewScrollTop(view)
  };
}

function dispatchRenderedTableFocus(view, descriptor, row, col, options = {}) {
  if (!view || !descriptor) return;
  const safeRow = clampTableNumber(row, 0, Math.max(0, descriptor.rows.length - 1), 0);
  const safeCol = clampTableNumber(col, 0, Math.max(0, descriptor.columnCount - 1), 0);
  const cursorPos = getRenderedTableCellDocPos(descriptor, safeRow, safeCol);
  const effectValue = buildActiveTableEditValue(view, descriptor, safeRow, safeCol, options);
  if (!effectValue) return;
  dispatchRenderedTableViewUpdate(view, {
    selection: EditorSelection.cursor(cursorPos, 1),
    effects: setActiveTableEditEffect.of(effectValue),
    annotations: Transaction.addToHistory.of(false),
    userEvent: "select"
  }, effectValue.scrollTop);
}

function getNextRenderedTableCellTarget(descriptor, row, col) {
  if (!descriptor || !descriptor.rows.length) return null;
  const safeRow = clampTableNumber(row, 0, Math.max(0, descriptor.rows.length - 1), 0);
  const safeCol = clampTableNumber(col, 0, Math.max(0, descriptor.columnCount - 1), 0);
  if (safeCol + 1 < descriptor.columnCount) return { row: safeRow, col: safeCol + 1 };
  if (safeRow + 1 < descriptor.rows.length) return { row: safeRow + 1, col: 0 };
  return null;
}

function getPreviousRenderedTableCellTarget(descriptor, row, col) {
  if (!descriptor || !descriptor.rows.length) return null;
  const safeRow = clampTableNumber(row, 0, Math.max(0, descriptor.rows.length - 1), 0);
  const safeCol = clampTableNumber(col, 0, Math.max(0, descriptor.columnCount - 1), 0);
  if (safeCol > 0) return { row: safeRow, col: safeCol - 1 };
  if (safeRow > 0) return { row: safeRow - 1, col: Math.max(0, descriptor.columnCount - 1) };
  return null;
}

function renderRenderedTableCell(cell, value, rowIndex, colIndex, isActive) {
  if (!(cell instanceof HTMLElement)) return null;
  const normalizedValue = normalizeTableEditableText(value || "");
  cell.setAttribute("data-row", String(rowIndex));
  cell.setAttribute("data-col", String(colIndex));
  cell.classList.add("is-table-edit-cell");
  cell.classList.toggle("is-active-table-cell", Boolean(isActive));
  if (!isActive) {
    cell.textContent = normalizedValue;
    return null;
  }
  let input = cell.querySelector(".noto-table-cell-input");
  if (!(input instanceof HTMLInputElement)) {
    input = document.createElement("input");
    input.type = "text";
    input.className = "noto-table-cell-input";
  }
  input.setAttribute("spellcheck", "false");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("data-row", String(rowIndex));
  input.setAttribute("data-col", String(colIndex));
  if (input.value !== normalizedValue) input.value = normalizedValue;
  if (cell.firstElementChild !== input || cell.childNodes.length !== 1) {
    cell.replaceChildren(input);
  }
  return input;
}

function activateRenderedTableEditMode(container) {
  if (!(container instanceof Element)) return;
  const shell = container.querySelector(".noto-table-shell");
  const table = shell ? shell.querySelector("table") : null;
  const view = findCodeMirrorViewFromElement(container);
  if (!(shell instanceof HTMLElement) || !(table instanceof HTMLTableElement) || !view) return;
  const descriptor = getRenderedTableBlockDescriptor(view.state, container);
  if (!descriptor) return;

  shell.classList.add("is-editing");
  shell.setAttribute("data-table-editable", canUseRichTableEdit(container) ? "true" : "false");
  const button = shell.querySelector(".noto-table-edit-btn");
  if (button instanceof HTMLButtonElement) button.setAttribute("aria-pressed", "true");

  const currentValues = readRenderedTableEditableRows(shell, descriptor);
  const displayRows = getRenderedTableDisplayRows(table, descriptor);
  const targetRow = clampTableNumber(
    container.getAttribute("data-table-edit-row"),
    0,
    Math.max(0, descriptor.rows.length - 1),
    0
  );
  const targetCol = clampTableNumber(
    container.getAttribute("data-table-edit-col"),
    0,
    Math.max(0, descriptor.columnCount - 1),
    0
  );
  let targetInput = null;
  displayRows.forEach((displayRow, rowIndex) => {
    const rowValues = currentValues[rowIndex] || Array.from({ length: descriptor.columnCount }, () => "");
    displayRow.cells.forEach((cell, colIndex) => {
      if (!(cell instanceof HTMLElement)) return;
      const input = renderRenderedTableCell(
        cell,
        rowValues[colIndex] || "",
        rowIndex,
        colIndex,
        rowIndex === targetRow && colIndex === targetCol
      );
      if (input instanceof HTMLInputElement) targetInput = input;
    });
  });
  const selectionStart = clampTableNumber(
    container.getAttribute("data-table-edit-offset"),
    0,
    targetInput instanceof HTMLInputElement ? String(targetInput.value || "").length : 0,
    0
  );
  const selectionEnd = clampTableNumber(
    container.getAttribute("data-table-edit-selection-end"),
    selectionStart,
    targetInput instanceof HTMLInputElement ? String(targetInput.value || "").length : selectionStart,
    selectionStart
  );
  const scrollLeft = Math.max(
    0,
    Number.parseFloat(container.getAttribute("data-table-edit-scroll-left") || "0") || 0
  );
  const scrollTop = Math.max(
    0,
    Number.parseFloat(container.getAttribute("data-table-edit-scroll-top") || "0") || 0
  );
  if (targetInput instanceof HTMLInputElement) {
    focusRenderedTableCellInput(targetInput, selectionStart, selectionEnd);
  }
  restoreRenderedTableShellScrollLeft(shell, scrollLeft);
  restoreRenderedTableViewScrollTop(view, scrollTop);
}

function insertRenderedTableRow(view, descriptor, row, col) {
  if (!view || !descriptor) return;
  const block = view.dom.querySelector(
    `.cm-block-render[data-from="${descriptor.from}"][data-to="${descriptor.to}"][data-kind="table"]`
  );
  const shell = block ? block.querySelector(".noto-table-shell") : null;
  const rows = readRenderedTableEditableRows(shell, descriptor);
  rows.push(Array.from({ length: descriptor.columnCount }, () => ""));
  const built = buildFormattedMarkdownTableBlock(descriptor, rows);
  const nextRow = Math.max(0, built.rows.length - 1);
  const safeCol = clampTableNumber(col, 0, Math.max(0, built.columnCount - 1), 0);
  const nextSelection = built.cellDocPositions[nextRow] && Number.isFinite(built.cellDocPositions[nextRow][safeCol])
    ? built.cellDocPositions[nextRow][safeCol]
    : descriptor.from;
  const current = view.state.field(activeTableEditField, false);
  const scrollLeft = getRenderedTableShellScrollLeft(shell);
  const scrollTop = getRenderedTableViewScrollTop(view);
  dispatchRenderedTableViewUpdate(view, {
    changes: { from: descriptor.from, to: descriptor.to, insert: built.text },
    selection: EditorSelection.cursor(nextSelection, 1),
    effects: setActiveTableEditEffect.of({
      from: descriptor.from,
      to: descriptor.from + built.text.length,
      row: nextRow,
      col: safeCol,
      offset: 0,
      selectionEnd: 0,
      focusSeq: current && Number.isFinite(current.focusSeq) ? current.focusSeq : 0,
      scrollLeft,
      scrollTop
    }),
    userEvent: "input.type"
  }, scrollTop);
}

function insertRenderedTableColumn(view, descriptor, row) {
  if (!view || !descriptor) return;
  const block = view.dom.querySelector(
    `.cm-block-render[data-from="${descriptor.from}"][data-to="${descriptor.to}"][data-kind="table"]`
  );
  const shell = block ? block.querySelector(".noto-table-shell") : null;
  const rows = readRenderedTableEditableRows(shell, descriptor);
  const built = buildTableBlockWithAppendedLastColumn(descriptor, rows);
  const safeRow = clampTableNumber(row, 0, Math.max(0, built.rows.length - 1), 0);
  const nextCol = Math.max(0, built.columnCount - 1);
  const nextSelection = built.cellDocPositions[safeRow] && Number.isFinite(built.cellDocPositions[safeRow][nextCol])
    ? built.cellDocPositions[safeRow][nextCol]
    : descriptor.from;
  const current = view.state.field(activeTableEditField, false);
  const scrollLeft = getRenderedTableShellScrollLeft(shell);
  const scrollTop = getRenderedTableViewScrollTop(view);
  dispatchRenderedTableViewUpdate(view, {
    changes: { from: descriptor.from, to: descriptor.to, insert: built.text },
    selection: EditorSelection.cursor(nextSelection, 1),
    effects: setActiveTableEditEffect.of({
      from: descriptor.from,
      to: descriptor.from + built.text.length,
      row: safeRow,
      col: nextCol,
      offset: 0,
      selectionEnd: 0,
      focusSeq: current && Number.isFinite(current.focusSeq) ? current.focusSeq : 0,
      scrollLeft,
      scrollTop
    }),
    userEvent: "input.type"
  }, scrollTop);
}

function syncRenderedTableCellChange(view, descriptor, row, col, input) {
  if (!view || !descriptor || !(input instanceof HTMLInputElement)) return;
  const shell = input.closest(".noto-table-shell");
  if (!(shell instanceof Element)) return;
  const { start, end } = getRenderedTableInputSelection(input);
  const normalizedValue = normalizeTableEditableText(input.value || "");
  if (String(input.value || "") !== normalizedValue) {
    input.value = normalizedValue;
    setRenderedTableInputSelection(input, Math.min(start, normalizedValue.length), Math.min(end, normalizedValue.length));
  }
  const rows = readRenderedTableEditableRows(shell, descriptor);
  if (rows[row]) rows[row][col] = normalizeTableEditableText(input.value || "");
  const built = buildFormattedMarkdownTableBlock(descriptor, rows);
  const safeRow = clampTableNumber(row, 0, Math.max(0, built.rows.length - 1), 0);
  const safeCol = clampTableNumber(col, 0, Math.max(0, built.columnCount - 1), 0);
  const current = view.state.field(activeTableEditField, false);
  const nextSelectionStart = clampTableNumber(
    start,
    0,
    String(built.rows[safeRow] && built.rows[safeRow][safeCol] ? built.rows[safeRow][safeCol] : "").length,
    0
  );
  const nextSelectionEnd = clampTableNumber(
    end,
    nextSelectionStart,
    String(built.rows[safeRow] && built.rows[safeRow][safeCol] ? built.rows[safeRow][safeCol] : "").length,
    nextSelectionStart
  );
  const nextSelection = built.cellDocPositions[safeRow] && Number.isFinite(built.cellDocPositions[safeRow][safeCol])
    ? built.cellDocPositions[safeRow][safeCol]
    : descriptor.from;
  const scrollLeft = getRenderedTableShellScrollLeft(shell);
  const scrollTop = getRenderedTableViewScrollTop(view);
  if (built.text === descriptor.raw) {
    if (
      !current ||
      current.from !== descriptor.from ||
      current.to !== descriptor.to ||
      current.row !== safeRow ||
      current.col !== safeCol ||
      current.offset !== nextSelectionStart ||
      current.selectionEnd !== nextSelectionEnd ||
      current.scrollLeft !== scrollLeft ||
      current.scrollTop !== scrollTop ||
      view.state.selection.main.head !== nextSelection
    ) {
      dispatchRenderedTableViewUpdate(view, {
        selection: EditorSelection.cursor(nextSelection, 1),
        effects: setActiveTableEditEffect.of({
          from: descriptor.from,
          to: descriptor.to,
          row: safeRow,
          col: safeCol,
          offset: nextSelectionStart,
          selectionEnd: nextSelectionEnd,
          focusSeq: current && Number.isFinite(current.focusSeq) ? current.focusSeq : 0,
          scrollLeft,
          scrollTop
        }),
        annotations: Transaction.addToHistory.of(false),
        userEvent: "select"
      }, scrollTop);
    }
    return;
  }
  dispatchRenderedTableViewUpdate(view, {
    changes: { from: descriptor.from, to: descriptor.to, insert: built.text },
    effects: setActiveTableEditEffect.of({
      from: descriptor.from,
      to: descriptor.from + built.text.length,
      row: safeRow,
      col: safeCol,
      offset: nextSelectionStart,
      selectionEnd: nextSelectionEnd,
      focusSeq: current && Number.isFinite(current.focusSeq) ? current.focusSeq : 0,
      scrollLeft,
      scrollTop
    }),
    userEvent: "input.type"
  }, scrollTop);
}

function renderKatexInHtml(htmlSource) {
  const w = typeof window !== "undefined" ? window : globalThis;
  if (!w || !w.katex) return String(htmlSource || "").trim();
  if (typeof document === "undefined" || typeof w.renderMathInElement !== "function") {
    return renderKatexWithRegexFallback(htmlSource);
  }
  try {
    const container = document.createElement("div");
    container.innerHTML = String(htmlSource || "");
    const macros = {};
    w.renderMathInElement(container, {
      ...getKatexRenderOptions(false, macros),
      delimiters: getKatexAutoRenderDelimiters()
    });
    container.querySelectorAll(".katex-display").forEach((el) => {
      el.classList.add("math-block");
    });
    container.querySelectorAll(".katex").forEach((el) => {
      if (!el.closest(".katex-display")) el.classList.add("math-inline");
    });
    unwrapStandaloneMathParagraphs(container);
    wrapOverflowTables(container);
    return container.innerHTML.trim();
  } catch (_) {
    return renderKatexWithRegexFallback(htmlSource);
  }
}

function renderMarkdown(raw, options = {}) {
  const kind = String(options && options.kind ? options.kind : "").toLowerCase();
  if (kind === "html") {
    return isImportedImageHtml(raw)
      ? String(raw || "").trim()
      : `<div class="md-raw-html-block">${escapeHtml(raw || "").replace(/\n/g, "<br>")}</div>`;
  }
  const cached = getCachedRenderedMarkdown(kind, raw);
  if (typeof cached === "string") return cached;
  const md = getMd();
  const headingReferenceIndex = buildHeadingReferenceIndexFromText(raw || "");
  let html = md ? md.render(raw || "", { headingReferenceIndex }) : escapeHtml(raw || "");
  html = renderKatexInHtml(html);
  return setCachedRenderedMarkdown(kind, raw, html);
}

const HTML_BLOCK_LEVEL_TAGS = new Set([
  "address", "article", "aside", "blockquote", "canvas", "dd", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "noscript", "ol", "p", "pre",
  "section", "table", "tfoot", "ul", "video"
]);

function getNearestNonWhitespaceSibling(node, direction) {
  let cur = node;
  while (cur) {
    cur = direction < 0 ? cur.previousSibling : cur.nextSibling;
    if (!cur) return null;
    if (cur.nodeType === 8) continue; // comment
    if (cur.nodeType === 3 && !(cur.textContent || "").trim()) continue;
    return cur;
  }
  return null;
}

function isBlockLevelElementNode(node) {
  return (
    node instanceof Element &&
    HTML_BLOCK_LEVEL_TAGS.has(String(node.tagName || "").toLowerCase())
  );
}

function pruneHtmlWhitespaceTextNodes(root) {
  if (!(root instanceof Element)) return;
  const candidates = [];
  const collect = (node) => {
    const children = Array.from(node.childNodes || []);
    for (const child of children) {
      if (child.nodeType === 3) {
        if (!(child.textContent || "").trim()) candidates.push(child);
        continue;
      }
      if (child.nodeType === 1) collect(child);
    }
  };
  collect(root);

  for (const node of candidates) {
    const parent = node.parentElement;
    if (!parent) continue;
    const prev = getNearestNonWhitespaceSibling(node, -1);
    const next = getNearestNonWhitespaceSibling(node, 1);
    const atEdge = !prev || !next;
    const betweenBlocks = isBlockLevelElementNode(prev) && isBlockLevelElementNode(next);
    if (atEdge || betweenBlocks) node.remove();
  }
}

function normalizeHtmlBoundaryMargins(root) {
  if (!(root instanceof Element)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let first = null;
  let last = null;
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Element && current !== root) {
      const tag = String(current.tagName || "").toLowerCase();
      if (tag !== "script" && tag !== "style") {
        if (!first) first = current;
        last = current;
      }
    }
    current = walker.nextNode();
  }
  if (first && first instanceof HTMLElement) {
    first.style.marginTop = "0";
  }
  if (last && last instanceof HTMLElement) {
    last.style.marginBottom = "0";
  }
}

function isImportedImageHtml(raw) {
  return /\bdata-noto-image-id\s*=|class=(["'])[^"']*\bnoto-imported-image\b/i.test(
    String(raw || "")
  );
}

/* ---------- Widgets ---------- */
function applyRenderedBlockWidgetStateToDom(el, widget) {
  if (!(el instanceof HTMLElement) || !widget) return;
  el.dataset.from = String(widget.from);
  el.dataset.to = String(widget.to);
  el.dataset.kind = widget.kind;
  el.__notoRenderedHtml = String(widget.html || "");
  if (widget.kind === "table" && widget.activeTableEdit) {
    el.setAttribute("data-table-edit-active", "true");
    if (Number.isFinite(widget.activeTableEdit.row)) el.setAttribute("data-table-edit-row", String(widget.activeTableEdit.row));
    if (Number.isFinite(widget.activeTableEdit.col)) el.setAttribute("data-table-edit-col", String(widget.activeTableEdit.col));
    el.setAttribute("data-table-edit-offset", String(widget.activeTableEdit.offset || 0));
    el.setAttribute("data-table-edit-selection-end", String(widget.activeTableEdit.selectionEnd || 0));
    el.setAttribute("data-table-edit-focus-seq", String(widget.activeTableEdit.focusSeq || 0));
    el.setAttribute("data-table-edit-scroll-left", String(widget.activeTableEdit.scrollLeft || 0));
    el.setAttribute("data-table-edit-scroll-top", String(widget.activeTableEdit.scrollTop || 0));
  } else {
    el.removeAttribute("data-table-edit-active");
    el.removeAttribute("data-table-edit-row");
    el.removeAttribute("data-table-edit-col");
    el.removeAttribute("data-table-edit-offset");
    el.removeAttribute("data-table-edit-selection-end");
    el.removeAttribute("data-table-edit-focus-seq");
    el.removeAttribute("data-table-edit-scroll-left");
    el.removeAttribute("data-table-edit-scroll-top");
  }
}

function clearRenderedBlockWidgetMeasureSync(el) {
  if (!(el instanceof HTMLElement)) return;
  const cleanup = el.__notoBlockWidgetMeasureCleanup;
  if (typeof cleanup === "function") {
    try {
      cleanup();
    } catch (_) {}
  }
  delete el.__notoBlockWidgetMeasureCleanup;
  delete el.__notoBlockWidgetMeasureView;
}

function ensureRenderedBlockWidgetMeasureSync(el, view) {
  if (!(el instanceof HTMLElement) || !view || typeof view.requestMeasure !== "function") return;
  if (el.__notoBlockWidgetMeasureView === view && typeof el.__notoBlockWidgetMeasureCleanup === "function") {
    return;
  }

  clearRenderedBlockWidgetMeasureSync(el);

  let raf = 0;
  const imageListenerCleanups = [];
  const scheduleMeasure = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!el.isConnected) return;
      try {
        view.requestMeasure();
      } catch (_) {}
    });
  };

  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
        scheduleMeasure();
      })
    : null;
  if (resizeObserver) resizeObserver.observe(el);

  Array.from(el.querySelectorAll("img")).forEach((img) => {
    if (!(img instanceof HTMLImageElement)) return;
    const handleImageMeasure = () => {
      scheduleMeasure();
    };
    img.addEventListener("load", handleImageMeasure);
    img.addEventListener("error", handleImageMeasure);
    imageListenerCleanups.push(() => {
      img.removeEventListener("load", handleImageMeasure);
      img.removeEventListener("error", handleImageMeasure);
    });
    if (img.complete) scheduleMeasure();
  });

  el.__notoBlockWidgetMeasureView = view;
  el.__notoBlockWidgetMeasureCleanup = () => {
    if (raf) cancelAnimationFrame(raf);
    if (resizeObserver) resizeObserver.disconnect();
    for (const cleanup of imageListenerCleanups) {
      try {
        cleanup();
      } catch (_) {}
    }
  };

  scheduleMeasure();
}

class RenderedBlockWidget extends WidgetType {
  constructor(html, from, to, kind = "block", estimatedHeight = -1, activeTableEdit = null) {
    super();
    this.html = html || "";
    this.from = from;
    this.to = to;
    this.kind = kind;
    this._estimatedHeight = Number.isFinite(estimatedHeight) ? estimatedHeight : -1;
    this.activeTableEdit = activeTableEdit && typeof activeTableEdit === "object"
      ? {
          row: Number.isFinite(activeTableEdit.row) ? activeTableEdit.row : null,
          col: Number.isFinite(activeTableEdit.col) ? activeTableEdit.col : null,
          offset: Number.isFinite(activeTableEdit.offset) ? activeTableEdit.offset : 0,
          selectionEnd: Number.isFinite(activeTableEdit.selectionEnd) ? activeTableEdit.selectionEnd : 0,
          focusSeq: Number.isFinite(activeTableEdit.focusSeq) ? activeTableEdit.focusSeq : 0,
          scrollLeft: Number.isFinite(activeTableEdit.scrollLeft) ? activeTableEdit.scrollLeft : 0,
          scrollTop: Number.isFinite(activeTableEdit.scrollTop) ? activeTableEdit.scrollTop : 0
        }
      : null;
  }
  eq(other) {
    return (
      other &&
      other.html === this.html &&
      other.from === this.from &&
      other.to === this.to &&
      other.kind === this.kind &&
      other._estimatedHeight === this._estimatedHeight &&
      (
        (!other.activeTableEdit && !this.activeTableEdit) ||
        (
          other.activeTableEdit &&
          this.activeTableEdit &&
          other.activeTableEdit.row === this.activeTableEdit.row &&
          other.activeTableEdit.col === this.activeTableEdit.col &&
          other.activeTableEdit.offset === this.activeTableEdit.offset &&
          other.activeTableEdit.selectionEnd === this.activeTableEdit.selectionEnd &&
          other.activeTableEdit.focusSeq === this.activeTableEdit.focusSeq &&
          other.activeTableEdit.scrollLeft === this.activeTableEdit.scrollLeft &&
          other.activeTableEdit.scrollTop === this.activeTableEdit.scrollTop
        )
      )
    );
  }
  toDOM(view) {
    const el = document.createElement("div");
    el.className = "cm-block-render";
    el.innerHTML = String(this.html || "").trim();
    wrapOverflowTables(el);
    // markdown-it commonly emits trailing newlines. Remove edge whitespace nodes
    // to avoid an extra empty text line under rendered block widgets.
    while (
      el.firstChild &&
      el.firstChild.nodeType === 3 &&
      !(el.firstChild.textContent || "").trim()
    ) {
      el.removeChild(el.firstChild);
    }
    while (
      el.lastChild &&
      el.lastChild.nodeType === 3 &&
      !(el.lastChild.textContent || "").trim()
    ) {
      el.removeChild(el.lastChild);
    }
    if (this.kind === "html") {
      pruneHtmlWhitespaceTextNodes(el);
      normalizeHtmlBoundaryMargins(el);
    }
    applyRenderedBlockWidgetStateToDom(el, this);
    bindOverflowTableInteractions(el);
    ensureRenderedBlockWidgetMeasureSync(el, view);
    return el;
  }
  updateDOM(dom, view) {
    if (!(dom instanceof HTMLElement)) return false;
    if (dom.__notoRenderedHtml !== this.html) return false;
    if (String(dom.getAttribute("data-kind") || "") !== this.kind) return false;
    const shell = dom.querySelector(".noto-table-shell");
    if (
      this.activeTableEdit ||
      dom.getAttribute("data-table-edit-active") === "true" ||
      (shell instanceof HTMLElement && shell.classList.contains("is-editing"))
    ) {
      return false;
    }
    applyRenderedBlockWidgetStateToDom(dom, this);
    bindOverflowTableInteractions(dom);
    ensureRenderedBlockWidgetMeasureSync(dom, view);
    return true;
  }
  destroy(dom) {
    clearRenderedBlockWidgetMeasureSync(dom);
  }
  ignoreEvent() {
    return false;
  }
  get estimatedHeight() {
    return this._estimatedHeight;
  }
}

class HiddenMarkerWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-formatting-hidden";
    return span;
  }
}

class BracketReferenceWidget extends WidgetType {
  constructor(label, resolved) {
    super();
    this.label = String(label || "");
    this.resolved = normalizeBracketReferenceResult(resolved, this.label);
  }
  eq(other) {
    return (
      other &&
      other.label === this.label &&
      ((other.resolved && other.resolved.kind) || "") === ((this.resolved && this.resolved.kind) || "") &&
      ((other.resolved && other.resolved.href) || "") === ((this.resolved && this.resolved.href) || "") &&
      ((other.resolved && other.resolved.noteRef) || "") === ((this.resolved && this.resolved.noteRef) || "") &&
      ((other.resolved && other.resolved.headingRef) || "") === ((this.resolved && this.resolved.headingRef) || "")
    );
  }
  toDOM() {
    const safeLabel = String(this.label || "");
    const resolved = this.resolved || resolveBracketReference(safeLabel.trim() || safeLabel);
    const anchor = document.createElement("a");
    anchor.className = `${BRACKET_LINK_WIDGET_CLASS} bracket-link ${
      resolved && resolved.kind === "note"
        ? "note-ref-link"
        : resolved && resolved.kind === "heading"
          ? "heading-bracket-link"
          : "external-bracket-link"
    }`;
    anchor.setAttribute("href", resolved && resolved.href ? resolved.href : "#");
    if (resolved && resolved.kind === "note" && resolved.noteRef) {
      anchor.setAttribute("data-note-ref", resolved.noteRef);
      anchor.setAttribute("data-custom-title", "");
    } else if (resolved && resolved.kind === "heading" && resolved.headingRef) {
      anchor.setAttribute("data-heading-ref", resolved.headingRef);
    }
    anchor.textContent = safeLabel;
    return anchor;
  }
  ignoreEvent() {
    return false;
  }
}

class TaskCheckboxWidget extends WidgetType {
  constructor(pos, checked) {
    super();
    this.pos = pos;
    this.checked = Boolean(checked);
  }
  eq(other) {
    return other && other.pos === this.pos && other.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-checkbox";
    box.checked = this.checked;
    box.setAttribute("data-md-pos", String(this.pos));
    return box;
  }
  ignoreEvent() {
    // Let editor-level mouse handlers receive checkbox events.
    return false;
  }
}

class ListMarkerWidget extends WidgetType {
  constructor(text, kind = "unordered") {
    super();
    this.text = String(text || "");
    this.kind = kind;
  }
  eq(other) {
    return other && other.text === this.text && other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-list-marker cm-list-marker-${this.kind}`;
    el.textContent = this.text;
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class InlineMathWidget extends WidgetType {
  constructor(expr) {
    super();
    this.expr = String(expr || "");
  }
  eq(other) {
    return other && other.expr === this.expr;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-inline-math";
    const w = typeof window !== "undefined" ? window : globalThis;
    if (w && w.katex && typeof w.katex.renderToString === "function") {
      try {
        el.innerHTML = w.katex.renderToString(this.expr, getKatexRenderOptions(false));
        return el;
      } catch (_) {}
    }
    el.textContent = `$${this.expr}$`;
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

function findInlineMathRanges(text) {
  const ranges = [];
  const src = String(text || "");
  let i = 0;

  while (i < src.length) {
    const open = src.indexOf("$", i);
    if (open < 0) break;

    const prev = open > 0 ? src[open - 1] : "";
    const next = open + 1 < src.length ? src[open + 1] : "";
    if (prev === "\\" || prev === "$" || next === "$") {
      i = open + 1;
      continue;
    }

    let close = open + 1;
    while (close < src.length) {
      if (
        src[close] === "$" &&
        src[close - 1] !== "\\" &&
        (close + 1 >= src.length || src[close + 1] !== "$")
      ) {
        break;
      }
      close += 1;
    }
    if (close >= src.length) {
      i = open + 1;
      continue;
    }

    const expr = src.slice(open + 1, close);
    if (!expr.trim()) {
      i = close + 1;
      continue;
    }

    ranges.push({ from: open, to: close + 1, expr });
    i = close + 1;
  }

  i = 0;
  while (i < src.length) {
    const open = src.indexOf("\\(", i);
    if (open < 0) break;
    if (open > 0 && src[open - 1] === "\\") {
      i = open + 2;
      continue;
    }
    let close = open + 2;
    while (close < src.length - 1) {
      if (src[close] === "\\" && src[close + 1] === ")" && src[close - 1] !== "\\") break;
      close += 1;
    }
    if (close >= src.length - 1) {
      i = open + 2;
      continue;
    }
    const expr = src.slice(open + 2, close);
    const from = open;
    const to = close + 2;
    const overlaps = ranges.some((range) => from < range.to && to > range.from);
    if (expr.trim() && !overlaps) ranges.push({ from, to, expr });
    i = close + 2;
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return ranges;
}

/* ---------- Live preview (block render) ---------- */
function collectBlocks(state) {
  const lines = state.doc.lines;
  const get = (n) => (n >= 1 && n <= lines ? state.doc.line(n).text || "" : "");
  const lineToEnd = (n) => {
    const lineInfo = state.doc.line(n);
    return lineInfo.to;
  };
  // Keep the terminating newline outside rendered block replacements so the
  // following editable line remains owned by CodeMirror's normal text layout.
  const blocks = [];
  let line = 1;
  const isMarkdownTableDividerLine = (value) => {
    const parts = String(value || "").trim().split("|").map((part) => part.trim());
    if (parts.length && parts[0] === "") parts.shift();
    if (parts.length && parts[parts.length - 1] === "") parts.pop();
    return parts.length > 0 && parts.every((part) => /^:?-{3,}:?$/.test(part));
  };
  const htmlTagStart = /^\s*<([A-Za-z][\w:-]*)(?:\s[^>]*)?>/;
  const htmlTagSelfClosing = /^\s*<([A-Za-z][\w:-]*)(?:\s[^>]*)?\/>\s*$/;
  const htmlTagInlineClosed = /^\s*<([A-Za-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$/i;
  const htmlComment = /^<!--[\s\S]*-->\s*$/;
  const htmlDocType = /^<!doctype[\s\S]*>$/i;
  const htmlProcessingInstruction = /^<\?[\s\S]*\?>$/;
  const htmlTagClose = (tag) => new RegExp(`^\\s*</${tag}>\\s*$`, "i");
  const htmlTagOpen = (tag) => new RegExp(`^\\s*<${tag}(?:\\s[^>]*)?>\\s*$`, "i");
  const htmlVoidTags = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr"
  ]);

  while (line <= lines) {
    const text = get(line);
    const trimmed = text.trim();
    const from = state.doc.line(line).from;

    // fenced code
    const fence = trimmed.match(/^(```+|~~~+)(.*)$/);
    if (fence) {
      const marker = fence[1];
      let end = line;
      for (let i = line + 1; i <= lines; i += 1) {
        end = i;
        if (get(i).trim().startsWith(marker)) break;
      }
      const to = lineToEnd(end);
      blocks.push({ from, to, kind: "code", raw: state.doc.sliceString(from, to, "\n") });
      line = end + 1;
      continue;
    }

    // math block
    if (trimmed === "$$" || trimmed === "\\[") {
      const closeDelimiter = trimmed === "$$" ? "$$" : "\\]";
      let end = line;
      for (let i = line + 1; i <= lines; i += 1) {
        end = i;
        if (get(i).trim() === closeDelimiter) break;
      }
      const to = lineToEnd(end);
      blocks.push({ from, to, kind: "math", raw: state.doc.sliceString(from, to, "\n") });
      line = end + 1;
      continue;
    }

    const beginMathEnv = trimmed.match(/^\\begin\{([A-Za-z*]+)\}\s*$/);
    if (beginMathEnv) {
      const envName = beginMathEnv[1];
      const closeRe = new RegExp(`^\\\\end\\{${envName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}\\s*$`);
      let end = line;
      for (let i = line + 1; i <= lines; i += 1) {
        end = i;
        if (closeRe.test(get(i).trim())) break;
      }
      const to = lineToEnd(end);
      blocks.push({ from, to, kind: "math", raw: state.doc.sliceString(from, to, "\n") });
      line = end + 1;
      continue;
    }

    // table
    if (line < lines && /\|/.test(text) && isMarkdownTableDividerLine(get(line + 1))) {
      let end = line + 1;
      for (let i = line + 2; i <= lines; i += 1) {
        const row = get(i);
        if (!row.trim() || !/\|/.test(row)) break;
        end = i;
      }
      const to = lineToEnd(end);
      blocks.push({ from, to, kind: "table", raw: state.doc.sliceString(from, to, "\n") });
      line = end + 1;
      continue;
    }

    // HTML blocks
    if (trimmed.startsWith("<")) {
      const selfClosing = trimmed.match(htmlTagSelfClosing);
      if (selfClosing) {
        const to = lineToEnd(line);
        const raw = state.doc.sliceString(from, to, "\n");
        if (isImportedImageHtml(raw)) {
          blocks.push({ from, to, kind: "image", raw });
          line += 1;
          continue;
        }
      }
      if (htmlComment.test(trimmed) || htmlDocType.test(trimmed) || htmlProcessingInstruction.test(trimmed)) {
        const to = lineToEnd(line);
        const raw = state.doc.sliceString(from, to, "\n");
        if (isImportedImageHtml(raw)) {
          blocks.push({ from, to, kind: "image", raw });
          line += 1;
          continue;
        }
      }
      const inlineClosed = trimmed.match(htmlTagInlineClosed);
      if (inlineClosed) {
        const to = lineToEnd(line);
        const raw = state.doc.sliceString(from, to, "\n");
        if (isImportedImageHtml(raw)) {
          blocks.push({ from, to, kind: "image", raw });
          line += 1;
          continue;
        }
      }
      const opening = trimmed.match(htmlTagStart);
      if (opening) {
        const tag = opening[1].toLowerCase();
        if (htmlVoidTags.has(tag)) {
          const to = lineToEnd(line);
          const raw = state.doc.sliceString(from, to, "\n");
          if (isImportedImageHtml(raw)) {
            blocks.push({ from, to, kind: "image", raw });
            line += 1;
            continue;
          }
        }
        let end = line;
        let depth = 0;
        const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi");
        const closeRe = new RegExp(`</${tag}>`, "gi");
        const selfRe = new RegExp(`<${tag}(?:\\s[^>]*)?/>`, "gi");
        for (let i = line; i <= lines; i += 1) {
          const row = get(i);
          const selfMatches = (row.match(selfRe) || []).length;
          const openMatches = Math.max(0, (row.match(openRe) || []).length - selfMatches);
          const closeMatches = (row.match(closeRe) || []).length;
          depth += openMatches - closeMatches;
          end = i;
          if (depth <= 0) break;
          const rowTrimmed = row.trim();
          if (!rowTrimmed && i > line && depth <= 0) break;
        }
        const to = lineToEnd(end);
        const raw = state.doc.sliceString(from, to, "\n");
        if (isImportedImageHtml(raw)) {
          blocks.push({ from, to, kind: "image", raw });
          line = end + 1;
          continue;
        }
      }
    }

    // standalone image lines render like preview
    if (/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(text)) {
      const to = lineToEnd(line);
      blocks.push({ from, to, kind: "image", raw: state.doc.sliceString(from, to, "\n") });
      line += 1;
      continue;
    }

    // blank lines: skip
    if (!trimmed) {
      line += 1;
      continue;
    }

    // Keep normal text/headings/lists native so clicking reveals syntax without losing styling.
    line += 1;
  }
  return blocks;
}

function estimateRenderedBlockHeight(kind, raw) {
  const lineCount = Math.max(1, String(raw || "").split("\n").length);
  if (kind === "image") return 220;
  if (kind === "table") return (lineCount * 28) + 10;
  if (kind === "math") return (lineCount * 30) + 16;
  if (kind === "code") return (lineCount * 23) + 20;
  if (kind === "html") return (lineCount * 24) + 14;
  return (lineCount * 22) + 12;
}

function getNonEmptySelectionRanges(state) {
  if (!state || !state.selection || !Array.isArray(state.selection.ranges)) return [];
  return state.selection.ranges
    .filter((range) => range && !range.empty)
    .map((range) => ({ from: range.from, to: range.to }));
}

function selectionIntersectsRange(selectionRanges, from, to) {
  if (!Array.isArray(selectionRanges) || !selectionRanges.length) return false;
  return selectionRanges.some((range) => range.from < to && range.to > from);
}

function getSelectableLineExtent(state, line) {
  if (!state || !line) return { from: 0, to: 0 };
  const lineEnd = line.number < state.doc.lines
    ? Math.min(state.doc.length, line.to + 1)
    : line.to;
  return {
    from: line.from,
    to: Math.max(line.from, lineEnd)
  };
}

function isLineRevealedBySelection(state, line, selectionRanges, activeLineNumber) {
  if (!line) return false;
  if (!selectionRanges.length) return line.number === activeLineNumber;
  const extent = getSelectableLineExtent(state, line);
  return selectionIntersectsRange(selectionRanges, extent.from, extent.to);
}

function buildRenderableBlockEntries(state, options = {}) {
  const kinds = options && options.kinds instanceof Set ? options.kinds : null;
  const entries = [];
  for (const block of collectBlocks(state)) {
    if (kinds && !kinds.has(block.kind)) continue;
    let html = "";
    try {
      html = renderMarkdown(block.raw || "", { kind: block.kind || "block" });
    } catch (_) {
      html = "";
    }
    if (!html) continue;
    entries.push({
      from: block.from,
      to: block.to,
      raw: block.raw || "",
      kind: block.kind || "block",
      html,
      estimatedHeight: estimateRenderedBlockHeight(block.kind || "block", block.raw || "")
    });
  }
  return entries;
}

function addRenderedBlockSourceLineDecorations(state, ranges, from, to) {
  if (!state || !state.doc || !Array.isArray(ranges)) return;
  const docLen = state.doc.length;
  const safeFrom = Math.max(0, Math.min(docLen, from));
  const safeTo = Math.max(safeFrom, Math.min(docLen, to));
  const endProbe = Math.max(safeFrom, Math.min(docLen, safeTo > safeFrom ? safeTo - 1 : safeTo));
  const startLine = state.doc.lineAt(safeFrom);
  const endLine = state.doc.lineAt(endProbe);

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    ranges.push(
      Decoration.line({
        class: "cm-rendered-block-source-hidden"
      }).range(line.from)
    );
  }
}

function buildBlockDecorationsFromEntries(state, blockEntries = []) {
  const sel = state.selection.main;
  const caret = sel.head;
  const assoc = Number.isFinite(sel.assoc) ? sel.assoc : 0;
  const caretLineNumber = state.doc.lineAt(Math.max(0, Math.min(state.doc.length, caret))).number;
  const activeTableEdit = state.field(activeTableEditField, false);
  const selectionRanges = getNonEmptySelectionRanges(state);
  const ranges = [];

  for (const block of blockEntries) {
    const tableEditForBlock = (
      activeTableEdit &&
      block.kind === "table" &&
      activeTableEdit.from === block.from &&
      activeTableEdit.to === block.to
    ) ? activeTableEdit : null;
    const intersects =
      (caret > block.from && caret < block.to) ||
      (caret === block.from && assoc >= 0) ||
      (caret === block.to && assoc < 0);
    const mathLineIntersects = (() => {
      if (block.kind !== "math") return false;
      const blockEndPos = Math.max(block.from, Math.min(state.doc.length, block.to - 1));
      const startLine = state.doc.lineAt(block.from).number;
      const endLine = state.doc.lineAt(blockEndPos).number;
      return caretLineNumber >= startLine && caretLineNumber <= endLine;
    })();
    const selectionIntersectsBlock = selectionIntersectsRange(selectionRanges, block.from, block.to);
    if (
      (selectionIntersectsBlock || ((intersects || mathLineIntersects) && block.kind !== "image"))
      && !tableEditForBlock
    ) continue;
    ranges.push(
      Decoration.widget({
        widget: new RenderedBlockWidget(
          block.html,
          block.from,
          block.to,
          block.kind,
          block.estimatedHeight,
          tableEditForBlock
        ),
        block: true,
        side: -1
      }).range(block.from)
    );
    addRenderedBlockSourceLineDecorations(state, ranges, block.from, block.to);
  }

  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

function buildStructureLineDecorations(state) {
  const ranges = [];
  const headingRe = /^\s*(#{1,6})\s+/;
  const quoteRe = /^\s*>\s?/;
  const hrRe = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

  for (let i = 1; i <= state.doc.lines; i += 1) {
    const line = state.doc.line(i);
    const text = line.text || "";
    const heading = text.match(headingRe);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      ranges.push(
        Decoration.line({
          class: `cm-md-heading cm-md-heading-${level}`
        }).range(line.from)
      );
    }
    if (quoteRe.test(text)) {
      ranges.push(
        Decoration.line({
          class: "cm-md-quote-line"
        }).range(line.from)
      );
    }
    if (hrRe.test(text.trim())) {
      ranges.push(
        Decoration.line({
          class: "cm-md-hr-line"
        }).range(line.from)
      );
    }
  }

  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

function createBlockPreviewField(options = {}) {
  return StateField.define({
    create(state) {
      const entries = buildRenderableBlockEntries(state, options);
      return {
        entries,
        decorations: buildBlockDecorationsFromEntries(state, entries)
      };
    },
    update(value, tr) {
      const shouldRefresh = tr.docChanged || tr.effects.some((effect) => effect.is(refreshBracketRenderingEffect));
      const entries = shouldRefresh
        ? buildRenderableBlockEntries(tr.state, options)
        : (value && Array.isArray(value.entries) ? value.entries : []);
      return {
        entries,
        decorations: buildBlockDecorationsFromEntries(tr.state, entries)
      };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => {
      return value && value.decorations ? value.decorations : Decoration.none;
    })
  });
}

const blockPreviewField = createBlockPreviewField();

const rawImagePreviewField = createBlockPreviewField({ kinds: new Set(["image"]) });

const setActiveTableEditEffect = StateEffect.define({
  map(value, mapping) {
    if (!value || typeof value !== "object") return null;
    const from = mapping.mapPos(value.from, 1);
    const to = mapping.mapPos(value.to, -1);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    return {
      ...value,
      from,
      to
    };
  }
});

function normalizeActiveTableEditState(value) {
  if (!value || typeof value !== "object") return null;
  const from = Number.parseInt(value.from, 10);
  const to = Number.parseInt(value.to, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const offset = Number.isFinite(value.offset) ? Math.max(0, Math.floor(value.offset)) : 0;
  return {
    from,
    to,
    row: Number.isFinite(value.row) ? Math.max(0, Math.floor(value.row)) : null,
    col: Number.isFinite(value.col) ? Math.max(0, Math.floor(value.col)) : null,
    offset,
    selectionEnd: Number.isFinite(value.selectionEnd)
      ? Math.max(offset, Math.floor(value.selectionEnd))
      : offset,
    focusSeq: Number.isFinite(value.focusSeq) ? Math.max(0, Math.floor(value.focusSeq)) : 0,
    scrollLeft: Number.isFinite(value.scrollLeft) ? Math.max(0, value.scrollLeft) : 0,
    scrollTop: Number.isFinite(value.scrollTop) ? Math.max(0, value.scrollTop) : 0
  };
}

function getNextActiveTableEditFocusSeq(state) {
  const current = state ? state.field(activeTableEditField, false) : null;
  return current && Number.isFinite(current.focusSeq) ? current.focusSeq + 1 : 1;
}

const activeTableEditField = StateField.define({
  create() {
    return null;
  },
  update(value, tr) {
    let next = value;
    if (next && tr.docChanged) {
      const mappedFrom = tr.changes.mapPos(next.from, 1);
      const mappedTo = tr.changes.mapPos(next.to, -1);
      next = mappedTo > mappedFrom
        ? {
            ...next,
            from: mappedFrom,
            to: mappedTo
          }
        : null;
    }
    for (const effect of tr.effects) {
      if (effect.is(setActiveTableEditEffect)) {
        next = normalizeActiveTableEditState(effect.value);
      }
    }
    return next;
  }
});

const structureLineField = StateField.define({
  create(state) {
    return buildStructureLineDecorations(state);
  },
  update(value, tr) {
    if (tr.docChanged) {
      return buildStructureLineDecorations(tr.state);
    }
    return value;
  }
});

class VersionHistoryGapWidget extends WidgetType {
  constructor(heightPx = 0) {
    super();
    this.heightPx = Number.isFinite(heightPx) ? Math.max(0, heightPx) : 0;
  }
  eq(other) {
    return other && Number.isFinite(other.heightPx) && Math.abs(other.heightPx - this.heightPx) < 0.01;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-vh-gap-widget";
    el.style.height = `${Math.max(0, this.heightPx).toFixed(2)}px`;
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const setVersionHistoryGapEffect = StateEffect.define();

function normalizeVersionHistoryGapPayload(payload) {
  const normalized = {
    entries: [],
    trailingHeightPx: 0
  };
  if (!payload || typeof payload !== "object") return normalized;
  const trailing = Number(payload.trailingHeightPx);
  if (Number.isFinite(trailing) && trailing > 0) normalized.trailingHeightPx = trailing;
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const merged = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const line = Number.parseInt(entry.line, 10);
    const heightPx = Number(entry.heightPx);
    if (!Number.isFinite(line) || line <= 0) continue;
    if (!Number.isFinite(heightPx) || heightPx <= 0) continue;
    merged.set(line, (merged.get(line) || 0) + heightPx);
  }
  merged.forEach((heightPx, line) => {
    normalized.entries.push({ line, heightPx });
  });
  normalized.entries.sort((a, b) => a.line - b.line);
  return normalized;
}

function buildVersionHistoryGapDecorations(state, payload) {
  const normalized = normalizeVersionHistoryGapPayload(payload);
  const ranges = [];
  const maxLine = Math.max(1, state.doc.lines);
  for (const entry of normalized.entries) {
    const lineNo = Math.max(1, Math.min(maxLine, Number(entry.line)));
    const line = state.doc.line(lineNo);
    const heightPx = Number(entry.heightPx);
    if (!(heightPx > 0)) continue;
    ranges.push(
      Decoration.widget({
        widget: new VersionHistoryGapWidget(heightPx),
        side: 1,
        block: true
      }).range(line.to)
    );
  }
  if (normalized.trailingHeightPx > 0) {
    ranges.push(
      Decoration.widget({
        widget: new VersionHistoryGapWidget(normalized.trailingHeightPx),
        side: 1,
        block: true
      }).range(state.doc.length)
    );
  }
  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

const versionHistoryGapField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setVersionHistoryGapEffect)) {
        return buildVersionHistoryGapDecorations(tr.state, effect.value);
      }
    }
    if (tr.docChanged) return value.map(tr.changes);
    return value;
  },
  provide: (field) => EditorView.decorations.from(field)
});

function revealRenderedBlock(event, view) {
  const block = findRenderedBlockForEvent(event, view);
  if (!block) return false;
  const kind = String(block.getAttribute("data-kind") || "").toLowerCase();
  if (kind === "image") {
    event.preventDefault();
    view.focus();
    return true;
  }
  const from = Number.parseInt(block.getAttribute("data-from") || "", 10);
  const to = Number.parseInt(block.getAttribute("data-to") || "", 10);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  const docLen = view.state.doc.length;
  const safeFrom = Math.max(0, Math.min(docLen, from));
  const safeTo = Math.max(safeFrom, Math.min(docLen, to));
  const revealTo = safeTo > safeFrom ? safeTo - 1 : safeFrom;
  const clickX = event.clientX;
  const clickY = event.clientY;
  let mapped = view.posAtCoords({ x: clickX, y: clickY });
  if (!Number.isFinite(mapped)) mapped = view.posAtCoords({ x: clickX, y: clickY }, false);
  let clamped = Number.isFinite(mapped) ? Math.max(safeFrom, Math.min(revealTo, mapped)) : safeFrom;

  if (!Number.isFinite(mapped)) {
    const rect = block.getBoundingClientRect();
    if (Number.isFinite(rect.top) && Number.isFinite(rect.bottom) && clickY > ((rect.top + rect.bottom) / 2)) {
      clamped = revealTo;
    }
  }

  view.dispatch({ selection: EditorSelection.cursor(clamped, clamped <= safeFrom ? 1 : -1) });
  view.focus();

  event.preventDefault();
  return true;
}

function getDocRangeForPaperTargetHost(view, host) {
  if (!view || !(host instanceof HTMLElement)) return null;
  const docLen = view.state && view.state.doc ? view.state.doc.length : 0;
  const blockEl = host.querySelector(".cm-block-render[data-from]");
  if (blockEl instanceof HTMLElement) {
    const rawFrom = Number.parseInt(blockEl.getAttribute("data-from") || "", 10);
    const rawTo = Number.parseInt(blockEl.getAttribute("data-to") || "", 10);
    if (Number.isFinite(rawFrom)) {
      const safeFrom = Math.max(0, Math.min(docLen, rawFrom));
      const safeTo = Number.isFinite(rawTo)
        ? Math.max(safeFrom, Math.min(docLen, rawTo))
        : safeFrom;
      return { from: safeFrom, to: safeTo };
    }
  }

  const pos = getDomPosSafe(view, host);
  if (!Number.isFinite(pos)) return null;
  try {
    const line = view.state.doc.lineAt(pos);
    return { from: line.from, to: line.to };
  } catch (_) {
    const safePos = Math.max(0, Math.min(docLen, pos));
    return { from: safePos, to: safePos };
  }
}

function getNearestPaperTargetHost(view, clickY) {
  if (!view || !view.contentDOM || !Number.isFinite(clickY)) return null;
  return pickNearestHostByY(
    clickY,
    Array.from(view.contentDOM.querySelectorAll(".cm-line, .cm-widgetBlock"))
  );
}

function getNearestPaperCaretTarget(view, clickX, clickY, options = {}) {
  if (!view || !Number.isFinite(clickX) || !Number.isFinite(clickY)) return null;
  const forceHostFallback = Boolean(options && options.forceHostFallback);
  let pos = forceHostFallback ? NaN : view.posAtCoords({ x: clickX, y: clickY }, false);
  let assoc = 1;
  if (Number.isFinite(pos)) {
    return {
      pos: Math.max(0, Math.min(view.state.doc.length, pos)),
      assoc
    };
  }

  const host = getNearestPaperTargetHost(view, clickY);
  if (!(host instanceof HTMLElement)) return null;
  const hostRect = host.getBoundingClientRect();
  const safeRange = getDocRangeForPaperTargetHost(view, host);
  if (!hostRect || !safeRange) return null;

  const lineFrom = Math.max(0, Math.min(view.state.doc.length, safeRange.from));
  const lineTo = Math.max(lineFrom, Math.min(view.state.doc.length, safeRange.to));
  const hasVisibleHeight = Number.isFinite(hostRect.height) && hostRect.height > 2;
  const clampedY = hasVisibleHeight
    ? Math.max(hostRect.top + 1, Math.min(hostRect.bottom - 1, clickY))
    : hostRect.top + (hostRect.height / 2);
  const fallbackY = Number.isFinite(clampedY) ? clampedY : (hostRect.top + hostRect.height / 2);
  const startRect = view.coordsAtPos(lineFrom, 1);
  const endRect = view.coordsAtPos(lineTo, lineTo > lineFrom ? -1 : 1);
  let fallbackPos = lineFrom;

  if (startRect && endRect) {
    const minX = Math.min(startRect.left, endRect.left);
    const maxX = Math.max(startRect.right, endRect.right);
    const clampedX = maxX > minX
      ? Math.max(minX + 1, Math.min(maxX - 1, clickX))
      : minX + 1;
    pos = view.posAtCoords({ x: clampedX, y: fallbackY }, false);
    if (!Number.isFinite(pos)) fallbackPos = clickX <= minX ? lineFrom : lineTo;
    assoc = clickX <= minX ? 1 : -1;
  } else {
    const rectX = Number.isFinite(hostRect.left) && Number.isFinite(hostRect.right)
      ? Math.max(hostRect.left + 1, Math.min(hostRect.right - 1, clickX))
      : clickX;
    pos = view.posAtCoords({ x: rectX, y: fallbackY }, false);
  }

  if (!Number.isFinite(pos)) {
    const docTop = Number(view.documentTop);
    const block = Number.isFinite(docTop) ? view.lineBlockAtHeight(fallbackY - docTop) : null;
    if (!block || !Number.isFinite(block.from)) return null;

    const blockFrom = Math.max(0, Math.min(view.state.doc.length, block.from));
    const blockTo = Number.isFinite(block.to)
      ? Math.max(blockFrom, Math.min(view.state.doc.length, block.to))
      : blockFrom;
    const blockStartRect = view.coordsAtPos(blockFrom, 1);
    const blockEndRect = view.coordsAtPos(blockTo, blockTo > blockFrom ? -1 : 1);
    fallbackPos = blockFrom;

    if (blockStartRect && blockEndRect) {
      const minX = Math.min(blockStartRect.left, blockEndRect.left);
      const maxX = Math.max(blockStartRect.right, blockEndRect.right);
      const clampedX = maxX > minX
        ? Math.max(minX + 1, Math.min(maxX - 1, clickX))
        : minX + 1;
      pos = view.posAtCoords({ x: clampedX, y: fallbackY }, false);
      if (!Number.isFinite(pos)) fallbackPos = clickX <= minX ? blockFrom : blockTo;
      assoc = clickX <= minX ? 1 : -1;
    }

    if (!Number.isFinite(pos)) pos = fallbackPos;
  }

  if (!Number.isFinite(pos)) return null;
  return {
    pos: Math.max(0, Math.min(view.state.doc.length, pos)),
    assoc
  };
}

const pendingBackgroundPointerByView = new WeakMap();
const lastFinishedBackgroundPointerByView = new WeakMap();
const backgroundPointerHooksByView = new WeakMap();
const BACKGROUND_POINTER_DRAG_THRESHOLD_PX = 6;
const BACKGROUND_POINTER_CLICK_SUPPRESS_MS = 450;

function setBackgroundPointerHooks(view, hooks = null) {
  if (!view) return;
  if (!hooks) {
    backgroundPointerHooksByView.delete(view);
    return;
  }
  backgroundPointerHooksByView.set(view, hooks);
}

function notifyBackgroundPointerHooks(view, method) {
  if (!view || !method) return;
  const hooks = backgroundPointerHooksByView.get(view);
  if (!hooks || typeof hooks[method] !== "function") return;
  try {
    hooks[method]();
  } catch (_) {}
}

function clearPendingBackgroundPointer(view) {
  if (!view) return;
  pendingBackgroundPointerByView.delete(view);
  notifyBackgroundPointerHooks(view, "onEnd");
}

function getPendingBackgroundPointer(view) {
  if (!view) return null;
  return pendingBackgroundPointerByView.get(view) || null;
}

function setPendingBackgroundPointer(view, pointer) {
  if (!view || !pointer) return;
  pendingBackgroundPointerByView.set(view, pointer);
  notifyBackgroundPointerHooks(view, "onStart");
}

function setLastFinishedBackgroundPointer(view, payload) {
  if (!view || !payload) return;
  lastFinishedBackgroundPointerByView.set(view, payload);
}

function consumeFinishedBackgroundPointerClick(event, view) {
  if (!event || !view) return false;
  const payload = lastFinishedBackgroundPointerByView.get(view);
  if (!payload) return false;
  const ageMs = Date.now() - payload.time;
  if (ageMs > BACKGROUND_POINTER_CLICK_SUPPRESS_MS) {
    lastFinishedBackgroundPointerByView.delete(view);
    return false;
  }
  const clickX = Number(event.clientX);
  const clickY = Number(event.clientY);
  if (!Number.isFinite(clickX) || !Number.isFinite(clickY)) {
    lastFinishedBackgroundPointerByView.delete(view);
    return false;
  }
  if (Math.hypot(clickX - payload.x, clickY - payload.y) > BACKGROUND_POINTER_DRAG_THRESHOLD_PX) {
    return false;
  }
  lastFinishedBackgroundPointerByView.delete(view);
  event.preventDefault();
  return true;
}

function isPointInsideRect(x, y, rect) {
  if (!rect || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function getEditorSurfaceRect(view) {
  if (!view) return null;
  const rects = [];
  const maybePushRect = (el) => {
    if (!(el instanceof HTMLElement)) return;
    const rect = el.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return;
    rects.push(rect);
  };
  maybePushRect(view.dom && view.dom.parentElement);
  maybePushRect(view.dom);
  maybePushRect(view.scrollDOM);
  maybePushRect(view.contentDOM);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, top, right, bottom };
}

function getBackgroundPointerSelection(anchor, head) {
  if (!anchor || !head) return null;
  const anchorPos = Math.max(0, Number(anchor.pos) || 0);
  const headPos = Math.max(0, Number(head.pos) || 0);
  if (headPos === anchorPos) return EditorSelection.cursor(anchorPos, anchor.assoc || 1);
  return EditorSelection.range(anchorPos, headPos);
}

function dispatchBackgroundPointerSelection(view, anchor, head, options = {}) {
  if (!view) return false;
  const selection = getBackgroundPointerSelection(anchor, head);
  if (!selection) return false;
  view.dispatch({
    selection,
    scrollIntoView: options.scrollIntoView !== false,
    userEvent: options.userEvent || "select.pointer"
  });
  view.focus();
  return true;
}

function finishBackgroundPointerSelection(view, pointer, clickX, clickY) {
  const target = Number.isFinite(clickX) && Number.isFinite(clickY)
    ? (getNearestPaperCaretTarget(view, clickX, clickY, {
      forceHostFallback: Boolean(pointer && pointer.forceHostFallback)
    }) || pointer.anchor)
    : pointer.anchor;
  if (!target) {
    view.focus();
    return false;
  }
  if (pointer.moved) {
    return dispatchBackgroundPointerSelection(view, pointer.anchor, target, {
      scrollIntoView: false,
      userEvent: "select.pointer"
    });
  }
  view.dispatch({
    selection: EditorSelection.cursor(target.pos, target.assoc),
    scrollIntoView: true,
    userEvent: "select.pointer"
  });
  view.focus();
  return true;
}

function getPaperInteractionInfo(event, view) {
  if (!event || !view) return null;
  const clickX = Number(event.clientX);
  const clickY = Number(event.clientY);
  if (!Number.isFinite(clickX) || !Number.isFinite(clickY)) return null;
  const surfaceRect = getEditorSurfaceRect(view);
  if (!surfaceRect || !isPointInsideRect(clickX, clickY, surfaceRect)) return null;

  const targetEl = getEventTargetElement(event);
  const lineEl = targetEl ? targetEl.closest(".cm-line") : null;
  const widgetBlockEl = targetEl ? targetEl.closest(".cm-widgetBlock") : null;
  const overlayEl = targetEl ? targetEl.closest(".cm-selectionLayer, .cm-cursorLayer") : null;
  const isRealTextLine = lineEl instanceof HTMLElement;
  const mappedPos = view.posAtCoords({ x: clickX, y: clickY }, false);
  const hasMappedDocumentPos = Number.isFinite(mappedPos);
  const isDocumentOverlay = overlayEl instanceof HTMLElement && Number.isFinite(mappedPos);
  const isWidgetHost = widgetBlockEl instanceof HTMLElement;
  const isInsideContentLayer = Boolean(
    targetEl
    && (
      (view.contentDOM instanceof HTMLElement && view.contentDOM.contains(targetEl))
      || targetEl.closest(".cm-selectionLayer, .cm-cursorLayer")
    )
  );
  const isOuterPaper = !isInsideContentLayer && !isWidgetHost && !isDocumentOverlay;

  return {
    targetEl,
    lineEl,
    isOuterPaper,
    isBackground: !isRealTextLine && !isWidgetHost && !isDocumentOverlay && (isOuterPaper || !hasMappedDocumentPos)
  };
}

function beginBackgroundPointerInteraction(event, view) {
  if (!event || !view || event.button !== 0) return false;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  const clickX = Number(event.clientX);
  const clickY = Number(event.clientY);
  if (!Number.isFinite(clickX) || !Number.isFinite(clickY)) return false;

  const info = getPaperInteractionInfo(event, view);
  if (!info || !info.isBackground) return false;
  const forceHostFallback = Boolean(info.isOuterPaper);
  const target = getNearestPaperCaretTarget(view, clickX, clickY, { forceHostFallback });
  if (!target) return false;

  setPendingBackgroundPointer(view, {
    startX: clickX,
    startY: clickY,
    anchor: target,
    moved: false,
    forceHostFallback
  });
  view.focus();
  event.preventDefault();
  return true;
}

function updateBackgroundPointerInteraction(event, view) {
  const pending = getPendingBackgroundPointer(view);
  if (!pending || !event) return false;
  const moveX = Number(event.clientX);
  const moveY = Number(event.clientY);
  if (!Number.isFinite(moveX) || !Number.isFinite(moveY)) return false;
  const dx = moveX - pending.startX;
  const dy = moveY - pending.startY;
  if (Math.hypot(dx, dy) <= BACKGROUND_POINTER_DRAG_THRESHOLD_PX) return false;
  pending.moved = true;
  setPendingBackgroundPointer(view, pending);
  const head = getNearestPaperCaretTarget(view, moveX, moveY, {
    forceHostFallback: Boolean(pending.forceHostFallback)
  }) || pending.anchor;
  if (!head) return false;
  dispatchBackgroundPointerSelection(view, pending.anchor, head, {
    scrollIntoView: false,
    userEvent: "select.pointer"
  });
  event.preventDefault();
  return true;
}

function finishBackgroundPointerInteraction(event, view) {
  const pending = getPendingBackgroundPointer(view);
  if (!pending) return false;
  clearPendingBackgroundPointer(view);
  if (!event || !view) return true;

  event.preventDefault();
  const clickX = Number(event.clientX);
  const clickY = Number(event.clientY);
  finishBackgroundPointerSelection(view, pending, clickX, clickY);
  if (Number.isFinite(clickX) && Number.isFinite(clickY)) {
    setLastFinishedBackgroundPointer(view, {
      x: clickX,
      y: clickY,
      time: Date.now()
    });
  }
  return true;
}

function getEventTargetElement(event) {
  if (!event) return null;
  const path = typeof event.composedPath === "function" ? event.composedPath() : null;
  if (Array.isArray(path)) {
    for (const node of path) {
      if (node instanceof Element) return node;
    }
  }
  const target = event.target;
  if (target instanceof Element) return target;
  if (
    target &&
    typeof target === "object" &&
    "nodeType" in target &&
    target.nodeType === 3 &&
    target.parentElement instanceof Element
  ) {
    return target.parentElement;
  }
  return null;
}

function getInteractiveAnchorFromEvent(event) {
  const targetEl = getEventTargetElement(event);
  if (!targetEl) return null;
  const anchor = targetEl.closest("a[href]");
  if (!anchor) return null;
  if (anchor.classList.contains(BRACKET_LINK_WIDGET_CLASS) || anchor.classList.contains("note-ref-link")) return anchor;
  if (!anchor.closest(".cm-block-render")) return null;
  return anchor;
}

function getInteractiveRenderedElementFromEvent(event) {
  const targetEl = getEventTargetElement(event);
  if (!targetEl) return null;
  const el = targetEl.closest(
    [
      ".noto-table-shell.is-editing",
      ".noto-table-shell.is-editing *",
      ".noto-imported-image",
      ".noto-imported-image img",
      ".noto-imported-image-resizer",
      "img",
      "figure",
      "button",
      "input",
      "select",
      "textarea",
      "label",
      "summary",
      "details",
      "audio",
      "video",
      "[role='button']",
      "[onclick]",
      "[contenteditable='true']",
      "[contenteditable='']"
    ].join(",")
  );
  if (!el) return null;
  if (!el.closest(".cm-block-render")) return null;
  return el;
}

function dispatchRenderedAnchorActivation(anchor) {
  if (!(anchor instanceof Element)) return;
  const href = String(anchor.getAttribute("href") || "");
  if (!href) return;
  const detail = {
    href,
    noteRef: String(anchor.getAttribute("data-note-ref") || "").trim(),
    text: String(anchor.textContent || "")
  };
  const host = typeof window !== "undefined" ? window : globalThis;
  if (!host || typeof host.dispatchEvent !== "function") return;
  try {
    host.dispatchEvent(new CustomEvent("noto-cm-link-activate", { detail }));
  } catch (_) {}
}

function toggleTaskCheckbox(checkbox, view) {
  if (!checkbox) return false;
  const pos = Number.parseInt(checkbox.getAttribute("data-md-pos") || "", 10);
  if (!Number.isFinite(pos)) return false;
  const docLen = view.state.doc.length;
  const safePos = Math.max(0, Math.min(docLen - 1, pos));
  const current = view.state.doc.sliceString(safePos, safePos + 1);
  const next = /x/i.test(current) ? " " : "x";
  view.dispatch({
    changes: { from: safePos, to: safePos + 1, insert: next }
  });
  view.focus();
  return true;
}

let lastMouseToggle = { pos: -1, time: 0 };

const livePreviewHandlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    clearPendingBackgroundPointer(view);
    const targetEl = getEventTargetElement(event);
    const tableInput = targetEl ? targetEl.closest(".noto-table-cell-input") : null;
    if (tableInput instanceof HTMLInputElement) {
      return false;
    }
    if (targetEl && targetEl.closest(".cm-selectionLayer, .cm-cursorLayer")) {
      return false;
    }
    const anchor = getInteractiveAnchorFromEvent(event);
    if (anchor) {
      event.preventDefault();
      return true;
    }

    const checkbox = targetEl ? targetEl.closest('input[type="checkbox"][data-md-pos]') : null;
    if (checkbox) {
      event.preventDefault();
      const ok = toggleTaskCheckbox(checkbox, view);
      if (ok) {
        const pos = Number.parseInt(checkbox.getAttribute("data-md-pos") || "", 10);
        lastMouseToggle = { pos: Number.isFinite(pos) ? pos : -1, time: Date.now() };
      }
      return ok;
    }

    const interactive = getInteractiveRenderedElementFromEvent(event);
    if (interactive) {
      return true;
    }
    if (revealRenderedBlock(event, view)) return true;
    return false;
  },
  mousemove(event, view) {
    updateBackgroundPointerInteraction(event, view);
    return false;
  },
  mouseup(event, view) {
    return finishBackgroundPointerInteraction(event, view);
  },
  click(event, view) {
    if (consumeFinishedBackgroundPointerClick(event, view)) return true;
    const targetEl = getEventTargetElement(event);
    const tableInput = targetEl ? targetEl.closest(".noto-table-cell-input") : null;
    if (tableInput instanceof HTMLInputElement) {
      return false;
    }
    if (targetEl && targetEl.closest(".cm-selectionLayer, .cm-cursorLayer")) {
      return false;
    }
    const anchor = getInteractiveAnchorFromEvent(event);
    if (anchor) {
      event.preventDefault();
      dispatchRenderedAnchorActivation(anchor);
      return true;
    }

    const checkbox = targetEl ? targetEl.closest('input[type="checkbox"][data-md-pos]') : null;
    if (checkbox) {
      event.preventDefault();
      const pos = Number.parseInt(checkbox.getAttribute("data-md-pos") || "", 10);
      const justHandledByMouseDown =
        Number.isFinite(pos) &&
        pos === lastMouseToggle.pos &&
        Date.now() - lastMouseToggle.time < 350;
      if (!justHandledByMouseDown) {
        return toggleTaskCheckbox(checkbox, view);
      }
      return true;
    }

    const interactive = getInteractiveRenderedElementFromEvent(event);
    if (interactive) {
      return true;
    }

    if (revealRenderedBlock(event, view)) return true;

    return finishBackgroundPointerInteraction(event, view);
  },
  keydown(event, view) {
    if (!event || event.key !== "Tab") return false;
    const handled = handleEditorTabKey(view, event.shiftKey);
    if (!handled) return false;
    stopHandledDomEvent(event);
    return true;
  },
  blur(_event, view) {
    clearPendingBackgroundPointer(view);
    return false;
  }
});

function getDomPosSafe(view, el) {
  if (!view || !el || typeof view.posAtDOM !== "function") return NaN;
  try {
    const docLen = view.state && view.state.doc ? view.state.doc.length : 0;
    const raw = view.posAtDOM(el, 0);
    if (!Number.isFinite(raw)) return NaN;
    return Math.max(0, Math.min(docLen, raw));
  } catch (_) {
    return NaN;
  }
}

function getBlockHostElement(blockEl) {
  if (!(blockEl instanceof HTMLElement)) return null;
  const host = blockEl.closest(".cm-widgetBlock, .cm-line");
  return host instanceof HTMLElement ? host : null;
}

function findRenderedBlockInHost(host) {
  if (!(host instanceof HTMLElement)) return null;
  const block = host.querySelector(".cm-block-render");
  return block instanceof HTMLElement ? block : null;
}

function pickNearestHostByY(clickY, hosts = []) {
  if (!Number.isFinite(clickY) || !Array.isArray(hosts) || !hosts.length) return null;
  let best = null;
  for (const host of hosts) {
    if (!(host instanceof HTMLElement)) continue;
    const rect = host.getBoundingClientRect();
    if (!rect || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) continue;
    const distance = clickY < rect.top
      ? rect.top - clickY
      : clickY > rect.bottom
        ? clickY - rect.bottom
        : 0;
    if (!best || distance < best.distance) {
      best = { host, distance };
    }
  }
  return best ? best.host : null;
}

function findRenderedBlockForEvent(event, view) {
  const targetEl = getEventTargetElement(event);
  const direct = targetEl ? targetEl.closest(".cm-block-render") : null;
  if (direct instanceof HTMLElement) return direct;
  const targetHost = targetEl ? targetEl.closest(".cm-line, .cm-widgetBlock") : null;
  if (targetHost instanceof HTMLElement) {
    const ownBlock = findRenderedBlockInHost(targetHost);
    if (ownBlock instanceof HTMLElement) return ownBlock;
    return null;
  }

  let hovered = null;
  if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
    hovered = document.elementFromPoint(event.clientX, event.clientY);
  }
  const hoveredDirect = hovered instanceof Element ? hovered.closest(".cm-block-render") : null;
  if (hoveredDirect instanceof HTMLElement) return hoveredDirect;
  const hoveredHost = hovered instanceof Element ? hovered.closest(".cm-line, .cm-widgetBlock") : null;
  if (hoveredHost instanceof HTMLElement) {
    const ownBlock = findRenderedBlockInHost(hoveredHost);
    if (ownBlock instanceof HTMLElement) return ownBlock;
  }
  return null;
}

/* ---------- Inline marker hiding (live formatting) ---------- */
function buildInlineDecorations(view) {
  const ranges = [];
  const { state } = view;
  const visible = view.visibleRanges || [{ from: 0, to: state.doc.length }];
  const headingReferenceIndex = buildHeadingReferenceIndexFromText(state.doc.toString());
  const activeLine = state.doc.lineAt(state.selection.main.head);
  const selectionRanges = getNonEmptySelectionRanges(state);
  const hide = (from, to) => {
    if (to <= from) return;
    ranges.push(
      Decoration.replace({ widget: new HiddenMarkerWidget(), inclusive: false }).range(
        from,
        to
      )
    );
  };

  const boldItalicRe = /(\*\*\*|___)(?=\S)([\s\S]*?)(?<=\S)\1/g;
  const boldRe =
    /(?<!\*)\*\*(?=\S)([\s\S]*?)(?<=\S)\*\*(?!\*)|(?<!_)__(?=\S)([\s\S]*?)(?<=\S)__(?!_)/g;
  const italicRe =
    /(?<!\*)(\*)(?!\*)(?=\S)([\s\S]*?)(?<=\S)\*(?!\*)|(?<!_)(_)(?!_)(?=\S)([\s\S]*?)(?<=\S)_(?!_)/g;
  const strikeRe = /~~(?=\S)([\s\S]*?)(?<=\S)~~/g;
  const highlightRe = /==(?=\S)([\s\S]*?)(?<=\S)==/g;
  const codeSpanRe = /`([^`]+?)`/g;
  const headingRefRe = /\[\[([^\]\n]+)\]\]/g;
  const noteRefRe = /\[([^\]\n]+)\]/g;
  const hrRe = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const unorderedListRe = /^(\s*)([-+*])(\s+)/;
  const orderedListRe = /^(\s*)(\d+[.)])(\s+)/;

  for (const { from, to } of visible) {
    let pos = from;
    while (pos < to) {
      const line = state.doc.lineAt(pos);
      if (line.from >= to) break;
      const text = line.text || "";
      const base = line.from;
      const isRevealedLine = isLineRevealedBySelection(state, line, selectionRanges, activeLine.number);
      const inlineMathRanges = [];
      const overlapsInlineMath = (fromPos, toPos) =>
        inlineMathRanges.some((r) => fromPos < r.to && toPos > r.from);
      const hideUnlessInlineMath = (fromPos, toPos) => {
        if (toPos <= fromPos) return;
        if (overlapsInlineMath(fromPos, toPos)) return;
        hide(fromPos, toPos);
      };
      const codeSpanRanges = [];
      codeSpanRe.lastIndex = 0;
      let codeSeg;
      while ((codeSeg = codeSpanRe.exec(text)) !== null) {
        codeSpanRanges.push({
          from: codeSeg.index,
          to: codeSeg.index + codeSeg[0].length
        });
      }
      const overlapsCodeSpan = (fromPos, toPos) =>
        codeSpanRanges.some((r) => fromPos < r.to && toPos > r.from);

      if (!isRevealedLine) {
        const mathRanges = findInlineMathRanges(text).filter(
          (m) => !overlapsCodeSpan(m.from, m.to)
        );
        for (const math of mathRanges) {
          const mathFrom = base + math.from;
          const mathTo = base + math.to;
          inlineMathRanges.push({ from: mathFrom, to: mathTo });
          ranges.push(
            Decoration.replace({
              widget: new InlineMathWidget(math.expr),
              inclusive: false
            }).range(mathFrom, mathTo)
          );
        }
      }

      if (hrRe.test(text.trim())) {
        if (!isRevealedLine) hideUnlessInlineMath(base, line.to);
        pos = line.to + 1;
        continue;
      }

      const heading = text.match(/^(#{1,6})(\s+)/);
      if (heading && !isRevealedLine) hideUnlessInlineMath(base, base + heading[0].length);

      const bq = text.match(/^>\s?/);
      if (bq && !isRevealedLine) hideUnlessInlineMath(base, base + bq[0].length);

      const task = text.match(/^(\s*)(?:([-+*])|(\d+[.)]))(\s+)\[([ xX])\](\s?)/);
      if (task) {
        const listIndent = task[1] || "";
        const listMarker = task[2] || task[3] || "";
        const listGap = task[4] || "";
        const checked = /x/i.test(task[5] || "");
        const trailingGap = task[6] || "";
        const markerStart = base + listIndent.length + listMarker.length + listGap.length;
        if (!isRevealedLine) {
          // Task list items render as checkbox only (no list bullet/number marker).
          hideUnlessInlineMath(base + listIndent.length, markerStart);
          ranges.push(
            Decoration.replace({
              widget: new TaskCheckboxWidget(markerStart + 1, checked),
              inclusive: false
            }).range(markerStart, markerStart + 3)
          );
          if (trailingGap) {
            hideUnlessInlineMath(markerStart + 3, markerStart + 3 + trailingGap.length);
          }
        }

        const contentFrom = markerStart + 3 + trailingGap.length;
        if (checked && contentFrom < line.to) {
          ranges.push(
            Decoration.mark({ class: "cm-task-checked-text" }).range(contentFrom, line.to)
          );
        }
      } else if (!isRevealedLine) {
        const unordered = text.match(unorderedListRe);
        if (unordered) {
          const markerFrom = base + unordered[1].length;
          const markerTo = markerFrom + unordered[2].length + unordered[3].length;
          ranges.push(
            Decoration.replace({
              widget: new ListMarkerWidget("\u2022", "unordered"),
              inclusive: false
            }).range(markerFrom, markerTo)
          );
        } else {
          const ordered = text.match(orderedListRe);
          if (ordered) {
            const markerFrom = base + ordered[1].length;
            const markerTo = markerFrom + ordered[2].length + ordered[3].length;
            const numberText = ordered[2].endsWith(")")
              ? `${ordered[2].slice(0, -1)}.`
              : ordered[2];
            ranges.push(
              Decoration.replace({
                widget: new ListMarkerWidget(numberText, "ordered"),
                inclusive: false
              }).range(markerFrom, markerTo)
            );
          }
        }
      }

      headingRefRe.lastIndex = 0;
      let headingMatch;
      while ((headingMatch = headingRefRe.exec(text)) !== null) {
        const raw = String(headingMatch[0] || "");
        if (!raw || raw.length < 3) continue;
        const labelRaw = String(headingMatch[1] || "");
        const label = labelRaw.trim();
        if (!label) continue;
        const resolved = resolveHeadingReference(label, headingReferenceIndex);
        if (!resolved) continue;

        const localStart = headingMatch.index;
        const localEnd = localStart + raw.length;
        const prevChar = localStart > 0 ? text.charAt(localStart - 1) : "";
        const nextChar = localEnd < text.length ? text.charAt(localEnd) : "";
        if (prevChar === "!" || prevChar === "\\") continue;
        if (overlapsCodeSpan(localStart, localEnd)) continue;
        if (overlapsInlineMath(base + localStart, base + localEnd)) continue;

        const start = base + localStart;
        const end = base + localEnd;
        if (isRevealedLine) {
          // When the line is revealed for editing, don't replace with a widget,
          // but add an inline mark so the entire bracketed link (including outer brackets)
          // is styled like a link while editing.
          ranges.push(
            Decoration.mark({ class: "cm-bracket-link-inline" }).range(start, end)
          );
          continue;
        }

        ranges.push(
          Decoration.replace({
            widget: new BracketReferenceWidget(labelRaw, resolved),
            inclusive: false
          }).range(start, end)
        );
      }

      noteRefRe.lastIndex = 0;
      let noteMatch;
      while ((noteMatch = noteRefRe.exec(text)) !== null) {
        const raw = String(noteMatch[0] || "");
        if (!raw || raw.length < 3) continue;
        const labelRaw = String(noteMatch[1] || "");
        const label = labelRaw.trim();
        if (!label) continue;
        if (/^[xX ]$/.test(label)) continue;
        const resolved = resolveBracketReference(label);
        if (!resolved) continue;

        const localStart = noteMatch.index;
        const localEnd = localStart + raw.length;
        const prevChar = localStart > 0 ? text.charAt(localStart - 1) : "";
        const nextChar = localEnd < text.length ? text.charAt(localEnd) : "";
        if (prevChar === "!" || prevChar === "\\" || prevChar === "[") continue;
        if (nextChar === "(" || nextChar === "[" || nextChar === ":" || nextChar === "]") continue;
        if (overlapsCodeSpan(localStart, localEnd)) continue;
        if (overlapsInlineMath(base + localStart, base + localEnd)) continue;

        const start = base + localStart;
        const end = base + localEnd;
        if (isRevealedLine) {
          ranges.push(
            Decoration.mark({ class: "cm-bracket-link-inline" }).range(start, end)
          );
          continue;
        }

        ranges.push(
          Decoration.replace({
            widget: new BracketReferenceWidget(labelRaw, resolved),
            inclusive: false
          }).range(start, end)
        );
      }

      if (!isRevealedLine) {
        boldItalicRe.lastIndex = 0;
        let m;
        while ((m = boldItalicRe.exec(text)) !== null) {
          const start = base + m.index;
          const end = start + m[0].length;
          hideUnlessInlineMath(start, start + 3);
          hideUnlessInlineMath(end - 3, end);
        }

        boldRe.lastIndex = 0;
        while ((m = boldRe.exec(text)) !== null) {
          const start = base + m.index;
          const end = start + m[0].length;
          hideUnlessInlineMath(start, start + 2);
          hideUnlessInlineMath(end - 2, end);
        }

        strikeRe.lastIndex = 0;
        while ((m = strikeRe.exec(text)) !== null) {
          const start = base + m.index;
          const end = start + m[0].length;
          hideUnlessInlineMath(start, start + 2);
          hideUnlessInlineMath(end - 2, end);
        }

        highlightRe.lastIndex = 0;
        while ((m = highlightRe.exec(text)) !== null) {
          const start = base + m.index;
          const end = start + m[0].length;
          const contentFrom = start + 2;
          const contentTo = end - 2;
          if (contentTo > contentFrom && !overlapsInlineMath(contentFrom, contentTo)) {
            ranges.push(
              Decoration.mark({ class: "cm-inline-highlight" }).range(contentFrom, contentTo)
            );
          }
          hideUnlessInlineMath(start, start + 2);
          hideUnlessInlineMath(end - 2, end);
        }

        italicRe.lastIndex = 0;
        while ((m = italicRe.exec(text)) !== null) {
          const marker = m[1] || m[2] || "*";
          const len = marker.length;
          const start = base + m.index;
          const end = start + m[0].length;
          hideUnlessInlineMath(start, start + len);
          hideUnlessInlineMath(end - len, end);
        }

        codeSpanRe.lastIndex = 0;
        while ((m = codeSpanRe.exec(text)) !== null) {
          const start = base + m.index;
          const end = start + m[0].length;
          const contentFrom = start + 1;
          const contentTo = end - 1;
          if (contentTo > contentFrom && !overlapsInlineMath(contentFrom, contentTo)) {
            ranges.push(
              Decoration.mark({ class: "cm-inline-code" }).range(contentFrom, contentTo)
            );
          }
          hideUnlessInlineMath(start, start + 1);
          hideUnlessInlineMath(end - 1, end);
        }
      }

      pos = line.to + 1;
    }
  }

  return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
}

const inlineFormattingPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = Decoration.none;
      try {
        this.decorations = buildInlineDecorations(view);
      } catch (e) {
        console.error("Inline formatting init failed.", e);
      }
    }
    update(u) {
      const shouldRefresh = u.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshBracketRenderingEffect)));
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || shouldRefresh) {
        try {
          this.decorations = buildInlineDecorations(u.view);
        } catch (e) {
          console.error("Inline formatting update failed.", e);
          this.decorations = Decoration.none;
        }
      }
    }
  },
  {
    decorations: (v) => v.decorations
  }
);

/* ---------- Theme (light Obsidian-ish) ---------- */
const obsidianHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "2.1em", fontWeight: "800", lineHeight: "1.1" },
  { tag: tags.heading2, fontSize: "1.8em", fontWeight: "760", lineHeight: "1.15" },
  { tag: tags.heading3, fontSize: "1.55em", fontWeight: "720" },
  { tag: tags.heading4, fontSize: "1.35em", fontWeight: "680" },
  { tag: tags.heading5, fontSize: "1.2em", fontWeight: "640" },
  { tag: tags.heading6, fontSize: "1.1em", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--link-color)", textDecoration: "underline" },
  { tag: tags.quote, color: "var(--text-sub)" },
  { tag: tags.monospace, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "0.92em" },
  { tag: tags.comment, color: "#6e7781", fontStyle: "italic" },
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword], color: "#d73a49" },
  { tag: [tags.string, tags.special(tags.string)], color: "#0a7f3f" },
  { tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null], color: "#005cc5" },
  { tag: [tags.variableName, tags.propertyName, tags.labelName], color: "#24292f" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#6f42c1" },
  { tag: [tags.className, tags.typeName, tags.namespace], color: "#e36209" },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: "#57606a" },
  { tag: [tags.regexp, tags.escape], color: "#116329" }
]);

const obsidianTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontFamily: "var(--editor-font)",
    fontOpticalSizing: "auto",
    fontSize: "15px",
    lineHeight: "1.6",
    color: "var(--text)",
    backgroundColor: "transparent"
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { padding: "0", caretColor: "var(--text)" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--text)"
  },
  ".cm-cursorLayer": {
    pointerEvents: "none"
  },
  ".cm-selectionLayer": {
    pointerEvents: "none"
  },
  ".cm-scroller": {
    overflow: "auto",
    padding:
      "clamp(22px, 4vh, 54px) clamp(28px, 6.5vw, 140px) clamp(128px, 24vh, 360px) clamp(28px, 6.5vw, 140px)",
    scrollbarWidth: "none",
    boxSizing: "border-box",
    overflowX: "hidden"
  },
  ".cm-scroller::-webkit-scrollbar": { width: "0" },
  ".cm-line": { padding: "0" },
  ".cm-gutters": { display: "none" },
  ".cm-selectionBackground": { backgroundColor: "rgba(0,120,215,0.35)" },
  ".cm-selectionLayer .cm-selectionBackground": { backgroundColor: "rgba(0,120,215,0.35)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-line.cm-rendered-block-source-hidden": {
    height: "0 !important",
    minHeight: "0 !important",
    maxHeight: "0 !important",
    lineHeight: "0 !important",
    fontSize: "0 !important",
    paddingTop: "0 !important",
    paddingBottom: "0 !important",
    overflow: "hidden !important",
    color: "transparent !important",
    caretColor: "transparent !important"
  },
  ".cm-line.cm-rendered-block-source-hidden *": {
    fontSize: "0 !important",
    lineHeight: "0 !important",
    color: "transparent !important",
    caretColor: "transparent !important"
  },
  ".cm-block-render": {
    margin: "0",
    paddingBottom: "0",
    display: "flow-root",
    width: "100%",
    boxSizing: "border-box"
  }
});

/* ---------- Public API ---------- */
function ensureString(v) {
  return typeof v === "string" ? v : String(v ?? "");
}

function clamp(len, value, fallback = 0) {
  const raw = Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(len, raw));
}

const INLINE_PAIR_MARKERS = new Set(["*", "_", "$"]);
const DOUBLE_PAIR_MARKERS = new Set(["*", "_"]);
const SMART_TABLE_DIVIDER_PATTERN = /^\s*\|?\s*:?[-]{3,}:?\s*(?:\|\s*:?[-]{3,}:?\s*)*\|?\s*$/;
const INLINE_DOLLAR_MATH_PATTERN = /(?<!\\)\$(?:[^$\n\\]|\\.)*?(?<!\\)\$/g;
const BLOCK_DOLLAR_MATH_PATTERN = /\$\$[\s\S]*?\$\$/g;
const BRACKET_MATH_PATTERN = /\\\[[\s\S]*?\\\]/g;
const PAREN_MATH_PATTERN = /\\\([\s\S]*?\\\)/g;
const SYMMETRIC_EXIT_DELIMITERS = [
  { token: "==", kind: "marker" },
  { token: "**", kind: "marker" },
  { token: "~~", kind: "marker" },
  { token: "__", kind: "marker" },
  { token: "`", kind: "code" },
  { token: "$", kind: "math" },
  { token: "*", kind: "marker" },
  { token: "_", kind: "marker" },
  { token: "\"", kind: "quote" },
  { token: "'", kind: "quote" }
];
const ASYMMETRIC_EXIT_DELIMITERS = [
  { open: "(", close: ")" },
  { open: "[", close: "]" },
  { open: "{", close: "}" },
  { open: "<", close: ">" }
];
const ASYMMETRIC_EXIT_OPENERS = new Map(ASYMMETRIC_EXIT_DELIMITERS.map((spec) => [spec.open, spec]));
const ASYMMETRIC_EXIT_CLOSERS = new Map(ASYMMETRIC_EXIT_DELIMITERS.map((spec) => [spec.close, spec]));

function normalizeEditorMode(mode) {
  return mode === "raw" ? "raw" : "rich";
}

function applyEditorModeClasses(parent, mode) {
  if (!parent || !parent.classList) return;
  const normalized = normalizeEditorMode(mode);
  parent.classList.toggle("live-rich-editor", normalized === "rich");
  parent.classList.toggle("live-raw-editor", normalized === "raw");
}

function dispatchTextChange(view, from, to, insert, anchor, head = anchor) {
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor, head },
    userEvent: "input.type"
  });
}

function isEscapedAt(text, index) {
  if (!text || index <= 0) return false;
  let slashCount = 0;
  for (let pos = index - 1; pos >= 0 && text.charCodeAt(pos) === 92; pos -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function promoteInlinePair(view, from, marker) {
  if (!view || !INLINE_PAIR_MARKERS.has(marker)) return false;
  const doc = view.state.doc;
  if (from <= 0 || from >= doc.length) return false;
  if (doc.sliceString(from - 1, from) !== marker || doc.sliceString(from, from + 1) !== marker) return false;
  let leftCount = 0;
  for (let index = from - 1; index >= 0 && doc.sliceString(index, index + 1) === marker; index -= 1) {
    leftCount += 1;
  }
  let rightCount = 0;
  for (let index = from; index < doc.length && doc.sliceString(index, index + 1) === marker; index += 1) {
    rightCount += 1;
  }
  if (leftCount !== 1 || rightCount !== 1) return false;
  const replacement = marker === "$"
    ? "$$\n\n$$"
    : marker === "`"
      ? "```\n\n```"
      : marker.repeat(4);
  const cursorOffset = marker === "$" || marker === "`"
    ? replacement.indexOf("\n") + 1
    : 2;
  dispatchTextChange(view, from - 1, from + 1, replacement, from - 1 + cursorOffset);
  return true;
}

function promoteHighlightPair(view, from) {
  if (!view) return false;
  const doc = view.state.doc;
  if (from <= 0) return false;
  if (doc.sliceString(from - 1, from) !== "=") return false;
  const leftExtra = from - 2 >= 0 ? doc.sliceString(from - 2, from - 1) : "";
  const rightExtra = from < doc.length ? doc.sliceString(from, from + 1) : "";
  if (leftExtra === "=" || rightExtra === "=") return false;
  dispatchTextChange(view, from - 1, from, "====", from + 1);
  return true;
}

function promoteStrikePair(view, from) {
  if (!view) return false;
  const doc = view.state.doc;
  if (from <= 0) return false;
  if (doc.sliceString(from - 1, from) !== "~") return false;
  const leftExtra = from - 2 >= 0 ? doc.sliceString(from - 2, from - 1) : "";
  const rightExtra = from < doc.length ? doc.sliceString(from, from + 1) : "";
  if (leftExtra === "~" || rightExtra === "~") return false;
  dispatchTextChange(view, from - 1, from, "~~~~", from + 1);
  return true;
}

function handleBacktickInput(view, from, to) {
  if (!view) return false;
  const { state } = view;
  const main = state.selection.main;
  const doc = state.doc;

  if (!main.empty) {
    const selected = doc.sliceString(from, to);
    dispatchTextChange(view, from, to, `\`${selected}\``, from + selected.length + 2);
    return true;
  }

  const prev = from > 0 ? doc.sliceString(from - 1, from) : "";
  const next = from < doc.length ? doc.sliceString(from, from + 1) : "";

  if (prev === "`" && next === "`") {
    const replacement = "```\n\n```";
    dispatchTextChange(view, from - 1, from + 1, replacement, from + 3);
    return true;
  }

  if (prev === "`") {
    dispatchTextChange(view, from, to, "`", from);
    return true;
  }

  return false;
}

function handleSmartMarkdownInput(view, from, to, text) {
  if (!view || typeof text !== "string" || text.length !== 1) return false;
  const { state } = view;
  if (!state.selection || state.selection.ranges.length !== 1) return false;
  const main = state.selection.main;
  if (main.from !== from || main.to !== to) return false;

  if (text === "`") return handleBacktickInput(view, from, to);

  if (text === "~") {
    if (main.empty && promoteStrikePair(view, from)) return true;
    if (!main.empty) {
      const selected = state.doc.sliceString(from, to);
      dispatchTextChange(view, from, to, `~~${selected}~~`, from + 2 + selected.length);
      return true;
    }
    return false;
  }

  if (text === "=") {
    if (main.empty && promoteHighlightPair(view, from)) return true;
    if (!main.empty) {
      const selected = state.doc.sliceString(from, to);
      dispatchTextChange(view, from, to, `==${selected}==`, from + 2 + selected.length);
      return true;
    }
    return false;
  }

  if (!INLINE_PAIR_MARKERS.has(text)) return false;

  if (main.empty && !isEscapedAt(state.doc.lineAt(from).text, from - state.doc.lineAt(from).from)) {
    if (promoteInlinePair(view, from, text)) return true;
    dispatchTextChange(view, from, to, text + text, from + 1);
    return true;
  }

  if (!main.empty) {
    const selected = state.doc.sliceString(from, to);
    const wrapper = DOUBLE_PAIR_MARKERS.has(text) ? text : text;
    const insert = `${wrapper}${selected}${wrapper}`;
    dispatchTextChange(view, from, to, insert, from + wrapper.length + selected.length);
    return true;
  }

  return false;
}

const smartMarkdownInputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (
    view &&
    typeof text === "string" &&
    view.state &&
    view.state.selection &&
    view.state.selection.ranges.length === 1 &&
    view.state.selection.main.empty &&
    from === to &&
    view.state.selection.main.from === from
  ) {
    const mathExitTarget = getPostMathBlockTypingTarget(view.state, from);
    if (Number.isFinite(mathExitTarget) && mathExitTarget !== from) {
      dispatchTextChange(view, mathExitTarget, mathExitTarget, text, mathExitTarget + text.length);
      return true;
    }
  }
  if (handleSmartMarkdownInput(view, from, to, text)) return true;
  return false;
});

function getTableCellsForLine(line) {
  if (!line || typeof line.text !== "string" || !/\|/.test(line.text)) return [];
  return getTableCellRangesFromText(line.text, line.from).map((cell) => ({
    from: cell.from,
    to: cell.to
  }));
}

function getDocLineToWithBreak(state, lineNumber) {
  if (!state || !state.doc || !Number.isFinite(lineNumber) || lineNumber < 1 || lineNumber > state.doc.lines) {
    return 0;
  }
  const line = state.doc.line(lineNumber);
  if (lineNumber < state.doc.lines) return Math.min(state.doc.length, line.to + 1);
  return line.to;
}

function findTableCellIndexForPos(cells, pos) {
  if (!Array.isArray(cells) || !cells.length || !Number.isFinite(pos)) return -1;
  let currentIndex = cells.findIndex((cell) => pos >= cell.from && pos <= cell.to + 1);
  if (currentIndex === -1) {
    currentIndex = cells.findIndex((cell) => pos < cell.from);
    currentIndex = currentIndex === -1 ? cells.length - 1 : Math.max(0, currentIndex - 1);
  }
  return currentIndex;
}

function findTableAppendColumnTarget(state, pos) {
  if (!state || !state.doc || !Number.isFinite(pos)) return null;
  const currentLine = state.doc.lineAt(pos);
  if (!currentLine || !/\|/.test(currentLine.text)) return null;

  let startLineNumber = currentLine.number;
  while (startLineNumber > 1) {
    const lineText = state.doc.line(startLineNumber - 1).text;
    if (!/\|/.test(lineText)) break;
    startLineNumber -= 1;
  }

  let endLineNumber = currentLine.number;
  while (endLineNumber < state.doc.lines) {
    const lineText = state.doc.line(endLineNumber + 1).text;
    if (!/\|/.test(lineText)) break;
    endLineNumber += 1;
  }

  let dividerLineNumber = -1;
  for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber += 1) {
    const lineText = state.doc.line(lineNumber).text;
    if (SMART_TABLE_DIVIDER_PATTERN.test(lineText)) {
      dividerLineNumber = lineNumber;
      break;
    }
  }

  if (dividerLineNumber === -1 || currentLine.number === dividerLineNumber) return null;

  const descriptor = getRenderedTableBlockDescriptor(state, {
    from: state.doc.line(startLineNumber).from,
    to: getDocLineToWithBreak(state, endLineNumber)
  });
  if (!descriptor || !Array.isArray(descriptor.rows) || !descriptor.rows.length) return null;

  const row = descriptor.rows.findIndex((tableRow) => tableRow.lineNumber === currentLine.number);
  if (row === -1) return null;

  const currentCells = getTableCellRangesFromText(currentLine.text, currentLine.from);
  const col = findTableCellIndexForPos(currentCells, pos);
  if (col !== descriptor.columnCount - 1) return null;

  return {
    descriptor,
    row,
    col
  };
}

function getTableContext(state, pos) {
  if (!state || !Number.isFinite(pos)) return null;
  const currentLine = state.doc.lineAt(pos);
  if (!currentLine || SMART_TABLE_DIVIDER_PATTERN.test(currentLine.text) || !/\|/.test(currentLine.text)) {
    return null;
  }

  let startLineNumber = currentLine.number;
  while (startLineNumber > 1) {
    const lineText = state.doc.line(startLineNumber - 1).text;
    if (!/\|/.test(lineText)) break;
    startLineNumber -= 1;
  }

  let endLineNumber = currentLine.number;
  while (endLineNumber < state.doc.lines) {
    const lineText = state.doc.line(endLineNumber + 1).text;
    if (!/\|/.test(lineText)) break;
    endLineNumber += 1;
  }

  let dividerLineNumber = -1;
  for (let lineNumber = startLineNumber; lineNumber <= endLineNumber; lineNumber += 1) {
    const lineText = state.doc.line(lineNumber).text;
    if (SMART_TABLE_DIVIDER_PATTERN.test(lineText)) {
      dividerLineNumber = lineNumber;
      break;
    }
  }

  if (dividerLineNumber === -1 || currentLine.number <= dividerLineNumber) return null;

  const rowLines = [];
  for (let lineNumber = dividerLineNumber + 1; lineNumber <= endLineNumber; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (!/\|/.test(line.text) || SMART_TABLE_DIVIDER_PATTERN.test(line.text)) continue;
    const cells = getTableCellsForLine(line);
    if (cells.length === 0) continue;
    rowLines.push(line);
  }

  if (!rowLines.length) return null;
  const currentRowIndex = rowLines.findIndex((line) => line.number === currentLine.number);
  if (currentRowIndex === -1) return null;

  const dividerLine = state.doc.line(dividerLineNumber);
  const dividerCells = getTableCellsForLine(dividerLine);
  const columnCount = Math.max(
    1,
    dividerCells.length || getTableCellsForLine(rowLines[0]).length
  );

  return {
    currentLine,
    currentRowIndex,
    rowLines,
    dividerLine,
    dividerLineNumber,
    columnCount
  };
}

function buildEmptyTableRow(columnCount) {
  return `| ${Array.from({ length: Math.max(1, Number(columnCount) || 1) }).fill("").join(" | ")} |`;
}

function isEmptyTableRow(state, line, cells = getTableCellsForLine(line)) {
  if (!state || !line || !cells.length) return false;
  return cells.every((cell) => !state.doc.sliceString(cell.from, cell.to).trim());
}

function findTableTabTarget(state, pos) {
  const context = getTableContext(state, pos);
  if (!context) return null;
  const { currentLine, currentRowIndex, rowLines } = context;
  const currentCells = getTableCellsForLine(currentLine);
  if (currentCells.length === 0) return null;

  const currentIndex = findTableCellIndexForPos(currentCells, pos);
  if (currentIndex === -1) return null;

  if (currentIndex + 1 < currentCells.length) return currentCells[currentIndex + 1].from;

  const nextLine = rowLines[currentRowIndex + 1];
  if (nextLine) {
    const nextCells = getTableCellsForLine(nextLine);
    if (nextCells.length > 0) return nextCells[0].from;
  }

  return null;
}

function handleSmartTableEnter(view) {
  if (!view || !view.state.selection || view.state.selection.ranges.length !== 1) return false;
  const main = view.state.selection.main;
  if (!main.empty) return false;

  const context = getTableContext(view.state, main.head);
  if (!context) return false;

  const { currentLine, currentRowIndex, rowLines, columnCount } = context;
  if (currentRowIndex !== rowLines.length - 1) return false;

  const currentCells = getTableCellsForLine(currentLine);
  if (!currentCells.length) return false;

  const rowIsEmpty = isEmptyTableRow(view.state, currentLine, currentCells);
  const lastCell = currentCells[currentCells.length - 1];
  if (!rowIsEmpty && main.head < lastCell.to) return false;

  if (rowIsEmpty) {
    let from = currentLine.from;
    let to = currentLine.to;
    let cursor = from;
    if (currentLine.number < view.state.doc.lines) {
      to = Math.min(view.state.doc.length, currentLine.to + 1);
    } else if (from > 0) {
      from -= 1;
      cursor = from;
    }
    view.dispatch({
      changes: { from, to, insert: "" },
      selection: { anchor: cursor, head: cursor },
      userEvent: "input.type"
    });
    return true;
  }

  const indent = (currentLine.text.match(/^\s*/) || [""])[0];
  const newRow = `${indent}${buildEmptyTableRow(columnCount)}`;
  const insert = `\n${newRow}`;
  const cursor = currentLine.to + 3 + indent.length;
  view.dispatch({
    changes: { from: currentLine.to, to: currentLine.to, insert },
    selection: { anchor: cursor, head: cursor },
    userEvent: "input.type"
  });
  return true;
}

function handleSmartTableShiftEnter(view) {
  if (!view || !view.state.selection || view.state.selection.ranges.length !== 1) return false;
  const main = view.state.selection.main;
  if (!main.empty) return false;

  const target = findTableAppendColumnTarget(view.state, main.head);
  if (!target) return false;

  const built = buildTableBlockWithAppendedLastColumn(target.descriptor);
  const nextCol = Math.max(0, built.columnCount - 1);
  const nextSelection = built.cellDocPositions[target.row] && Number.isFinite(built.cellDocPositions[target.row][nextCol])
    ? built.cellDocPositions[target.row][nextCol]
    : target.descriptor.from;

  view.dispatch({
    changes: { from: target.descriptor.from, to: target.descriptor.to, insert: built.text },
    selection: { anchor: nextSelection, head: nextSelection },
    userEvent: "input.type"
  });
  return true;
}

function collectBracePairs(text, offset = 0) {
  const stack = [];
  const pairs = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" && !isEscapedAt(text, index)) {
      stack.push(offset + index);
    } else if (char === "}" && !isEscapedAt(text, index) && stack.length) {
      const open = stack.pop();
      pairs.push({ open, close: offset + index });
    }
  }
  pairs.sort((left, right) => left.open - right.open || left.close - right.close);
  return pairs;
}

function findEnclosingMathRegion(state, pos) {
  if (!state || !Number.isFinite(pos)) return null;
  const text = state.doc.toString();
  const matchers = [
    { pattern: BRACKET_MATH_PATTERN, openLen: 2, closeLen: 2 },
    { pattern: PAREN_MATH_PATTERN, openLen: 2, closeLen: 2 },
    { pattern: BLOCK_DOLLAR_MATH_PATTERN, openLen: 2, closeLen: 2 },
    { pattern: INLINE_DOLLAR_MATH_PATTERN, openLen: 1, closeLen: 1 }
  ];
  for (const matcher of matchers) {
    matcher.pattern.lastIndex = 0;
    let match;
    while ((match = matcher.pattern.exec(text))) {
      const start = match.index;
      const end = start + match[0].length;
      const contentStart = start + matcher.openLen;
      const contentEnd = end - matcher.closeLen;
      if (pos < contentStart || pos > contentEnd) continue;
      return { start, end, contentStart, contentEnd, content: match[0].slice(matcher.openLen, match[0].length - matcher.closeLen) };
    }
  }
  return null;
}

function findMathTabTarget(state, pos) {
  const region = findEnclosingMathRegion(state, pos);
  if (!region) return null;
  const buildTarget = (targetPos) => {
    const openDelimiter = state.doc.sliceString(region.start, region.contentStart);
    const closeDelimiter = state.doc.sliceString(region.contentEnd, region.end);
    const isBlockRegion =
      (openDelimiter === "$$" && closeDelimiter === "$$")
      || (openDelimiter === "\\[" && closeDelimiter === "\\]");
    return {
      pos: targetPos,
      assoc: isBlockRegion && targetPos >= region.end ? -1 : 1
    };
  };
  const getRegionExitTarget = () => {
    return buildTarget(region.end);
  };
  const pairs = collectBracePairs(region.content, region.contentStart);
  if (pairs.length === 0) return getRegionExitTarget();

  let currentPair = null;
  for (const pair of pairs) {
    if (pos < pair.open + 1 || pos > pair.close) continue;
    if (!currentPair || (pair.close - pair.open) < (currentPair.close - currentPair.open)) currentPair = pair;
  }

  if (currentPair) {
    const nextPair = pairs.find((pair) => pair.open > currentPair.open);
    if (nextPair) return buildTarget(nextPair.open + 1);
    return getRegionExitTarget();
  }

  const upcomingPair = pairs.find((pair) => pair.open + 1 >= pos);
  return upcomingPair ? buildTarget(upcomingPair.open + 1) : getRegionExitTarget();
}

function getPostMathBlockTypingTarget(state, pos) {
  if (!state || !Number.isFinite(pos)) return null;
  const line = state.doc.lineAt(pos);
  if (!line || pos !== line.to || line.number >= state.doc.lines) return null;
  const trimmed = String(line.text || "").trim();
  if (!(trimmed === "$$" || trimmed === "\\]" || /^\\end\{[A-Za-z*]+\}\s*$/.test(trimmed))) {
    return null;
  }
  const nextChar = state.doc.sliceString(pos, Math.min(state.doc.length, pos + 1));
  if (nextChar !== "\n") return null;
  return pos + 1;
}

function isWordLikeExitCharacter(char) {
  return typeof char === "string" && /^[A-Za-z0-9]$/.test(char);
}

function isRepeatedDelimiterRun(text, index, token) {
  if (typeof token !== "string" || token.length < 1) return false;
  const isRepeated = token.split("").every((char) => char === token[0]);
  if (!isRepeated) return false;
  const prev = index > 0 ? text.charAt(index - 1) : "";
  const next = index + token.length < text.length ? text.charAt(index + token.length) : "";
  return prev === token[0] || next === token[0];
}

function isValidSymmetricDelimiterBoundary(text, index, spec) {
  if (!text.startsWith(spec.token, index) || isEscapedAt(text, index)) return false;
  if (spec.kind === "quote") {
    const prev = index > 0 ? text.charAt(index - 1) : "";
    const next = index + spec.token.length < text.length ? text.charAt(index + spec.token.length) : "";
    return !(isWordLikeExitCharacter(prev) && isWordLikeExitCharacter(next));
  }
  return !isRepeatedDelimiterRun(text, index, spec.token);
}

function collectSymmetricDelimiterExitCandidates(text, lineFrom, offset) {
  const candidates = [];
  for (const spec of SYMMETRIC_EXIT_DELIMITERS) {
    const tokenLength = spec.token.length;
    let searchFrom = offset - tokenLength;
    while (searchFrom >= 0) {
      const openIndex = text.lastIndexOf(spec.token, searchFrom);
      if (openIndex === -1) break;
      const openEnd = openIndex + tokenLength;
      if (offset < openEnd || !isValidSymmetricDelimiterBoundary(text, openIndex, spec)) {
        searchFrom = openIndex - 1;
        continue;
      }
      let closeIndex = text.indexOf(spec.token, Math.max(openEnd, offset));
      while (closeIndex !== -1) {
        if (closeIndex >= offset && isValidSymmetricDelimiterBoundary(text, closeIndex, spec)) {
          candidates.push({
            openStart: lineFrom + openIndex,
            openEnd: lineFrom + openEnd,
            closeStart: lineFrom + closeIndex,
            closeEnd: lineFrom + closeIndex + tokenLength
          });
          break;
        }
        closeIndex = text.indexOf(spec.token, closeIndex + 1);
      }
      searchFrom = openIndex - 1;
    }
  }
  return candidates;
}

function collectAsymmetricDelimiterExitCandidates(text, lineFrom, offset) {
  const stack = [];
  const candidates = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (isEscapedAt(text, index)) continue;
    const openSpec = ASYMMETRIC_EXIT_OPENERS.get(char);
    if (openSpec) {
      stack.push({ spec: openSpec, index });
      continue;
    }
    const closeSpec = ASYMMETRIC_EXIT_CLOSERS.get(char);
    if (!closeSpec) continue;
    for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex -= 1) {
      const current = stack[stackIndex];
      if (current.spec.close !== char) continue;
      stack.splice(stackIndex, 1);
      const openEnd = current.index + current.spec.open.length;
      if (offset >= openEnd && offset <= index) {
        candidates.push({
          openStart: lineFrom + current.index,
          openEnd: lineFrom + openEnd,
          closeStart: lineFrom + index,
          closeEnd: lineFrom + index + current.spec.close.length
        });
      }
      break;
    }
  }
  return candidates;
}

function findPairedDelimiterExitTarget(state, pos) {
  if (!state || !Number.isFinite(pos)) return null;
  const line = state.doc.lineAt(pos);
  if (!line) return null;
  const offset = pos - line.from;
  const candidates = [
    ...collectSymmetricDelimiterExitCandidates(line.text, line.from, offset),
    ...collectAsymmetricDelimiterExitCandidates(line.text, line.from, offset)
  ].filter((candidate) => pos >= candidate.openEnd && pos <= candidate.closeStart);
  if (!candidates.length) return null;
  candidates.sort((left, right) => {
    const spanDiff = (left.closeEnd - left.openStart) - (right.closeEnd - right.openStart);
    if (spanDiff) return spanDiff;
    return right.openStart - left.openStart;
  });
  const best = candidates[0];
  return best ? { pos: best.closeEnd, assoc: 1 } : null;
}

function getSelectedLineStarts(state) {
  if (!state || !state.selection) return [];
  const starts = [];
  const seen = new Set();
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    const startLine = state.doc.lineAt(range.from).number;
    const endPos = Math.max(range.from, range.to - 1);
    const endLine = state.doc.lineAt(endPos).number;
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      if (seen.has(line.from)) continue;
      seen.add(line.from);
      starts.push(line.from);
    }
  }
  return starts;
}

function indentSelectedLinesWithSpaces(view, count = 4) {
  if (!view || !view.state || typeof view.dispatch !== "function") return false;
  const lineStarts = getSelectedLineStarts(view.state);
  if (!lineStarts.length) return false;
  const indent = " ".repeat(Math.max(1, Number(count) || 4));
  const changes = ChangeSet.of(
    lineStarts.map((from) => ({ from, insert: indent })),
    view.state.doc.length
  );
  const ranges = view.state.selection.ranges.map((range) => EditorSelection.range(
    changes.mapPos(range.anchor, 1),
    changes.mapPos(range.head, 1)
  ));
  view.dispatch(view.state.update({
    changes,
    selection: EditorSelection.create(ranges, view.state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: "input.indent"
  }));
  return true;
}

function outdentSelectedLines(view, count = 4) {
  if (!view || !view.state || typeof view.dispatch !== "function") return false;
  const lineStarts = getSelectedLineStarts(view.state);
  if (!lineStarts.length && view.state.selection && view.state.selection.main) {
    lineStarts.push(view.state.doc.lineAt(view.state.selection.main.head).from);
  }
  if (!lineStarts.length) return false;
  const maxRemove = Math.max(1, Number(count) || 4);
  const specs = [];
  for (const from of lineStarts) {
    const line = view.state.doc.lineAt(from);
    let remove = 0;
    while (remove < maxRemove && (from + remove) < line.to) {
      if (view.state.doc.sliceString(from + remove, from + remove + 1) !== " ") break;
      remove += 1;
    }
    if (remove > 0) specs.push({ from, to: from + remove, insert: "" });
  }
  if (!specs.length) return false;
  const changes = ChangeSet.of(specs, view.state.doc.length);
  const ranges = view.state.selection.ranges.map((range) => EditorSelection.range(
    changes.mapPos(range.anchor, -1),
    changes.mapPos(range.head, -1)
  ));
  view.dispatch(view.state.update({
    changes,
    selection: EditorSelection.create(ranges, view.state.selection.mainIndex),
    scrollIntoView: true,
    userEvent: "delete.backward"
  }));
  return true;
}

function handleSmartTabNavigation(view) {
  if (!view || !view.state.selection || view.state.selection.ranges.length !== 1) return false;
  const main = view.state.selection.main;
  if (!main.empty) return false;
  const pos = main.head;
  const target = findMathTabTarget(view.state, pos)
    ?? findTableTabTarget(view.state, pos)
    ?? findPairedDelimiterExitTarget(view.state, pos);
  const targetPos = Number.isFinite(target && typeof target === "object" ? target.pos : target)
    ? (typeof target === "object" ? target.pos : target)
    : NaN;
  const assoc = typeof target === "object" && Number.isFinite(target.assoc) ? target.assoc : 1;
  if (!Number.isFinite(targetPos) || targetPos === pos) return false;
  view.dispatch({ selection: EditorSelection.cursor(targetPos, assoc), userEvent: "select" });
  return true;
}

function insertRegularTabSpaces(view) {
  if (!view || !view.state || typeof view.dispatch !== "function") return false;
  const { state } = view;
  if (state.selection.ranges.some((range) => !range.empty)) {
    return indentSelectedLinesWithSpaces(view, 4);
  }
  view.dispatch(state.update(state.replaceSelection("    "), {
    scrollIntoView: true,
    userEvent: "input"
  }));
  return true;
}

function handleEditorTabKey(view, shiftKey = false) {
  if (!view) return false;
  return shiftKey
    ? outdentSelectedLines(view, 4)
    : (handleSmartTabNavigation(view) || insertRegularTabSpaces(view));
}

function stopHandledDomEvent(event) {
  if (!event) return;
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  }
}

function shouldBypassEditorTabOverride(event) {
  const targetEl = getEventTargetElement(event);
  if (!(targetEl instanceof HTMLElement)) return false;
  if (targetEl.closest(".noto-table-cell-input")) return true;
  if (targetEl.closest(".cm-search, .cm-panel")) return true;
  if (targetEl.closest("button, select, textarea, a[href]")) return true;
  const editableHost = targetEl.closest(
    '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
  );
  if (editableHost instanceof HTMLElement && !editableHost.closest(".cm-editor")) {
    return true;
  }
  return targetEl instanceof HTMLInputElement && targetEl.type !== "hidden";
}

const smartMarkdownKeyBindings = [
  {
    key: "Shift-Enter",
    run: handleSmartTableShiftEnter
  },
  {
    key: "Enter",
    run: handleSmartTableEnter
  },
  {
    key: "Tab",
    run: handleSmartTabNavigation
  },
  {
    key: "Tab",
    run: insertRegularTabSpaces,
    shift: (view) => outdentSelectedLines(view, 4)
  }
];

function createSearchInput(name, placeholder) {
  const input = document.createElement("input");
  input.className = "cm-textfield";
  input.name = name;
  input.form = "";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  return input;
}

function createSearchButton(name, onClick, text) {
  const button = document.createElement("button");
  button.type = "button";
  button.name = name;
  button.className = "cm-button";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function createNotoSearchPanel(view) {
  let query = getSearchQuery(view.state);

  const dom = document.createElement("div");
  dom.className = "cm-search noto-enhanced";
  dom.setAttribute("role", "search");

  const searchField = createSearchInput("search", view.state.phrase("Find"));
  searchField.setAttribute("main-field", "true");
  const replaceField = createSearchInput("replace", view.state.phrase("Replace"));

  const caseField = document.createElement("input");
  caseField.type = "checkbox";
  caseField.name = "case";
  caseField.form = "";
  caseField.className = "noto-hidden-control";
  caseField.tabIndex = -1;
  caseField.setAttribute("aria-hidden", "true");

  const prevButton = createSearchButton("prev", () => findPrevious(view), view.state.phrase("previous"));
  const nextButton = createSearchButton("next", () => findNext(view), view.state.phrase("next"));
  const replaceButton = createSearchButton("replace", () => replaceNext(view), view.state.phrase("replace"));
  const replaceAllButton = createSearchButton("replaceAll", () => replaceAll(view), view.state.phrase("replace all"));
  replaceButton.innerHTML = `<svg class="note-find-action-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5.3 12.6 3 3.1 7-7.2" stroke="currentColor" stroke-width="2.55" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
  replaceButton.setAttribute("aria-label", "Replace match");
  replaceButton.title = "Replace match";
  replaceAllButton.innerHTML = `<svg class="note-find-action-icon note-find-action-icon-double" width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m3.1 12.7 2.4 2.4 5.3-5.5" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round"></path><path d="m8.2 12.7 2.4 2.4 5.3-5.5" stroke="currentColor" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
  replaceAllButton.setAttribute("aria-label", "Replace all matches");
  replaceAllButton.title = "Replace all matches";
  const closeButton = createSearchButton("close", () => {
    cmCloseSearchPanel(view);
    view.focus();
  }, "");
  closeButton.innerHTML = `<svg class="x-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
  closeButton.setAttribute("aria-label", view.state.phrase("close"));

  function setQuery(nextQuery) {
    query = nextQuery;
    searchField.value = nextQuery.search;
    replaceField.value = nextQuery.replace;
    caseField.checked = nextQuery.caseSensitive;
  }

  function commitQuery() {
    const nextQuery = new SearchQuery({
      search: ensureString(searchField.value),
      caseSensitive: Boolean(caseField.checked),
      literal: Boolean(query.literal),
      regexp: Boolean(query.regexp),
      wholeWord: Boolean(query.wholeWord),
      replace: ensureString(replaceField.value)
    });
    if (!nextQuery.eq(query)) {
      query = nextQuery;
      view.dispatch({ effects: setSearchQuery.of(nextQuery) });
    }
  }

  searchField.addEventListener("input", commitQuery);
  searchField.addEventListener("change", commitQuery);
  searchField.addEventListener("keyup", commitQuery);
  replaceField.addEventListener("input", commitQuery);
  replaceField.addEventListener("change", commitQuery);
  replaceField.addEventListener("keyup", commitQuery);
  caseField.addEventListener("change", commitQuery);

  dom.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target === searchField) {
      event.preventDefault();
      if (event.shiftKey) findPrevious(view);
      else findNext(view);
      return;
    }
    if (event.key === "Enter" && event.target === replaceField) {
      event.preventDefault();
      replaceNext(view);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cmCloseSearchPanel(view);
      view.focus();
    }
  });

  dom.append(
    searchField,
    caseField,
    prevButton,
    nextButton,
    replaceField,
    replaceButton,
    replaceAllButton,
    closeButton
  );

  setQuery(query);

  return {
    dom,
    top: true,
    mount() {
      searchField.select();
    },
    update(update) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery) && !effect.value.eq(query)) setQuery(effect.value);
        }
      }
    }
  };
}

function buildEditorModeExtensions(mode) {
  const normalized = normalizeEditorMode(mode);
  if (normalized === "raw") {
    return [
      rawImagePreviewField,
      livePreviewHandlers
    ];
  }
  if (normalized !== "rich") return [];
  return [
    blockPreviewField,
    structureLineField,
    EditorView.decorations.from(structureLineField),
    inlineFormattingPlugin,
    livePreviewHandlers
  ];
}

function createEditor({ parent, doc = "", mode = "rich", onDocChange, onSelectionChange, onScroll } = {}) {
  if (!parent) throw new Error("parent element required");
  let suppress = 0;
  let currentMode = normalizeEditorMode(mode);
  const modeCompartment = new Compartment();

  const selectionListener = (view) => {
    if (typeof onSelectionChange !== "function") return;
    const main = view.state.selection.main;
    onSelectionChange(
      {
        from: main.from,
        to: main.to,
        anchor: main.anchor,
        head: main.head,
        empty: main.empty
      },
      view
    );
  };

  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && suppress === 0 && typeof onDocChange === "function") {
      const main = u.state.selection.main;
      try {
        onDocChange(
          u.state.doc.toString(),
          {
            from: main.from,
            to: main.to,
            anchor: main.anchor,
            head: main.head,
            empty: main.empty
          },
          u.view
        );
      } catch (e) {
        console.error("onDocChange callback failed.", e);
      }
    }
    if (u.selectionSet) {
      try {
        selectionListener(u.view);
      } catch (e) {
        console.error("onSelectionChange callback failed.", e);
      }
    }
  });

  const extensions = [
    EditorView.lineWrapping,
    drawSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    smartMarkdownInputHandler,
    closeBrackets(),
    search({ top: true, createPanel: createNotoSearchPanel }),
    highlightSelectionMatches(),
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: [GFM, Subscript, Superscript]
    }),
    syntaxHighlighting(defaultHighlightStyle),
    syntaxHighlighting(obsidianHighlightStyle),
    syntaxHighlighting(classHighlighter),
    activeTableEditField,
    versionHistoryGapField,
    modeCompartment.of(buildEditorModeExtensions(currentMode)),
    keymap.of([
      ...smartMarkdownKeyBindings,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...foldKeymap
    ]),
    obsidianTheme,
    updateListener
  ];

  const state = EditorState.create({
    doc: ensureString(doc),
    extensions
  });
  parent.innerHTML = "";
  applyEditorModeClasses(parent, currentMode);
  const view = new EditorView({ state, parent });
  view.dom.__cmView = view;
  view.scrollDOM.__cmView = view;
  parent.__cmView = view;
  activeEditorViews.add(view);

  const handleParentTabKeyDown = (event) => {
    if (!event || event.key !== "Tab" || shouldBypassEditorTabOverride(event)) return;
    const handled = handleEditorTabKey(view, event.shiftKey);
    if (!handled) return;
    view.focus();
    stopHandledDomEvent(event);
  };
  let backgroundPointerDocumentTracking = false;
  const stopBackgroundPointerDocumentTracking = () => {
    if (!backgroundPointerDocumentTracking) return;
    backgroundPointerDocumentTracking = false;
    document.removeEventListener("mousemove", handleDocumentMouseMove, true);
    document.removeEventListener("mouseup", handleDocumentMouseUp, true);
    window.removeEventListener("blur", handleWindowBlur, true);
  };
  const startBackgroundPointerDocumentTracking = () => {
    if (backgroundPointerDocumentTracking) return;
    backgroundPointerDocumentTracking = true;
    document.addEventListener("mousemove", handleDocumentMouseMove, true);
    document.addEventListener("mouseup", handleDocumentMouseUp, true);
    window.addEventListener("blur", handleWindowBlur, true);
  };
  const handleWindowBlur = () => {
    clearPendingBackgroundPointer(view);
    stopBackgroundPointerDocumentTracking();
  };
  const handleDocumentMouseMove = (event) => {
    if (!getPendingBackgroundPointer(view)) {
      stopBackgroundPointerDocumentTracking();
      return;
    }
    if (!updateBackgroundPointerInteraction(event, view)) return;
    stopHandledDomEvent(event);
  };
  const handleDocumentMouseUp = (event) => {
    if (!getPendingBackgroundPointer(view)) {
      stopBackgroundPointerDocumentTracking();
      return;
    }
    const handled = finishBackgroundPointerInteraction(event, view);
    stopBackgroundPointerDocumentTracking();
    if (handled) stopHandledDomEvent(event);
  };
  const handleParentMouseDown = (event) => {
    const targetEl = getEventTargetElement(event);
    if (
      targetEl &&
      targetEl.closest(
        ".cm-content, .cm-line, .cm-widgetBlock, .cm-widgetBuffer, .cm-block-render, .cm-selectionLayer, .cm-cursorLayer"
      )
    ) {
      return;
    }
    if (!beginBackgroundPointerInteraction(event, view)) return;
    stopHandledDomEvent(event);
  };
  const handleParentClick = (event) => {
    if (consumeFinishedBackgroundPointerClick(event, view)) {
      stopHandledDomEvent(event);
      return;
    }
    if (!getPendingBackgroundPointer(view)) return;
    if (!finishBackgroundPointerInteraction(event, view)) return;
    stopHandledDomEvent(event);
  };
  const handleParentBlur = () => {
    clearPendingBackgroundPointer(view);
    stopBackgroundPointerDocumentTracking();
  };

  setBackgroundPointerHooks(view, {
    onStart: startBackgroundPointerDocumentTracking,
    onEnd: stopBackgroundPointerDocumentTracking
  });

  parent.addEventListener("keydown", handleParentTabKeyDown, true);
  parent.addEventListener("mousedown", handleParentMouseDown, true);
  parent.addEventListener("click", handleParentClick, true);
  parent.addEventListener("blur", handleParentBlur, true);

  if (typeof onScroll === "function") {
    view.scrollDOM.addEventListener(
      "scroll",
      () => {
        try {
          onScroll(view);
        } catch (e) {
          console.error("onScroll callback failed.", e);
        }
      },
      { passive: true }
    );
  }

  const api = {
    view,
    getMode() {
      return currentMode;
    },
    setMode(nextMode) {
      const normalized = normalizeEditorMode(nextMode);
      if (normalized === currentMode) return;
      currentMode = normalized;
      applyEditorModeClasses(parent, currentMode);
      view.dispatch({
        effects: [
          modeCompartment.reconfigure(buildEditorModeExtensions(currentMode)),
          setActiveTableEditEffect.of(null)
        ],
        annotations: Transaction.addToHistory.of(false)
      });
    },
    focus() {
      view.focus();
    },
    handleTab(shiftKey = false) {
      const handled = handleEditorTabKey(view, shiftKey);
      if (handled) view.focus();
      return handled;
    },
    destroy() {
      parent.removeEventListener("keydown", handleParentTabKeyDown, true);
      parent.removeEventListener("mousedown", handleParentMouseDown, true);
      parent.removeEventListener("click", handleParentClick, true);
      parent.removeEventListener("blur", handleParentBlur, true);
      clearPendingBackgroundPointer(view);
      stopBackgroundPointerDocumentTracking();
      setBackgroundPointerHooks(view, null);
      activeEditorViews.delete(view);
      view.destroy();
    },
    getDoc() {
      return view.state.doc.toString();
    },
    setVersionHistoryGaps(entries = [], trailingHeightPx = 0) {
      const payload = {
        entries: Array.isArray(entries) ? entries : [],
        trailingHeightPx
      };
      view.dispatch({
        effects: setVersionHistoryGapEffect.of(payload),
        annotations: Transaction.addToHistory.of(false)
      });
    },
    clearVersionHistoryGaps() {
      view.dispatch({
        effects: setVersionHistoryGapEffect.of({ entries: [], trailingHeightPx: 0 }),
        annotations: Transaction.addToHistory.of(false)
      });
    },
    setSearchQuery(query, options = {}) {
      const nextQuery = new SearchQuery({
        search: ensureString(query),
        caseSensitive: Boolean(options && options.caseSensitive),
        literal: true,
        regexp: false,
        wholeWord: false
      });
      view.dispatch({ effects: setSearchQuery.of(nextQuery) });
    },
    openSearchPanel() {
      cmOpenSearchPanel(view);
    },
    closeSearchPanel() {
      cmCloseSearchPanel(view);
    },
    setDoc(nextDoc, selection) {
      const current = view.state.doc.toString();
      const incoming = ensureString(nextDoc);
      if (current === incoming) {
        if (selection) api.setSelection(selection.anchor ?? selection.head ?? 0, selection.head ?? selection.anchor ?? 0);
        return;
      }
      const prevLen = current.length;
      const nextLen = incoming.length;
      const baseSel = selection || view.state.selection.main;
      const anchor = clamp(nextLen, baseSel.anchor, Math.min(nextLen, prevLen));
      const head = clamp(nextLen, baseSel.head, anchor);
      suppress += 1;
      try {
        view.dispatch({
          changes: { from: 0, to: prevLen, insert: incoming },
          selection: { anchor, head },
          annotations: Transaction.addToHistory.of(false)
        });
      } finally {
        suppress = Math.max(0, suppress - 1);
      }
    },
    setSelection(anchor, head = anchor) {
      const len = view.state.doc.length;
      const a = clamp(len, anchor, 0);
      const h = clamp(len, head, a);
      if (a === h) {
        view.dispatch({ selection: EditorSelection.cursor(a, 1) });
        return;
      }
      view.dispatch({ selection: EditorSelection.range(a, h) });
    },
    getSelection() {
      const m = view.state.selection.main;
      return { from: m.from, to: m.to, anchor: m.anchor, head: m.head, empty: m.empty };
    },
    scrollToPos(pos, options = {}) {
      const len = view.state.doc.length;
      const safe = clamp(len, pos, 0);
      const smooth = Boolean(options && options.smooth);
      const yMargin = Number.isFinite(options && options.yMargin) ? Math.max(0, options.yMargin) : 56;
      if (smooth && view.scrollDOM && typeof view.coordsAtPos === "function") {
        try {
          const coords = view.coordsAtPos(safe);
          const scrollerRect = view.scrollDOM.getBoundingClientRect();
          if (coords && Number.isFinite(coords.top) && Number.isFinite(scrollerRect.top)) {
            const targetTop = Math.max(
              0,
              view.scrollDOM.scrollTop + coords.top - scrollerRect.top - yMargin
            );
            const startTop = Number.isFinite(view.scrollDOM.scrollTop) ? view.scrollDOM.scrollTop : 0;
            const delta = targetTop - startTop;
            if (Math.abs(delta) <= 1) {
              view.scrollDOM.scrollTop = targetTop;
              return;
            }
            const priorRaf = Number(view.scrollDOM.__notoSmoothScrollRaf || 0);
            if (priorRaf) cancelAnimationFrame(priorRaf);
            const startTime = typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now();
            const duration = Math.max(140, Math.min(320, Math.abs(delta) * 0.35));
            const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
            const tick = (now) => {
              if (!view.scrollDOM || !view.scrollDOM.isConnected) return;
              const currentTime = Number.isFinite(now) ? now : Date.now();
              const elapsed = currentTime - startTime;
              const progress = duration > 0 ? Math.max(0, Math.min(1, elapsed / duration)) : 1;
              view.scrollDOM.scrollTop = startTop + (delta * easeInOut(progress));
              if (progress < 1) {
                view.scrollDOM.__notoSmoothScrollRaf = requestAnimationFrame(tick);
                return;
              }
              view.scrollDOM.scrollTop = targetTop;
              view.scrollDOM.__notoSmoothScrollRaf = 0;
            };
            view.scrollDOM.__notoSmoothScrollRaf = requestAnimationFrame(tick);
            return;
          }
        } catch (_) {}
      }
      try {
        view.dispatch({
          effects: EditorView.scrollIntoView(safe, { y: "start", yMargin })
        });
      } catch (_) {}
    },
    getCaretRect(pos) {
      const len = view.state.doc.length;
      const safe = clamp(len, pos, len);
      return view.coordsAtPos(safe);
    },
    refreshBracketLinks() {
      view.dispatch({
        effects: refreshBracketRenderingEffect.of(bracketReferenceResolverVersion),
        annotations: Transaction.addToHistory.of(false)
      });
    }
  };

  return api;
}

window.NotoCodeMirror = {
  createEditor,
  renderMarkdownToHtml: renderMarkdown,
  setBracketReferenceResolver
};
