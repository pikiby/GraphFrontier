const { ItemView, Notice, Menu, MarkdownRenderer, Modal } = require('obsidian');

const {
  GRAPHFRONTIER_VIEW_TYPE,
  NODE_MULTIPLIER_MIN,
  NODE_MULTIPLIER_MAX,
  ZOOM_STEP_FACTOR,
  MIN_ZOOM,
  MAX_ZOOM,
} = require('./constants');

const {
  kickLayoutSearch: kickLayoutSearchPhysics,
  updateLayoutCenter: updateLayoutCenterPhysics,
  getOrbitRadiusBySpacing,
  getOrbitRadiusForAnchor,
  buildAttachmentAutoOrbitMap: buildAttachmentAutoOrbitMapPhysics,
  recomputeOrbitRadii: recomputeOrbitRadiiPhysics,
  stepCameraSmoothing: stepCameraSmoothingPhysics,
  stepSimulation: stepSimulationPhysics,
} = require('./physics');

const {
  stepFocusSmoothing: stepFocusSmoothingRender,
  renderFrame: renderFrameRender,
  getHoverDimAlpha,
  hexToRgba,
  drawFocusedNodeTitle: drawFocusedNodeTitleRender,
  getNodeRadius: getNodeRadiusRender,
  getLabelZoomThreshold: getLabelZoomThresholdRender,
  getLabelFontSize: getLabelFontSizeRender,
  getGroupColorForNode: getGroupColorForNodeRender,
  nodeMatchesParsedGroup: nodeMatchesParsedGroupRender,
  drawGrid: drawGridRender,
  drawEdges: drawEdgesRender,
  drawNodes: drawNodesRender,
} = require('./render');

