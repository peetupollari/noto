(function () {
  const whatsNewAPI = window.whatsNewAPI;
  const contentEl = document.getElementById('whats-new-content');
  const measureEl = document.getElementById('whats-new-measure');
  const updateNumberEl = document.getElementById('whats-new-update-number');
  const updateDateEl = document.getElementById('whats-new-update-date');
  const pageIndicatorEl = document.getElementById('page-indicator');
  const messageEl = document.getElementById('whats-new-message');
  const backButton = document.getElementById('back-btn');
  const nextButton = document.getElementById('next-btn');
  const finishButton = document.getElementById('finish-btn');
  const minBtn = document.getElementById('min-button');
  const maxBtn = document.getElementById('max-button');
  const closeBtn = document.getElementById('close-button');
  const THEME_MODE_STORAGE_KEY = 'notoThemeMode';
  const APP_SIZE_MODE_STORAGE_KEY = 'notoAppSizeMode';
  const THEME_MODE_VALUES = new Set(['system', 'light', 'dark']);
  const APP_SIZE_MODE_PRESETS = {
    normal: { zoom: 1 },
    smaller: { zoom: 0.92 },
    smallest: { zoom: 0.86 }
  };
  const PAGE_BOTTOM_BREATHING_ROOM_PX = 18;

  let systemThemeMediaQuery = null;
  let blocks = [];
  let pagedBlocks = [[]];
  let currentPageIndex = 0;
  let resizeTimer = null;
  let completeInFlight = false;

  function wireWindowControls() {
    if (!window.electronAPI) return;
    if (minBtn) minBtn.onclick = () => window.electronAPI.minimize();
    if (maxBtn) maxBtn.onclick = () => window.electronAPI.maximize();
    if (closeBtn) closeBtn.onclick = () => window.electronAPI.close();
  }

  function readThemeMode() {
    try {
      const raw = String(window.localStorage.getItem(THEME_MODE_STORAGE_KEY) || '').trim().toLowerCase();
      return THEME_MODE_VALUES.has(raw) ? raw : 'system';
    } catch (error) {
      return 'system';
    }
  }

  function resolveAppliedTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch (error) {
      return 'light';
    }
  }

  function applySavedTheme() {
    const root = document.documentElement;
    if (!root) return;
    const themeMode = readThemeMode();
    root.setAttribute('data-theme-mode', themeMode);
    root.setAttribute('data-theme', resolveAppliedTheme(themeMode));
  }

  function handleSystemThemePreferenceChange() {
    if (readThemeMode() === 'system') applySavedTheme();
  }

  function ensureSystemThemePreferenceListener() {
    if (!window.matchMedia) return;
    if (!systemThemeMediaQuery) {
      try {
        systemThemeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      } catch (error) {
        systemThemeMediaQuery = null;
      }
    }
    if (!systemThemeMediaQuery) return;
    try {
      if (typeof systemThemeMediaQuery.addEventListener === 'function') {
        systemThemeMediaQuery.addEventListener('change', handleSystemThemePreferenceChange);
      } else if (typeof systemThemeMediaQuery.addListener === 'function') {
        systemThemeMediaQuery.addListener(handleSystemThemePreferenceChange);
      }
    } catch (error) {}
  }

  function readAppSizeMode() {
    try {
      const raw = String(window.localStorage.getItem(APP_SIZE_MODE_STORAGE_KEY) || '').trim().toLowerCase();
      return Object.prototype.hasOwnProperty.call(APP_SIZE_MODE_PRESETS, raw) ? raw : 'normal';
    } catch (error) {
      return 'normal';
    }
  }

  function applySavedAppSize() {
    const sizeMode = readAppSizeMode();
    const preset = APP_SIZE_MODE_PRESETS[sizeMode] || APP_SIZE_MODE_PRESETS.normal;
    const root = document.documentElement;
    if (root) root.setAttribute('data-app-size-mode', sizeMode);
    if (!window.electronAPI || typeof window.electronAPI.setZoomFactor !== 'function') return;
    try {
      window.electronAPI.setZoomFactor(preset.zoom);
    } catch (error) {}
  }

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function setMessage(message, type) {
    if (!messageEl) return;
    const safeMessage = normalizeText(message);
    messageEl.hidden = !safeMessage;
    messageEl.textContent = safeMessage;
    messageEl.classList.toggle('error', type === 'error');
  }

  function setTopMeta(state = {}) {
    if (updateNumberEl) {
      const updateNumber = normalizeText(state.updateNumber);
      updateNumberEl.textContent = updateNumber ? `Update ${updateNumber}` : "What's new in Noto";
    }
    if (updateDateEl) {
      const updateDate = normalizeText(state.updateDate);
      updateDateEl.textContent = updateDate || '';
    }
  }

  function hasBlockContent(block = {}) {
    return Boolean(
      normalizeText(block.number)
      || normalizeText(block.heading)
      || normalizeText(block.paragraph)
    );
  }

  function buildBlocks(state = {}) {
    const nextBlocks = [];
    if (state.intro && hasBlockContent(state.intro)) {
      nextBlocks.push({
        id: normalizeText(state.intro.id) || 'intro',
        kind: 'intro',
        number: '',
        heading: normalizeText(state.intro.heading),
        paragraph: normalizeText(state.intro.paragraph)
      });
    }

    const sectionList = Array.isArray(state.sections) ? state.sections : [];
    sectionList.forEach((section, index) => {
      if (!hasBlockContent(section)) return;
      nextBlocks.push({
        id: normalizeText(section.id) || `section-${index + 1}`,
        kind: 'section',
        number: normalizeText(section.number),
        heading: normalizeText(section.heading),
        paragraph: normalizeText(section.paragraph)
      });
    });

    if (nextBlocks.length) return nextBlocks;

    return [{
      id: 'empty',
      kind: 'empty',
      number: '',
      heading: 'No update notes were added yet',
      paragraph: 'Edit src/whats-new.json and add any heading, paragraph, or numbered sections you want to show here.'
    }];
  }

  function createBlockElement(block = {}) {
    const card = document.createElement('article');
    card.className = `whats-new-block is-${block.kind || 'section'}`;

    const hasHeaderRow = Boolean(block.number || block.heading || block.paragraph);
    if (hasHeaderRow) {
      const head = document.createElement('div');
      head.className = 'whats-new-block-head';

      if (block.number) {
        const numberEl = document.createElement('span');
        numberEl.className = 'whats-new-block-number';
        numberEl.textContent = block.number;
        head.appendChild(numberEl);
      }

      const copy = document.createElement('div');
      copy.className = 'whats-new-block-copy';

      if (block.heading) {
        const headingEl = document.createElement(block.kind === 'intro' ? 'h2' : 'h3');
        headingEl.className = 'whats-new-block-heading';
        headingEl.textContent = block.heading;
        copy.appendChild(headingEl);
      }

      if (block.paragraph) {
        const paragraphEl = document.createElement('p');
        paragraphEl.className = 'whats-new-block-paragraph';
        paragraphEl.textContent = block.paragraph;
        copy.appendChild(paragraphEl);
      }

      head.appendChild(copy);
      card.appendChild(head);
    }
    return card;
  }

  function renderCurrentPage() {
    if (!contentEl) return;
    contentEl.innerHTML = '';

    const pageBlocks = pagedBlocks[currentPageIndex] || [];
    const pageEl = document.createElement('div');
    pageEl.className = 'whats-new-page';
    pageBlocks.forEach((block) => {
      pageEl.appendChild(createBlockElement(block));
    });
    contentEl.appendChild(pageEl);
    updateNavigation();
  }

  function updateNavigation() {
    const totalPages = Math.max(1, pagedBlocks.length);
    const isFirstPage = currentPageIndex <= 0;
    const isLastPage = currentPageIndex >= totalPages - 1;
    const hideBack = totalPages <= 1 || isFirstPage;
    const hideNext = totalPages <= 1 || isLastPage;
    const hideFinish = !isLastPage;

    if (backButton) {
      backButton.classList.toggle('is-hidden', hideBack);
      backButton.disabled = hideBack;
    }
    if (nextButton) {
      nextButton.classList.toggle('is-hidden', hideNext);
      nextButton.disabled = hideNext;
    }
    if (finishButton) {
      finishButton.classList.toggle('is-hidden', hideFinish);
      finishButton.disabled = hideFinish || completeInFlight;
    }
    if (pageIndicatorEl) {
      pageIndicatorEl.textContent = totalPages > 1 ? `${currentPageIndex + 1} / ${totalPages}` : '';
    }
  }

  function createMeasurePage(widthPx) {
    const pageEl = document.createElement('div');
    pageEl.className = 'whats-new-measure-page';
    pageEl.style.width = `${Math.max(0, widthPx)}px`;
    return pageEl;
  }

  function paginateBlocks(blockList) {
    if (!contentEl || !measureEl) return [blockList];

    const availableHeight = Math.max(0, Math.floor(contentEl.clientHeight - PAGE_BOTTOM_BREATHING_ROOM_PX));
    const availableWidth = Math.floor(contentEl.clientWidth);
    if (!availableHeight || !availableWidth) return [blockList];

    measureEl.innerHTML = '';
    measureEl.style.width = `${availableWidth}px`;

    const pages = [];
    let currentBlocks = [];
    let measurePage = createMeasurePage(availableWidth);
    measureEl.appendChild(measurePage);

    blockList.forEach((block) => {
      const blockEl = createBlockElement(block);
      measurePage.appendChild(blockEl);
      const measuredHeight = Math.ceil(measurePage.getBoundingClientRect().height);

      if (measuredHeight > availableHeight && currentBlocks.length > 0) {
        measurePage.removeChild(blockEl);
        pages.push(currentBlocks);
        currentBlocks = [block];
        measurePage = createMeasurePage(availableWidth);
        measureEl.appendChild(measurePage);
        measurePage.appendChild(createBlockElement(block));
        return;
      }

      currentBlocks.push(block);
    });

    if (currentBlocks.length) {
      pages.push(currentBlocks);
    }
    if (!pages.length) {
      pages.push([]);
    }

    measureEl.innerHTML = '';
    return pages;
  }

  function repaginate() {
    pagedBlocks = paginateBlocks(blocks);
    currentPageIndex = Math.min(currentPageIndex, Math.max(0, pagedBlocks.length - 1));
    renderCurrentPage();
  }

  function queueRepaginate() {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null;
      repaginate();
    }, 90);
  }

  function waitForAnimationFrame() {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  async function waitForAssets() {
    const tasks = [];
    if (document.fonts && document.fonts.ready) {
      tasks.push(document.fonts.ready.catch(() => {}));
    }
    await Promise.all(tasks);
  }

  async function completeTour() {
    if (completeInFlight) return;
    completeInFlight = true;
    if (finishButton) finishButton.disabled = true;
    setMessage('', 'info');

    try {
      const result = (whatsNewAPI && typeof whatsNewAPI.complete === 'function')
        ? await whatsNewAPI.complete()
        : { success: true, page: 'index.html' };
      if (!result || result.success === false) {
        throw new Error((result && result.error) ? result.error : 'Failed to finish the update tour.');
      }
      const nextPage = normalizeText(result.page) || 'index.html';
      window.location.replace(nextPage);
    } catch (error) {
      setMessage(error && error.message ? error.message : 'Failed to finish the update tour.', 'error');
      completeInFlight = false;
      if (finishButton) finishButton.disabled = false;
    }
  }

  async function bootstrap() {
    wireWindowControls();
    setMessage('', 'info');

    if (!contentEl) return;
    contentEl.textContent = 'Loading update notes...';

    let state = null;
    try {
      state = (whatsNewAPI && typeof whatsNewAPI.getState === 'function')
        ? await whatsNewAPI.getState()
        : null;
    } catch (error) {
      state = null;
    }

    setTopMeta(state || {});
    blocks = buildBlocks(state || {});

    await waitForAssets();
    await waitForAnimationFrame();
    await waitForAnimationFrame();

    repaginate();
  }

  applySavedTheme();
  applySavedAppSize();
  ensureSystemThemePreferenceListener();

  if (backButton) {
    backButton.addEventListener('click', () => {
      if (currentPageIndex <= 0) return;
      currentPageIndex -= 1;
      renderCurrentPage();
    });
  }

  if (nextButton) {
    nextButton.addEventListener('click', () => {
      if (currentPageIndex >= pagedBlocks.length - 1) return;
      currentPageIndex += 1;
      renderCurrentPage();
    });
  }

  if (finishButton) {
    finishButton.addEventListener('click', completeTour);
  }

  window.addEventListener('resize', queueRepaginate);
  bootstrap();
})();