class GraphFrontierView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;

    this.canvasEl = null;
    this.ctx = null;
    this.wrapEl = null;
    this.sidePanelEl = null;

    this.viewWidth = 1;
    this.viewHeight = 1;
    this.devicePixelRatio = 1;

    this.nodes = [];
    this.nodeById = new Map();
    this.nodeMetaById = new Map();
    this.edges = [];

    this.lastCursorScreen = null;
    this.hoverNodeId = null;
    this.dragNodeId = null;
    this.dragNodeOffset = { x: 0, y: 0 };
    this.panDrag = null;
    this.touchGesture = null;
    this.ignoreMouseUntilMs = 0;
    this.touchLongPressTimer = null;

    this.camera = {
      x: plugin.data.view_state.pan_x || 0,
      y: plugin.data.view_state.pan_y || 0,
      zoom: plugin.data.view_state.zoom || 1,
    };
    this.cameraTarget = {
      x: this.camera.x,
      y: this.camera.y,
      zoom: this.camera.zoom,
    };
    this.layoutCenter = { x: 0, y: 0 };
    this.dragStartScreen = null;
    this.dragMovedDistance = 0;
    this.sidePanelOpen = true;
    this.sideControls = new Map();
    this.sidePanelSectionState = {};
    this.groupEditorRows = [];
    this.draggingGroupRow = null;
    this.blacklistEditorRows = [];
    this.whitelistEditorRows = [];
    this.draggingQueryRuleRow = null;
    this.searchMode = this.plugin.data.settings.search_mode === 'filter' ? 'filter' : 'find';
    this.searchInputValue = '';
    this.searchSelectedNodeId = null;
    this.searchMatchedNodeIds = new Set();
    this.searchModeToggleEl = null;
    this.searchModeFindLabelEl = null;
    this.searchModeFilterLabelEl = null;
    this.searchInputEl = null;
    this.searchClearButtonEl = null;
    this.searchSuggestSuppressUntilMs = 0;
    this.contentSearchIndex = new Map();
    this.contentSearchBuildToken = 0;
    this.focusNodeId = null;
    this.focusProgress = 0;
    this.hoverFocusNodeId = null;
    this.hoverFocusProgress = 0;
    this.hoverFadeNodeId = null;
    this.hoverFadeProgress = 0;
    this.neighborsById = new Map();
    this.clickFlashNodeId = null;
    this.clickFlashUntilMs = 0;
    this.layoutKickAtMs = Date.now();
    this.layoutStillFrames = 0;
    this.layoutAutosaveDirty = false;
    this.layoutPaused = false;
    this.quickPreviewEl = null;
    this.quickPreviewTitleEl = null;
    this.quickPreviewBodyEl = null;
    this.quickPreviewNodeId = null;
    this.quickPreviewLoadToken = 0;
    this.inputSuggestMenu = null;
    this.inputSuggestInputEl = null;
    this.visibilityGraphVersion = 0;
    this.visibilitySearchVersion = 0;
    this.filterVisibilityCache = {
      parsedRulesSignature: '',
      parsedBlacklistRules: [],
      parsedWhitelistRules: [],
      queryRuleVisibleGraphVersion: -1,
      queryRuleVisibleRulesSignature: '',
      queryRuleVisibleNodeIds: null,
      searchVisibleVersion: -1,
      searchVisibleNodeIds: null,
      finalVisibleKey: '',
      finalVisibleNodeIds: null,
    };

    this.isOpen = false;
    this.resizeObserver = null;
    this.frameHandle = null;
  }

  getViewType() {
    return GRAPHFRONTIER_VIEW_TYPE;
  }

  getDisplayText() {
    return 'GraphFrontier';
  }

  getIcon() {
    return 'orbit';
  }

  // View lifecycle: create canvas/UI on open and release resources on close.
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('graphfrontier-host');

    this.wrapEl = this.contentEl.createDiv({ cls: 'graphfrontier-wrap' });
    this.canvasEl = this.wrapEl.createEl('canvas', { cls: 'graphfrontier-canvas' });
    this.sidePanelEl = this.wrapEl.createDiv({ cls: 'graphfrontier-sidepanel' });
    this.buildQuickPreviewPanel();
    this.ctx = this.canvasEl.getContext('2d');

    this.buildSidePanel();
    this.bindEvents();
    this.installResizeObserver();
    this.resizeCanvas();

    this.refreshFromVault({ keepCamera: false });

    this.isOpen = true;
    this.runFrame();
  }

  async onClose() {
    this.isOpen = false;
    if (this.frameHandle) {
      this.contentEl.win.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.plugin.data.view_state.pan_x = this.cameraTarget.x;
    this.plugin.data.view_state.pan_y = this.cameraTarget.y;
    this.plugin.data.view_state.zoom = this.cameraTarget.zoom;
    this.contentEl.removeClass('graphfrontier-host');
    this.clearTouchLongPressTimer();
    this.closeInputSuggestMenu();
    this.closeQuickPreview();
    this.plugin.schedulePersist();
  }

  bindEvents() {
    this.registerDomEvent(this.canvasEl, 'mousemove', (event) => this.onMouseMove(event));
    this.registerDomEvent(this.canvasEl, 'mousedown', (event) => this.onMouseDown(event));
    this.registerDomEvent(this.canvasEl, 'mouseup', (event) => this.onMouseUp(event));
    this.registerDomEvent(this.canvasEl, 'mouseleave', () => this.onMouseUp());
    this.registerDomEvent(this.canvasEl, 'touchstart', (event) => this.onTouchStart(event), {
      passive: false,
    });
    this.registerDomEvent(this.canvasEl, 'touchmove', (event) => this.onTouchMove(event), {
      passive: false,
    });
    this.registerDomEvent(this.canvasEl, 'touchend', (event) => this.onTouchEnd(event), {
      passive: false,
    });
    this.registerDomEvent(this.canvasEl, 'touchcancel', (event) => this.onTouchEnd(event), {
      passive: false,
    });
    this.registerDomEvent(this.canvasEl, 'wheel', (event) => this.onWheel(event), {
      passive: false,
    });
    this.registerDomEvent(this.canvasEl, 'contextmenu', (event) => this.onContextMenu(event));
    this.registerDomEvent(this.contentEl.ownerDocument, 'mousedown', (event) => {
      if (!this.quickPreviewEl || !this.quickPreviewEl.classList.contains('is-open')) return;
      const eventTarget = event.target;
      if (eventTarget && this.quickPreviewEl.contains(eventTarget)) return;
      this.closeQuickPreview();
    });
    const visualViewport = this.contentEl.win ? this.contentEl.win.visualViewport : null;
    if (visualViewport) {
      this.registerDomEvent(visualViewport, 'resize', () => this.handleViewportResize());
      this.registerDomEvent(visualViewport, 'scroll', () => this.handleViewportResize());
    }
  }

  buildQuickPreviewPanel() {
    if (!this.wrapEl) return;
    this.quickPreviewEl = this.wrapEl.createDiv({ cls: 'graphfrontier-preview' });
    const header = this.quickPreviewEl.createDiv({ cls: 'graphfrontier-preview-header' });
    this.quickPreviewTitleEl = header.createDiv({
      cls: 'graphfrontier-preview-title',
      text: 'Preview',
    });
    const closeButton = header.createEl('button', {
      cls: 'graphfrontier-preview-close',
      text: 'x',
    });
    this.quickPreviewBodyEl = this.quickPreviewEl.createDiv({ cls: 'graphfrontier-preview-body' });
    this.registerDomEvent(closeButton, 'click', () => this.closeQuickPreview());
  }

  // Right side panel assembly: toggles, sliders, and layout action buttons.
  buildSidePanel() {
    if (!this.sidePanelEl) return;
    this.sidePanelEl.empty();
    this.sideControls.clear();
    this.searchModeToggleEl = null;
    this.searchModeFindLabelEl = null;
    this.searchModeFilterLabelEl = null;
    this.searchInputEl = null;
    this.searchClearButtonEl = null;
    this.sidePanelEl.toggleClass('is-open', this.sidePanelOpen);

    const header = this.sidePanelEl.createDiv({ cls: 'graphfrontier-sidepanel-header' });
    header.createSpan({ text: 'Graph settings', cls: 'graphfrontier-sidepanel-title' });
    const toggleBtn = header.createEl('button', {
      text: this.sidePanelOpen ? 'Hide' : 'Show',
      cls: 'graphfrontier-sidepanel-toggle',
    });
    this.registerDomEvent(toggleBtn, 'click', () => {
      this.sidePanelOpen = !this.sidePanelOpen;
      this.buildSidePanel();
    });

    const body = this.sidePanelEl.createDiv({ cls: 'graphfrontier-sidepanel-body' });
    if (!this.sidePanelOpen) return;

    const searchSection = this.createSidePanelSection(body, {
      id: 'search',
      title: 'Search',
      openByDefault: true,
    });
    this.buildFindSection(searchSection);

    const displaySection = this.createSidePanelSection(body, {
      id: 'display',
      title: 'Display',
      openByDefault: true,
    });
    this.addSideToggle(displaySection, 'Show grid', 'show_grid', 'render', {
      hint: 'Show or hide background grid in graph area',
    });
    this.addSideToggle(displaySection, 'Existing files only', 'existing_files_only', 'data', {
      hint: 'Show only files that currently exist in vault',
    });
    this.addSideToggle(displaySection, 'Show orphans', 'hide_orphans', 'data', {
      inverted: true,
      hint: 'Show nodes without links (orphans)',
    });
    this.addSideToggle(displaySection, 'Show attachments', 'hide_attachments', 'data', {
      inverted: true,
      rebuildPanelOnChange: true,
      hint: 'Show non-markdown files as attachment nodes',
    });
    if (!this.plugin.data.settings.hide_attachments) {
      this.addSideSlider(
        displaySection,
        'Attachment size',
        'attachment_size_multiplier',
        0.1,
        1,
        0.1,
        'render',
        {
          hint: 'Scale multiplier for attachment node size',
        }
      );
      this.addSideSlider(
        displaySection,
        'Attachment link distance',
        'attachment_link_distance_multiplier',
        1,
        100,
        1,
        'render',
        {
          hint: 'Target distance for links connected to attachments',
        }
      );
    }

    this.addSideSlider(displaySection, 'Grid step', 'grid_step', 5, 50, 5, 'render', {
      hint: 'Grid cell size in world coordinates',
    });
    this.addSideSlider(displaySection, 'Node size', 'node_size_scale', 0.1, 2, 0.01, 'render', {
      hint: 'Visual node radius scale',
    });
    this.addSideSlider(displaySection, 'Edge width', 'edge_width_scale', 0.01, 1, 0.01, 'render', {
      hint: 'Visual thickness of regular edges',
    });
    this.addSideSlider(
      displaySection,
      'Painted edge width',
      'painted_edge_width',
      0.01,
      1,
      0.01,
      'render',
      {
        hint: 'Visual thickness for painted edges only',
      }
    );
    this.addSideSlider(displaySection, 'Text zoom', 'label_zoom_steps', 1, 20, 1, 'render', {
      hint: 'How far labels stay visible when zooming out',
    });
    this.addSideSlider(displaySection, 'Text size', 'label_font_size', 5, 20, 1, 'render', {
      hint: 'Base font size for node labels',
    });
    this.addSideSlider(displaySection, 'Hover dimming', 'hover_dim_strength', 0, 100, 1, 'render', {
      hint: 'How strongly non-focused nodes/edges are dimmed',
    });

    const physicsSection = this.createSidePanelSection(body, {
      id: 'physics',
      title: 'Physics',
      openByDefault: true,
    });
    this.addSideSlider(physicsSection, 'Link strength', 'base_link_strength', 1, 100, 1, 'render', {
      hint: 'Spring force for graph links',
    });
    this.addSideSlider(physicsSection, 'Link distance', 'link_distance', 1, 50, 1, 'render', {
      hint: 'Target distance for regular links',
    });
    this.addSideSlider(
      physicsSection,
      'Strong pull x',
      'strong_pull_multiplier',
      NODE_MULTIPLIER_MIN,
      NODE_MULTIPLIER_MAX,
      1,
      'render',
      {
        hint: 'Multiplier used by Strong pull command',
      }
    );
    this.addSideSlider(physicsSection, 'Orbit distance', 'orbit_distance', 1, 100, 1, 'render', {
      hint: 'Desired spacing between nodes pinned to same orbit',
    });
    this.addSideSlider(physicsSection, 'Repel strength', 'repel_strength', 0, 100, 1, 'render', {
      hint: 'Repulsion force between nodes',
    });
    this.addSideSlider(physicsSection, 'Repel radius', 'repel_radius', 20, 500, 5, 'render', {
      hint: 'Repulsion cutoff radius for node-to-node interactions',
    });
    this.addSideSlider(physicsSection, 'Center strength', 'center_strength', 1, 100, 1, 'render', {
      hint: 'How strongly free nodes are attracted to layout center',
    });
    this.addSideSlider(physicsSection, 'Damping', 'damping', 0.01, 0.9, 0.01, 'render', {
      hint: 'Speed damping per frame; higher means faster stop',
    });

    const groupsSection = this.createSidePanelSection(body, {
      id: 'groups',
      title: 'Groups',
      openByDefault: true,
    });
    this.buildGroupEditorSection(groupsSection);

    const listsSection = this.createSidePanelSection(body, {
      id: 'lists',
      title: 'Blacklist / Whitelist',
      openByDefault: true,
    });
    this.buildQueryRuleEditorSection(listsSection, {
      title: 'Blacklist',
      key: 'blacklist',
      hint: 'Hide nodes that match query rules',
    });
    this.buildQueryRuleEditorSection(listsSection, {
      title: 'Whitelist',
      key: 'whitelist',
      hint: 'Show only nodes that match query rules (after blacklist)',
    });

    const layoutSection = this.createSidePanelSection(body, {
      id: 'layout',
      title: 'Layout',
      openByDefault: true,
    });
    this.addSideSaveLayoutButton(layoutSection);
  }

  createSidePanelSection(parentEl, options = {}) {
    const sectionId = String(options.id || '')
      .trim()
      .toLowerCase();
    const titleText = String(options.title || '').trim() || 'Section';
    const openByDefault = options.openByDefault !== false;
    const hasSavedState = sectionId
      ? Object.prototype.hasOwnProperty.call(this.sidePanelSectionState, sectionId)
      : false;
    let isOpen = hasSavedState ? !!this.sidePanelSectionState[sectionId] : openByDefault;

    const section = parentEl.createDiv({ cls: 'graphfrontier-sidepanel-section' });
    const toggleBtn = section.createEl('button', {
      cls: 'graphfrontier-sidepanel-section-toggle',
      text: titleText,
      attr: {
        type: 'button',
        'aria-label': `Toggle ${titleText}`,
      },
    });
    const content = section.createDiv({ cls: 'graphfrontier-sidepanel-section-content' });

    const applyOpenState = (nextOpen) => {
      isOpen = !!nextOpen;
      section.toggleClass('is-open', isOpen);
      toggleBtn.toggleClass('is-open', isOpen);
      toggleBtn.setAttr('aria-expanded', isOpen ? 'true' : 'false');
      if (sectionId) this.sidePanelSectionState[sectionId] = isOpen;
    };

    applyOpenState(isOpen);
    this.registerDomEvent(toggleBtn, 'click', (event) => {
      event.preventDefault();
      applyOpenState(!isOpen);
    });

    return content;
  }

  addSideToggle(parentEl, label, key, refreshMode, options = {}) {
    const isInverted = !!options.inverted;
    const hintText = String(options.hint || label);
    const toUiValue = (rawValue) => {
      const safeValue = !!rawValue;
      return isInverted ? !safeValue : safeValue;
    };
    const fromUiValue = (uiValue) => {
      const safeValue = !!uiValue;
      return isInverted ? !safeValue : safeValue;
    };

    const row = parentEl.createDiv({ cls: 'graphfrontier-sidepanel-row' });
    row.setAttr('title', hintText);
    const labelEl = row.createSpan({ text: label, cls: 'graphfrontier-sidepanel-label' });
    labelEl.setAttr('title', hintText);
    const button = row.createEl('button', { cls: 'graphfrontier-toggle-btn' });
    button.setAttr('title', hintText);
    const updateButton = (isOn) => {
      button.setText('');
      button.toggleClass('is-on', isOn);
      button.setAttr('aria-label', `${label}: ${isOn ? 'on' : 'off'}`);
    };
    updateButton(toUiValue(this.plugin.data.settings[key]));

    this.sideControls.set(key, {
      type: 'boolean',
      input: button,
      updateButton,
      toUiValue,
    });

    this.registerDomEvent(button, 'click', () => {
      const currentUiValue = toUiValue(this.plugin.data.settings[key]);
      const nextUiValue = !currentUiValue;
      this.plugin.data.settings[key] = fromUiValue(nextUiValue);
      updateButton(nextUiValue);
      this.plugin.schedulePersist();
      this.applyRefreshMode(refreshMode);
      if (options.rebuildPanelOnChange) {
        this.buildSidePanel();
      }
    });
  }

  addSideSlider(parentEl, label, key, min, max, step, refreshMode, options = {}) {
    const hintText = String(options.hint || label);
    const row = parentEl.createDiv({ cls: 'graphfrontier-sidepanel-row' });
    row.addClass('is-slider');
    row.setAttr('title', hintText);
    const labelEl = row.createSpan({ text: label, cls: 'graphfrontier-sidepanel-label' });
    labelEl.setAttr('title', hintText);
    const input = row.createEl('input', { type: 'range', cls: 'graphfrontier-sidepanel-slider' });
    input.setAttr('title', hintText);
    const valueEl = row.createSpan({ cls: 'graphfrontier-sidepanel-value' });
    valueEl.setAttr('title', hintText);
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(this.plugin.data.settings[key]);
    valueEl.setText(this.formatSliderValue(Number(input.value), step));

    this.sideControls.set(key, {
      type: 'slider',
      input,
      valueEl,
      min,
      max,
      step,
    });

    const applyValueFromSlider = () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) return;
      const clamped = Math.max(min, Math.min(max, parsed));
      this.plugin.data.settings[key] = clamped;
      valueEl.setText(this.formatSliderValue(clamped, step));
      if (key === 'strong_pull_multiplier') {
        this.plugin.applyStrongPullToMarkedNodes();
      }
      if (
        key === 'strong_pull_multiplier' ||
        key === 'base_link_strength' ||
        key === 'link_distance' ||
        key === 'orbit_distance' ||
        key === 'attachment_link_distance_multiplier' ||
        key === 'repel_strength' ||
        key === 'repel_radius' ||
        key === 'center_strength' ||
        key === 'damping'
      ) {
        this.kickLayoutSearch();
      }
      if (key === 'link_distance' || key === 'orbit_distance') {
        this.recomputeOrbitRadii();
      }
      this.plugin.schedulePersist();
      this.applyRefreshMode(refreshMode);
    };

    this.registerDomEvent(input, 'input', applyValueFromSlider);
    this.registerDomEvent(input, 'change', applyValueFromSlider);
  }

  addSideSaveLayoutButton(parentEl) {
    const wrap = parentEl.createDiv({ cls: 'graphfrontier-sidepanel-actions' });
    const row = wrap.createDiv({ cls: 'graphfrontier-sidepanel-actions-row' });
    const autosaveWrap = row.createDiv({ cls: 'graphfrontier-sidepanel-autosave' });
    autosaveWrap.setAttr('title', 'Automatically save layout after nodes stop moving');
    const autosaveLabel = autosaveWrap.createSpan({
      text: 'Autosave',
      cls: 'graphfrontier-sidepanel-label',
    });
    autosaveLabel.setAttr('title', 'Automatically save layout after nodes stop moving');
    const autosaveBtn = autosaveWrap.createEl('button', { cls: 'graphfrontier-toggle-btn' });
    autosaveBtn.setAttr('title', 'Automatically save layout after nodes stop moving');
    const updateAutosaveButton = (isOn) => {
      autosaveBtn.setText('');
      autosaveBtn.toggleClass('is-on', isOn);
      autosaveBtn.setAttr('aria-label', `Autosave: ${isOn ? 'on' : 'off'}`);
    };
    updateAutosaveButton(!!this.plugin.data.settings.layout_autosave);

    this.registerDomEvent(autosaveBtn, 'click', () => {
      const next = !this.plugin.data.settings.layout_autosave;
      this.plugin.data.settings.layout_autosave = next;
      updateAutosaveButton(next);
      this.plugin.schedulePersist();
    });

    const buttonsWrap = row.createDiv({ cls: 'graphfrontier-sidepanel-buttons' });

    const saveButton = buttonsWrap.createEl('button', {
      cls: 'graphfrontier-sidepanel-save',
      text: 'Save layout',
    });
    saveButton.setAttr('title', 'Save positions, settings, and pin states');

    this.registerDomEvent(saveButton, 'click', async () => {
      if (this.isSearchFilled()) {
        new Notice('Clear search field to save');
        return;
      }
      await this.saveCurrentLayout();
    });

    const loadButton = buttonsWrap.createEl('button', {
      cls: 'graphfrontier-sidepanel-save',
      text: 'Load layout',
    });
    loadButton.setAttr('title', 'Load last saved positions, settings, and pin states');
    this.registerDomEvent(loadButton, 'click', async () => {
      await this.loadSavedLayout();
    });
  }

  // Search block: find/filter mode controls, source picker (name/content), and node suggestions.
  buildFindSection(parentEl) {
    const section = parentEl.createDiv({ cls: 'graphfrontier-find' });

    const controlsRow = section.createDiv({ cls: 'graphfrontier-find-mode-row' });
    const controlsLeft = controlsRow.createDiv({
      cls: 'graphfrontier-find-mode-controls graphfrontier-find-mode-controls-left',
    });
    const findLabel = controlsLeft.createSpan({
      cls: 'graphfrontier-find-mode-label',
      text: 'Find',
    });
    this.searchModeFindLabelEl = findLabel;
    const modeToggle = controlsLeft.createEl('button', {
      cls: 'graphfrontier-toggle-btn graphfrontier-search-mode-toggle',
      attr: { 'aria-label': 'Search mode toggle' },
    });
    this.searchModeToggleEl = modeToggle;
    const filterLabel = controlsLeft.createSpan({
      cls: 'graphfrontier-find-mode-label',
      text: 'Filter',
    });
    this.searchModeFilterLabelEl = filterLabel;
    this.syncSearchModeToggleUi();

    const searchRow = section.createDiv({ cls: 'graphfrontier-find-row' });
    const searchInputWrap = searchRow.createDiv({
      cls: 'graphfrontier-search-input-wrap graphfrontier-input-anchor',
    });
    const searchInput = searchInputWrap.createEl('input', {
      cls: 'graphfrontier-find-input',
      type: 'text',
      placeholder: 'Enter query...',
    });
    searchInput.value = this.searchInputValue;
    this.searchInputEl = searchInput;
    const clearButton = searchInputWrap.createEl('button', {
      cls: 'graphfrontier-search-inline-clear',
      text: 'x',
      attr: { 'aria-label': 'Clear search' },
    });
    this.searchClearButtonEl = clearButton;

    const getSuggestionPack = () => {
      const rawQuery = String(searchInput.value || '');
      return this.getSearchSuggestionPack(rawQuery, Number.POSITIVE_INFINITY);
    };

    const isSuggestPopupSuppressed = () => Date.now() < this.searchSuggestSuppressUntilMs;

    const openSearchSuggestionPopup = () => {
      if (isSuggestPopupSuppressed()) return;
      const suggestionPack = getSuggestionPack();
      this.showInputSuggestMenu(
        searchInput,
        suggestionPack.items,
        (selectedText, selectedSuggestion) => {
          const suggestionKind = String(selectedSuggestion?.kind || '');
          if (suggestionKind === 'source') {
            const parsed = this.parseSearchQuery(searchInput.value || '');
            const suffixQuery = String(parsed.query || '').trim();
            const nextText = suffixQuery ? `${selectedText}${suffixQuery}` : selectedText;
            searchInput.value = nextText;
            this.searchInputValue = nextText;
            this.searchSelectedNodeId = null;
            this.syncSearchMatchesLive();
            this.syncSearchClearButtonVisibility();
            this.kickLayoutSearch();
            this.contentEl.win.setTimeout(() => openSearchSuggestionPopup(), 0);
            return;
          }
          searchInput.value = selectedText;
          this.searchInputValue = selectedText;
          commitBestSearchSelection();
          this.kickLayoutSearch();
        },
        { title: suggestionPack.menuTitle || '' }
      );
    };

    const commitBestSearchSelection = () => {
      const rawText = String(searchInput.value || '');
      this.commitSearchSelectionFromInput(rawText);
    };

    this.registerDomEvent(modeToggle, 'click', () => {
      this.searchMode = this.searchMode === 'filter' ? 'find' : 'filter';
      this.plugin.data.settings.search_mode = this.searchMode;
      this.markSearchVisibilityDirty();
      this.syncSearchModeToggleUi();
      this.kickLayoutSearch();
      this.plugin.schedulePersist();
    });

    this.registerDomEvent(searchInput, 'input', () => {
      this.searchInputValue = String(searchInput.value || '');
      this.searchSelectedNodeId = null;
      this.syncSearchMatchesLive();
      this.syncSearchClearButtonVisibility();
      this.kickLayoutSearch();
      openSearchSuggestionPopup();
    });
    this.registerDomEvent(searchInput, 'change', () => {
      commitBestSearchSelection();
    });
    this.registerDomEvent(searchInput, 'keydown', (event) => {
      const hasActiveMenu =
        !!this.inputSuggestMenu &&
        this.inputSuggestInputEl &&
        this.inputSuggestInputEl === searchInput;
      if (hasActiveMenu && event.key === 'ArrowDown') {
        event.preventDefault();
        this.moveInputSuggestSelection(1);
        return;
      }
      if (hasActiveMenu && event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveInputSuggestSelection(-1);
        return;
      }
      if (hasActiveMenu && event.key === 'Escape') {
        event.preventDefault();
        this.closeInputSuggestMenu();
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (hasActiveMenu && this.selectInputSuggestActive()) return;
      commitBestSearchSelection();
      this.closeInputSuggestMenu();
    });
    this.registerDomEvent(searchInput, 'blur', () => {
      commitBestSearchSelection();
      this.contentEl.win.setTimeout(() => {
        if (!this.inputSuggestInputEl || this.inputSuggestInputEl !== searchInput) return;
        this.closeInputSuggestMenu();
      }, 0);
    });
    this.registerDomEvent(searchInput, 'click', () => {
      openSearchSuggestionPopup();
    });

    this.registerDomEvent(clearButton, 'click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.searchSuggestSuppressUntilMs = Date.now() + 220;
      this.searchInputValue = '';
      this.searchSelectedNodeId = null;
      this.searchMatchedNodeIds = new Set();
      this.markSearchVisibilityDirty();
      if (this.searchInputEl) this.searchInputEl.value = '';
      this.syncSearchClearButtonVisibility();
      this.kickLayoutSearch();
      this.closeInputSuggestMenu();
      if (this.searchInputEl) this.searchInputEl.focus();
    });

    this.syncSearchClearButtonVisibility();
  }

  syncSearchModeToggleUi() {
    if (!this.searchModeToggleEl) return;
    const safeMode = this.searchMode === 'filter' ? 'filter' : 'find';
    this.searchModeToggleEl.toggleClass('is-on', safeMode === 'filter');
    this.searchModeToggleEl.setAttr('aria-label', `Search mode: ${safeMode}`);
    if (this.searchModeFindLabelEl)
      this.searchModeFindLabelEl.toggleClass('is-active', safeMode === 'find');
    if (this.searchModeFilterLabelEl)
      this.searchModeFilterLabelEl.toggleClass('is-active', safeMode === 'filter');
  }

  parseDropdownQuery(rawQueryText, options = {}) {
    const allowName = options.allowName === true;
    const implicitSource = String(options.implicitSource || '')
      .trim()
      .toLowerCase();
    const raw = String(rawQueryText || '');
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    if (allowName && lower.startsWith('name:')) {
      return {
        source: 'name',
        query: trimmed.slice('name:'.length).trim(),
        hasExplicitSource: true,
        parsedGroup: null,
      };
    }
    const parsedGroup = this.plugin.parseGroupQuery(trimmed);
    if (parsedGroup) {
      return {
        source: parsedGroup.type,
        query: String(parsedGroup.value || '').trim(),
        hasExplicitSource: true,
        parsedGroup,
      };
    }
    return {
      source: implicitSource,
      query: trimmed,
      hasExplicitSource: false,
      parsedGroup: null,
    };
  }

  parseSearchQuery(rawQueryText) {
    return this.parseDropdownQuery(rawQueryText, {
      allowName: true,
      implicitSource: 'content',
    });
  }

  getEffectiveSearchSource() {
    const rawText = this.searchInputEl ? this.searchInputEl.value : this.searchInputValue;
    return this.parseSearchQuery(rawText).source;
  }

  getQueryTypeOptions(options = {}) {
    const includeName = options.includeName === true;
    const base = [
      { value: 'path:', description: 'match path of the file' },
      { value: 'file:', description: 'match file name' },
      { value: 'tag:', description: 'search for tags' },
      { value: 'line:', description: 'search keywords on same line' },
      { value: 'section:', description: 'search keywords under same heading' },
      { value: '[property]:', description: 'match property' },
    ];
    if (!includeName) return base;
    return [{ value: 'name:', description: 'search by node names' }, ...base];
  }

  getQueryTypeSuggestions(rawQueryText, options = {}) {
    const allowName = options.allowName === true;
    const showWhenTyping = options.showWhenTyping === true;
    const parsed = this.parseDropdownQuery(rawQueryText, {
      allowName,
      implicitSource: String(options.implicitSource || ''),
    });
    if (parsed.hasExplicitSource) return [];

    const text = String(parsed.query || '')
      .trim()
      .toLowerCase();
    if (text && !showWhenTyping) return [];

    const optionItems = this.getQueryTypeOptions({ includeName: allowName });
    const filteredItems = text
      ? optionItems.filter((option) => {
          const valueText = String(option.value || '').toLowerCase();
          const descriptionText = String(option.description || '').toLowerCase();
          return valueText.includes(text) || descriptionText.includes(text);
        })
      : optionItems;
    return filteredItems.map((option) => ({
      title: option.value,
      value: option.value,
      description: option.description,
      kind: 'source',
      selectable: true,
    }));
  }

  getQueryPropertyPrefixSuggestions(rawQueryText, limit = 2000) {
    const cleanQuery = String(rawQueryText || '').trim();
    const maybeProperty = /^\[([^\]]*)$/i.exec(cleanQuery);
    if (!maybeProperty) return [];
    const propertyQuery = String(maybeProperty[1] || '').trim();
    const propertyKeys = this.plugin.getGroupPropertyKeySuggestions(propertyQuery, limit);
    return propertyKeys.map((propertyKey) => ({
      title: `[${propertyKey}]:`,
      value: `[${propertyKey}]:`,
      description: '',
      kind: 'source',
      selectable: true,
    }));
  }

  getQueryValueSuggestions(parsed, limit = 2000) {
    if (!parsed || !parsed.hasExplicitSource) return [];
    if (parsed.source === 'name') {
      return this.getVisibleNodeSuggestionsByName(parsed.query, limit).map((label) => ({
        title: label,
        value: `name:${label}`,
        description: '',
        kind: 'node',
        selectable: true,
      }));
    }
    if (parsed.source === 'property') {
      const propertyKey = String(parsed.parsedGroup?.propertyKey || '')
        .trim()
        .toLowerCase();
      if (propertyKey === 'property' && !String(parsed.query || '').trim()) {
        const propertyKeys = this.plugin.getGroupPropertyKeySuggestions('', limit);
        return propertyKeys.map((propertyName) => ({
          title: `[${propertyName}]:`,
          value: `[${propertyName}]:`,
          description: '',
          kind: 'value',
          selectable: true,
        }));
      }
      if (!propertyKey) return [];
      const values = this.plugin.getGroupValueSuggestions(
        'property',
        parsed.query,
        propertyKey,
        limit
      );
      return values.map((value) => ({
        title: value,
        value: `[${propertyKey}]:${value}`,
        description: '',
        kind: 'value',
        selectable: true,
      }));
    }

    if (!['path', 'file', 'tag', 'line', 'section'].includes(parsed.source)) return [];
    const values = this.plugin.getGroupValueSuggestions(parsed.source, parsed.query, '', limit);
    return values.map((value) => ({
      title: value,
      value: `${parsed.source}:${value}`,
      description: '',
      kind: 'value',
      selectable: true,
    }));
  }

  getQuerySuggestionPack(rawQueryText, options = {}) {
    const allowName = options.allowName === true;
    const showTypeSuggestionsWhenTyping = options.showTypeSuggestionsWhenTyping === true;
    const implicitSource = String(options.implicitSource || '');
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : Number.POSITIVE_INFINITY;
    const parsed = this.parseDropdownQuery(rawQueryText, {
      allowName,
      implicitSource,
    });

    if (!parsed.hasExplicitSource) {
      if (!parsed.query) {
        return {
          items: this.getQueryTypeSuggestions(rawQueryText, {
            allowName,
            implicitSource,
            showWhenTyping: true,
          }),
          menuTitle: 'Search options',
        };
      }
      if (!showTypeSuggestionsWhenTyping) return { items: [], menuTitle: '' };
      const propertyPrefixItems = this.getQueryPropertyPrefixSuggestions(rawQueryText, limit);
      if (propertyPrefixItems.length > 0) {
        return { items: propertyPrefixItems, menuTitle: 'Search options' };
      }
      return {
        items: this.getQueryTypeSuggestions(rawQueryText, {
          allowName,
          implicitSource,
          showWhenTyping: true,
        }),
        menuTitle: 'Search options',
      };
    }
    return { items: this.getQueryValueSuggestions(parsed, limit), menuTitle: '' };
  }

  getSearchSuggestionPack(rawQueryText, limit = Number.POSITIVE_INFINITY) {
    return this.getQuerySuggestionPack(rawQueryText, {
      allowName: true,
      implicitSource: 'content',
      showTypeSuggestionsWhenTyping: false,
      limit,
    });
  }

  getGroupQuerySuggestions(queryText = '') {
    return this.getQuerySuggestionPack(queryText, {
      allowName: true,
      implicitSource: '',
      showTypeSuggestionsWhenTyping: true,
      limit: 2000,
    });
  }

  getVisibleNodeSuggestionsByName(query = '', limit = Number.POSITIVE_INFINITY) {
    const text = String(query || '')
      .trim()
      .toLowerCase();
    const labels = [];
    const used = new Set();
    for (const node of this.nodes) {
      const label = String(node?.label || '').trim();
      if (!label || used.has(label)) continue;
      used.add(label);
      labels.push(label);
    }
    labels.sort((leftLabel, rightLabel) => leftLabel.localeCompare(rightLabel));
    const filtered = [];
    for (const label of labels) {
      if (filtered.length >= limit) break;
      if (!text || label.toLowerCase().includes(text)) filtered.push(label);
    }
    return filtered;
  }

  getBestMatchingNodeByName(queryText) {
    const query = String(queryText || '')
      .trim()
      .toLowerCase();
    if (!query) return null;
    let bestStartsWithNode = null;
    let bestStartsWithLabel = '';
    let bestContainsNode = null;
    let bestContainsLabel = '';
    for (const node of this.nodes) {
      const label = String(node.label || '').toLowerCase();
      if (!label) continue;
      if (label === query) return node;
      if (label.startsWith(query)) {
        if (!bestStartsWithNode || label.localeCompare(bestStartsWithLabel) < 0) {
          bestStartsWithNode = node;
          bestStartsWithLabel = label;
        }
        continue;
      }
      if (label.includes(query)) {
        if (!bestContainsNode || label.localeCompare(bestContainsLabel) < 0) {
          bestContainsNode = node;
          bestContainsLabel = label;
        }
      }
    }
    return bestStartsWithNode || bestContainsNode || null;
  }

  getBestMatchingNode(queryText) {
    const parsed = this.parseSearchQuery(queryText);
    if (parsed.source !== 'name') return null;
    return this.getBestMatchingNodeByName(parsed.query);
  }

  getNodeMetaForSearch(node) {
    return this.nodeMetaById.get(node.id) || node.meta || null;
  }

  nodeMatchesSearchParsed(meta, parsed) {
    if (!meta || !parsed) return false;
    const needle = String(parsed.query || '')
      .trim()
      .toLowerCase();
    if (!needle) return false;

    const includesCI = (value) =>
      String(value || '')
        .toLowerCase()
        .includes(needle);
    if (parsed.source === 'path') return includesCI(meta.path);
    if (parsed.source === 'file') return includesCI(meta.fileName);
    if (parsed.source === 'tag')
      return Array.isArray(meta.tags) && meta.tags.some((tag) => includesCI(tag));
    if (parsed.source === 'section')
      return Array.isArray(meta.sections) && meta.sections.some((section) => includesCI(section));
    if (parsed.source === 'line')
      return Array.isArray(meta.lines) && meta.lines.some((line) => includesCI(line));
    if (parsed.source === 'property') {
      const key = String(parsed.parsedGroup?.propertyKey || '')
        .trim()
        .toLowerCase();
      if (!key) return false;
      const values = meta.properties instanceof Map ? meta.properties.get(key) : null;
      return Array.isArray(values) && values.some((value) => includesCI(value));
    }
    return false;
  }

  getMatchedNodeIdsForParsedSearch(parsed) {
    const matches = new Set();
    if (!parsed) return matches;
    const queryText = String(parsed.query || '')
      .trim()
      .toLowerCase();
    if (!queryText) return matches;

    if (parsed.source === 'content') {
      for (const node of this.nodes) {
        if (node?.meta?.isAttachment) continue;
        const contentText = this.contentSearchIndex.get(node.id);
        if (contentText && contentText.includes(queryText)) matches.add(node.id);
      }
      return matches;
    }

    if (parsed.source === 'name') return matches;

    for (const node of this.nodes) {
      const meta = this.getNodeMetaForSearch(node);
      if (!meta) continue;
      if (this.nodeMatchesSearchParsed(meta, parsed)) matches.add(node.id);
    }
    return matches;
  }

  syncSearchMatchesLive() {
    const rawText = this.searchInputEl ? this.searchInputEl.value : this.searchInputValue;
    const parsed = this.parseSearchQuery(rawText);
    if (!parsed.query || parsed.source === 'name') {
      this.searchMatchedNodeIds = new Set();
      this.markSearchVisibilityDirty();
      return;
    }
    this.searchMatchedNodeIds = this.getMatchedNodeIdsForParsedSearch(parsed);
    this.markSearchVisibilityDirty();
  }

  commitSearchSelectionFromInput(rawText) {
    const text = String(rawText || '');
    this.searchInputValue = text;
    const parsed = this.parseSearchQuery(text);
    if (!parsed.query) {
      this.searchSelectedNodeId = null;
      this.searchMatchedNodeIds = new Set();
      this.markSearchVisibilityDirty();
      this.syncSearchClearButtonVisibility();
      if (this.searchMode === 'filter') this.kickLayoutSearch();
      return;
    }
    if (parsed.source === 'name') {
      this.searchMatchedNodeIds = new Set();
      const bestNode = this.getBestMatchingNodeByName(parsed.query);
      if (!bestNode) {
        this.searchSelectedNodeId = null;
        this.markSearchVisibilityDirty();
        this.syncSearchClearButtonVisibility();
        if (this.searchMode === 'filter') this.kickLayoutSearch();
        return;
      }
      this.applySearchSelectionFromNode(bestNode, { forceSource: 'name' });
      this.syncSearchClearButtonVisibility();
      if (this.searchMode === 'filter') this.kickLayoutSearch();
      return;
    }
    this.searchSelectedNodeId = null;
    this.searchMatchedNodeIds = this.getMatchedNodeIdsForParsedSearch(parsed);
    this.markSearchVisibilityDirty();
    this.syncSearchClearButtonVisibility();
    if (this.searchMode === 'filter') this.kickLayoutSearch();
  }

  getSearchHighlightNodeIds() {
    if (this.searchMatchedNodeIds instanceof Set && this.searchMatchedNodeIds.size > 0) {
      return this.searchMatchedNodeIds;
    }
    return null;
  }

  applySearchSelectionFromNode(node, options = {}) {
    if (!node) return;
    this.searchMatchedNodeIds = new Set();
    this.searchSelectedNodeId = node.id;
    const parsed = this.parseSearchQuery(
      this.searchInputEl ? this.searchInputEl.value : this.searchInputValue
    );
    const forcedSource = options && options.forceSource === 'name' ? 'name' : '';
    const prefix = forcedSource
      ? `${forcedSource}:`
      : parsed.hasExplicitSource
        ? `${parsed.source}:`
        : '';
    this.searchInputValue = prefix
      ? `${prefix}${String(node.label || '')}`
      : String(node.label || '');
    if (this.searchInputEl) this.searchInputEl.value = this.searchInputValue;
    this.markSearchVisibilityDirty();
    this.syncSearchClearButtonVisibility();
    this.plugin.schedulePersist();
  }

  syncSearchClearButtonVisibility() {
    if (!this.searchClearButtonEl) return;
    const textFromInput = this.searchInputEl ? this.searchInputEl.value : '';
    const effectiveText = String(textFromInput || this.searchInputValue || '').trim();
    const hasText = effectiveText.length > 0;
    this.searchClearButtonEl.toggleClass('is-visible', hasText);
    this.searchClearButtonEl.disabled = !hasText;
  }

  markGraphVisibilityDirty() {
    this.visibilityGraphVersion += 1;
    this.filterVisibilityCache.queryRuleVisibleGraphVersion = -1;
    this.filterVisibilityCache.queryRuleVisibleNodeIds = null;
    this.filterVisibilityCache.finalVisibleKey = '';
    this.filterVisibilityCache.finalVisibleNodeIds = null;
  }

  markSearchVisibilityDirty() {
    this.visibilitySearchVersion += 1;
    this.filterVisibilityCache.searchVisibleVersion = -1;
    this.filterVisibilityCache.searchVisibleNodeIds = null;
    this.filterVisibilityCache.finalVisibleKey = '';
    this.filterVisibilityCache.finalVisibleNodeIds = null;
  }

  markQueryRuleVisibilityDirty() {
    this.filterVisibilityCache.parsedRulesSignature = '';
    this.filterVisibilityCache.parsedBlacklistRules = [];
    this.filterVisibilityCache.parsedWhitelistRules = [];
    this.filterVisibilityCache.queryRuleVisibleGraphVersion = -1;
    this.filterVisibilityCache.queryRuleVisibleRulesSignature = '';
    this.filterVisibilityCache.queryRuleVisibleNodeIds = null;
    this.filterVisibilityCache.finalVisibleKey = '';
    this.filterVisibilityCache.finalVisibleNodeIds = null;
  }

  getActiveQueryRuleSignature() {
    const serializeRules = (rules) => {
      if (!Array.isArray(rules) || rules.length === 0) return '';
      const parts = [];
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        const id = String(rule.id || '').trim();
        const query = String(rule.query || '').trim();
        const enabled = rule.enabled !== false ? '1' : '0';
        parts.push(`${id}|${enabled}|${query}`);
      }
      return parts.join('||');
    };
    const blacklistRules = this.plugin?.data?.blacklist;
    const whitelistRules = this.plugin?.data?.whitelist;
    return `b:${serializeRules(blacklistRules)}##w:${serializeRules(whitelistRules)}`;
  }

  getFilterNodeId() {
    if (this.searchMode !== 'filter') return null;
    if (this.getEffectiveSearchSource() !== 'name') return null;
    const rawText = this.searchInputEl ? this.searchInputEl.value : this.searchInputValue;
    const parsed = this.parseSearchQuery(rawText);
    if (parsed.query) {
      const liveBestNode = this.getBestMatchingNodeByName(parsed.query);
      if (liveBestNode) return liveBestNode.id;
    }
    return this.searchSelectedNodeId || null;
  }

  getFilterVisibleNodeIds() {
    const queryRuleVisibleNodeIds = this.getQueryRuleVisibleNodeIds();
    const searchVisibleNodeIds = this.getSearchModeVisibleNodeIds();
    const activeRuleSignature = this.filterVisibilityCache.queryRuleVisibleRulesSignature || '';
    const finalKey = [
      this.visibilityGraphVersion,
      this.visibilitySearchVersion,
      activeRuleSignature,
      queryRuleVisibleNodeIds instanceof Set ? 'q:1' : 'q:0',
      searchVisibleNodeIds instanceof Set ? 's:1' : 's:0',
    ].join('|');
    if (this.filterVisibilityCache.finalVisibleKey === finalKey) {
      return this.filterVisibilityCache.finalVisibleNodeIds;
    }

    let finalVisibleNodeIds = null;
    if (!(queryRuleVisibleNodeIds instanceof Set) && !(searchVisibleNodeIds instanceof Set)) {
      finalVisibleNodeIds = null;
    } else if (!(queryRuleVisibleNodeIds instanceof Set)) {
      finalVisibleNodeIds = searchVisibleNodeIds;
    } else if (!(searchVisibleNodeIds instanceof Set)) {
      finalVisibleNodeIds = queryRuleVisibleNodeIds;
    } else {
      const combined = new Set();
      for (const nodeId of queryRuleVisibleNodeIds) {
        if (searchVisibleNodeIds.has(nodeId)) combined.add(nodeId);
      }
      finalVisibleNodeIds = combined;
    }
    this.filterVisibilityCache.finalVisibleKey = finalKey;
    this.filterVisibilityCache.finalVisibleNodeIds = finalVisibleNodeIds;
    return finalVisibleNodeIds;
  }

  getSearchModeVisibleNodeIds() {
    if (this.filterVisibilityCache.searchVisibleVersion === this.visibilitySearchVersion) {
      return this.filterVisibilityCache.searchVisibleNodeIds;
    }

    let visibleNodeIds = null;
    if (this.searchMode !== 'filter') {
      this.filterVisibilityCache.searchVisibleVersion = this.visibilitySearchVersion;
      this.filterVisibilityCache.searchVisibleNodeIds = null;
      return null;
    }

    const rawText = this.searchInputEl ? this.searchInputEl.value : this.searchInputValue;
    const parsed = this.parseSearchQuery(rawText);
    if (!parsed.query) {
      this.filterVisibilityCache.searchVisibleVersion = this.visibilitySearchVersion;
      this.filterVisibilityCache.searchVisibleNodeIds = null;
      return null;
    }

    if (parsed.source === 'name') {
      const filterNodeId = this.getFilterNodeId();
      if (!filterNodeId) {
        visibleNodeIds = new Set();
      } else {
        visibleNodeIds = new Set([filterNodeId]);
      }
      const neighbors = this.neighborsById.get(filterNodeId);
      if (neighbors && visibleNodeIds) {
        for (const nodeId of neighbors) visibleNodeIds.add(nodeId);
      }
    } else if (this.searchMatchedNodeIds instanceof Set) {
      visibleNodeIds = this.searchMatchedNodeIds;
    } else {
      visibleNodeIds = new Set();
    }

    this.filterVisibilityCache.searchVisibleVersion = this.visibilitySearchVersion;
    this.filterVisibilityCache.searchVisibleNodeIds = visibleNodeIds;
    return visibleNodeIds;
  }

  getQueryRuleVisibleNodeIds() {
    const ruleSignature = this.getActiveQueryRuleSignature();
    const canReuseVisibleSet =
      this.filterVisibilityCache.queryRuleVisibleGraphVersion === this.visibilityGraphVersion &&
      this.filterVisibilityCache.queryRuleVisibleRulesSignature === ruleSignature;
    if (canReuseVisibleSet) {
      return this.filterVisibilityCache.queryRuleVisibleNodeIds;
    }

    if (this.filterVisibilityCache.parsedRulesSignature !== ruleSignature) {
      this.filterVisibilityCache.parsedBlacklistRules =
        this.getCompleteQueryRulesByKey('blacklist');
      this.filterVisibilityCache.parsedWhitelistRules =
        this.getCompleteQueryRulesByKey('whitelist');
      this.filterVisibilityCache.parsedRulesSignature = ruleSignature;
    }

    const blacklistRules = this.filterVisibilityCache.parsedBlacklistRules;
    const whitelistRules = this.filterVisibilityCache.parsedWhitelistRules;
    if (blacklistRules.length === 0 && whitelistRules.length === 0) {
      this.filterVisibilityCache.queryRuleVisibleGraphVersion = this.visibilityGraphVersion;
      this.filterVisibilityCache.queryRuleVisibleRulesSignature = ruleSignature;
      this.filterVisibilityCache.queryRuleVisibleNodeIds = null;
      return null;
    }

    const visibleNodeIds = new Set(this.nodes.map((node) => node.id));
    if (blacklistRules.length > 0) {
      for (const node of this.nodes) {
        const meta = this.nodeMetaById.get(node.id) || node.meta || null;
        if (!meta) continue;
        for (const parsedRule of blacklistRules) {
          if (this.nodeMatchesParsedGroup(meta, parsedRule, node)) {
            visibleNodeIds.delete(node.id);
            break;
          }
        }
      }
    }

    if (whitelistRules.length > 0) {
      const whitelistMatchedNodeIds = new Set();
      for (const node of this.nodes) {
        if (!visibleNodeIds.has(node.id)) continue;
        const meta = this.nodeMetaById.get(node.id) || node.meta || null;
        if (!meta) continue;
        for (const parsedRule of whitelistRules) {
          if (this.nodeMatchesParsedGroup(meta, parsedRule, node)) {
            whitelistMatchedNodeIds.add(node.id);
            break;
          }
        }
      }
      this.filterVisibilityCache.queryRuleVisibleGraphVersion = this.visibilityGraphVersion;
      this.filterVisibilityCache.queryRuleVisibleRulesSignature = ruleSignature;
      this.filterVisibilityCache.queryRuleVisibleNodeIds = whitelistMatchedNodeIds;
      return whitelistMatchedNodeIds;
    }

    this.filterVisibilityCache.queryRuleVisibleGraphVersion = this.visibilityGraphVersion;
    this.filterVisibilityCache.queryRuleVisibleRulesSignature = ruleSignature;
    this.filterVisibilityCache.queryRuleVisibleNodeIds = visibleNodeIds;
    return visibleNodeIds;
  }

  getCompleteQueryRulesByKey(ruleKey) {
    const rawRules = Array.isArray(this.plugin.data?.[ruleKey]) ? this.plugin.data[ruleKey] : [];
    const parsedRules = [];
    for (const rawRule of rawRules) {
      if (!rawRule || rawRule.enabled === false) continue;
      const queryText = String(rawRule.query || '').trim();
      if (!queryText) continue;
      const parsed = this.plugin.parseGroupQuery(queryText);
      if (!parsed || !String(parsed.value || '').trim()) continue;
      parsedRules.push(parsed);
    }
    return parsedRules;
  }

  isSearchFilled() {
    const rawText = this.searchInputEl ? this.searchInputEl.value : this.searchInputValue;
    const parsed = this.parseSearchQuery(rawText);
    return parsed.query.length > 0;
  }

  getFindFocusNodeId() {
    if (this.searchMode !== 'find') return null;
    if (this.getEffectiveSearchSource() !== 'name') return null;
    return this.searchSelectedNodeId || null;
  }

  getActiveFocusNodeId() {
    const filterFocusNodeId = this.getFilterNodeId();
    if (filterFocusNodeId) return filterFocusNodeId;
    const findFocusNodeId = this.getFindFocusNodeId();
    if (findFocusNodeId) return findFocusNodeId;
    return this.hoverNodeId || null;
  }

  // Shared input suggestion popup used by both search and group editor inputs.
  showInputSuggestMenu(inputEl, suggestions, onSelect, meta = {}) {
    this.closeInputSuggestMenu();
    if (!inputEl || !Array.isArray(suggestions) || suggestions.length === 0) return;

    const normalizedSuggestions = [];
    for (const rawSuggestion of suggestions) {
      if (typeof rawSuggestion === 'string') {
        const textValue = String(rawSuggestion || '').trim();
        if (!textValue) continue;
        normalizedSuggestions.push({
          title: textValue,
          value: textValue,
          description: '',
          selectable: true,
          kind: 'default',
        });
        continue;
      }

      const titleText = String(rawSuggestion?.title || rawSuggestion?.value || '').trim();
      const valueText = String(rawSuggestion?.value || rawSuggestion?.title || '').trim();
      if (!titleText || !valueText) continue;
      normalizedSuggestions.push({
        title: titleText,
        value: valueText,
        description: String(rawSuggestion?.description || '').trim(),
        selectable: rawSuggestion?.selectable !== false,
        kind: String(rawSuggestion?.kind || 'default'),
      });
    }
    if (normalizedSuggestions.length <= 0) return;

    const ownerDocument = inputEl.ownerDocument || this.contentEl.ownerDocument;
    const ownerWindow = ownerDocument.defaultView || this.contentEl.win;
    if (!ownerDocument || !ownerWindow || !ownerDocument.body) return;

    const menuEl = ownerDocument.createElement('div');
    menuEl.className = 'graphfrontier-input-menu';
    menuEl.setAttribute('role', 'listbox');

    if (meta && typeof meta.title === 'string' && meta.title.trim()) {
      const headerEl = ownerDocument.createElement('div');
      headerEl.className = 'graphfrontier-input-menu-header';
      headerEl.textContent = meta.title.trim();
      menuEl.appendChild(headerEl);
    }

    const selectableEntries = [];
    for (const suggestion of normalizedSuggestions) {
      const itemEl = ownerDocument.createElement('div');
      itemEl.className = 'graphfrontier-input-menu-item';
      itemEl.setAttribute('role', 'option');

      const mainTextEl = ownerDocument.createElement('div');
      mainTextEl.className = 'graphfrontier-input-menu-main';
      mainTextEl.textContent = suggestion.title;
      itemEl.appendChild(mainTextEl);

      if (suggestion.description) {
        const descEl = ownerDocument.createElement('div');
        descEl.className = 'graphfrontier-input-menu-desc';
        descEl.textContent = suggestion.description;
        itemEl.appendChild(descEl);
      }

      if (!suggestion.selectable) itemEl.classList.add('is-disabled');
      else {
        selectableEntries.push({ itemEl, suggestion });
        itemEl.addEventListener('mousedown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect(String(suggestion.value), suggestion);
          this.closeInputSuggestMenu();
        });
      }
      menuEl.appendChild(itemEl);
    }

    const setActiveIndex = (nextIndex) => {
      if (selectableEntries.length <= 0) return false;
      const boundedIndex =
        ((nextIndex % selectableEntries.length) + selectableEntries.length) %
        selectableEntries.length;
      for (const entry of selectableEntries) entry.itemEl.classList.remove('is-active');
      const activeEntry = selectableEntries[boundedIndex];
      if (!activeEntry) return false;
      activeEntry.itemEl.classList.add('is-active');
      activeEntry.itemEl.scrollIntoView({ block: 'nearest' });
      return true;
    };

    const placeMenu = () => {
      if (!inputEl.isConnected || !menuEl.isConnected) {
        this.closeInputSuggestMenu();
        return;
      }

      const inputRect = inputEl.getBoundingClientRect();
      const viewportWidth = Math.max(
        1,
        ownerWindow.innerWidth || ownerDocument.documentElement.clientWidth || 1
      );
      const viewportHeight = Math.max(
        1,
        ownerWindow.innerHeight || ownerDocument.documentElement.clientHeight || 1
      );
      const marginPx = 8;
      const desiredWidth = Math.max(inputRect.width, 320);
      const maxWidth = Math.max(240, viewportWidth - marginPx * 2);
      const menuWidth = Math.min(desiredWidth, maxWidth);

      const maxLeft = Math.max(marginPx, viewportWidth - menuWidth - marginPx);
      const leftPx = Math.min(Math.max(inputRect.left, marginPx), maxLeft);

      menuEl.style.width = `${menuWidth}px`;
      menuEl.style.left = `${Math.round(leftPx)}px`;

      const menuHeight = Math.max(1, menuEl.offsetHeight);
      let topPx = inputRect.bottom + 4;
      if (topPx + menuHeight > viewportHeight - marginPx) {
        topPx = Math.max(marginPx, inputRect.top - menuHeight - 4);
      }
      menuEl.style.top = `${Math.round(topPx)}px`;
    };

    ownerDocument.body.appendChild(menuEl);
    placeMenu();
    ownerWindow.requestAnimationFrame(placeMenu);

    const closeHandler = (event) => {
      if (!this.inputSuggestMenu || !this.inputSuggestMenu.menuEl) return;
      const eventTarget = event.target;
      if (!eventTarget) return;
      if (this.inputSuggestMenu.menuEl.contains(eventTarget)) return;
      if (inputEl.contains(eventTarget)) return;
      this.closeInputSuggestMenu();
    };

    const repositionHandler = () => {
      placeMenu();
    };

    ownerDocument.addEventListener('mousedown', closeHandler, true);
    ownerDocument.addEventListener('scroll', repositionHandler, true);
    ownerWindow.addEventListener('resize', repositionHandler, true);

    this.inputSuggestMenu = {
      menuEl,
      onSelect,
      ownerDocument,
      ownerWindow,
      closeHandler,
      repositionHandler,
      selectableEntries,
      activeIndex: selectableEntries.length > 0 ? 0 : -1,
      setActiveIndex,
    };
    if (this.inputSuggestMenu.activeIndex >= 0) {
      this.inputSuggestMenu.setActiveIndex(this.inputSuggestMenu.activeIndex);
    }
    this.inputSuggestInputEl = inputEl;
  }

  closeInputSuggestMenu() {
    if (!this.inputSuggestMenu) return;
    const { ownerDocument, ownerWindow, closeHandler, repositionHandler } = this.inputSuggestMenu;
    if (ownerDocument && closeHandler) {
      ownerDocument.removeEventListener('mousedown', closeHandler, true);
    }
    if (ownerDocument && repositionHandler) {
      ownerDocument.removeEventListener('scroll', repositionHandler, true);
    }
    if (ownerWindow && repositionHandler) {
      ownerWindow.removeEventListener('resize', repositionHandler, true);
    }
    if (this.inputSuggestMenu.menuEl && this.inputSuggestMenu.menuEl.parentElement) {
      this.inputSuggestMenu.menuEl.remove();
    }
    this.inputSuggestMenu = null;
    this.inputSuggestInputEl = null;
  }

  moveInputSuggestSelection(delta) {
    if (!this.inputSuggestMenu || !Array.isArray(this.inputSuggestMenu.selectableEntries)) return;
    const itemCount = this.inputSuggestMenu.selectableEntries.length;
    if (itemCount <= 0) return;
    const currentIndex = Number.isInteger(this.inputSuggestMenu.activeIndex)
      ? this.inputSuggestMenu.activeIndex
      : 0;
    const nextIndex = currentIndex + Number(delta || 0);
    this.inputSuggestMenu.activeIndex = ((nextIndex % itemCount) + itemCount) % itemCount;
    this.inputSuggestMenu.setActiveIndex(this.inputSuggestMenu.activeIndex);
  }

  selectInputSuggestActive() {
    if (!this.inputSuggestMenu || !Array.isArray(this.inputSuggestMenu.selectableEntries))
      return false;
    const itemCount = this.inputSuggestMenu.selectableEntries.length;
    if (itemCount <= 0) return false;
    const currentIndex = Number.isInteger(this.inputSuggestMenu.activeIndex)
      ? this.inputSuggestMenu.activeIndex
      : 0;
    const boundedIndex = ((currentIndex % itemCount) + itemCount) % itemCount;
    const activeEntry = this.inputSuggestMenu.selectableEntries[boundedIndex];
    if (!activeEntry || !activeEntry.suggestion) return false;
    this.inputSuggestMenu.onSelect(
      String(activeEntry.suggestion.value || ''),
      activeEntry.suggestion
    );
    this.closeInputSuggestMenu();
    return true;
  }

  // Focus blending state machine for smooth highlight transitions.
  stepFocusSmoothing() {
    return stepFocusSmoothingRender(this);
  }

  // Simulation restart marker: called when settings or node positions change.
  kickLayoutSearch() {
    return kickLayoutSearchPhysics(this);
  }

  // Groups block: color-rule rows, drag-and-drop priority, and settings persistence.
  buildGroupEditorSection(parentEl) {
    const section = parentEl.createDiv({ cls: 'graphfrontier-groups' });
    section.createDiv({ cls: 'graphfrontier-groups-title', text: 'Groups' });

    this.groupEditorRows = [];
    const existingGroups = Array.isArray(this.plugin.data.groups) ? this.plugin.data.groups : [];
    for (const group of existingGroups) {
      this.addGroupEditorRow(section, group);
    }
    this.addGroupEditorRow(section, null);
  }

  parseGroupForm(group) {
    return {
      id: group?.id || null,
      query: String(group?.query || ''),
      color: this.plugin.normalizeGroupColor(group?.color || '#7aa2f7'),
    };
  }

  isGroupRowComplete(rowState) {
    const queryText = String(rowState.queryInput.value || '').trim();
    if (!queryText) return false;
    const parsed = this.plugin.parseGroupQuery(queryText);
    if (!parsed) return false;
    return !!String(parsed.value || '').trim();
  }

  isGroupRowEmpty(rowState) {
    const queryText = String(rowState.queryInput.value || '').trim();
    return !queryText;
  }

  refreshGroupRowState(rowState) {
    const complete = this.isGroupRowComplete(rowState);
    const empty = this.isGroupRowEmpty(rowState);
    rowState.removeBtn.style.visibility = empty ? 'hidden' : 'visible';
    rowState.dragHandle.style.visibility = complete ? 'visible' : 'hidden';
    rowState.colorInput.style.display = complete ? '' : 'none';
    rowState.colorInput.disabled = !complete;
    rowState.row.draggable = complete;
    rowState.row.toggleClass('is-empty', empty);
    rowState.row.toggleClass('is-complete', complete);
  }

  persistGroupRows(sectionEl) {
    const nextGroups = [];
    for (const rowState of this.groupEditorRows) {
      const queryText = String(rowState.queryInput.value || '').trim();
      const parsed = this.plugin.parseGroupQuery(queryText);
      if (!parsed || !String(parsed.value || '').trim()) continue;
      const query = this.plugin.composeGroupQuery(
        parsed.type,
        parsed.value,
        parsed.propertyKey || ''
      );
      if (!query) continue;
      if (!rowState.id) rowState.id = this.plugin.createGroupId();
      nextGroups.push({
        id: rowState.id,
        query,
        color: this.plugin.normalizeGroupColor(rowState.colorInput.value),
        enabled: true,
      });
    }
    this.plugin.updateGroups(nextGroups);

    const hasIncompleteRow = this.groupEditorRows.some(
      (rowState) => !this.isGroupRowComplete(rowState)
    );
    if (!hasIncompleteRow) this.addGroupEditorRow(sectionEl, null);
  }

  addGroupEditorRow(sectionEl, group) {
    const form = this.parseGroupForm(group);

    const row = sectionEl.createDiv({ cls: 'graphfrontier-group-row' });
    const dragHandle = row.createSpan({ cls: 'graphfrontier-group-drag', text: '::' });
    const queryInputWrap = row.createDiv({
      cls: 'graphfrontier-group-query-wrap graphfrontier-input-anchor',
    });
    const queryInput = queryInputWrap.createEl('input', {
      cls: 'graphfrontier-group-query',
      type: 'text',
      placeholder: 'Enter query...',
    });
    queryInput.value = form.query;

    const colorInput = row.createEl('input', {
      cls: 'graphfrontier-group-color-input',
      type: 'color',
    });
    colorInput.value = form.color;

    const removeBtn = row.createEl('button', { cls: 'graphfrontier-group-remove', text: 'x' });

    const rowState = {
      row,
      dragHandle,
      queryInput,
      colorInput,
      removeBtn,
      id: form.id,
    };
    this.groupEditorRows.push(rowState);

    const openGroupSuggestMenu = () => {
      const queryText = String(rowState.queryInput.value || '');
      const suggestionPack = this.getGroupQuerySuggestions(queryText);
      const items = Array.isArray(suggestionPack?.items) ? suggestionPack.items : [];
      if (items.length === 0) {
        this.closeInputSuggestMenu();
        return;
      }
      this.showInputSuggestMenu(
        rowState.queryInput,
        items,
        (selectedText) => {
          rowState.queryInput.value = selectedText;
          this.refreshGroupRowState(rowState);
          this.persistGroupRows(sectionEl);
          const shouldOpenValueMenu = /:\s*$/.test(String(selectedText || '').trim());
          if (shouldOpenValueMenu) {
            this.contentEl.win.setTimeout(() => {
              if (!rowState.queryInput) return;
              rowState.queryInput.focus();
              openGroupSuggestMenu();
            }, 0);
          }
        },
        { title: suggestionPack?.menuTitle || '' }
      );
    };

    this.registerDomEvent(queryInput, 'input', () => {
      this.refreshGroupRowState(rowState);
      this.persistGroupRows(sectionEl);
      openGroupSuggestMenu();
    });
    this.registerDomEvent(queryInput, 'keydown', (event) => {
      const hasActiveMenu =
        !!this.inputSuggestMenu &&
        this.inputSuggestInputEl &&
        this.inputSuggestInputEl === queryInput;
      if (hasActiveMenu && event.key === 'ArrowDown') {
        event.preventDefault();
        this.moveInputSuggestSelection(1);
        return;
      }
      if (hasActiveMenu && event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveInputSuggestSelection(-1);
        return;
      }
      if (hasActiveMenu && event.key === 'Escape') {
        event.preventDefault();
        this.closeInputSuggestMenu();
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (hasActiveMenu && this.selectInputSuggestActive()) {
        this.refreshGroupRowState(rowState);
        this.persistGroupRows(sectionEl);
        return;
      }
      this.persistGroupRows(sectionEl);
      this.closeInputSuggestMenu();
    });
    this.registerDomEvent(queryInput, 'blur', () => {
      this.contentEl.win.setTimeout(() => {
        if (!this.inputSuggestInputEl || this.inputSuggestInputEl !== queryInput) return;
        this.closeInputSuggestMenu();
      }, 0);
    });
    this.registerDomEvent(queryInput, 'click', () => {
      openGroupSuggestMenu();
    });
    this.registerDomEvent(queryInput, 'focus', () => {
      openGroupSuggestMenu();
    });
    this.registerDomEvent(colorInput, 'input', () => {
      this.persistGroupRows(sectionEl);
    });
    this.registerDomEvent(removeBtn, 'click', () => {
      const index = this.groupEditorRows.indexOf(rowState);
      if (index >= 0) this.groupEditorRows.splice(index, 1);
      row.remove();
      this.persistGroupRows(sectionEl);
    });

    this.registerDomEvent(row, 'dragstart', (event) => {
      if (!this.isGroupRowComplete(rowState)) {
        event.preventDefault();
        return;
      }
      this.draggingGroupRow = rowState;
      row.addClass('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', rowState.id || 'group');
      }
    });
    this.registerDomEvent(row, 'dragover', (event) => {
      if (!this.draggingGroupRow || this.draggingGroupRow === rowState) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    this.registerDomEvent(row, 'drop', (event) => {
      if (!this.draggingGroupRow || this.draggingGroupRow === rowState) return;
      event.preventDefault();

      const fromIndex = this.groupEditorRows.indexOf(this.draggingGroupRow);
      const toIndex = this.groupEditorRows.indexOf(rowState);
      if (fromIndex < 0 || toIndex < 0) return;

      const [moved] = this.groupEditorRows.splice(fromIndex, 1);
      this.groupEditorRows.splice(toIndex, 0, moved);
      if (fromIndex < toIndex) sectionEl.insertBefore(moved.row, rowState.row.nextSibling);
      else sectionEl.insertBefore(moved.row, rowState.row);
      this.persistGroupRows(sectionEl);
    });
    this.registerDomEvent(row, 'dragend', () => {
      row.removeClass('is-dragging');
      this.draggingGroupRow = null;
    });

    this.refreshGroupRowState(rowState);
  }

  buildQueryRuleEditorSection(parentEl, options = {}) {
    const ruleKey = String(options.key || '')
      .trim()
      .toLowerCase();
    if (!ruleKey || !['blacklist', 'whitelist'].includes(ruleKey)) return;

    const section = parentEl.createDiv({ cls: 'graphfrontier-groups' });
    const titleText = String(options.title || '').trim() || ruleKey;
    const titleEl = section.createDiv({ cls: 'graphfrontier-groups-title', text: titleText });
    if (options.hint) titleEl.setAttr('title', String(options.hint));

    const existingRules = Array.isArray(this.plugin.data[ruleKey]) ? this.plugin.data[ruleKey] : [];
    const rowStateList = [];
    if (ruleKey === 'blacklist') this.blacklistEditorRows = rowStateList;
    else this.whitelistEditorRows = rowStateList;

    for (const rule of existingRules) {
      this.addQueryRuleEditorRow(section, ruleKey, rowStateList, rule);
    }
    this.addQueryRuleEditorRow(section, ruleKey, rowStateList, null);
  }

  parseQueryRuleForm(rule) {
    return {
      id: rule?.id || null,
      query: String(rule?.query || ''),
    };
  }

  isQueryRuleRowComplete(rowState) {
    const queryText = String(rowState.queryInput.value || '').trim();
    if (!queryText) return false;
    const parsed = this.plugin.parseGroupQuery(queryText);
    if (!parsed) return false;
    return !!String(parsed.value || '').trim();
  }

  isQueryRuleRowEmpty(rowState) {
    const queryText = String(rowState.queryInput.value || '').trim();
    return !queryText;
  }

  refreshQueryRuleRowState(rowState) {
    const complete = this.isQueryRuleRowComplete(rowState);
    const empty = this.isQueryRuleRowEmpty(rowState);
    rowState.removeBtn.style.visibility = empty ? 'hidden' : 'visible';
    rowState.dragHandle.style.visibility = complete ? 'visible' : 'hidden';
    rowState.row.draggable = complete;
    rowState.row.toggleClass('is-empty', empty);
    rowState.row.toggleClass('is-complete', complete);
  }

  persistQueryRuleRows(sectionEl, ruleKey, rowStateList) {
    const nextRules = [];
    for (const rowState of rowStateList) {
      const queryText = String(rowState.queryInput.value || '').trim();
      const parsed = this.plugin.parseGroupQuery(queryText);
      if (!parsed || !String(parsed.value || '').trim()) continue;
      const query = this.plugin.composeGroupQuery(
        parsed.type,
        parsed.value,
        parsed.propertyKey || ''
      );
      if (!query) continue;
      if (!rowState.id) rowState.id = this.plugin.createGroupId();
      nextRules.push({
        id: rowState.id,
        query,
        enabled: true,
      });
    }

    if (ruleKey === 'blacklist') this.plugin.updateBlacklist(nextRules);
    else this.plugin.updateWhitelist(nextRules);
    this.markQueryRuleVisibilityDirty();

    const hasIncompleteRow = rowStateList.some(
      (rowState) => !this.isQueryRuleRowComplete(rowState)
    );
    if (!hasIncompleteRow) {
      this.addQueryRuleEditorRow(sectionEl, ruleKey, rowStateList, null);
    }
  }

  addQueryRuleEditorRow(sectionEl, ruleKey, rowStateList, rule) {
    const form = this.parseQueryRuleForm(rule);

    const row = sectionEl.createDiv({ cls: 'graphfrontier-group-row' });
    const dragHandle = row.createSpan({ cls: 'graphfrontier-group-drag', text: '::' });
    const queryInputWrap = row.createDiv({
      cls: 'graphfrontier-group-query-wrap graphfrontier-input-anchor',
    });
    const queryInput = queryInputWrap.createEl('input', {
      cls: 'graphfrontier-group-query',
      type: 'text',
      placeholder: 'Enter query...',
    });
    queryInput.value = form.query;
    const removeBtn = row.createEl('button', { cls: 'graphfrontier-group-remove', text: 'x' });

    const rowState = {
      row,
      dragHandle,
      queryInput,
      removeBtn,
      id: form.id,
    };
    rowStateList.push(rowState);

    const openRuleSuggestMenu = () => {
      const queryText = String(rowState.queryInput.value || '');
      const suggestionPack = this.getGroupQuerySuggestions(queryText);
      const items = Array.isArray(suggestionPack?.items) ? suggestionPack.items : [];
      if (items.length === 0) {
        this.closeInputSuggestMenu();
        return;
      }
      this.showInputSuggestMenu(
        rowState.queryInput,
        items,
        (selectedText) => {
          rowState.queryInput.value = selectedText;
          this.refreshQueryRuleRowState(rowState);
          this.persistQueryRuleRows(sectionEl, ruleKey, rowStateList);
          const shouldOpenValueMenu = /:\s*$/.test(String(selectedText || '').trim());
          if (shouldOpenValueMenu) {
            this.contentEl.win.setTimeout(() => {
              if (!rowState.queryInput) return;
              rowState.queryInput.focus();
              openRuleSuggestMenu();
            }, 0);
          }
        },
        { title: suggestionPack?.menuTitle || '' }
      );
    };

    this.registerDomEvent(queryInput, 'input', () => {
      this.refreshQueryRuleRowState(rowState);
      this.persistQueryRuleRows(sectionEl, ruleKey, rowStateList);
      openRuleSuggestMenu();
    });
    this.registerDomEvent(queryInput, 'keydown', (event) => {
      const hasActiveMenu =
        !!this.inputSuggestMenu &&
        this.inputSuggestInputEl &&
        this.inputSuggestInputEl === queryInput;
      if (hasActiveMenu && event.key === 'ArrowDown') {
        event.preventDefault();
        this.moveInputSuggestSelection(1);
        return;
      }
      if (hasActiveMenu && event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveInputSuggestSelection(-1);
        return;
      }
      if (hasActiveMenu && event.key === 'Escape') {
        event.preventDefault();
        this.closeInputSuggestMenu();
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (hasActiveMenu && this.selectInputSuggestActive()) {
        this.refreshQueryRuleRowState(rowState);
        this.persistQueryRuleRows(sectionEl, ruleKey, rowStateList);
        return;
      }
      this.persistQueryRuleRows(sectionEl, ruleKey, rowStateList);
      this.closeInputSuggestMenu();
    });
    this.registerDomEvent(queryInput, 'blur', () => {
      this.contentEl.win.setTimeout(() => {
        if (!this.inputSuggestInputEl || this.inputSuggestInputEl !== queryInput) return;
        this.closeInputSuggestMenu();
      }, 0);
    });
    this.registerDomEvent(queryInput, 'click', () => {
      openRuleSuggestMenu();
    });
    this.registerDomEvent(queryInput, 'focus', () => {
      openRuleSuggestMenu();
    });
    this.registerDomEvent(removeBtn, 'click', () => {
      const index = rowStateList.indexOf(rowState);
      if (index >= 0) rowStateList.splice(index, 1);
      row.remove();
      this.persistQueryRuleRows(sectionEl, ruleKey, rowStateList);
    });

    this.registerDomEvent(row, 'dragstart', (event) => {
      if (!this.isQueryRuleRowComplete(rowState)) {
        event.preventDefault();
        return;
      }
      this.draggingQueryRuleRow = rowState;
      row.addClass('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', rowState.id || 'rule');
      }
    });
    this.registerDomEvent(row, 'dragover', (event) => {
      if (!this.draggingQueryRuleRow || this.draggingQueryRuleRow === rowState) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    this.registerDomEvent(row, 'drop', (event) => {
      if (!this.draggingQueryRuleRow || this.draggingQueryRuleRow === rowState) return;
      event.preventDefault();

      const fromIndex = rowStateList.indexOf(this.draggingQueryRuleRow);
      const toIndex = rowStateList.indexOf(rowState);
      if (fromIndex < 0 || toIndex < 0) return;

      const [moved] = rowStateList.splice(fromIndex, 1);
      rowStateList.splice(toIndex, 0, moved);
      if (fromIndex < toIndex) sectionEl.insertBefore(moved.row, rowState.row.nextSibling);
      else sectionEl.insertBefore(moved.row, rowState.row);
      this.persistQueryRuleRows(sectionEl, ruleKey, rowStateList);
    });
    this.registerDomEvent(row, 'dragend', () => {
      row.removeClass('is-dragging');
      this.draggingQueryRuleRow = null;
    });

    this.refreshQueryRuleRowState(rowState);
  }

  formatSliderValue(value, step) {
    const stepNum = Number(step);
    if (!Number.isFinite(stepNum) || stepNum >= 1) return String(Math.round(value));
    if (stepNum >= 0.1) return value.toFixed(1);
    if (stepNum >= 0.01) return value.toFixed(2);
    if (stepNum >= 0.001) return value.toFixed(3);
    return value.toFixed(4);
  }

  // UI refresh helpers: keep controls synced and canvas sized to current container.
  applyRefreshMode(refreshMode) {
    if (refreshMode === 'data') this.plugin.refreshAllViews();
    else this.plugin.renderAllViews();
  }

  syncSidePanelControls() {
    if (!this.sidePanelOpen || this.sideControls.size === 0) return;
    const activeEl = this.contentEl.ownerDocument
      ? this.contentEl.ownerDocument.activeElement
      : null;

    for (const [key, meta] of this.sideControls.entries()) {
      const currentValue = this.plugin.data.settings[key];
      if (meta.type === 'boolean') {
        if (activeEl !== meta.input) {
          const uiValue =
            typeof meta.toUiValue === 'function' ? meta.toUiValue(currentValue) : !!currentValue;
          meta.updateButton(uiValue);
        }
        continue;
      }

      if (meta.type === 'slider' && activeEl !== meta.input) {
        const clamped = Math.max(meta.min, Math.min(meta.max, Number(currentValue)));
        const nextValue = String(clamped);
        if (meta.input.value !== nextValue) meta.input.value = nextValue;
        meta.valueEl.setText(this.formatSliderValue(clamped, meta.step));
      }
    }

    if (this.searchModeToggleEl) this.syncSearchModeToggleUi();
    if (this.searchInputEl && activeEl !== this.searchInputEl) {
      const nextText = String(this.searchInputValue || '');
      if (this.searchInputEl.value !== nextText) this.searchInputEl.value = nextText;
      this.syncSearchClearButtonVisibility();
    }
  }

  installResizeObserver() {
    if (typeof ResizeObserver !== 'function') return;
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(this.wrapEl);
  }

  handleViewportResize() {
    this.resizeCanvas();
  }

  updateWrapHeightForKeyboard() {
    if (!this.wrapEl) return;
    if (this.wrapEl.style.height) this.wrapEl.style.height = '';
    if (this.wrapEl.style.maxHeight) this.wrapEl.style.maxHeight = '';
  }

  resizeCanvas() {
    if (!this.canvasEl || !this.ctx) return;

    this.updateWrapHeightForKeyboard();

    const rect = this.wrapEl.getBoundingClientRect();
    this.viewWidth = Math.max(1, Math.floor(rect.width));
    this.viewHeight = Math.max(1, Math.floor(rect.height));
    this.devicePixelRatio = this.contentEl.win.devicePixelRatio || 1;

    this.canvasEl.width = Math.floor(this.viewWidth * this.devicePixelRatio);
    this.canvasEl.height = Math.floor(this.viewHeight * this.devicePixelRatio);

    this.ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
    this.render();
  }

  // In-memory graph rebuild: load nodes/edges, restore positions, and recompute neighbors.
  refreshFromVault(opts = {}) {
    const keepCamera = !!opts.keepCamera;
    const graphData = this.plugin.collectGraphData();
    this.syncGraphRuntimeState(graphData);
    this.markGraphVisibilityDirty();

    if (this.searchSelectedNodeId && !this.nodeById.has(this.searchSelectedNodeId)) {
      this.searchSelectedNodeId = null;
    }
    this.syncSearchMatchesLive();
    this.syncSearchClearButtonVisibility();
    this.scheduleContentSearchIndexRebuild();
    this.updateLayoutCenter();

    this.cleanupDetachedData();

    if (!keepCamera) {
      this.fitCameraToNodes();
    }

    this.kickLayoutSearch();
    this.render();
  }

  scheduleContentSearchIndexRebuild() {
    const buildToken = ++this.contentSearchBuildToken;
    const nodesSnapshot = this.nodes.slice();
    const appRef = this.app;
    const nextIndex = new Map();

    const buildIndexAsync = async () => {
      for (const node of nodesSnapshot) {
        if (buildToken !== this.contentSearchBuildToken) return;
        if (!node || node.meta?.isAttachment) continue;
        const file = appRef.vault.getAbstractFileByPath(node.id);
        if (!file || typeof file.extension !== 'string' || file.extension.toLowerCase() !== 'md')
          continue;
        try {
          const contentText = await appRef.vault.cachedRead(file);
          nextIndex.set(node.id, String(contentText || '').toLowerCase());
        } catch {
          continue;
        }
      }
      if (buildToken !== this.contentSearchBuildToken) return;
      this.contentSearchIndex = nextIndex;
      this.syncSearchMatchesLive();
    };

    buildIndexAsync();
  }

  /*
   * ============================================================
   * GRAPH SYNC BLOCK
   * Runtime graph-state rebuild: create nodes, rebuild edges/neighbors, and restore constrained positions.
   * ============================================================
   */
  syncGraphRuntimeState(graphData) {
    const oldNodes = this.nodeById;
    const { nextNodes, nextNodeById } = this.buildNextNodesFromGraphData(graphData.nodes, oldNodes);
    const { nextEdges, nextNeighborsById } = this.buildNextEdgesAndNeighbors(
      graphData.edges,
      nextNodeById,
      nextNodes
    );

    this.applyOrbitPinnedPositions(nextNodes, nextNodeById);

    this.nodes = nextNodes;
    this.nodeById = nextNodeById;
    this.nodeMetaById = new Map(nextNodes.map((node) => [node.id, node.meta || null]));
    this.neighborsById = nextNeighborsById;
    this.edges = nextEdges;

    this.applyAutoAttachmentOrbitPositions();
  }

  buildNextNodesFromGraphData(rawNodes, oldNodes) {
    const nextNodes = [];
    const nextNodeById = new Map();
    let index = 0;

    for (const rawNode of rawNodes) {
      const oldNode = oldNodes.get(rawNode.id);
      const node = this.createRuntimeNode(rawNode, oldNode, index);
      nextNodes.push(node);
      nextNodeById.set(node.id, node);
      index += 1;
    }

    return { nextNodes, nextNodeById };
  }

  createRuntimeNode(rawNode, oldNode, index) {
    const pin = this.plugin.getPin(rawNode.id);
    const savedPosition = this.plugin.data.saved_positions[rawNode.id];

    let x;
    let y;
    let vx = 0;
    let vy = 0;

    if (pin) {
      x = pin.x;
      y = pin.y;
    } else if (oldNode) {
      x = oldNode.x;
      y = oldNode.y;
      vx = oldNode.vx;
      vy = oldNode.vy;
    } else if (
      savedPosition &&
      Number.isFinite(savedPosition.x) &&
      Number.isFinite(savedPosition.y)
    ) {
      x = Number(savedPosition.x);
      y = Number(savedPosition.y);
      vx = 0;
      vy = 0;
    } else {
      const angle = (index % 360) * (Math.PI / 180);
      const radius = 80 + 10 * Math.sqrt(index + 1);
      const jitterX = (Math.random() - 0.5) * 18;
      const jitterY = (Math.random() - 0.5) * 18;
      x = this.camera.x + Math.cos(angle) * radius + jitterX;
      y = this.camera.y + Math.sin(angle) * radius + jitterY;
    }

    return {
      id: rawNode.id,
      label: rawNode.label,
      meta: rawNode.meta || null,
      x,
      y,
      vx,
      vy,
      degree: 0,
    };
  }

  buildNextEdgesAndNeighbors(rawEdges, nextNodeById, nextNodes) {
    const nextEdges = [];
    const nextNeighborsById = new Map(nextNodes.map((node) => [node.id, new Set()]));

    for (const rawEdge of rawEdges) {
      const sourceNode = nextNodeById.get(rawEdge.source);
      const targetNode = nextNodeById.get(rawEdge.target);
      if (!sourceNode || !targetNode) continue;

      sourceNode.degree += 1;
      targetNode.degree += 1;
      nextNeighborsById.get(sourceNode.id).add(targetNode.id);
      nextNeighborsById.get(targetNode.id).add(sourceNode.id);

      nextEdges.push({
        source: rawEdge.source,
        target: rawEdge.target,
      });
    }

    return { nextEdges, nextNeighborsById };
  }

  applyOrbitPinnedPositions(nextNodes, nextNodeById) {
    for (const node of nextNodes) {
      const orbitPin = this.plugin.getOrbitPin(node.id);
      if (!orbitPin) continue;
      const anchorNode = nextNodeById.get(orbitPin.anchor_id);
      if (!anchorNode) continue;
      node.x = anchorNode.x + Math.cos(orbitPin.angle) * orbitPin.radius;
      node.y = anchorNode.y + Math.sin(orbitPin.angle) * orbitPin.radius;
      node.vx = 0;
      node.vy = 0;
    }
  }

  applyAutoAttachmentOrbitPositions() {
    const autoAttachmentOrbitMap = this.buildAttachmentAutoOrbitMap();
    for (const [nodeId, orbitMeta] of autoAttachmentOrbitMap.entries()) {
      const autoNode = this.nodeById.get(nodeId);
      const anchorNode = this.nodeById.get(orbitMeta.anchor_id);
      if (!autoNode || !anchorNode) continue;
      autoNode.x = anchorNode.x + Math.cos(orbitMeta.angle) * orbitMeta.radius;
      autoNode.y = anchorNode.y + Math.sin(orbitMeta.angle) * orbitMeta.radius;
      autoNode.vx = 0;
      autoNode.vy = 0;
    }
  }

  // Data cleanup and initial framing after graph rebuild.
  cleanupDetachedData() {
    const nodeIds = new Set(this.nodes.map((node) => node.id));

    let changed = false;
    for (const nodeId of Object.keys(this.plugin.data.pins)) {
      if (!nodeIds.has(nodeId)) {
        delete this.plugin.data.pins[nodeId];
        changed = true;
      }
    }
    for (const nodeId of Object.keys(this.plugin.data.saved_positions || {})) {
      if (!nodeIds.has(nodeId)) {
        delete this.plugin.data.saved_positions[nodeId];
        changed = true;
      }
    }
    for (const nodeId of Object.keys(this.plugin.data.saved_layout_pins || {})) {
      if (!nodeIds.has(nodeId)) {
        delete this.plugin.data.saved_layout_pins[nodeId];
        changed = true;
      }
    }
    for (const [nodeId, orbitMeta] of Object.entries(
      this.plugin.data.saved_layout_orbit_pins || {}
    )) {
      if (!nodeIds.has(nodeId)) {
        delete this.plugin.data.saved_layout_orbit_pins[nodeId];
        changed = true;
        continue;
      }
      const anchorId = String(orbitMeta?.anchor_id || '').trim();
      if (!anchorId || anchorId === nodeId || !nodeIds.has(anchorId)) {
        delete this.plugin.data.saved_layout_orbit_pins[nodeId];
        changed = true;
      }
    }
    for (const nodeId of Object.keys(this.plugin.data.node_force_multipliers)) {
      if (!nodeIds.has(nodeId)) {
        delete this.plugin.data.node_force_multipliers[nodeId];
        changed = true;
      }
    }
    for (const nodeId of Object.keys(this.plugin.data.strong_pull_nodes)) {
      if (!nodeIds.has(nodeId)) {
        delete this.plugin.data.strong_pull_nodes[nodeId];
        changed = true;
      }
    }
    for (const nodeId of Object.keys(this.plugin.data.painted_edge_colors || {})) {
      if (!nodeIds.has(nodeId)) {
        delete this.plugin.data.painted_edge_colors[nodeId];
        changed = true;
      }
    }
    for (const [nodeId, orbitMeta] of Object.entries(this.plugin.data.orbit_pins || {})) {
      if (!nodeIds.has(nodeId)) {
        delete this.plugin.data.orbit_pins[nodeId];
        changed = true;
        continue;
      }
      const anchorId = String(orbitMeta?.anchor_id || '').trim();
      if (!anchorId || anchorId === nodeId || !nodeIds.has(anchorId)) {
        delete this.plugin.data.orbit_pins[nodeId];
        changed = true;
      }
    }

    if (changed) this.plugin.schedulePersist();
  }

  fitCameraToNodes() {
    if (this.nodes.length === 0) {
      this.camera.x = 0;
      this.camera.y = 0;
      this.camera.zoom = 1;
      this.cameraTarget.x = this.camera.x;
      this.cameraTarget.y = this.camera.y;
      this.cameraTarget.zoom = this.camera.zoom;
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const node of this.nodes) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    }

    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);

    this.camera.x = (minX + maxX) / 2;
    this.camera.y = (minY + maxY) / 2;

    const zoomX = (this.viewWidth * 0.9) / width;
    const zoomY = (this.viewHeight * 0.9) / height;
    const targetZoom = Math.min(zoomX, zoomY, 1);
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom));
    this.cameraTarget.x = this.camera.x;
    this.cameraTarget.y = this.camera.y;
    this.cameraTarget.zoom = this.camera.zoom;
  }

  updateLayoutCenter() {
    return updateLayoutCenterPhysics(this);
  }

  /*
   * ============================================================
   * PHYSICS BLOCK
   * Simulation layer: attraction/repulsion forces, damping, orbit logic, and autosave after stabilization.
   * ============================================================
   */
  runFrame() {
    if (!this.isOpen) return;
    this.stepCameraSmoothing();
    this.stepSimulation();
    this.stepFocusSmoothing();
    this.render();
    this.frameHandle = this.contentEl.win.requestAnimationFrame(() => this.runFrame());
  }

  stepCameraSmoothing() {
    return stepCameraSmoothingPhysics(this);
  }

  stepSimulation() {
    return stepSimulationPhysics(this);
  }

  /*
   * ============================================================
   * RENDER BLOCK
   * Rendering layer: background, grid, edges, nodes, labels, and focus/highlight effects.
   * ============================================================
   */
  render() {
    return renderFrameRender(this);
  }

  drawGrid(ctx) {
    return drawGridRender(this, ctx);
  }

  getHoverDimAlpha(focusProgress) {
    return getHoverDimAlpha(this.plugin, focusProgress);
  }

  drawEdges(ctx) {
    return drawEdgesRender(this, ctx);
  }

  hexToRgba(hexColor, alpha) {
    return hexToRgba(hexColor, alpha);
  }

  drawNodes(ctx) {
    return drawNodesRender(this, ctx);
  }

  drawFocusedNodeTitle(ctx, node) {
    return drawFocusedNodeTitleRender(this, ctx, node);
  }

  // Pointer and navigation: hover, node drag, scene pan, zoom, and node open actions.
  onMouseMove(event) {
    if (Date.now() < this.ignoreMouseUntilMs) return;

    const rect = this.canvasEl.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    this.lastCursorScreen = { x: screenX, y: screenY };

    if (this.dragNodeId) {
      const node = this.nodeById.get(this.dragNodeId);
      if (node) {
        const world = this.screenToWorld(screenX, screenY);
        node.x = world.x + this.dragNodeOffset.x;
        node.y = world.y + this.dragNodeOffset.y;
        node.vx = 0;
        node.vy = 0;
        if (this.dragStartScreen) {
          const ddx = screenX - this.dragStartScreen.x;
          const ddy = screenY - this.dragStartScreen.y;
          this.dragMovedDistance = Math.max(
            this.dragMovedDistance,
            Math.sqrt(ddx * ddx + ddy * ddy)
          );
        }
      }
      return;
    }

    if (this.panDrag) {
      const dx = screenX - this.panDrag.startX;
      const dy = screenY - this.panDrag.startY;
      this.cameraTarget.x = this.panDrag.startCameraX - dx / this.panDrag.startZoom;
      this.cameraTarget.y = this.panDrag.startCameraY - dy / this.panDrag.startZoom;
      this.persistViewState();
      return;
    }

    const hoverNode = this.getNodeAtScreen(screenX, screenY);
    this.hoverNodeId = hoverNode ? hoverNode.id : null;
  }

  onMouseDown(event) {
    if (Date.now() < this.ignoreMouseUntilMs) return;
    if (event.button !== 0) return;

    const rect = this.canvasEl.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    const node = this.getNodeAtScreen(screenX, screenY);

    if (node) {
      if (event.ctrlKey) {
        this.toggleQuickPreview(node.id, event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const world = this.screenToWorld(screenX, screenY);
      this.dragNodeId = node.id;
      this.dragNodeOffset = {
        x: node.x - world.x,
        y: node.y - world.y,
      };
      this.dragStartScreen = { x: screenX, y: screenY };
      this.dragMovedDistance = 0;
      this.canvasEl.addClass('is-dragging');
      return;
    }

    this.panDrag = {
      startX: screenX,
      startY: screenY,
      startCameraX: this.cameraTarget.x,
      startCameraY: this.cameraTarget.y,
      startZoom: this.cameraTarget.zoom,
    };
    this.canvasEl.addClass('is-dragging');
  }

  onMouseUp(event = null, options = {}) {
    const fromTouch = !!(options && options.fromTouch);
    const suppressClick = !!(options && options.suppressClick);
    if (!fromTouch && Date.now() < this.ignoreMouseUntilMs) return;

    let clickedNodeId = null;
    const hadDraggedNode = !!this.dragNodeId;
    const draggedNodeId = this.dragNodeId;
    if (draggedNodeId) {
      if (this.dragMovedDistance <= 3) clickedNodeId = draggedNodeId;
      const draggedNode = this.nodeById.get(draggedNodeId);
      if (draggedNode && this.plugin.isPinned(draggedNodeId)) {
        const pinMode = this.plugin.getPinMode(draggedNodeId);
        if (pinMode === 'grid') {
          const snapped = this.snapPositionToGrid(draggedNodeId, draggedNode.x, draggedNode.y);
          draggedNode.x = snapped.x;
          draggedNode.y = snapped.y;
          draggedNode.vx = 0;
          draggedNode.vy = 0;
          this.plugin.setPin(draggedNodeId, { x: snapped.x, y: snapped.y }, { mode: 'grid' });
        } else {
          this.plugin.setPin(
            draggedNodeId,
            { x: draggedNode.x, y: draggedNode.y },
            { mode: 'exact' }
          );
        }
      }
    }

    this.dragNodeId = null;
    this.dragStartScreen = null;
    this.dragMovedDistance = 0;
    this.panDrag = null;
    this.canvasEl.removeClass('is-dragging');

    if (hadDraggedNode) this.kickLayoutSearch();

    if (!suppressClick && clickedNodeId && event && event.button === 0) {
      this.clickFlashNodeId = clickedNodeId;
      this.clickFlashUntilMs = Date.now() + 180;
      this.openNodeFile(clickedNodeId);
    }
  }

  closeQuickPreview() {
    if (!this.quickPreviewEl) return;
    this.quickPreviewEl.classList.remove('is-open');
    this.quickPreviewNodeId = null;
    this.quickPreviewLoadToken += 1;
  }

  async toggleQuickPreview(nodeId, clientX, clientY) {
    if (!this.quickPreviewEl || !this.quickPreviewTitleEl || !this.quickPreviewBodyEl) return;
    const isOpen = this.quickPreviewEl.classList.contains('is-open');
    if (isOpen && this.quickPreviewNodeId === nodeId) {
      this.closeQuickPreview();
      return;
    }

    this.quickPreviewNodeId = nodeId;
    const rect = this.wrapEl.getBoundingClientRect();
    const panelWidth = 380;
    const panelHeight = 360;
    const offset = 12;
    const targetLeft = Number(clientX) - rect.left + offset;
    const targetTop = Number(clientY) - rect.top + offset;
    const maxLeft = Math.max(8, this.viewWidth - panelWidth - 8);
    const maxTop = Math.max(8, this.viewHeight - panelHeight - 8);
    const clampedLeft = Math.max(8, Math.min(maxLeft, targetLeft));
    const clampedTop = Math.max(8, Math.min(maxTop, targetTop));
    this.quickPreviewEl.style.left = `${clampedLeft}px`;
    this.quickPreviewEl.style.top = `${clampedTop}px`;
    this.quickPreviewEl.classList.add('is-open');

    this.quickPreviewTitleEl.setText(nodeId);
    this.quickPreviewBodyEl.setText('Loading...');
    const loadToken = ++this.quickPreviewLoadToken;

    const abstractFile = this.app.vault.getAbstractFileByPath(nodeId);
    if (
      !abstractFile ||
      typeof abstractFile.extension !== 'string' ||
      abstractFile.extension.toLowerCase() !== 'md'
    ) {
      if (loadToken !== this.quickPreviewLoadToken) return;
      this.quickPreviewBodyEl.setText('Preview is available only for markdown nodes.');
      return;
    }

    const markdownText = await this.app.vault.cachedRead(abstractFile);
    if (loadToken !== this.quickPreviewLoadToken) return;
    const sourcePath = abstractFile.path || nodeId;
    this.quickPreviewTitleEl.setText(sourcePath);
    this.quickPreviewBodyEl.empty();

    if (MarkdownRenderer && typeof MarkdownRenderer.render === 'function') {
      await MarkdownRenderer.render(
        this.app,
        markdownText || '',
        this.quickPreviewBodyEl,
        sourcePath,
        this
      );
    } else if (MarkdownRenderer && typeof MarkdownRenderer.renderMarkdown === 'function') {
      await MarkdownRenderer.renderMarkdown(
        markdownText || '',
        this.quickPreviewBodyEl,
        sourcePath,
        this
      );
    } else {
      this.quickPreviewBodyEl.setText(markdownText || '(empty)');
    }

    if (loadToken !== this.quickPreviewLoadToken) return;
    if (!markdownText || !markdownText.trim()) this.quickPreviewBodyEl.setText('(empty)');
    this.quickPreviewBodyEl.scrollTop = 0;
  }

  onWheel(event) {
    if (Date.now() < this.ignoreMouseUntilMs) return;

    event.preventDefault();

    const rect = this.canvasEl.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    const before = this.screenToWorldWithCamera(screenX, screenY, this.cameraTarget);

    const zoomFactor = Math.pow(ZOOM_STEP_FACTOR, -event.deltaY / 100);
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.cameraTarget.zoom * zoomFactor));
    this.cameraTarget.zoom = nextZoom;

    const after = this.screenToWorldWithCamera(screenX, screenY, this.cameraTarget);
    this.cameraTarget.x += before.x - after.x;
    this.cameraTarget.y += before.y - after.y;

    this.persistViewState();
  }

  // Touch navigation on mobile: one finger drags node/pans scene, two fingers pinch+pan camera.
  onTouchStart(event) {
    if (!event.touches || event.touches.length === 0) return;
    this.ignoreMouseUntilMs = Date.now() + 700;
    if (event.cancelable) event.preventDefault();
    this.clearTouchLongPressTimer();

    if (event.touches.length >= 2) {
      this.startPinchGesture(event);
      return;
    }

    const point = this.getTouchScreenPoint(event.touches[0]);
    if (!point) return;
    const node = this.startSingleTouchGesture(point);
    if (node)
      this.scheduleTouchLongPress(node.id, event.touches[0].clientX, event.touches[0].clientY);
  }

  onTouchMove(event) {
    if (!event.touches || event.touches.length === 0) return;
    this.ignoreMouseUntilMs = Date.now() + 700;
    if (event.cancelable) event.preventDefault();

    if (event.touches.length >= 2) {
      this.clearTouchLongPressTimer();
      if (!this.touchGesture || this.touchGesture.mode !== 'pinch') {
        this.startPinchGesture(event);
      }
      this.updatePinchGesture(event);
      return;
    }

    const point = this.getTouchScreenPoint(event.touches[0]);
    if (!point) return;
    this.lastCursorScreen = { x: point.x, y: point.y };
    if (this.touchGesture && this.touchGesture.mode === 'single') {
      const dx = point.x - this.touchGesture.startX;
      const dy = point.y - this.touchGesture.startY;
      const moved = Math.sqrt(dx * dx + dy * dy);
      if (moved > 10) {
        this.touchGesture.moved = true;
        this.clearTouchLongPressTimer();
      }
      if (this.touchGesture.longPressTriggered) return;
    }

    if (this.dragNodeId) {
      const node = this.nodeById.get(this.dragNodeId);
      if (node) {
        const world = this.screenToWorld(point.x, point.y);
        node.x = world.x + this.dragNodeOffset.x;
        node.y = world.y + this.dragNodeOffset.y;
        node.vx = 0;
        node.vy = 0;
        if (this.dragStartScreen) {
          const ddx = point.x - this.dragStartScreen.x;
          const ddy = point.y - this.dragStartScreen.y;
          this.dragMovedDistance = Math.max(
            this.dragMovedDistance,
            Math.sqrt(ddx * ddx + ddy * ddy)
          );
        }
      }
      return;
    }

    if (!this.panDrag) {
      this.panDrag = {
        startX: point.x,
        startY: point.y,
        startCameraX: this.cameraTarget.x,
        startCameraY: this.cameraTarget.y,
        startZoom: this.cameraTarget.zoom,
      };
      this.canvasEl.addClass('is-dragging');
    }

    const dx = point.x - this.panDrag.startX;
    const dy = point.y - this.panDrag.startY;
    this.cameraTarget.x = this.panDrag.startCameraX - dx / this.panDrag.startZoom;
    this.cameraTarget.y = this.panDrag.startCameraY - dy / this.panDrag.startZoom;
    this.persistViewState();
  }

  onTouchEnd(event) {
    this.ignoreMouseUntilMs = Date.now() + 700;
    if (event && event.cancelable) event.preventDefault();

    const touchesCount = event && event.touches ? event.touches.length : 0;

    if (touchesCount >= 2) {
      this.clearTouchLongPressTimer();
      this.startPinchGesture(event);
      return;
    }

    if (touchesCount === 1) {
      const point = this.getTouchScreenPoint(event.touches[0]);
      this.touchGesture = null;
      this.dragNodeId = null;
      this.dragStartScreen = null;
      this.dragMovedDistance = 0;
      if (point) {
        this.panDrag = {
          startX: point.x,
          startY: point.y,
          startCameraX: this.cameraTarget.x,
          startCameraY: this.cameraTarget.y,
          startZoom: this.cameraTarget.zoom,
        };
      }
      this.canvasEl.addClass('is-dragging');
      return;
    }

    const hadLongPress =
      !!this.touchGesture &&
      this.touchGesture.mode === 'single' &&
      !!this.touchGesture.longPressTriggered;
    this.touchGesture = null;
    this.clearTouchLongPressTimer();
    this.onMouseUp({ button: 0 }, { fromTouch: true, suppressClick: hadLongPress });
  }

  startSingleTouchGesture(point) {
    this.touchGesture = {
      mode: 'single',
      startX: point.x,
      startY: point.y,
      moved: false,
      longPressTriggered: false,
    };
    this.lastCursorScreen = { x: point.x, y: point.y };

    const node = this.getNodeAtScreen(point.x, point.y);
    if (node) {
      this.touchGesture.nodeId = node.id;
      const world = this.screenToWorld(point.x, point.y);
      this.dragNodeId = node.id;
      this.dragNodeOffset = {
        x: node.x - world.x,
        y: node.y - world.y,
      };
      this.dragStartScreen = { x: point.x, y: point.y };
      this.dragMovedDistance = 0;
      this.canvasEl.addClass('is-dragging');
      return node;
    }

    this.panDrag = {
      startX: point.x,
      startY: point.y,
      startCameraX: this.cameraTarget.x,
      startCameraY: this.cameraTarget.y,
      startZoom: this.cameraTarget.zoom,
    };
    this.canvasEl.addClass('is-dragging');
    return null;
  }

  startPinchGesture(event) {
    const first = event && event.touches ? event.touches[0] : null;
    const second = event && event.touches ? event.touches[1] : null;
    if (!first || !second) return;

    const pointA = this.getTouchScreenPoint(first);
    const pointB = this.getTouchScreenPoint(second);
    if (!pointA || !pointB) return;

    const midX = (pointA.x + pointB.x) * 0.5;
    const midY = (pointA.y + pointB.y) * 0.5;
    const dist = Math.max(1, Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y));
    const anchor = this.screenToWorldWithCamera(midX, midY, this.cameraTarget);

    this.dragNodeId = null;
    this.dragStartScreen = null;
    this.dragMovedDistance = 0;
    this.panDrag = null;
    this.clearTouchLongPressTimer();
    this.canvasEl.addClass('is-dragging');

    this.touchGesture = {
      mode: 'pinch',
      touchIdA: first.identifier,
      touchIdB: second.identifier,
      startDistance: dist,
      startCameraX: this.cameraTarget.x,
      startCameraY: this.cameraTarget.y,
      startCameraZoom: this.cameraTarget.zoom,
      anchorWorldX: anchor.x,
      anchorWorldY: anchor.y,
    };
  }

  updatePinchGesture(event) {
    if (!this.touchGesture || this.touchGesture.mode !== 'pinch') return;

    const touchA = this.findTouchById(event.touches, this.touchGesture.touchIdA);
    const touchB = this.findTouchById(event.touches, this.touchGesture.touchIdB);
    if (!touchA || !touchB) {
      this.startPinchGesture(event);
      return;
    }

    const pointA = this.getTouchScreenPoint(touchA);
    const pointB = this.getTouchScreenPoint(touchB);
    if (!pointA || !pointB) return;

    const midX = (pointA.x + pointB.x) * 0.5;
    const midY = (pointA.y + pointB.y) * 0.5;
    const dist = Math.max(1, Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y));

    const zoomScale = dist / Math.max(1, this.touchGesture.startDistance);
    const nextZoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, this.touchGesture.startCameraZoom * zoomScale)
    );

    const cameraAtStartCenter = {
      x: this.touchGesture.startCameraX,
      y: this.touchGesture.startCameraY,
      zoom: nextZoom,
    };
    const worldAtCurrentCenter = this.screenToWorldWithCamera(midX, midY, cameraAtStartCenter);

    this.cameraTarget.zoom = nextZoom;
    this.cameraTarget.x =
      this.touchGesture.startCameraX + (this.touchGesture.anchorWorldX - worldAtCurrentCenter.x);
    this.cameraTarget.y =
      this.touchGesture.startCameraY + (this.touchGesture.anchorWorldY - worldAtCurrentCenter.y);
    this.persistViewState();
  }

  getTouchScreenPoint(touch) {
    if (!touch || !this.canvasEl) return null;
    const rect = this.canvasEl.getBoundingClientRect();
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top,
    };
  }

  findTouchById(touches, id) {
    if (!touches) return null;
    for (const touch of touches) {
      if (touch.identifier === id) return touch;
    }
    return null;
  }

  scheduleTouchLongPress(nodeId, clientX, clientY) {
    this.clearTouchLongPressTimer();
    this.touchLongPressTimer = window.setTimeout(() => {
      if (!this.touchGesture || this.touchGesture.mode !== 'single') return;
      if (this.touchGesture.moved || this.touchGesture.longPressTriggered) return;
      if (this.touchGesture.nodeId !== nodeId) return;

      this.touchGesture.longPressTriggered = true;
      this.dragNodeId = null;
      this.dragStartScreen = null;
      this.dragMovedDistance = 0;
      this.panDrag = null;
      this.canvasEl.removeClass('is-dragging');
      this.openTouchContextMenuAt(clientX, clientY);
    }, 450);
  }

  clearTouchLongPressTimer() {
    if (!this.touchLongPressTimer) return;
    window.clearTimeout(this.touchLongPressTimer);
    this.touchLongPressTimer = null;
  }

  openTouchContextMenuAt(clientX, clientY) {
    if (!this.canvasEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    this.lastCursorScreen = { x: screenX, y: screenY };
    const node = this.getNodeAtScreen(screenX, screenY);
    if (!node) return;
    this.showNodeContextMenu(node, clientX, clientY, null);
  }

  // Node context menu: standard Obsidian actions plus GraphFrontier actions.
  onContextMenu(event) {
    event.preventDefault();

    const rect = this.canvasEl.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;
    this.lastCursorScreen = { x: screenX, y: screenY };

    const node = this.getNodeAtScreen(screenX, screenY);
    if (!node) return;
    this.showNodeContextMenu(node, event.clientX, event.clientY, event);
  }

  showNodeContextMenu(node, clientX, clientY, sourceMouseEvent = null) {
    const menu = new Menu(this.app);
    const abstractFile = this.app.vault.getAbstractFileByPath(node.id);
    const isMarkdownNode =
      !!abstractFile &&
      typeof abstractFile.path === 'string' &&
      typeof abstractFile.extension === 'string' &&
      abstractFile.extension.toLowerCase() === 'md';

    if (isMarkdownNode && typeof this.app.workspace.trigger === 'function') {
      this.app.workspace.trigger('file-menu', menu, abstractFile, 'graphfrontier', this.leaf);
      this.removeLinkedViewMenuItems(menu);
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle('Add to search')
          .setIcon('search')
          .onClick(() => {
            this.applySearchSelectionFromNode(node, { forceSource: 'name' });
          })
      );
      menu.addItem((item) =>
        item
          .setTitle('Show local graph')
          .setIcon('dot-network')
          .onClick(async () => {
            await this.openLocalGraphForNode(node.id);
          })
      );
      menu.addSeparator();
    } else {
      menu.addItem((item) =>
        item
          .setTitle('Add to search')
          .setIcon('search')
          .onClick(() => {
            this.applySearchSelectionFromNode(node, { forceSource: 'name' });
          })
      );
      menu.addSeparator();
    }

    const isStrongPullNode = this.plugin.isStrongPullNode(node.id);
    if (!isStrongPullNode) {
      menu.addItem((item) =>
        item
          .setTitle('Strong pull')
          .setIcon('zap')
          .onClick(async () => {
            const strong = this.plugin.clampStrongPullMultiplier(
              this.plugin.getSettings().strong_pull_multiplier
            );
            this.plugin.setNodeMultiplier(node.id, strong, { mode: 'strong-pull' });
            this.kickLayoutSearch();
            new Notice(`Strong pull: ${node.id} x${strong.toFixed(2)}`);
          })
      );
    }

    const nodeMultiplier = this.plugin.getNodeMultiplier(node.id);
    if (nodeMultiplier > 1 || isStrongPullNode) {
      menu.addItem((item) =>
        item
          .setTitle('Clear strong pull')
          .setIcon('x')
          .onClick(async () => {
            this.plugin.clearNodeMultiplier(node.id);
            this.kickLayoutSearch();
            new Notice(`Strong pull cleared: ${node.id}`);
          })
      );
    }
    menu.addItem((item) =>
      item
        .setTitle('Paint edges')
        .setIcon('palette')
        .onClick(async () => {
          await this.promptPickPaintedEdgeColor(node.id, clientX, clientY);
        })
    );
    if (this.plugin.getPaintedEdgeColor(node.id)) {
      menu.addItem((item) =>
        item
          .setTitle('Clear painted edges')
          .setIcon('x')
          .onClick(async () => {
            this.plugin.clearPaintedEdgeColor(node.id);
            this.plugin.renderAllViews();
            new Notice(`Painted edges cleared: ${node.id}`);
          })
      );
    }
    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle('Pin node')
        .setIcon('pin')
        .onClick(async () => {
          await this.pinNodeExact(node.id, { x: node.x, y: node.y });
          new Notice(`Pinned: ${node.id}`);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('Pin to grid')
        .setIcon('pin')
        .onClick(async () => {
          await this.pinNodeToGrid(node.id, { x: node.x, y: node.y });
          new Notice(`Pinned to grid: ${node.id}`);
        })
    );

    const hasPinState = this.plugin.isPinned(node.id) || this.plugin.isOrbitPinned(node.id);
    if (hasPinState) {
      menu.addItem((item) =>
        item
          .setTitle('Unpin node')
          .setIcon('pin-off')
          .onClick(async () => {
            this.plugin.removePin(node.id);
            this.plugin.removeOrbitPin(node.id);
            this.kickLayoutSearch();
            new Notice(`Unpinned: ${node.id}`);
          })
      );
    }
    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle('Pin linked nodes')
        .setIcon('pin')
        .onClick(async () => {
          await this.pinLinkedNodes(node.id);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('Pin linked nodes to grid')
        .setIcon('pin')
        .onClick(async () => {
          await this.pinLinkedNodesToGrid(node.id);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('Pin linked to orbit')
        .setIcon('orbit')
        .onClick(async () => {
          await this.pinLinkedNodesToOrbit(node.id);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('Unpin linked nodes')
        .setIcon('pin-off')
        .onClick(async () => {
          await this.unpinLinkedNodes(node.id);
        })
    );

    if (sourceMouseEvent && typeof menu.showAtMouseEvent === 'function') {
      menu.showAtMouseEvent(sourceMouseEvent);
      return;
    }
    if (typeof menu.showAtPosition === 'function') {
      menu.showAtPosition({ x: clientX, y: clientY });
      return;
    }
    menu.showAtMouseEvent({
      clientX,
      clientY,
      preventDefault() {},
      stopPropagation() {},
    });
  }

  removeLinkedViewMenuItems(menu) {
    if (!menu || !Array.isArray(menu.items)) return;
    const blockedTitles = new Set([
      'open linked view',
      'open local graph',
      'open backlinks',
      'open outgoing links',
      'open outline',
    ]);

    menu.items = menu.items.filter((item) => {
      const title = this.getMenuItemTitleText(item).toLowerCase();
      if (!title) return true;
      return !blockedTitles.has(title);
    });
  }

  getMenuItemTitleText(item) {
    if (!item) return '';
    if (typeof item.title === 'string') return item.title.trim();
    if (item.titleEl && typeof item.titleEl.textContent === 'string')
      return item.titleEl.textContent.trim();
    if (item.dom && typeof item.dom.textContent === 'string') return item.dom.textContent.trim();
    return '';
  }

  async openLocalGraphForNode(nodeId) {
    const abstractFile = this.app.vault.getAbstractFileByPath(nodeId);
    if (!abstractFile || typeof abstractFile.path !== 'string') return;
    if (typeof abstractFile.extension === 'string' && abstractFile.extension.toLowerCase() !== 'md')
      return;

    const sourceLeaf = this.app.workspace.getLeaf('tab') || this.leaf;
    await sourceLeaf.openFile(abstractFile);
    this.app.workspace.setActiveLeaf(sourceLeaf, true, true);

    const localGraphLeaf =
      this.app.workspace.getLeavesOfType('localgraph')[0] ||
      this.app.workspace.getRightLeaf(true) ||
      this.app.workspace.getLeaf('tab') ||
      this.app.workspace.getLeaf(true);
    await localGraphLeaf.setViewState({ type: 'localgraph', state: {}, active: true });
    this.app.workspace.revealLeaf(localGraphLeaf);
  }

  // Hotkey command handlers: each command resolves a target node under cursor/focus.
  async togglePinUnderCursor() {
    const node = this.getNodeUnderCursor();
    if (!node) {
      new Notice('No node under cursor');
      return;
    }

    if (this.plugin.isPinned(node.id)) {
      this.plugin.removePin(node.id);
      this.kickLayoutSearch();
      new Notice(`Unpinned: ${node.id}`);
      return;
    }

    await this.pinNodeExact(node.id, { x: node.x, y: node.y });
    new Notice(`Pinned: ${node.id}`);
  }

  async promptSetMultiplierUnderCursor() {
    const node = this.getNodeUnderCursor();
    if (!node) {
      new Notice('No node under cursor');
      return;
    }
    await this.promptSetMultiplier(node.id);
  }

  async clearMultiplierUnderCursor() {
    const node = this.getNodeUnderCursor();
    if (!node) {
      new Notice('No node under cursor');
      return;
    }

    if (this.plugin.getNodeMultiplier(node.id) <= 1) {
      new Notice('Multiplier is already default');
      return;
    }

    this.plugin.clearNodeMultiplier(node.id);
    this.kickLayoutSearch();
    new Notice(`Force multiplier cleared: ${node.id}`);
  }

  getNodeUnderCursor() {
    if (!this.lastCursorScreen) return null;
    return this.getNodeAtScreen(this.lastCursorScreen.x, this.lastCursorScreen.y);
  }

  getCommandTargetNode() {
    const cursorNode = this.getNodeUnderCursor();
    if (cursorNode) return cursorNode;
    if (this.hoverNodeId && this.nodeById.has(this.hoverNodeId)) {
      return this.nodeById.get(this.hoverNodeId);
    }
    if (this.searchSelectedNodeId && this.nodeById.has(this.searchSelectedNodeId)) {
      return this.nodeById.get(this.searchSelectedNodeId);
    }
    return null;
  }

  getCommandTargetNodeOrNotice() {
    const node = this.getCommandTargetNode();
    if (node) return node;
    new Notice('No target node under cursor');
    return null;
  }

  async commandPinNode() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    await this.pinNodeExact(node.id, { x: node.x, y: node.y });
    new Notice(`Pinned: ${node.id}`);
  }

  async commandPinToGrid() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    await this.pinNodeToGrid(node.id, { x: node.x, y: node.y });
    new Notice(`Pinned to grid: ${node.id}`);
  }

  async commandUnpinNode() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    this.plugin.removePin(node.id);
    this.plugin.removeOrbitPin(node.id);
    this.kickLayoutSearch();
    new Notice(`Unpinned: ${node.id}`);
  }

  async commandPinLinkedToOrbit() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    await this.pinLinkedNodesToOrbit(node.id);
  }

  async commandUnpinLinkedNodes() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    await this.unpinLinkedNodes(node.id);
  }

  async commandAddToSearch() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    this.applySearchSelectionFromNode(node, { forceSource: 'name' });
    if (this.searchMode === 'filter') this.kickLayoutSearch();
  }

  async commandShowLocalGraph() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    await this.openLocalGraphForNode(node.id);
  }

  async commandPinLinkedNodes() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    await this.pinLinkedNodes(node.id);
  }

  async commandPinLinkedNodesToGrid() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    await this.pinLinkedNodesToGrid(node.id);
  }

  async commandPaintEdges() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    await this.promptPickPaintedEdgeColor(node.id);
  }

  async commandClearPaintedEdges() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    if (!this.plugin.getPaintedEdgeColor(node.id)) {
      new Notice('No painted edges on node');
      return;
    }
    this.plugin.clearPaintedEdgeColor(node.id);
    this.plugin.renderAllViews();
    new Notice(`Painted edges cleared: ${node.id}`);
  }

  async commandStrongPull() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    const strong = this.plugin.clampStrongPullMultiplier(
      this.plugin.getSettings().strong_pull_multiplier
    );
    this.plugin.setNodeMultiplier(node.id, strong, { mode: 'strong-pull' });
    this.kickLayoutSearch();
    new Notice(`Strong pull: ${node.id} x${strong.toFixed(2)}`);
  }

  async commandClearStrongPull() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    if (this.plugin.getNodeMultiplier(node.id) <= 1 && !this.plugin.isStrongPullNode(node.id)) {
      new Notice('Strong pull is already cleared');
      return;
    }
    this.plugin.clearNodeMultiplier(node.id);
    this.kickLayoutSearch();
    new Notice(`Strong pull cleared: ${node.id}`);
  }

  async commandPinAllNodes() {
    if (this.nodes.length <= 0) {
      new Notice('No nodes');
      return;
    }
    let pinnedCount = 0;
    for (const node of this.nodes) {
      this.plugin.setPin(node.id, { x: node.x, y: node.y }, { mode: 'exact' });
      node.vx = 0;
      node.vy = 0;
      pinnedCount += 1;
    }
    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Pinned all nodes: ${pinnedCount}`);
  }

  async commandUnpinAllNodes() {
    const pinCount = Object.keys(this.plugin.data.pins || {}).length;
    const orbitPinCount = Object.keys(this.plugin.data.orbit_pins || {}).length;
    if (pinCount <= 0 && orbitPinCount <= 0) {
      new Notice('No pinned nodes');
      return;
    }
    this.plugin.data.pins = {};
    this.plugin.data.orbit_pins = {};
    this.plugin.schedulePersist();
    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Unpinned all nodes: ${pinCount + orbitPinCount}`);
  }

  // Prompt-based node tools used by context menu and hotkeys.
  async promptSetCoordinates(nodeId) {
    const node = this.nodeById.get(nodeId);
    if (!node) return;

    const coords = await ExactCoordinatesModal.openFor(this.app, node.x, node.y);
    if (!coords) return;
    const x = coords.x;
    const y = coords.y;

    const nextPos = { x, y };
    this.plugin.setPin(nodeId, nextPos, { mode: 'exact' });
    const currentNode = this.nodeById.get(nodeId);
    if (currentNode) {
      currentNode.x = nextPos.x;
      currentNode.y = nextPos.y;
      currentNode.vx = 0;
      currentNode.vy = 0;
    }
    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Pinned to coordinates: ${nodeId} (${x.toFixed(2)}, ${y.toFixed(2)})`);
  }

  async promptSetMultiplier(nodeId) {
    const current = this.plugin.getNodeMultiplier(nodeId);
    const raw = this.contentEl.win.prompt(
      `Set force multiplier for node (${NODE_MULTIPLIER_MIN}..${NODE_MULTIPLIER_MAX})`,
      String(current)
    );
    if (raw == null) return;

    const value = Number(String(raw).trim());
    if (!Number.isFinite(value)) {
      new Notice('Invalid number');
      return;
    }

    const clamped = this.plugin.clampMultiplier(value);
    this.plugin.setNodeMultiplier(nodeId, clamped, { mode: 'manual' });
    this.kickLayoutSearch();

    if (clamped <= 1) {
      new Notice(`Multiplier cleared: ${nodeId}`);
    } else {
      new Notice(`Multiplier set: ${nodeId} x${clamped.toFixed(2)}`);
    }
  }

  async promptPickPaintedEdgeColor(nodeId, clientX = null, clientY = null) {
    const initialColor = this.plugin.getPaintedEdgeColor(nodeId) || '#ef6f6c';
    const hostDocument = this.contentEl.ownerDocument || document;
    const colorInput = hostDocument.createElement('input');
    colorInput.type = 'color';
    colorInput.value = initialColor;
    colorInput.className = 'graphfrontier-group-color-input';
    hostDocument.body.appendChild(colorInput);

    const viewportWidth = this.contentEl.win.innerWidth || 1200;
    const viewportHeight = this.contentEl.win.innerHeight || 800;
    const pickerSize = 24;
    const targetX = Number.isFinite(clientX) ? Number(clientX) : Math.floor(viewportWidth / 2);
    const targetY = Number.isFinite(clientY) ? Number(clientY) : Math.floor(viewportHeight / 2);
    const clampedX = Math.max(8, Math.min(viewportWidth - pickerSize - 8, targetX));
    const clampedY = Math.max(8, Math.min(viewportHeight - pickerSize - 8, targetY));

    colorInput.style.position = 'fixed';
    colorInput.style.left = `${clampedX}px`;
    colorInput.style.top = `${clampedY}px`;
    colorInput.style.opacity = '0';
    colorInput.style.zIndex = '9999';
    colorInput.style.pointerEvents = 'none';

    const cleanup = () => {
      colorInput.remove();
    };
    const applySelectedColor = () => {
      this.plugin.setPaintedEdgeColor(nodeId, colorInput.value);
      this.plugin.renderAllViews();
    };

    this.registerDomEvent(colorInput, 'input', () => {
      applySelectedColor();
    });
    this.registerDomEvent(colorInput, 'change', () => {
      applySelectedColor();
    });
    this.registerDomEvent(colorInput, 'blur', () => {
      window.setTimeout(cleanup, 40);
    });

    colorInput.focus();
    colorInput.click();
  }

  // Pin placement primitives for exact/grid modes and bulk pin alignment.
  async pinNodeToGrid(nodeId, position) {
    const next = this.snapPositionToGrid(nodeId, position.x, position.y);
    this.plugin.setPin(nodeId, next, { mode: 'grid' });

    const node = this.nodeById.get(nodeId);
    if (node) {
      node.x = next.x;
      node.y = next.y;
      node.vx = 0;
      node.vy = 0;
    }
    this.kickLayoutSearch();
  }

  async pinNodeExact(nodeId, position) {
    const next = { x: position.x, y: position.y };
    this.plugin.setPin(nodeId, next, { mode: 'exact' });

    const node = this.nodeById.get(nodeId);
    if (node) {
      node.x = next.x;
      node.y = next.y;
      node.vx = 0;
      node.vy = 0;
    }
    this.kickLayoutSearch();
  }

  async alignPinsToGrid() {
    const step = this.plugin.clampGridStep(this.plugin.getSettings().grid_step);
    const sortedPins = Object.entries(this.plugin.data.pins).sort((entryA, entryB) =>
      entryA[0].localeCompare(entryB[0])
    );

    const occupied = new Set();
    let moved = 0;

    for (const [nodeId, pos] of sortedPins) {
      if (!pos || typeof pos !== 'object') continue;
      const snapped = this.findNearestFreeGridCell(pos.x, pos.y, step, occupied);
      occupied.add(this.gridKey(snapped.gx, snapped.gy));

      if (snapped.x !== pos.x || snapped.y !== pos.y) moved++;

      const pinMode = this.plugin.getPinMode(nodeId);
      this.plugin.data.pins[nodeId] = { x: snapped.x, y: snapped.y, mode: pinMode };

      const node = this.nodeById.get(nodeId);
      if (node) {
        node.x = snapped.x;
        node.y = snapped.y;
        node.vx = 0;
        node.vy = 0;
      }
    }

    this.plugin.schedulePersist();
    new Notice(
      moved > 0
        ? `Aligned pinned nodes to grid: moved ${moved}`
        : `Pinned nodes already aligned (step ${step})`
    );
  }

  // Linked-node bulk actions: pin, unpin, and pin-to-grid for neighbor nodes.
  async pinLinkedNodes(nodeId) {
    const linkedNodeIds = this.getLinkedRegularNodeIds(nodeId);
    if (linkedNodeIds.length === 0) {
      new Notice('No linked nodes');
      return;
    }

    let pinnedCount = 0;
    for (const linkedNodeId of linkedNodeIds) {
      const linkedNode = this.nodeById.get(linkedNodeId);
      if (!linkedNode) continue;
      this.plugin.setPin(linkedNodeId, { x: linkedNode.x, y: linkedNode.y }, { mode: 'exact' });
      linkedNode.vx = 0;
      linkedNode.vy = 0;
      pinnedCount += 1;
    }

    if (pinnedCount <= 0) {
      new Notice('No linked nodes');
      return;
    }

    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Pinned linked nodes: ${pinnedCount}`);
  }

  async pinLinkedNodesToGrid(nodeId) {
    const linkedNodeIds = this.getLinkedRegularNodeIds(nodeId);
    if (linkedNodeIds.length === 0) {
      new Notice('No linked nodes');
      return;
    }

    const gridStep = this.plugin.clampGridStep(this.plugin.getSettings().grid_step);
    const occupiedGridCells = this.getOccupiedGridCells();
    let pinnedCount = 0;

    for (const linkedNodeId of linkedNodeIds) {
      const linkedNode = this.nodeById.get(linkedNodeId);
      if (!linkedNode) continue;

      const snappedCell = this.findNearestFreeGridCell(
        linkedNode.x,
        linkedNode.y,
        gridStep,
        occupiedGridCells
      );
      occupiedGridCells.add(this.gridKey(snappedCell.gx, snappedCell.gy));

      this.plugin.setPin(linkedNodeId, { x: snappedCell.x, y: snappedCell.y }, { mode: 'grid' });
      linkedNode.x = snappedCell.x;
      linkedNode.y = snappedCell.y;
      linkedNode.vx = 0;
      linkedNode.vy = 0;
      pinnedCount += 1;
    }

    if (pinnedCount <= 0) {
      new Notice('No linked nodes');
      return;
    }

    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Pinned linked nodes to grid: ${pinnedCount}`);
  }

  async unpinLinkedNodes(nodeId) {
    const linkedNodeIds = this.getLinkedNodeIds(nodeId);
    if (linkedNodeIds.length === 0) {
      new Notice('No linked nodes');
      return;
    }

    let unpinnedCount = 0;
    for (const linkedNodeId of linkedNodeIds) {
      let removedAnyMode = false;
      if (this.plugin.isPinned(linkedNodeId)) {
        this.plugin.removePin(linkedNodeId);
        removedAnyMode = true;
      }
      if (this.plugin.isOrbitPinned(linkedNodeId)) {
        this.plugin.removeOrbitPin(linkedNodeId);
        removedAnyMode = true;
      }
      if (removedAnyMode) unpinnedCount += 1;
    }

    if (unpinnedCount <= 0) {
      new Notice('No linked pins');
      return;
    }

    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Unpinned linked nodes: ${unpinnedCount}`);
  }

  // Orbit geometry and auto-orbit rules for linked nodes and attachments.
  getOrbitRadiusBySpacing(orbitNodeCount, minRadius) {
    return getOrbitRadiusBySpacing(this.plugin, orbitNodeCount, minRadius);
  }

  getOrbitRadiusForAnchor(orbitNodeCount) {
    return getOrbitRadiusForAnchor(this.plugin, orbitNodeCount);
  }

  buildAttachmentAutoOrbitMap() {
    return buildAttachmentAutoOrbitMapPhysics(this);
  }

  recomputeOrbitRadii() {
    return recomputeOrbitRadiiPhysics(this);
  }

  async pinLinkedNodesToOrbit(nodeId) {
    const anchorNode = this.nodeById.get(nodeId);
    if (!anchorNode) return;

    const linkedNodeIds = this.getLinkedRegularNodeIds(nodeId);
    if (linkedNodeIds.length === 0) {
      new Notice('No linked nodes');
      return;
    }

    const sortedLinkedNodeIds = linkedNodeIds
      .slice()
      .sort((leftId, rightId) => leftId.localeCompare(rightId));
    const orbitRadius = this.getOrbitRadiusForAnchor(sortedLinkedNodeIds.length);
    let orbitPinnedCount = 0;

    for (let index = 0; index < sortedLinkedNodeIds.length; index++) {
      const linkedNodeId = sortedLinkedNodeIds[index];
      const linkedNode = this.nodeById.get(linkedNodeId);
      if (!linkedNode) continue;

      const angle = (Math.PI * 2 * index) / sortedLinkedNodeIds.length;
      this.plugin.setOrbitPin(linkedNodeId, {
        anchor_id: nodeId,
        radius: orbitRadius,
        angle,
      });

      linkedNode.x = anchorNode.x + Math.cos(angle) * orbitRadius;
      linkedNode.y = anchorNode.y + Math.sin(angle) * orbitRadius;
      linkedNode.vx = 0;
      linkedNode.vy = 0;
      orbitPinnedCount += 1;
    }

    if (orbitPinnedCount <= 0) {
      new Notice('No linked nodes');
      return;
    }

    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Orbit pinned linked nodes: ${orbitPinnedCount}`);
  }

  async unpinLinkedNodesFromOrbit(nodeId) {
    const linkedNodeIds = this.getLinkedNodeIds(nodeId);
    if (linkedNodeIds.length === 0) {
      new Notice('No linked nodes');
      return;
    }

    let unpinnedCount = 0;
    for (const linkedNodeId of linkedNodeIds) {
      const orbitPin = this.plugin.getOrbitPin(linkedNodeId);
      if (!orbitPin || orbitPin.anchor_id !== nodeId) continue;
      this.plugin.removeOrbitPin(linkedNodeId);
      unpinnedCount += 1;
    }

    if (unpinnedCount <= 0) {
      new Notice('No linked orbit pins');
      return;
    }

    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Unpinned linked orbit nodes: ${unpinnedCount}`);
  }

  // Linked-node discovery helpers reused by multiple bulk actions.
  getLinkedNodeIds(nodeId) {
    const linkedNodeIds = this.neighborsById.get(nodeId);
    if (!linkedNodeIds) return [];
    const result = [];
    for (const linkedNodeId of linkedNodeIds) {
      if (linkedNodeId === nodeId) continue;
      if (!this.nodeById.has(linkedNodeId)) continue;
      result.push(linkedNodeId);
    }
    return result;
  }

  getLinkedRegularNodeIds(nodeId) {
    const linkedNodeIds = this.getLinkedNodeIds(nodeId);
    const result = [];
    for (const linkedNodeId of linkedNodeIds) {
      const linkedNode = this.nodeById.get(linkedNodeId);
      if (!linkedNode) continue;
      if (linkedNode.meta?.isAttachment) continue;
      result.push(linkedNodeId);
    }
    return result;
  }

  // Layout persistence: save/load full graph layout including settings and pin modes.
  async saveCurrentLayout(options = {}) {
    const silent = !!options.silent;
    if (this.isSearchFilled()) {
      if (!silent) new Notice('Clear search field to save');
      return;
    }
    const savedPositions = {};
    for (const node of this.nodes) {
      savedPositions[node.id] = { x: node.x, y: node.y };
      node.vx = 0;
      node.vy = 0;
    }
    this.plugin.data.saved_positions = savedPositions;
    this.plugin.data.saved_layout_settings = Object.assign({}, this.plugin.data.settings);
    this.plugin.data.saved_layout_pins = {};
    for (const [nodeId, pinMeta] of Object.entries(this.plugin.data.pins || {})) {
      if (!pinMeta || typeof pinMeta !== 'object') continue;
      const x = Number(pinMeta.x);
      const y = Number(pinMeta.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const mode = pinMeta.mode === 'grid' ? 'grid' : 'exact';
      this.plugin.data.saved_layout_pins[nodeId] = { x, y, mode };
    }
    this.plugin.data.saved_layout_orbit_pins = {};
    for (const [nodeId, orbitMeta] of Object.entries(this.plugin.data.orbit_pins || {})) {
      if (!orbitMeta || typeof orbitMeta !== 'object') continue;
      const anchorId = String(orbitMeta.anchor_id || '').trim();
      const radius = Number(orbitMeta.radius);
      const angle = Number(orbitMeta.angle);
      if (!anchorId || anchorId === nodeId) continue;
      if (!Number.isFinite(radius) || radius <= 0) continue;
      if (!Number.isFinite(angle)) continue;
      this.plugin.data.saved_layout_orbit_pins[nodeId] = {
        anchor_id: anchorId,
        radius,
        angle,
      };
      delete this.plugin.data.saved_layout_pins[nodeId];
    }
    this.layoutAutosaveDirty = false;
    this.layoutStillFrames = 0;
    this.plugin.schedulePersist();
    if (!silent) new Notice(`Layout saved: ${this.nodes.length} nodes`);
  }

  async loadSavedLayout(options = {}) {
    const silent = !!options.silent;
    const savedPositions = this.plugin.data.saved_positions || {};
    const savedSettings = this.plugin.data.saved_layout_settings || {};
    const savedPins = this.plugin.data.saved_layout_pins || {};
    const savedOrbitPins = this.plugin.data.saved_layout_orbit_pins || {};

    const hasSomethingToLoad =
      Object.keys(savedPositions).length > 0 ||
      Object.keys(savedSettings).length > 0 ||
      Object.keys(savedPins).length > 0 ||
      Object.keys(savedOrbitPins).length > 0;
    if (!hasSomethingToLoad) {
      if (!silent) new Notice('No saved layout');
      return;
    }

    this.plugin.data.settings = Object.assign({}, this.plugin.data.settings, savedSettings);
    this.plugin.data.pins = {};
    for (const [nodeId, pinMeta] of Object.entries(savedPins)) {
      if (!pinMeta || typeof pinMeta !== 'object') continue;
      const x = Number(pinMeta.x);
      const y = Number(pinMeta.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const mode = pinMeta.mode === 'grid' ? 'grid' : 'exact';
      this.plugin.data.pins[nodeId] = { x, y, mode };
    }
    this.plugin.data.orbit_pins = {};
    for (const [nodeId, orbitMeta] of Object.entries(savedOrbitPins)) {
      if (!orbitMeta || typeof orbitMeta !== 'object') continue;
      const anchorId = String(orbitMeta.anchor_id || '').trim();
      const radius = Number(orbitMeta.radius);
      const angle = Number(orbitMeta.angle);
      if (!anchorId || anchorId === nodeId) continue;
      if (!Number.isFinite(radius) || radius <= 0) continue;
      if (!Number.isFinite(angle)) continue;
      this.plugin.data.orbit_pins[nodeId] = {
        anchor_id: anchorId,
        radius,
        angle,
      };
      delete this.plugin.data.pins[nodeId];
    }

    this.plugin.data = this.plugin.normalizeData(this.plugin.data);
    this.refreshFromVault({ keepCamera: true });
    this.buildSidePanel();
    this.plugin.schedulePersist();
    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    if (!silent) new Notice('Layout loaded');
  }

  // Grid occupancy utilities for collision-safe snapping.
  snapPositionToGrid(nodeId, x, y) {
    const step = this.plugin.clampGridStep(this.plugin.getSettings().grid_step);
    const occupied = this.getOccupiedGridCells(nodeId);
    const snapped = this.findNearestFreeGridCell(x, y, step, occupied);
    return { x: snapped.x, y: snapped.y };
  }

  getOccupiedGridCells(exceptNodeId = null) {
    const step = this.plugin.clampGridStep(this.plugin.getSettings().grid_step);
    const occupied = new Set();

    for (const [nodeId, pos] of Object.entries(this.plugin.data.pins)) {
      if (nodeId === exceptNodeId) continue;
      if (!pos || typeof pos !== 'object') continue;
      const gx = Math.round(pos.x / step);
      const gy = Math.round(pos.y / step);
      occupied.add(this.gridKey(gx, gy));
    }

    return occupied;
  }

  gridKey(gx, gy) {
    return `${gx},${gy}`;
  }

  findNearestFreeGridCell(x, y, step, occupied) {
    const baseGX = Math.round(x / step);
    const baseGY = Math.round(y / step);

    const testCell = (gx, gy) => {
      const key = this.gridKey(gx, gy);
      if (occupied.has(key)) return null;
      const cellX = gx * step;
      const cellY = gy * step;
      const dx = x - cellX;
      const dy = y - cellY;
      return {
        gx,
        gy,
        x: cellX,
        y: cellY,
        d2: dx * dx + dy * dy,
      };
    };

    const direct = testCell(baseGX, baseGY);
    if (direct) return direct;

    let best = null;
    const maxRing = 260;

    for (let ring = 1; ring <= maxRing; ring++) {
      best = null;

      for (let dx = -ring; dx <= ring; dx++) {
        const top = testCell(baseGX + dx, baseGY - ring);
        if (top && (!best || top.d2 < best.d2)) best = top;

        const bottom = testCell(baseGX + dx, baseGY + ring);
        if (bottom && (!best || bottom.d2 < best.d2)) best = bottom;
      }

      for (let dy = -ring + 1; dy <= ring - 1; dy++) {
        const left = testCell(baseGX - ring, baseGY + dy);
        if (left && (!best || left.d2 < best.d2)) best = left;

        const right = testCell(baseGX + ring, baseGY + dy);
        if (right && (!best || right.d2 < best.d2)) best = right;
      }

      if (best) return best;
    }

    return {
      gx: baseGX,
      gy: baseGY,
      x: baseGX * step,
      y: baseGY * step,
      d2: 0,
    };
  }

  // View-state persistence and file opening helpers.
  persistViewState() {
    this.plugin.data.view_state.pan_x = this.cameraTarget.x;
    this.plugin.data.view_state.pan_y = this.cameraTarget.y;
    this.plugin.data.view_state.zoom = this.cameraTarget.zoom;
    this.plugin.schedulePersist();
  }

  async openNodeFile(nodeId) {
    const abstractFile = this.app.vault.getAbstractFileByPath(nodeId);
    if (!abstractFile) return;
    if (typeof abstractFile.extension === 'string' && abstractFile.extension.toLowerCase() !== 'md')
      return;
    if (typeof this.app.workspace.getLeaf === 'function' && typeof abstractFile.path === 'string') {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(abstractFile);
    }
  }

  // Node visual metrics: radius and label visibility thresholds.
  getNodeRadius(node) {
    return getNodeRadiusRender(this, node);
  }

  getLabelZoomThreshold() {
    return getLabelZoomThresholdRender(this);
  }

  getLabelFontSize() {
    return getLabelFontSizeRender(this);
  }

  // Group color matching logic used during node rendering.
  getGroupColorForNode(node) {
    return getGroupColorForNodeRender(this, node);
  }

  nodeMatchesParsedGroup(meta, parsed, node = null) {
    return nodeMatchesParsedGroupRender(meta, parsed, node);
  }

  // Hit testing and coordinate transforms between screen and world spaces.
  getNodeAtScreen(screenX, screenY) {
    const world = this.screenToWorld(screenX, screenY);
    const visibleNodeIds = this.getFilterVisibleNodeIds();
    const hasFilter = visibleNodeIds instanceof Set;

    let bestNode = null;
    let bestDist2 = Infinity;

    for (const node of this.nodes) {
      if (hasFilter && (!visibleNodeIds || !visibleNodeIds.has(node.id))) continue;
      const dx = node.x - world.x;
      const dy = node.y - world.y;
      const dist2 = dx * dx + dy * dy;
      if (dist2 < bestDist2) {
        bestDist2 = dist2;
        bestNode = node;
      }
    }

    if (!bestNode) return null;

    const baseRadius = this.getNodeRadius(bestNode);
    const maxDist = Math.max(1, baseRadius + 2 / Math.max(this.camera.zoom, 0.0001));
    if (bestDist2 > maxDist * maxDist) return null;

    return bestNode;
  }

  screenToWorld(screenX, screenY) {
    return this.screenToWorldWithCamera(screenX, screenY, this.camera);
  }

  screenToWorldWithCamera(screenX, screenY, cameraRef) {
    return {
      x: (screenX - this.viewWidth / 2) / cameraRef.zoom + cameraRef.x,
      y: (screenY - this.viewHeight / 2) / cameraRef.zoom + cameraRef.y,
    };
  }

  worldToScreen(worldX, worldY) {
    return {
      x: (worldX - this.camera.x) * this.camera.zoom + this.viewWidth / 2,
      y: (worldY - this.camera.y) * this.camera.zoom + this.viewHeight / 2,
    };
  }
}

// Modal block for entering and confirming exact coordinates for pin mode.
class ExactCoordinatesModal extends Modal {
  constructor(app, initialX, initialY, resolve) {
    super(app);
    this.initialX = initialX;
    this.initialY = initialY;
    this.resolve = resolve;
  }

  static openFor(app, initialX, initialY) {
    return new Promise((resolve) => {
      const modal = new ExactCoordinatesModal(app, initialX, initialY, resolve);
      modal.open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Set exact coordinates' });

    const form = contentEl.createDiv({ cls: 'graphfrontier-coord-form' });
    const xInput = form.createEl('input', { type: 'text', cls: 'graphfrontier-coord-input' });
    xInput.value = this.initialX.toFixed(2);
    const yInput = form.createEl('input', { type: 'text', cls: 'graphfrontier-coord-input' });
    yInput.value = this.initialY.toFixed(2);

    const parseValue = (rawValue) => {
      const text = String(rawValue || '').trim();
      if (!text) return NaN;
      return Number(text.replace(',', '.'));
    };

    const submit = () => {
      const x = parseValue(xInput.value);
      const y = parseValue(yInput.value);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        new Notice('Invalid coordinates');
        return;
      }
      const done = this.resolve;
      this.resolve = null;
      done({ x, y });
      this.close();
    };

    const actions = contentEl.createDiv({ cls: 'graphfrontier-coord-actions' });
    const okBtn = actions.createEl('button', { text: 'Apply' });
    const cancelBtn = actions.createEl('button', { text: 'Cancel' });

    okBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => {
      const done = this.resolve;
      this.resolve = null;
      done(null);
      this.close();
    });
    xInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    yInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
  }

  onClose() {
    if (this.resolve) {
      this.resolve(null);
      this.resolve = null;
    }
    this.contentEl.empty();
  }
}

module.exports = {
  GraphFrontierView,
};
