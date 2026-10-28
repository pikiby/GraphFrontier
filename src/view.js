const { ItemView, Notice, Menu, MarkdownRenderer, Modal, Scope } = require('obsidian');
const { resolveVaultExportPath, writeVaultExport } = require('./vault-export');
const { ExportModal } = require('./export-modal');
const { DARK_THEME, readGraphTheme, getLabelAppearance } = require('./theme');
const { buildNodeContextMenu } = require('./node-context-menu');
const { PREFIX, normalizeDarkEnergy } = require('./dark-energy');
const { DarkEnergyModal } = require('./dark-energy-modal');
const {
  SUBGRAPH_PREFIX,
  normalizeSubgraphs,
  subgraphNodes,
  hierarchy,
  projectSubgraphs,
  projectNodeId,
  translateMembers,
  reconcileOrbitSpaces,
} = require('./subgraphs');
const { SubgraphModal } = require('./subgraph-modal');
const {
  NODE_VISUAL_SETTINGS,
  getNodeColor,
  getNodeVisualOverride,
  getNodeVisualSetting,
  getEdgeVisualSetting,
} = require('./node-visuals');

const {
  DEFAULT_DATA,
  normalizeAttachmentExtensions,
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
  recomputeOrbitRadii: recomputeOrbitRadiiPhysics,
  stepCameraSmoothing: stepCameraSmoothingPhysics,
  stepSimulation: stepSimulationPhysics,
} = require('./physics');

const {
  stepFocusSmoothing: stepFocusSmoothingRender,
  renderFrame: renderFrameRender,
  getHoverDimAlpha,
  hexToRgba,
  getNodeLabelText,
  getNodeRadius: getNodeRadiusRender,
  getLabelZoomThreshold: getLabelZoomThresholdRender,
  getLabelFontSize: getLabelFontSizeRender,
  getLabelMinimumSize: getLabelMinimumSizeRender,
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
    this.subgraphScope =
      plugin.pendingSubgraphScopes?.get(leaf) || leaf.getViewState?.()?.state?.subgraph || null;

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
    this.nodeSpatialIndex = null;
    this.nodeSpatialIndexVersion = 0;
    this.nodeSpatialIndexBuildVersion = -1;
    this.nodeSpatialIndexCellSize = 64;
    this.groupColorCache = {
      graphVersion: -1,
      groupsSignature: '',
      colorByNodeId: new Map(),
    };

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
    this.panDragMovedDistance = 0;
    this.sidePanelOpen = !this.subgraphScope;
    this.sideControls = new Map();
    const savedSidePanelSections =
      plugin.data?.view_state?.side_panel_sections &&
      typeof plugin.data.view_state.side_panel_sections === 'object'
        ? plugin.data.view_state.side_panel_sections
        : {};
    this.sidePanelSectionState = Object.assign({}, savedSidePanelSections);
    this.groupEditorRows = [];
    this.draggingGroupRow = null;
    this.blacklistEditorRows = [];
    this.whitelistEditorRows = [];
    this.draggingQueryRuleRow = null;
    this.searchMode = this.plugin.data.settings.search_mode === 'filter' ? 'filter' : 'find';
    this.searchInputValue = 'name:';
    this.searchSelectedNodeId = null;
    this.searchMatchedNodeIds = new Set();
    this.searchModeToggleEl = null;
    this.searchModeFindLabelEl = null;
    this.searchModeFilterLabelEl = null;
    this.searchInputEl = null;
    this.searchClearButtonEl = null;
    this.searchSuggestSuppressUntilMs = 0;
    this.layoutFileSearchInputValue = this.plugin.getActiveLayoutFileName();
    this.layoutFileSelectedName = this.layoutFileSearchInputValue;
    this.layoutFileSearchInputEl = null;
    this.layoutFileSearchClearButtonEl = null;
    this.layoutFileSuggestSuppressUntilMs = 0;
    this.layoutFileSuggestRequestToken = 0;
    this.contentSearchIndex = new Map();
    this.contentSearchBuildToken = 0;
    this.contentSearchIndexGraphVersion = -1;
    this.contentSearchBuildGraphVersion = -1;
    this.focusNodeId = null;
    this.focusProgress = 0;
    this.hoverFocusNodeId = null;
    this.hoverFocusProgress = 0;
    this.hoverFadeNodeId = null;
    this.hoverFadeProgress = 0;
    this.neighborsById = new Map();
    this.clickFlashNodeId = null;
    this.clickFlashUntilMs = 0;
    this.selectedNodeIds = new Set();
    this.boxSelectDrag = null;
    this.boxSelectArmed = false;
    this.dragSelectionOffsets = null;
    this.layoutKickAtMs = Date.now();
    this.layoutStillFrames = 0;
    this.layoutAutosaveDirty = false;
    this.layoutEditVersion = 0;
    this.layoutPaused = false;
    this.hasSeenMetadataResolvedRefresh = !!this.plugin.metadataResolvedOnce;
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
    this.canvasTheme = { ...DARK_THEME };
    this.canvasBackgroundColor = this.canvasTheme.background;
  }

  getViewType() {
    return GRAPHFRONTIER_VIEW_TYPE;
  }

  getScopeLeaves() {
    const leaves = this.app.workspace.getLeavesOfType(this.getViewType());
    return this.plugin.isLocalGraphFrontier
      ? leaves.filter((leaf) => leaf.view?.plugin === this.plugin)
      : leaves;
  }

  getDisplayText() {
    if (this.subgraphScope)
      return (
        this.plugin.data.subgraphs?.find((group) => group.id === this.subgraphScope.id)?.name ||
        'Subgraph (unavailable)'
      );
    return 'GraphFrontier';
  }

  getState() {
    return this.subgraphScope ? { subgraph: { ...this.subgraphScope } } : {};
  }

  async setState(state) {
    const nextScope = state?.subgraph?.id
      ? { id: state.subgraph.id, layout: state.subgraph.layout }
      : null;
    const scopeChanged = JSON.stringify(nextScope) !== JSON.stringify(this.subgraphScope);
    if (this.graphDataRef && !scopeChanged) return;
    if (this.graphDataRef === this.plugin.data) {
      this.captureGraphPositions(this.plugin.data);
      this.persistCameraState();
    }
    this.subgraphScope = nextScope;
    this.restoreLayoutViewState();
    if (nextScope && scopeChanged) {
      this.sidePanelOpen = false;
      if (this.isOpen) this.buildSidePanel();
    }
    if (this.isOpen)
      this.refreshFromVault({
        keepCamera: true,
        forceSavedPositions: true,
        skipLayoutKick: !this.subgraphScope,
      });
  }

  getIcon() {
    return 'orbit';
  }

  // View lifecycle: create canvas/UI on open and release resources on close.
  async onOpen() {
    const alreadyOpen = this.getScopeLeaves().some(
      (leaf) => leaf.view !== this && leaf.view?.isOpen
    );
    const loaded =
      !!this.subgraphScope ||
      alreadyOpen ||
      (await this.plugin.setActiveLayoutFile(this.plugin.getActiveLayoutFileName()));
    if (!loaded) new Notice('Cannot read active layout. File left unchanged.');
    this.searchMode = this.plugin.data.settings.search_mode === 'filter' ? 'filter' : 'find';
    this.sidePanelSectionState = this.plugin.getSidePanelSectionsState();
    this.restoreLayoutViewState();
    this.contentEl.empty();
    this.contentEl.addClass('graphfrontier-host');

    this.wrapEl = this.contentEl.createDiv({ cls: 'graphfrontier-wrap' });
    this.canvasEl = this.wrapEl.createEl('canvas', { cls: 'graphfrontier-canvas' });
    this.sidePanelEl = this.wrapEl.createDiv({ cls: 'graphfrontier-sidepanel' });
    this.buildQuickPreviewPanel();
    this.ctx = this.canvasEl.getContext('2d');
    this.updateCanvasBackgroundColor();

    this.buildSidePanel();
    this.bindEvents();
    this.installResizeObserver();
    this.resizeCanvas();

    // Saved coordinates seed normal settling; only duplicate roots/read failures stay paused.
    const skipLayoutKick = !this.subgraphScope && (alreadyOpen || !loaded);
    this.refreshFromVault({
      keepCamera: this.subgraphScope
        ? !!this.plugin.data.subgraph_cameras?.[this.subgraphScope.id]
        : !!(loaded && this.plugin.data.view_state.camera_saved),
      forceSavedPositions: loaded,
      skipLayoutKick,
    });
    if (!this.subgraphScope && this.plugin.data.view_state.search_query && this.isSearchFilled()) {
      this.commitSearchSelectionFromInput(this.searchInputValue);
      if (skipLayoutKick) {
        this.layoutPaused = true;
        this.layoutAutosaveDirty = false;
      }
    }

    this.isOpen = true;
    this.runFrame();
  }

  async onClose() {
    if (
      this.plugin.isLocalGraphFrontier ||
      this.subgraphScope ||
      this.plugin.data.subgraphs?.length
    )
      this.captureGraphPositions(this.plugin.data);
    this.isOpen = false;
    if (this.frameHandle) {
      this.contentEl.win.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    this.persistCameraState();

    const autosaveEnabled = !!this.plugin.data.settings.layout_autosave;
    if (autosaveEnabled && this.layoutAutosaveDirty && !this.isSearchFilled()) {
      if (!(await this.saveCurrentLayout({ silent: true }))) {
        new Notice('Failed to save layout on close. Changes are still unsaved.');
      }
    } else if (
      !autosaveEnabled &&
      !this.plugin.isLocalGraphFrontier &&
      !this.subgraphScope &&
      !this.getScopeLeaves().some((leaf) => leaf.view !== this && leaf.view?.isOpen)
    ) {
      // Groups, rules, and display settings can change without a physics kick.
      await this.loadSavedLayout({ silent: true });
    }

    this.contentEl.removeClass('graphfrontier-host');
    this.clearTouchLongPressTimer();
    this.closeInputSuggestMenu();
    this.closeQuickPreview();
    this.plugin.schedulePersist();
  }

  bindEvents() {
    // View scopes run before the app scope; null key also matches non-Latin layouts.
    if (Scope) {
      this.scope = new Scope(this.app.scope);
      for (const modifier of ['Ctrl', 'Meta']) {
        this.scope.register([modifier], null, (event) => this.onSelectedNodeCopyKeyDown(event));
      }
    }
    this.registerEvent(
      this.app.workspace.on('css-change', () => {
        this.updateCanvasBackgroundColor();
        this.render();
      })
    );
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
    this.closeInputSuggestMenu();
    this.sidePanelEl.empty();
    this.sideControls.clear();
    this.searchModeToggleEl = null;
    this.searchModeFindLabelEl = null;
    this.searchModeFilterLabelEl = null;
    this.searchInputEl = null;
    this.searchClearButtonEl = null;
    this.layoutFileSearchInputEl = null;
    this.layoutFileSearchClearButtonEl = null;
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

    const selectionSection = this.createSidePanelSection(body, {
      id: 'selection',
      title: 'Selection',
      openByDefault: true,
    });
    this.addSideModifierSelect(selectionSection, 'Box select', 'selection_box_modifier', {
      hint: 'Modifier key for box selection drag on empty space',
    });
    this.addSideModifierSelect(
      selectionSection,
      'Add/remove selected',
      'selection_toggle_modifier',
      {
        hint: 'Modifier key for toggling single-node selection on click',
      }
    );

    this.addSideModifierSelect(selectionSection, 'Add to search', 'quick_pick_modifier', {
      hint: 'Modifier key + node click adds its name to search. None disables this action. Selection takes priority; this action takes priority over quick preview.',
    });

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
    this.addSideSlider(displaySection, 'Grid step', 'grid_step', 5, 50, 5, 'render', {
      hint: 'Grid cell size in world coordinates',
    });
    this.addSideSlider(displaySection, 'Grid thickness', 'grid_line_width', 0.1, 1, 0.1, 'render', {
      hint: 'Grid line thickness in CSS pixels, independent of zoom',
    });
    const colorRow = displaySection.createDiv({ cls: 'graphfrontier-sidepanel-row' });
    colorRow.createSpan({ text: 'Node color', cls: 'graphfrontier-sidepanel-label' });
    const colorInput = colorRow.createEl('input', { type: 'color' });
    colorInput.setAttribute('aria-label', 'Node color');
    colorInput.value = this.plugin.getSettings().node_color;
    colorInput.addClass('graphfrontier-group-color-input');
    this.sideControls.set('node_color', { type: 'color', input: colorInput });
    this.registerDomEvent(colorInput, 'input', () => {
      this.plugin.data.settings.node_color = colorInput.value;
      const attachmentColor = this.sideControls.get('attachment_node_color');
      if (attachmentColor && this.plugin.data.settings.attachment_node_color == null)
        attachmentColor.input.value = colorInput.value;
      this.plugin.persistNodeVisualSettings();
    });
    this.addSideSlider(displaySection, 'Node size', 'node_size_scale', 0.1, 4, 0.01, 'render', {
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
    this.addSideSlider(displaySection, 'Text zoom', 'label_zoom_steps', 1, 40, 1, 'render', {
      hint: 'How far labels stay visible when zooming out',
    });
    this.addSideSlider(displaySection, 'Text size', 'label_font_size', 5, 20, 1, 'render', {
      hint: 'Base font size for node labels',
    });
    this.addSideSlider(displaySection, 'Hover dimming', 'hover_dim_strength', 0, 100, 1, 'render', {
      hint: 'How strongly non-focused nodes/edges are dimmed',
    });

    const attachmentsSection = this.createSidePanelSection(body, {
      id: 'attachments',
      title: 'Attachments',
      openByDefault: true,
    });
    attachmentsSection.addClass('graphfrontier-attachments-content');
    this.addSideToggle(attachmentsSection, 'Show attachments', 'hide_attachments', 'data', {
      inverted: true,
      rebuildPanelOnChange: true,
      hint: 'Show non-markdown files as attachment nodes',
    });
    if (!this.plugin.data.settings.hide_attachments) {
      this.buildAttachmentFileTypesControl(attachmentsSection);
      this.addSideToggle(
        attachmentsSection,
        'Show unlinked attachments',
        'include_unlinked_attachments',
        'data',
        {
          hint: 'Include all vault non-markdown files when Show attachments is on; Show orphans still applies',
        }
      );
      const colorRow = attachmentsSection.createDiv({ cls: 'graphfrontier-sidepanel-row' });
      colorRow.createSpan({ text: 'Attachment node color', cls: 'graphfrontier-sidepanel-label' });
      const colorInput = colorRow.createEl('input', { type: 'color' });
      colorInput.setAttribute('aria-label', 'Attachment node color');
      colorInput.addClass('graphfrontier-group-color-input');
      const inheritedColor = () =>
        this.plugin.getSettings().attachment_node_color ?? this.plugin.getSettings().node_color;
      colorInput.value = inheritedColor();
      this.sideControls.set('attachment_node_color', {
        type: 'color',
        input: colorInput,
        getValue: inheritedColor,
      });
      this.registerDomEvent(colorInput, 'input', () => {
        this.plugin.data.settings.attachment_node_color = colorInput.value;
        this.plugin.persistNodeVisualSettings();
      });
    }
    const physicsSection = this.createSidePanelSection(body, {
      id: 'physics',
      title: 'Physics',
      openByDefault: true,
    });
    this.addSideSlider(physicsSection, 'Link strength', 'base_link_strength', 1, 100, 1, 'render', {
      hint: 'Spring force for graph links',
    });
    this.addSideSlider(physicsSection, 'Link distance', 'link_distance', 1, 50, 1, 'render', {
      hint: 'Target distance for all graph links',
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
    this.addSideSlider(physicsSection, 'Repel strength', 'repel_strength', 0, 200, 1, 'render', {
      hint: 'Repulsion force between nodes',
    });
    this.addSideSlider(physicsSection, 'Repel radius', 'repel_radius', 20, 1000, 5, 'render', {
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
    if (!this.plugin.isLocalGraphFrontier) this.addLayoutFileSearchRow(layoutSection);
    this.addSideSaveLayoutButton(layoutSection);
    this.syncSidePanelControls();
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

    const applyOpenState = (nextOpen, persist = true) => {
      isOpen = !!nextOpen;
      section.toggleClass('is-open', isOpen);
      toggleBtn.toggleClass('is-open', isOpen);
      toggleBtn.setAttr('aria-expanded', isOpen ? 'true' : 'false');
      if (!sectionId) return;
      const previousState = this.sidePanelSectionState[sectionId];
      this.sidePanelSectionState[sectionId] = isOpen;
      if (!persist) return;
      if (previousState === isOpen) return;
      if (!this.plugin.data.view_state || typeof this.plugin.data.view_state !== 'object') {
        this.plugin.data.view_state = Object.assign({}, DEFAULT_DATA.view_state);
      }
      this.plugin.data.view_state.side_panel_sections = Object.assign(
        {},
        this.sidePanelSectionState
      );
      this.plugin.schedulePersist();
    };

    applyOpenState(isOpen, false);
    this.registerDomEvent(toggleBtn, 'click', (event) => {
      event.preventDefault();
      applyOpenState(!isOpen, true);
    });

    return content;
  }

  buildAttachmentFileTypesControl(parentEl) {
    const prefix = 'File type: ';
    const row = parentEl.createDiv({ cls: 'graphfrontier-find-row' });
    const wrap = row.createDiv({
      cls: 'graphfrontier-search-input-wrap graphfrontier-input-anchor graphfrontier-file-types-search',
    });
    const input = wrap.createEl('input', {
      cls: 'graphfrontier-find-input',
      type: 'text',
      placeholder: 'File types',
      attr: { 'aria-label': 'File types', 'aria-expanded': 'false', 'aria-haspopup': 'listbox' },
    });
    const clear = wrap.createEl('button', {
      cls: 'graphfrontier-search-inline-clear',
      text: 'x',
      attr: { type: 'button', 'aria-label': 'Clear file type search' },
    });
    const excluded = () =>
      new Set(
        normalizeAttachmentExtensions(this.plugin.data.settings.excluded_attachment_extensions)
      );
    const label = (extension) => (extension ? '.' + extension : 'No extension');
    let inventory = this.plugin.getAttachmentExtensionInventory();
    let query = '';
    let editing = false;
    let showingSummary = false;
    const syncClear = () => {
      clear.toggleClass('is-visible', editing && query.length > 0);
      clear.disabled = !editing || !query;
    };
    const showSummary = (closed = true) => {
      if (closed) {
        editing = false;
        query = '';
      }
      showingSummary = true;
      const exclusions = excluded();
      const selected = inventory.filter(([extension]) => !exclusions.has(extension));
      input.value =
        prefix +
        (selected.length === inventory.length
          ? 'All file types'
          : selected.length
            ? selected
                .slice(0, 3)
                .map(([extension]) => label(extension))
                .join(', ') + (selected.length > 3 ? ' +' + (selected.length - 3) : '')
            : 'No file types');
      input.setAttr('title', input.value);
      input.setAttr('aria-expanded', closed ? 'false' : 'true');
      syncClear();
    };
    const open = () => {
      if (!editing) {
        inventory = this.plugin.getAttachmentExtensionInventory();
        editing = true;
        showingSummary = false;
        input.value = prefix + query;
      }
      const search = query.trim().toLowerCase().replace(/^\./, '');
      const matched = inventory.filter(([extension]) =>
        (extension || label(extension)).toLowerCase().includes(search)
      );
      const items = matched.map(([extension, count]) => ({
        title: label(extension),
        value: extension || '__no_extension__',
        kind: 'attachment-extension',
        extension,
        count,
        isChecked: () => !excluded().has(extension),
      }));
      items.push(
        { title: 'All', value: 'all', kind: 'bulk' },
        { title: 'None', value: 'none', kind: 'bulk' }
      );
      this.showInputSuggestMenu(
        input,
        items,
        (value, item) => {
          const next = excluded();
          if (item.kind === 'bulk') {
            for (const [extension] of matched) {
              if (value === 'all') next.delete(extension);
              else next.add(extension);
            }
          } else if (next.has(item.extension)) next.delete(item.extension);
          else next.add(item.extension);
          this.plugin.data.settings.excluded_attachment_extensions = [...next];
          // Keep the active query and existing option callbacks while showing the new selection.
          showSummary(false);
          this.plugin.schedulePersist();
          this.applyRefreshMode('data');
        },
        {
          multiSelect: true,
          matchInputWidth: true,
          onClose: showSummary,
          clearButtonEl: clear,
          title: matched.length ? '' : 'No matching file types',
        }
      );
      input.setAttr('aria-expanded', 'true');
      syncClear();
    };
    const openIfClosed = () => {
      if (this.inputSuggestInputEl !== input) open();
    };
    this.registerDomEvent(input, 'focus', openIfClosed);
    this.registerDomEvent(input, 'click', openIfClosed);
    this.registerDomEvent(input, 'beforeinput', (event) => {
      const inputType = event.inputType || '';
      if (!inputType) return;
      if (showingSummary) {
        showingSummary = false;
        query = '';
        input.value = prefix;
        input.setSelectionRange(prefix.length, prefix.length);
        if (inputType.startsWith('delete')) {
          event.preventDefault();
          open();
          return;
        }
      }
      if (
        inputType.startsWith('delete') &&
        input.selectionEnd <= prefix.length &&
        (input.selectionStart < prefix.length || inputType.includes('Backward'))
      ) {
        event.preventDefault();
        return;
      }
      this.protectQueryInputPrefix(input, event, prefix);
    });
    this.registerDomEvent(input, 'input', () => {
      showingSummary = false;
      query = input.value.startsWith(prefix) ? input.value.slice(prefix.length) : input.value;
      if (!input.value.startsWith(prefix)) input.value = prefix + query;
      open();
    });
    this.registerDomEvent(input, 'blur', () => {
      if (this.inputSuggestInputEl === input) this.closeInputSuggestMenu();
    });
    this.registerDomEvent(input, 'keydown', (event) => {
      event.stopPropagation();
      if (this.inputSuggestInputEl !== input) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeInputSuggestMenu();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveInputSuggestSelection(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.selectInputSuggestActive();
      }
    });
    for (const name of ['keyup', 'keypress']) {
      this.registerDomEvent(input, name, (event) => event.stopPropagation());
    }
    this.registerDomEvent(clear, 'mousedown', (event) => event.preventDefault());
    this.registerDomEvent(clear, 'click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      query = '';
      showingSummary = false;
      input.value = prefix;
      open();
      input.focus();
    });
    showSummary();
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
      if (typeof options.onChange === 'function') {
        options.onChange(this.plugin.data.settings[key]);
      }
      if (options.rebuildPanelOnChange) {
        this.buildSidePanel();
      }
    });
  }

  addSideModifierSelect(parentEl, label, key, options = {}) {
    const hintText = String(options.hint || label);
    const row = parentEl.createDiv({ cls: 'graphfrontier-sidepanel-row' });
    row.setAttr('title', hintText);
    const labelEl = row.createSpan({ text: label, cls: 'graphfrontier-sidepanel-label' });
    labelEl.setAttr('title', hintText);

    const buttonEl = row.createEl('button', {
      cls: 'graphfrontier-sidepanel-toggle graphfrontier-sidepanel-inline-toggle',
    });
    buttonEl.setAttr('title', hintText);

    const modifierOptions = [
      { value: 'none', text: 'None' },
      { value: 'shift', text: 'Shift' },
      { value: 'ctrl', text: 'Ctrl' },
      { value: 'meta', text: 'Meta' },
      { value: 'alt', text: 'Alt' },
    ];
    const modifierTextByValue = new Map(
      modifierOptions.map((optionMeta) => [optionMeta.value, optionMeta.text])
    );
    const normalize = (value) => this.normalizeModifierSetting(value, 'none');
    const updateButton = (value) => {
      const normalized = normalize(value);
      const text = modifierTextByValue.get(normalized) || 'None';
      buttonEl.setText(text);
      buttonEl.setAttr('aria-label', `${label}: ${text}`);
    };
    updateButton(this.plugin.data.settings[key]);

    this.sideControls.set(key, {
      type: 'modifier-button',
      input: buttonEl,
      normalize,
      updateButton,
    });

    this.registerDomEvent(buttonEl, 'click', () => {
      const menu = new Menu(this.app);
      for (const optionMeta of modifierOptions) {
        menu.addItem((item) =>
          item.setTitle(optionMeta.text).onClick(() => {
            this.plugin.data.settings[key] = optionMeta.value;
            updateButton(optionMeta.value);
            this.plugin.schedulePersist();
          })
        );
      }
      const rect = buttonEl.getBoundingClientRect();
      this.showMenuAtPointer(menu, rect.left + rect.width / 2, rect.bottom + 2, null);
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
      const targetLayoutFileName = this.getLayoutFileNameFromInputValue(
        this.layoutFileSearchInputEl
          ? this.layoutFileSearchInputEl.value
          : this.layoutFileSearchInputValue
      );
      await this.saveCurrentLayout({ layoutFileName: targetLayoutFileName });
    });

    const loadButton = buttonsWrap.createEl('button', {
      cls: 'graphfrontier-sidepanel-save',
      text: 'Load layout',
    });
    loadButton.setAttr('title', 'Load last saved positions, settings, and pin states');
    this.registerDomEvent(loadButton, 'click', async () => {
      await this.loadSavedLayout();
    });

    const exportButton = buttonsWrap.createEl('button', {
      cls: 'graphfrontier-sidepanel-save',
      text: 'Export to',
    });
    exportButton.setAttr('title', 'Export static graph HTML inside the current vault');
    this.registerDomEvent(exportButton, 'click', async () => {
      await this.commandExportStaticHtml();
    });
  }

  addLayoutFileSearchRow(parentEl) {
    this.syncLayoutFileSelectionFromPlugin();
    const row = parentEl.createDiv({ cls: 'graphfrontier-find-row graphfrontier-layout-file-row' });
    const inputWrap = row.createDiv({
      cls: 'graphfrontier-search-input-wrap graphfrontier-input-anchor',
    });
    const inputEl = inputWrap.createEl('input', {
      cls: 'graphfrontier-find-input',
      type: 'text',
      placeholder: 'Select layout file...',
    });
    inputEl.value = this.layoutFileSearchInputValue;
    this.layoutFileSearchInputEl = inputEl;

    this.layoutFileSearchClearButtonEl = null;

    const deleteLayoutByName = async (layoutFileName) => {
      const normalizedName = this.plugin.normalizeLayoutFileName(layoutFileName);
      if (!normalizedName) return;
      const result = await this.plugin.deleteLayoutFile(normalizedName);
      if (!result || result.ok !== true) {
        const reason = String(result?.reason || '');
        if (reason === 'last-layout') new Notice('Cannot delete the last layout');
        else if (reason === 'not-found') new Notice('Layout file not found');
        else new Notice('Failed to delete layout');
        return;
      }

      if (result.activeChanged) {
        this.syncLayoutFileSelectionFromPlugin();
        this.plugin.refreshAllViews({ forceSavedPositions: true, skipLayoutKick: true });
        this.buildSidePanel();
        this.plugin.renderAllViews();
        return;
      }

      this.layoutFileSuggestSuppressUntilMs = Date.now() + 220;
      this.closeInputSuggestMenu();
      inputEl.focus();
      this.contentEl.win.setTimeout(() => {
        this.layoutFileSuggestSuppressUntilMs = 0;
        void openLayoutSuggestionPopup('');
      }, 0);
    };

    const openLayoutSuggestionPopup = async (rawQueryOverride = null) => {
      if (Date.now() < this.layoutFileSuggestSuppressUntilMs) return;
      const requestToken = ++this.layoutFileSuggestRequestToken;
      const effectiveQuery =
        rawQueryOverride == null ? String(inputEl.value || '') : String(rawQueryOverride || '');
      const suggestionPack = await this.getLayoutFileSuggestionPack(effectiveQuery);
      if (requestToken !== this.layoutFileSuggestRequestToken) return;
      const items = Array.isArray(suggestionPack?.items) ? suggestionPack.items : [];
      if (items.length <= 0) {
        this.closeInputSuggestMenu();
        return;
      }
      const itemsWithDeleteAction = items.map((item) =>
        String(item?.kind || '') === 'layout-file'
          ? Object.assign({}, item, {
              actionLabel: 'x',
              actionTitle: `Delete layout "${String(item?.title || item?.value || '').trim()}"`,
              onAction: () => {
                void deleteLayoutByName(String(item?.value || ''));
              },
            })
          : item
      );
      this.showInputSuggestMenu(
        inputEl,
        itemsWithDeleteAction,
        (selectedText) => {
          void this.selectActiveLayoutFileByName(String(selectedText || ''));
        },
        { title: suggestionPack?.menuTitle || '' }
      );
    };

    this.registerDomEvent(inputEl, 'input', () => {
      this.layoutFileSearchInputValue = String(inputEl.value || '');
      this.layoutFileSelectedName = '';
      this.syncLayoutFileSearchClearButtonVisibility();
      openLayoutSuggestionPopup();
    });
    this.registerDomEvent(inputEl, 'keydown', (event) => {
      const hasActiveMenu =
        !!this.inputSuggestMenu && this.inputSuggestInputEl && this.inputSuggestInputEl === inputEl;
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
      this.closeInputSuggestMenu();
    });
    this.registerDomEvent(inputEl, 'blur', () => {
      if (!String(inputEl.value || '').trim()) {
        this.syncLayoutFileSelectionFromPlugin();
      }
      this.contentEl.win.setTimeout(() => {
        if (!this.inputSuggestInputEl || this.inputSuggestInputEl !== inputEl) return;
        this.closeInputSuggestMenu();
      }, 0);
    });
    this.registerDomEvent(inputEl, 'click', () => {
      openLayoutSuggestionPopup('');
    });
    this.registerDomEvent(inputEl, 'focus', () => {
      openLayoutSuggestionPopup('');
    });
    this.syncLayoutFileSearchClearButtonVisibility();
  }

  syncLayoutFileSearchClearButtonVisibility() {
    if (!this.layoutFileSearchClearButtonEl) return;
    const textValue = this.layoutFileSearchInputEl
      ? this.layoutFileSearchInputEl.value
      : this.layoutFileSearchInputValue;
    const isVisible = String(textValue || '').trim().length > 0;
    this.layoutFileSearchClearButtonEl.toggleClass('is-visible', isVisible);
  }

  syncLayoutFileSelectionFromPlugin() {
    const activeLayoutName = this.plugin.getActiveLayoutFileName();
    const activeLayoutDisplayName = this.getLayoutDisplayName(activeLayoutName);
    this.layoutFileSearchInputValue = activeLayoutDisplayName;
    this.layoutFileSelectedName = activeLayoutName;
    if (this.layoutFileSearchInputEl) this.layoutFileSearchInputEl.value = activeLayoutDisplayName;
    this.syncLayoutFileSearchClearButtonVisibility();
  }

  async getLayoutFileSuggestionPack(rawQueryText) {
    const listPath = this.plugin.getLayoutsFolderRelativePath();
    const names = await this.plugin.listLayoutFileNames();

    const queryText = String(rawQueryText || '')
      .trim()
      .toLowerCase();
    const filteredNames =
      queryText.length <= 0
        ? names
        : names.filter((fileName) => {
            const lowerFileName = fileName.toLowerCase();
            const lowerDisplayName = this.getLayoutDisplayName(fileName).toLowerCase();
            return lowerFileName.includes(queryText) || lowerDisplayName.includes(queryText);
          });
    const items = filteredNames.map((fileName) => ({
      title: this.getLayoutDisplayName(fileName),
      value: fileName,
      description: listPath,
      kind: 'layout-file',
    }));
    return {
      menuTitle: 'Layouts',
      items,
    };
  }

  async selectActiveLayoutFileByName(layoutFileName) {
    const selectedName = String(layoutFileName || '').trim();
    if (!selectedName) return false;
    return this.loadSavedLayout({ layoutFileName: selectedName, silent: true });
  }

  getLayoutDisplayName(layoutFileName) {
    const rawName = String(layoutFileName || '').trim();
    return rawName.replace(/\.json$/iu, '');
  }

  getLayoutFileNameFromInputValue(rawInputValue) {
    const rawText = String(rawInputValue || '').trim();
    if (!rawText) return this.plugin.getActiveLayoutFileName();
    const selectedFileName = String(this.layoutFileSelectedName || '').trim();
    if (selectedFileName) {
      const selectedDisplay = this.getLayoutDisplayName(selectedFileName).toLowerCase();
      if (selectedDisplay === rawText.toLowerCase()) return selectedFileName;
    }
    return this.plugin.normalizeLayoutFileName(rawText);
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
    this.searchInputValue = this.normalizeSearchInput(this.searchInputValue);
    searchInput.value = this.searchInputValue;
    this.searchInputEl = searchInput;
    const clearButton = searchInputWrap.createEl('button', {
      cls: 'graphfrontier-search-inline-clear',
      text: 'x',
      attr: { 'aria-label': 'Clear search' },
    });
    this.searchClearButtonEl = clearButton;

    const connectionsRow = section.createDiv({ cls: 'graphfrontier-search-connections' });
    this.searchConnectionsToggleEl = connectionsRow.createEl('button', {
      cls: 'graphfrontier-toggle-btn graphfrontier-search-mode-toggle',
      attr: { type: 'button', role: 'switch', 'aria-label': 'Show connections' },
    });
    connectionsRow.createSpan({ text: 'Show connections' });
    this.registerDomEvent(this.searchConnectionsToggleEl, 'click', () => {
      this.plugin.data.settings.show_search_connections =
        !this.plugin.getSettings().show_search_connections;
      this.syncSearchModeToggleUi();
      this.plugin.schedulePersist();
    });
    this.syncSearchModeToggleUi();

    const getSuggestionPack = () => {
      const rawQuery = String(searchInput.value || '');
      const prefix = this.getSearchInputPrefix(rawQuery);
      if (!this.parseSearchQuery(rawQuery).query || searchInput.selectionStart < prefix.length) {
        return {
          items: this.getQueryTypeSuggestions('', { allowName: true }),
          menuTitle: 'Search options',
        };
      }
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
            searchInput.setSelectionRange(nextText.length, nextText.length);
            this.searchInputValue = nextText;
            this.searchSelectedNodeId = null;
            this.syncSearchMatchesLive();
            this.syncSearchClearButtonVisibility();
            if (this.searchMode === 'filter') this.kickLayoutSearch();
            this.contentEl.win.setTimeout(() => openSearchSuggestionPopup(), 0);
            return;
          }
          searchInput.value = selectedText;
          this.searchInputValue = selectedText;
          commitBestSearchSelection();
          if (this.searchMode === 'filter') this.kickLayoutSearch();
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
      if (!this.subgraphScope) this.plugin.data.settings.search_mode = this.searchMode;
      this.syncSearchMatchesLive();
      this.markSearchVisibilityDirty();
      this.syncSearchModeToggleUi();
      this.kickLayoutSearch();
      this.plugin.schedulePersist();
    });

    this.registerDomEvent(searchInput, 'beforeinput', (event) => {
      this.protectQueryInputPrefix(searchInput, event);
    });
    this.registerDomEvent(searchInput, 'input', () => {
      searchInput.value = this.normalizeSearchInput(
        searchInput.value,
        this.getSearchInputPrefix(this.searchInputValue)
      );
      this.searchInputValue = String(searchInput.value || '');
      this.searchSelectedNodeId = null;
      this.syncSearchMatchesLive();
      this.syncSearchClearButtonVisibility();
      if (this.searchMode === 'filter') this.kickLayoutSearch();
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
      this.searchInputValue = this.getSearchInputPrefix(searchInput.value);
      this.searchSelectedNodeId = null;
      this.searchMatchedNodeIds = new Set();
      this.markSearchVisibilityDirty();
      if (this.searchInputEl) this.searchInputEl.value = this.searchInputValue;
      this.syncSearchClearButtonVisibility();
      if (this.searchMode === 'filter') this.kickLayoutSearch();
      this.closeInputSuggestMenu();
      if (this.searchInputEl) this.searchInputEl.focus();
    });

    this.syncSearchClearButtonVisibility();
  }

  syncSearchModeToggleUi() {
    if (this.searchConnectionsToggleEl) {
      const enabled = this.plugin.getSettings().show_search_connections === true;
      this.searchConnectionsToggleEl.toggleClass('is-on', enabled);
      this.searchConnectionsToggleEl.setAttr('aria-checked', String(enabled));
    }
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

  getSearchInputPrefix(rawQueryText) {
    return (
      /^(?:name|tag|path|file|line|section|\[[^\]]+\])\s*:\s*/i.exec(
        String(rawQueryText || '')
      )?.[0] || 'name:'
    );
  }

  protectQueryInputPrefix(input, event, prefix = this.getSearchInputPrefix(input.value)) {
    const length = prefix.length;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === end && start <= length && event.inputType.startsWith('delete')) {
      if (start < length || event.inputType.includes('Backward')) {
        event.preventDefault();
        return;
      }
    }
    if (start < length) input.setSelectionRange(length, Math.max(length, end));
  }

  normalizeSearchInput(rawQueryText, prefix = 'name:') {
    const text = String(rawQueryText || '');
    return this.plugin.parseGroupQuery(text) ? text.trimStart() : `${prefix}${text}`;
  }

  parseSearchQuery(rawQueryText) {
    return this.parseDropdownQuery(this.normalizeSearchInput(rawQueryText), {
      allowName: true,
      implicitSource: 'name',
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
    return this.getQuerySuggestionPack(this.normalizeSearchInput(rawQueryText), {
      allowName: true,
      implicitSource: 'name',
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
      if (!this.ensureContentSearchIndexForCurrentGraph(parsed)) return matches;
      for (const node of this.nodes) {
        if (node?.meta?.isAttachment) continue;
        const contentText = this.contentSearchIndex.get(node.id);
        if (contentText && contentText.includes(queryText)) matches.add(node.id);
      }
      return matches;
    }

    if (parsed.source === 'name') {
      for (const node of this.nodes) {
        if (
          String(node.label || '')
            .toLowerCase()
            .includes(queryText)
        )
          matches.add(node.id);
      }
      return matches;
    }

    for (const node of this.nodes) {
      const meta = this.getNodeMetaForSearch(node);
      if (!meta) continue;
      if (this.nodeMatchesSearchParsed(meta, parsed)) matches.add(node.id);
    }
    return matches;
  }

  shouldUseContentSearchIndex(parsed = null) {
    const safeParsed =
      parsed ||
      this.parseSearchQuery(this.searchInputEl ? this.searchInputEl.value : this.searchInputValue);
    return safeParsed && safeParsed.source === 'content' && !!String(safeParsed.query || '').trim();
  }

  ensureContentSearchIndexForCurrentGraph(parsed = null) {
    if (!this.shouldUseContentSearchIndex(parsed)) return false;
    if (this.contentSearchIndexGraphVersion === this.visibilityGraphVersion) return true;
    this.scheduleContentSearchIndexRebuild();
    return false;
  }

  cancelContentSearchIndexBuild() {
    if (this.contentSearchBuildGraphVersion === -1) return;
    this.contentSearchBuildToken += 1;
    this.contentSearchBuildGraphVersion = -1;
  }

  syncSearchMatchesLive() {
    const rawText = this.searchInputEl ? this.searchInputEl.value : this.searchInputValue;
    const parsed = this.parseSearchQuery(rawText);
    if (!parsed.query || (parsed.source === 'name' && this.searchMode === 'filter')) {
      this.cancelContentSearchIndexBuild();
      this.searchMatchedNodeIds = new Set();
      this.markSearchVisibilityDirty();
      return;
    }
    if (parsed.source !== 'content') this.cancelContentSearchIndexBuild();
    this.searchMatchedNodeIds = this.getMatchedNodeIdsForParsedSearch(parsed);
    this.markSearchVisibilityDirty();
  }

  commitSearchSelectionFromInput(rawText) {
    const text = this.normalizeSearchInput(rawText);
    this.searchInputValue = text;
    if (this.searchInputEl) this.searchInputEl.value = text;
    const parsed = this.parseSearchQuery(text);
    if (!parsed.query) {
      this.searchSelectedNodeId = null;
      this.searchMatchedNodeIds = new Set();
      this.markSearchVisibilityDirty();
      this.syncSearchClearButtonVisibility();
      if (this.searchMode === 'filter') this.kickLayoutSearch();
      return;
    }
    if (parsed.source === 'name' && this.searchMode === 'filter') {
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
    this.focusNodeId = node.id;
    this.focusProgress = 1;
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
    const hasText = this.parseSearchQuery(effectiveText).query.length > 0;
    this.searchClearButtonEl.toggleClass('is-visible', hasText);
    this.searchClearButtonEl.disabled = !hasText;
  }

  markGraphVisibilityDirty() {
    this.visibilityGraphVersion += 1;
    this.contentSearchIndexGraphVersion = -1;
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

  getFilterNodeIds() {
    const id = this.getFilterNodeId();
    if (!id) return new Set();
    const selected = this.nodes.find((node) => node.id === id);
    if (!selected) return new Set();
    const label = String(selected.label || '').toLowerCase();
    return new Set(
      this.nodes
        .filter((node) => String(node.label || '').toLowerCase() === label)
        .map((node) => node.id)
    );
  }

  getSearchSelectedFocusNodeId() {
    if (!this.searchSelectedNodeId) return null;
    return this.nodeById.has(this.searchSelectedNodeId) ? this.searchSelectedNodeId : null;
  }

  getFilterVisibleNodeIds() {
    if (this.plugin.data.subgraphs?.length || this.subgraphScope)
      return this.getSubgraphFilterVisibleNodeIds();
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
    if (finalVisibleNodeIds instanceof Set && this.plugin.data.dark_energy?.length) {
      finalVisibleNodeIds = new Set(finalVisibleNodeIds);
      for (const item of this.plugin.data.dark_energy) finalVisibleNodeIds.add(item.id);
    }
    if (this.apiVisibleNodeIds instanceof Set) {
      finalVisibleNodeIds = new Set(
        [...this.apiVisibleNodeIds].filter(
          (id) =>
            this.nodeById.has(id) &&
            (!(finalVisibleNodeIds instanceof Set) || finalVisibleNodeIds.has(id))
        )
      );
    }
    this.filterVisibilityCache.finalVisibleKey = finalKey;
    this.filterVisibilityCache.finalVisibleNodeIds = finalVisibleNodeIds;
    return finalVisibleNodeIds;
  }

  getSubgraphFilterVisibleNodeIds() {
    const key = `${this.visibilityGraphVersion}|${this.visibilitySearchVersion}|${this.getActiveQueryRuleSignature()}`;
    if (this.subgraphFilterKey === key && this.subgraphFilterApiIds === this.apiVisibleNodeIds)
      return this.subgraphFilterIds;
    const groups = this.plugin.data.subgraphs;
    const parents = hierarchy(groups);
    const raw = this.canonicalGraphData || { nodes: [], edges: [] };
    const nodes = new Map([...raw.nodes, ...subgraphNodes(groups)].map((node) => [node.id, node]));
    const blacklist = this.getCompleteQueryRulesByKey('blacklist');
    const whitelist = this.getCompleteQueryRulesByKey('whitelist');
    const matches = (node, rules) =>
      rules.some((rule) => this.nodeMatchesParsedGroup(node.meta || {}, rule, node));
    const blockedGroups = new Set(
      groups.filter((group) => matches(nodes.get(group.id), blacklist)).map((group) => group.id)
    );
    const blocked = (node) => {
      if (!node.meta?.darkEnergy && matches(node, blacklist)) return true;
      for (let parent = parents.get(node.id); parent; parent = parents.get(parent))
        if (blockedGroups.has(parent)) return true;
      return false;
    };
    const representative = (id) => projectNodeId(id, parents, this.subgraphScope?.id || null);
    const parsed = this.parseSearchQuery(this.searchInputEl?.value || this.searchInputValue);
    const api = this.apiVisibleNodeIds;
    const eligible = new Set();
    for (const node of nodes.values()) {
      if (
        node.meta?.subgraph ||
        blocked(node) ||
        (!node.meta?.darkEnergy && whitelist.length && !matches(node, whitelist))
      )
        continue;
      const projectedId = representative(node.id);
      if (api && !api.has(node.id) && !api.has(projectedId)) continue;
      eligible.add(node.id);
    }
    const baseProjection = projectSubgraphs(
      {
        ...raw,
        edges: raw.edges.filter((edge) => eligible.has(edge.source) && eligible.has(edge.target)),
      },
      groups,
      this.subgraphScope?.id
    );
    let search = null;
    if (this.searchMode === 'filter' && parsed.query) {
      if (parsed.source === 'name') {
        const centers = this.getFilterNodeIds();
        search = new Set(centers);
        for (const edge of baseProjection.edges) {
          if (centers.has(edge.source)) search.add(edge.target);
          if (centers.has(edge.target)) search.add(edge.source);
        }
      } else search = this.searchMatchedNodeIds || new Set();
    }
    this.filterVisibilityCache.searchVisibleVersion = this.visibilitySearchVersion;
    this.filterVisibilityCache.searchVisibleNodeIds = search;
    const allowed = new Set();
    const visible = new Set();
    for (const id of eligible) {
      const node = nodes.get(id);
      const projectedId = representative(id);
      if (search && !search.has(node.id) && !search.has(projectedId)) {
        if (
          !node.meta?.darkEnergy &&
          (parsed.source === 'name' || !this.nodeMatchesSearchParsed(node.meta || {}, parsed))
        )
          continue;
      }
      allowed.add(node.id);
      if (this.nodeById.has(node.id)) visible.add(node.id);
      for (let parent = parents.get(node.id); parent; parent = parents.get(parent))
        if (this.nodeById.has(parent)) visible.add(parent);
    }
    for (const node of nodes.values()) {
      if (!node.meta?.subgraph || !this.nodeById.has(node.id) || blocked(node)) continue;
      const empty = !node.meta.subgraph.members.length;
      if (
        ((!blacklist.length && !whitelist.length && !api && !search) ||
          (whitelist.length
            ? matches(node, whitelist)
            : empty || api?.has(node.id) || search?.has(node.id))) &&
        (!api || api.has(node.id)) &&
        (!search || search.has(node.id))
      )
        visible.add(node.id);
    }
    // Project only eligible original links: a hidden note cannot leak a relationship
    // through the otherwise-visible container of another matching member.
    const projected = projectSubgraphs(
      {
        ...raw,
        edges: raw.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)),
      },
      groups,
      this.subgraphScope?.id
    );
    for (const node of this.nodes) node.degree = 0;
    const { nextEdges, nextNeighborsById } = this.buildNextEdgesAndNeighbors(
      projected.edges,
      this.nodeById,
      this.nodes
    );
    this.edges = nextEdges;
    this.neighborsById = nextNeighborsById;
    this.subgraphFilterKey = key;
    this.subgraphFilterApiIds = api;
    this.subgraphFilterIds = visible;
    return visible;
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
      const centers = this.getFilterNodeIds();
      visibleNodeIds = new Set(centers);
      for (const id of centers) {
        const neighbors = this.neighborsById.get(id);
        if (neighbors) for (const nodeId of neighbors) visibleNodeIds.add(nodeId);
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
    const selectedFocusNodeId = this.getSearchSelectedFocusNodeId();
    if (selectedFocusNodeId) return selectedFocusNodeId;
    if (this.getEffectiveSearchSource() !== 'name') return null;
    return this.searchSelectedNodeId || null;
  }

  getActiveFocusNodeId() {
    const selectedFocusNodeId = this.getSearchSelectedFocusNodeId();
    if (selectedFocusNodeId) return selectedFocusNodeId;
    const filterFocusNodeId = this.getFilterNodeId();
    if (filterFocusNodeId) return filterFocusNodeId;
    const findFocusNodeId = this.getFindFocusNodeId();
    if (findFocusNodeId) return findFocusNodeId;
    return null;
  }

  // Shared input suggestion popup used by both search and group editor inputs.
  showInputSuggestMenu(inputEl, suggestions, onSelect, meta = {}) {
    this.closeInputSuggestMenu(this.inputSuggestInputEl !== inputEl);
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
      const onAction =
        rawSuggestion && typeof rawSuggestion.onAction === 'function'
          ? rawSuggestion.onAction
          : null;
      normalizedSuggestions.push({
        title: titleText,
        value: valueText,
        description: String(rawSuggestion?.description || '').trim(),
        selectable: rawSuggestion?.selectable !== false,
        kind: String(rawSuggestion?.kind || 'default'),
        ...(meta.multiSelect
          ? {
              extension: rawSuggestion.extension,
              count: rawSuggestion.count,
              isChecked: rawSuggestion.isChecked,
            }
          : {}),
        onAction,
        actionLabel: onAction ? String(rawSuggestion?.actionLabel || '').trim() || 'x' : '',
        actionTitle: onAction ? String(rawSuggestion?.actionTitle || '').trim() : '',
      });
    }
    if (normalizedSuggestions.length <= 0) return;

    const ownerDocument = inputEl.ownerDocument || this.contentEl.ownerDocument;
    const ownerWindow = ownerDocument.defaultView || this.contentEl.win;
    if (!ownerDocument || !ownerWindow || !ownerDocument.body) return;
    const viewport = meta.matchInputWidth ? ownerWindow.visualViewport : null;

    const menuEl = ownerDocument.createElement('div');
    menuEl.className = 'graphfrontier-input-menu';
    menuEl.setAttribute('role', 'listbox');
    if (meta.matchInputWidth) menuEl.classList.add('graphfrontier-input-menu-match-width');
    let listEl = menuEl;
    let controlsEl = null;
    if (meta.multiSelect) {
      menuEl.classList.add('graphfrontier-input-menu-multi');
      menuEl.setAttribute('role', 'group');
      controlsEl = ownerDocument.createElement('div');
      controlsEl.className = 'graphfrontier-input-menu-controls';
      menuEl.appendChild(controlsEl);
      listEl = ownerDocument.createElement('div');
      listEl.className = 'graphfrontier-input-menu-list';
      listEl.setAttribute('role', 'listbox');
      listEl.setAttribute('aria-multiselectable', 'true');
      menuEl.appendChild(listEl);
    }

    if (meta && typeof meta.title === 'string' && meta.title.trim()) {
      const headerEl = ownerDocument.createElement('div');
      headerEl.className = 'graphfrontier-input-menu-header';
      headerEl.textContent = meta.title.trim();
      listEl.appendChild(headerEl);
    }

    const selectableEntries = [];
    const syncChecks = () => {
      for (const { itemEl, suggestion, checkbox } of selectableEntries) {
        if (!checkbox) continue;
        checkbox.checked = !!suggestion.isChecked();
        itemEl.setAttribute('aria-selected', String(checkbox.checked));
      }
    };
    const select = (value, suggestion) => {
      onSelect(value, suggestion);
      if (meta.multiSelect) syncChecks();
      else this.closeInputSuggestMenu();
    };
    for (const suggestion of normalizedSuggestions) {
      const isBulk = meta.multiSelect && suggestion.kind === 'bulk';
      const itemEl = ownerDocument.createElement(isBulk ? 'button' : 'div');
      itemEl.className = isBulk
        ? 'graphfrontier-sidepanel-toggle graphfrontier-sidepanel-inline-toggle graphfrontier-input-menu-bulk'
        : 'graphfrontier-input-menu-item';
      if (isBulk) itemEl.setAttribute('type', 'button');
      else itemEl.setAttribute('role', 'option');
      const hasAction = typeof suggestion.onAction === 'function';
      let checkbox = null;
      if (meta.multiSelect && typeof suggestion.isChecked === 'function') {
        itemEl.classList.add('graphfrontier-input-menu-check-item');
        checkbox = ownerDocument.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.tabIndex = -1;
        checkbox.setAttribute('aria-label', suggestion.title);
        checkbox.addEventListener('change', () => select(String(suggestion.value), suggestion));
        itemEl.appendChild(checkbox);
      }

      let textContainerEl = itemEl;
      if (hasAction) {
        itemEl.style.display = 'flex';
        itemEl.style.alignItems = 'flex-start';
        itemEl.style.justifyContent = 'space-between';
        itemEl.style.gap = '8px';
        textContainerEl = ownerDocument.createElement('div');
        textContainerEl.style.minWidth = '0';
        textContainerEl.style.flex = '1 1 auto';
        itemEl.appendChild(textContainerEl);
      }

      const mainTextEl = ownerDocument.createElement('div');
      mainTextEl.className = 'graphfrontier-input-menu-main';
      mainTextEl.textContent = suggestion.title;
      textContainerEl.appendChild(mainTextEl);

      if (suggestion.description) {
        const descEl = ownerDocument.createElement('div');
        descEl.className = 'graphfrontier-input-menu-desc';
        descEl.textContent = suggestion.description;
        textContainerEl.appendChild(descEl);
      }

      if (checkbox && suggestion.count != null) {
        const countEl = ownerDocument.createElement('span');
        countEl.className = 'graphfrontier-input-menu-count';
        countEl.textContent = String(suggestion.count);
        countEl.setAttribute('title', 'Files in the whole vault');
        itemEl.appendChild(countEl);
      }

      if (hasAction) {
        const actionBtnEl = ownerDocument.createElement('button');
        actionBtnEl.className = 'graphfrontier-group-remove';
        actionBtnEl.setAttribute('type', 'button');
        const actionTitle = suggestion.actionTitle || 'Delete';
        actionBtnEl.setAttribute('aria-label', actionTitle);
        actionBtnEl.setAttribute('title', actionTitle);
        actionBtnEl.textContent = suggestion.actionLabel || 'x';
        actionBtnEl.addEventListener('mousedown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          suggestion.onAction(suggestion);
        });
        itemEl.appendChild(actionBtnEl);
      }

      if (!suggestion.selectable) itemEl.classList.add('is-disabled');
      else {
        selectableEntries.push({ itemEl, suggestion, checkbox });
        itemEl.addEventListener('mousedown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!meta.multiSelect) select(String(suggestion.value), suggestion);
        });
      }
      if (meta.multiSelect && suggestion.selectable) {
        itemEl.addEventListener('click', (event) => {
          if (event.target === checkbox) return;
          event.preventDefault();
          event.stopPropagation();
          select(String(suggestion.value), suggestion);
        });
      }
      (isBulk ? controlsEl : listEl).appendChild(itemEl);
    }
    syncChecks();

    const setActiveIndex = (nextIndex) => {
      if (selectableEntries.length <= 0) return false;
      const boundedIndex =
        ((nextIndex % selectableEntries.length) + selectableEntries.length) %
        selectableEntries.length;
      for (const entry of selectableEntries) entry.itemEl.classList.remove('is-active');
      const activeEntry = selectableEntries[boundedIndex];
      if (!activeEntry) return false;
      activeEntry.itemEl.classList.add('is-active');
      if (!meta.multiSelect) activeEntry.itemEl.scrollIntoView({ block: 'nearest' });
      else if (activeEntry.itemEl.parentElement === listEl) {
        // Scroll only the options, never the popup or its pinned bulk controls.
        const itemRect = activeEntry.itemEl.getBoundingClientRect();
        const listRect = listEl.getBoundingClientRect();
        if (itemRect.top < listRect.top) listEl.scrollTop -= listRect.top - itemRect.top;
        else if (itemRect.bottom > listRect.bottom)
          listEl.scrollTop += itemRect.bottom - listRect.bottom;
      }
      return true;
    };

    const placeMenu = () => {
      if (!inputEl.isConnected || !menuEl.isConnected) {
        // A queued frame from a replaced menu must not close its replacement.
        if (this.inputSuggestMenu?.menuEl === menuEl) this.closeInputSuggestMenu();
        return;
      }

      const inputRect = inputEl.getBoundingClientRect();
      const viewportWidth = Math.max(
        1,
        viewport?.width || ownerWindow.innerWidth || ownerDocument.documentElement.clientWidth || 1
      );
      const viewportHeight = Math.max(
        1,
        viewport?.height ||
          ownerWindow.innerHeight ||
          ownerDocument.documentElement.clientHeight ||
          1
      );
      const marginPx = 8;
      const desiredWidth = meta.matchInputWidth ? inputRect.width : Math.max(inputRect.width, 320);
      const maxWidth = Math.max(meta.matchInputWidth ? 1 : 240, viewportWidth - marginPx * 2);
      const menuWidth = Math.min(desiredWidth, maxWidth);

      const minLeft = (viewport?.offsetLeft || 0) + marginPx;
      const minTop = (viewport?.offsetTop || 0) + marginPx;
      const maxLeft = Math.max(minLeft, minLeft + viewportWidth - menuWidth - marginPx * 2);
      const leftPx = Math.min(Math.max(inputRect.left, minLeft), maxLeft);

      menuEl.style.width = `${menuWidth}px`;
      menuEl.style.left = `${Math.round(leftPx)}px`;
      if (meta.multiSelect) {
        const maxBottom = minTop + viewportHeight - marginPx * 2;
        const below = Math.max(0, maxBottom - Math.max(minTop, inputRect.bottom + 4));
        const above = Math.max(0, Math.min(maxBottom, inputRect.top - 4) - minTop);
        const desiredHeight = Math.min(
          248,
          listEl.scrollHeight + controlsEl.offsetHeight + 8 || 248
        );
        const useBelow = below >= desiredHeight || below >= above;
        const available = useBelow ? below : above;
        menuEl.style.maxHeight = `${Math.min(248, available)}px`;
        const menuHeight = Math.min(menuEl.offsetHeight, 248, available);
        const top = useBelow ? inputRect.bottom + 4 : inputRect.top - menuHeight - 4;
        menuEl.style.top = `${Math.round(Math.max(minTop, Math.min(top, maxBottom - menuHeight)))}px`;
        return;
      }

      const menuHeight = Math.max(1, menuEl.offsetHeight);
      let topPx = inputRect.bottom + 4;
      if (topPx + menuHeight > minTop + viewportHeight - marginPx * 2) {
        topPx = Math.max(minTop, inputRect.top - menuHeight - 4);
      }
      if (meta.matchInputWidth)
        topPx = Math.max(
          minTop,
          Math.min(topPx, minTop + viewportHeight - marginPx * 2 - menuHeight)
        );
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
      if (meta.multiSelect && meta.clearButtonEl?.contains(eventTarget)) return;
      this.closeInputSuggestMenu();
    };

    const repositionHandler = () => {
      placeMenu();
    };

    ownerDocument.addEventListener('mousedown', closeHandler, true);
    ownerDocument.addEventListener('scroll', repositionHandler, true);
    ownerWindow.addEventListener('resize', repositionHandler, true);
    viewport?.addEventListener('resize', repositionHandler);
    viewport?.addEventListener('scroll', repositionHandler);

    this.inputSuggestMenu = {
      menuEl,
      onSelect: select,
      onClose: meta.onClose,
      multiSelect: !!meta.multiSelect,
      ownerDocument,
      ownerWindow,
      viewport,
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

  closeInputSuggestMenu(notify = true) {
    if (!this.inputSuggestMenu) return;
    const { ownerDocument, ownerWindow, viewport, closeHandler, repositionHandler, onClose } =
      this.inputSuggestMenu;
    viewport?.removeEventListener('resize', repositionHandler);
    viewport?.removeEventListener('scroll', repositionHandler);
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
    if (notify && typeof onClose === 'function') onClose();
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
    this.inputSuggestMenu.onSelect(String(activeEntry.suggestion.value), activeEntry.suggestion);
    return true;
  }

  // Focus blending state machine for smooth highlight transitions.
  stepFocusSmoothing() {
    return stepFocusSmoothingRender(this);
  }

  // Simulation restart marker: called when settings or node positions change.
  kickLayoutSearch() {
    this.layoutEditVersion += 1;
    return kickLayoutSearchPhysics(this);
  }

  markNodeSpatialIndexDirty() {
    this.nodeSpatialIndexVersion += 1;
  }

  getNodeSpatialIndex() {
    if (
      this.nodeSpatialIndex &&
      this.nodeSpatialIndexBuildVersion === this.nodeSpatialIndexVersion
    ) {
      return this.nodeSpatialIndex;
    }

    const cellSize = Math.max(1, Number(this.nodeSpatialIndexCellSize) || 64);
    const buckets = new Map();
    for (const node of this.nodes) {
      const gx = Math.floor(node.x / cellSize);
      const gy = Math.floor(node.y / cellSize);
      const key = `${gx}:${gy}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(node);
    }

    this.nodeSpatialIndex = { buckets, cellSize };
    this.nodeSpatialIndexBuildVersion = this.nodeSpatialIndexVersion;
    return this.nodeSpatialIndex;
  }

  isNodeSpatialIndexFresh() {
    return (
      !!this.nodeSpatialIndex && this.nodeSpatialIndexBuildVersion === this.nodeSpatialIndexVersion
    );
  }

  warmNodeSpatialIndexIfIdle() {
    if (this.isNodeSpatialIndexFresh()) return;
    if (this.dragNodeId || this.panDrag || this.boxSelectDrag) return;
    if (!this.nodeSpatialIndex || this.layoutPaused) this.getNodeSpatialIndex();
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

  normalizeModifierSetting(rawModifier, fallback = 'none') {
    const normalized = String(rawModifier || '')
      .trim()
      .toLowerCase();
    if (['alt', 'ctrl', 'meta', 'shift', 'none'].includes(normalized)) return normalized;
    return String(fallback || 'none')
      .trim()
      .toLowerCase();
  }

  isModifierActive(event, rawModifier) {
    const modifier = this.normalizeModifierSetting(rawModifier, 'none');
    if (modifier === 'none') return false;
    if (modifier === 'alt') return !!event.altKey;
    if (modifier === 'shift') return !!event.shiftKey;
    if (modifier === 'meta') return !!event.metaKey;
    if (modifier === 'ctrl') return !!event.ctrlKey || !!event.metaKey;
    return false;
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

      if (meta.type === 'color' && activeEl !== meta.input) {
        meta.input.value = meta.getValue ? meta.getValue() : currentValue;
        continue;
      }
      if (meta.type === 'slider' && activeEl !== meta.input) {
        const clamped = Math.max(meta.min, Math.min(meta.max, Number(currentValue)));
        const nextValue = String(clamped);
        if (meta.input.value !== nextValue) meta.input.value = nextValue;
        meta.valueEl.setText(this.formatSliderValue(clamped, meta.step));
        continue;
      }

      if (meta.type === 'select' && activeEl !== meta.input) {
        const normalize =
          typeof meta.normalize === 'function'
            ? meta.normalize
            : (value) =>
                String(value || '')
                  .trim()
                  .toLowerCase();
        const nextValue = normalize(currentValue);
        if (meta.input.value !== nextValue) meta.input.value = nextValue;
        continue;
      }

      if (meta.type === 'modifier-button' && activeEl !== meta.input) {
        const normalize =
          typeof meta.normalize === 'function'
            ? meta.normalize
            : (value) =>
                String(value || '')
                  .trim()
                  .toLowerCase();
        const nextValue = normalize(currentValue);
        if (typeof meta.updateButton === 'function') meta.updateButton(nextValue);
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
    const doc = this.contentEl.ownerDocument;
    const viewport = doc?.defaultView?.visualViewport;
    const host = this.contentEl.getBoundingClientRect?.();
    if (!host) return;
    let bottom = Math.min(
      host.bottom,
      viewport ? viewport.offsetTop + viewport.height : host.bottom
    );
    // Obsidian's floating navigation overlaps the view rather than reducing its height.
    const navbar = doc.querySelector('.mobile-navbar')?.getBoundingClientRect();
    if (
      navbar?.height &&
      navbar.right > host.left &&
      navbar.left < host.right &&
      navbar.top > host.top
    ) {
      bottom = Math.min(bottom, navbar.top - 8);
    }
    this.wrapEl.style.maxHeight = `${Math.max(0, bottom - host.top)}px`;
  }

  updateCanvasBackgroundColor() {
    if (!this.contentEl) return;
    this.canvasTheme = readGraphTheme(this.contentEl);
    this.canvasBackgroundColor = this.canvasTheme.background;
  }

  resizeCanvas() {
    if (!this.canvasEl || !this.ctx) return;

    this.updateWrapHeightForKeyboard();
    this.updateCanvasBackgroundColor();

    const rect = this.wrapEl.getBoundingClientRect();
    this.viewWidth = Math.max(1, Math.floor(rect.width));
    this.viewHeight = Math.max(1, Math.floor(rect.height));
    this.devicePixelRatio = this.contentEl.win.devicePixelRatio || 1;

    this.canvasEl.width = Math.floor(this.viewWidth * this.devicePixelRatio);
    this.canvasEl.height = Math.floor(this.viewHeight * this.devicePixelRatio);

    this.ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
    this.finishSubgraphFraming();
    this.render();
  }

  finishSubgraphFraming() {
    if (
      !this.pendingSubgraphFit ||
      !this.hasValidSubgraphScope() ||
      this.graphDataRef !== this.plugin.data ||
      this.viewWidth <= 1 ||
      this.viewHeight <= 1
    )
      return false;
    const visible = this.getFilterVisibleNodeIds();
    this.fitCameraToNodes(
      this.nodes.filter((node) => !visible || visible.has(node.id)),
      {
        initialSubgraphFit: true,
      }
    );
    this.pendingSubgraphFit = false;
    return true;
  }

  // In-memory graph rebuild: load nodes/edges, restore positions, and recompute neighbors.
  refreshFromVault(opts = {}) {
    const keepCamera = !!opts.keepCamera;
    const forceSavedPositions = !!opts.forceSavedPositions;
    const skipLayoutKick = !!opts.skipLayoutKick;
    const metadataResolved = !!opts.metadataResolved;
    const passive = opts.passive === true || metadataResolved;
    if (metadataResolved) {
      this.hasSeenMetadataResolvedRefresh = true;
    } else if (this.plugin.metadataResolvedOnce) {
      this.hasSeenMetadataResolvedRefresh = true;
    }
    const fullGraph = this.plugin.collectGraphData();
    this.canonicalGraphData = fullGraph;
    this.graphDataRef = this.plugin.data;
    const scope = this.subgraphScope;
    const graphData = this.plugin.isLocalGraphFrontier
      ? this.localGraphData(fullGraph)
      : scope && scope.layout !== this.plugin.getActiveLayoutFileName()
        ? { nodes: [], edges: [] }
        : projectSubgraphs(fullGraph, this.plugin.data.subgraphs, scope?.id);
    const { topologyChanged } = this.syncGraphRuntimeState(graphData, { forceSavedPositions });
    this.markGraphVisibilityDirty();

    if (this.searchSelectedNodeId && !this.nodeById.has(this.searchSelectedNodeId)) {
      this.searchSelectedNodeId = null;
    }
    this.syncSearchMatchesLive();
    this.syncSearchClearButtonVisibility();
    if (!this.shouldUseContentSearchIndex()) {
      this.cancelContentSearchIndexBuild();
    }
    this.getNodeSpatialIndex();
    this.updateLayoutCenter();

    this.cleanupDetachedData({
      allowDestructivePrune: this.hasSeenMetadataResolvedRefresh,
    });

    if (!keepCamera) {
      if (this.subgraphScope) this.pendingSubgraphFit = true;
      else {
        this.fitCameraToNodes();
        this.centerCameraOnActiveFileNode();
      }
    }
    this.finishSubgraphFraming();

    if (skipLayoutKick) {
      this.layoutPaused = true;
      this.layoutStillFrames = 0;
      if (forceSavedPositions) this.layoutAutosaveDirty = false;
    } else if (!passive || topologyChanged) {
      this.kickLayoutSearch();
    }
    this.render();
  }

  scheduleContentSearchIndexRebuild() {
    if (!this.shouldUseContentSearchIndex()) return;
    if (
      this.contentSearchBuildGraphVersion === this.visibilityGraphVersion ||
      this.contentSearchIndexGraphVersion === this.visibilityGraphVersion
    ) {
      return;
    }
    const buildToken = ++this.contentSearchBuildToken;
    const graphVersion = this.visibilityGraphVersion;
    this.contentSearchBuildGraphVersion = graphVersion;
    const nodesSnapshot = this.nodes.slice();
    const appRef = this.app;
    const nextIndex = new Map();

    const buildIndexAsync = async () => {
      for (const node of nodesSnapshot) {
        if (
          buildToken !== this.contentSearchBuildToken ||
          graphVersion !== this.visibilityGraphVersion
        )
          return;
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
      if (
        buildToken !== this.contentSearchBuildToken ||
        graphVersion !== this.visibilityGraphVersion
      )
        return;
      this.contentSearchIndex = nextIndex;
      this.contentSearchIndexGraphVersion = graphVersion;
      this.contentSearchBuildGraphVersion = -1;
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
  syncGraphRuntimeState(graphData, options = {}) {
    const oldNodes = this.nodeById;
    const oldNeighborsById = this.topologyNeighborsById || this.neighborsById;
    const oldEdgeCount = this.topologyEdgeCount ?? this.edges.length;
    const { nextNodes, nextNodeById } = this.buildNextNodesFromGraphData(
      graphData.nodes,
      oldNodes,
      options
    );
    const { nextEdges, nextNeighborsById } = this.buildNextEdgesAndNeighbors(
      graphData.edges,
      nextNodeById,
      nextNodes
    );
    const topologyChanged =
      oldNodes.size !== nextNodeById.size ||
      nextNodes.some((node) => !oldNodes.has(node.id)) ||
      oldEdgeCount !== nextEdges.length ||
      nextEdges.some((edge) => !oldNeighborsById.get(edge.source)?.has(edge.target));

    this.applyOrbitPinnedPositions(nextNodes, nextNodeById);

    this.nodes = nextNodes;
    this.nodeById = nextNodeById;
    this.nodeMetaById = new Map(nextNodes.map((node) => [node.id, node.meta || null]));
    this.neighborsById = nextNeighborsById;
    this.edges = nextEdges;
    this.topologyNeighborsById = nextNeighborsById;
    this.topologyEdgeCount = nextEdges.length;
    this.selectedNodeIds = new Set(
      Array.from(this.selectedNodeIds).filter((nodeId) => this.nodeById.has(nodeId))
    );
    if (this.dragNodeId && !this.nodeById.has(this.dragNodeId)) this.dragNodeId = null;
    if (this.dragSelectionOffsets instanceof Map && this.dragSelectionOffsets.size > 0) {
      const nextOffsets = new Map();
      for (const [nodeId, offset] of this.dragSelectionOffsets.entries()) {
        if (!this.nodeById.has(nodeId)) continue;
        nextOffsets.set(nodeId, offset);
      }
      this.dragSelectionOffsets = nextOffsets.size > 0 ? nextOffsets : null;
    }
    this.boxSelectDrag = null;

    this.nodeSpatialIndex = null;
    this.nodeSpatialIndexBuildVersion = -1;
    this.markNodeSpatialIndexDirty();
    return { topologyChanged };
  }

  buildNextNodesFromGraphData(rawNodes, oldNodes, options = {}) {
    const nextNodes = [];
    const nextNodeById = new Map();
    let index = 0;

    for (const rawNode of rawNodes) {
      const oldNode = oldNodes.get(rawNode.id);
      const node = this.createRuntimeNode(rawNode, oldNode, index, options);
      nextNodes.push(node);
      nextNodeById.set(node.id, node);
      index += 1;
    }

    return { nextNodes, nextNodeById };
  }

  createRuntimeNode(rawNode, oldNode, index, options = {}) {
    const forceSavedPositions = !!options.forceSavedPositions;
    const pin = this.plugin.getPin(rawNode.id);
    const savedPosition = this.plugin.data.saved_positions[rawNode.id];

    let x;
    let y;
    let vx = 0;
    let vy = 0;

    if (pin) {
      x = pin.x;
      y = pin.y;
    } else if (
      forceSavedPositions &&
      savedPosition &&
      Number.isFinite(savedPosition.x) &&
      Number.isFinite(savedPosition.y)
    ) {
      x = Number(savedPosition.x);
      y = Number(savedPosition.y);
      vx = 0;
      vy = 0;
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
    } else if (rawNode.meta?.darkEnergy) {
      x = rawNode.meta.darkEnergy.x;
      y = rawNode.meta.darkEnergy.y;
    } else if (rawNode.meta?.subgraph) {
      x = rawNode.meta.subgraph.x;
      y = rawNode.meta.subgraph.y;
    } else {
      const angle = (index % 360) * (Math.PI / 180);
      const radius = 80 + 10 * Math.sqrt(index + 1);
      const jitterX = (Math.random() - 0.5) * 18;
      const jitterY = (Math.random() - 0.5) * 18;
      x = this.camera.x + Math.cos(angle) * radius + jitterX;
      y = this.camera.y + Math.sin(angle) * radius + jitterY;
    }

    const node = {
      id: rawNode.id,
      label: rawNode.label,
      meta: rawNode.meta || null,
      x,
      y,
      vx,
      vy,
      degree: 0,
    };
    return node;
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
        sourceNode,
        targetNode,
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

  // Data cleanup and initial framing after graph rebuild.
  cleanupDetachedData(options = {}) {
    void options;
    // The runtime graph is settings-dependent and can be incomplete while Obsidian metadata
    // is still resolving. Never prune persisted layout state from this filtered snapshot.
  }

  fitCameraToNodes(nodes = this.nodes, { initialSubgraphFit = false } = {}) {
    if (nodes.length === 0) {
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

    for (const node of nodes) {
      const radius = initialSubgraphFit ? this.getNodeRadius(node) : 0;
      minX = Math.min(minX, node.x - radius);
      maxX = Math.max(maxX, node.x + radius);
      minY = Math.min(minY, node.y - radius);
      maxY = Math.max(maxY, node.y + radius);
    }

    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);

    this.camera.x = (minX + maxX) / 2;
    this.camera.y = (minY + maxY) / 2;

    const padding = initialSubgraphFit ? 24 : 0;
    const zoomX = (this.viewWidth * 0.9 - padding * 2) / width;
    const zoomY = (this.viewHeight * 0.9 - padding * 2) / height;
    const targetZoom = Math.min(zoomX, zoomY, initialSubgraphFit ? 2 : 1);
    this.camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom));
    this.cameraTarget.x = this.camera.x;
    this.cameraTarget.y = this.camera.y;
    this.cameraTarget.zoom = this.camera.zoom;
  }

  // Keep first-open framing close to the user's current note when possible.
  centerCameraOnActiveFileNode() {
    const activePath = this.plugin.isLocalGraphFrontier
      ? this.localPath
      : this.app?.workspace?.getActiveFile?.()?.path;
    if (!activePath) return false;
    const activeNode = this.nodeById.get(activePath);
    if (!activeNode) return false;

    this.camera.x = activeNode.x;
    this.camera.y = activeNode.y;
    this.cameraTarget.x = this.camera.x;
    this.cameraTarget.y = this.camera.y;
    this.camera.zoom = Math.max(this.camera.zoom, 0.85);
    this.cameraTarget.zoom = this.camera.zoom;
    return true;
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
    if (this.subgraphScope && !this.hasValidSubgraphScope() && this.nodes.length)
      this.refreshFromVault({ keepCamera: true, skipLayoutKick: true });
    this.finishSubgraphFraming();
    this.stepCameraSmoothing();
    this.stepSimulation();
    this.warmNodeSpatialIndexIfIdle();
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

  getQuickPreviewModifier() {
    return 'ctrl';
  }

  getBoxSelectModifier() {
    return this.normalizeModifierSetting(
      this.plugin?.data?.settings?.selection_box_modifier,
      'shift'
    );
  }

  getSelectionToggleModifier() {
    return this.normalizeModifierSetting(
      this.plugin?.data?.settings?.selection_toggle_modifier,
      'none'
    );
  }

  isNodeSelected(nodeId) {
    return this.selectedNodeIds.has(nodeId);
  }

  clearNodeSelection() {
    if (this.selectedNodeIds.size <= 0) return;
    this.selectedNodeIds.clear();
    this.plugin.renderAllViews();
  }

  toggleNodeSelection(nodeId) {
    if (!nodeId || !this.nodeById.has(nodeId)) return false;
    if (this.selectedNodeIds.has(nodeId)) this.selectedNodeIds.delete(nodeId);
    else this.selectedNodeIds.add(nodeId);
    this.plugin.renderAllViews();
    return true;
  }

  setNodeSelection(nodeIds) {
    const nextSelectedNodeIds = new Set();
    if (nodeIds instanceof Set || Array.isArray(nodeIds)) {
      for (const nodeId of nodeIds) {
        if (!this.nodeById.has(nodeId)) continue;
        nextSelectedNodeIds.add(nodeId);
      }
    }
    this.selectedNodeIds = nextSelectedNodeIds;
    this.plugin.renderAllViews();
  }

  getDraggedNodeIds(seedNodeId) {
    if (!seedNodeId || !this.nodeById.has(seedNodeId)) return [];
    if (!this.selectedNodeIds.has(seedNodeId) || this.selectedNodeIds.size <= 1)
      return [seedNodeId];
    return [...this.selectedNodeIds].filter((id) => this.nodeById.has(id));
  }

  getNodeIdsInScreenRect(screenRect) {
    if (!screenRect) return [];
    const minX = Math.min(screenRect.startX, screenRect.currentX);
    const maxX = Math.max(screenRect.startX, screenRect.currentX);
    const minY = Math.min(screenRect.startY, screenRect.currentY);
    const maxY = Math.max(screenRect.startY, screenRect.currentY);
    const selectedNodeIds = [];
    for (const node of this.nodes) {
      const point = this.worldToScreen(node.x, node.y);
      if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) continue;
      selectedNodeIds.push(node.id);
    }
    return selectedNodeIds;
  }

  // Pointer and navigation: hover, node drag, scene pan, zoom, and node open actions.
  onMouseMove(event) {
    if (Date.now() < this.ignoreMouseUntilMs) return;

    const rect = this.canvasEl.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    this.lastCursorScreen = { x: screenX, y: screenY };

    if (this.boxSelectDrag) {
      this.boxSelectDrag.currentX = screenX;
      this.boxSelectDrag.currentY = screenY;
      return;
    }

    if (this.dragNodeId) {
      const world = this.screenToWorld(screenX, screenY);
      if (this.dragSelectionOffsets instanceof Map && this.dragSelectionOffsets.size > 0) {
        for (const [nodeId, offset] of this.dragSelectionOffsets.entries()) {
          const node = this.nodeById.get(nodeId);
          if (!node) continue;
          node.x = world.x + offset.x;
          node.y = world.y + offset.y;
          node.vx = 0;
          node.vy = 0;
        }
        if (this.dragStartScreen) {
          const ddx = screenX - this.dragStartScreen.x;
          const ddy = screenY - this.dragStartScreen.y;
          this.dragMovedDistance = Math.max(
            this.dragMovedDistance,
            Math.sqrt(ddx * ddx + ddy * ddy)
          );
        }
        this.markNodeSpatialIndexDirty();
        return;
      }
      const node = this.nodeById.get(this.dragNodeId);
      if (node) {
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
        this.markNodeSpatialIndexDirty();
      }
      return;
    }

    if (this.panDrag) {
      const dx = screenX - this.panDrag.startX;
      const dy = screenY - this.panDrag.startY;
      this.panDragMovedDistance = Math.max(this.panDragMovedDistance, Math.sqrt(dx * dx + dy * dy));
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
    const selectionToggleModifier = this.getSelectionToggleModifier();
    const quickPreviewModifier = this.getQuickPreviewModifier();
    const boxSelectModifier = this.getBoxSelectModifier();

    if (node) {
      if (this.isModifierActive(event, selectionToggleModifier)) {
        this.toggleNodeSelection(node.id);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.isModifierActive(event, this.plugin.getSettings().quick_pick_modifier)) {
        this.applySearchSelectionFromNode(node, { forceSource: 'name' });
        if (this.searchMode === 'filter') this.kickLayoutSearch();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.isModifierActive(event, quickPreviewModifier)) {
        this.toggleQuickPreview(node.id, event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const world = this.screenToWorld(screenX, screenY);
      const dragNodeIds = this.getDraggedNodeIds(node.id);
      const seed = dragNodeIds.length === 1 ? this.nodeById.get(dragNodeIds[0]) : node;
      this.dragNodeId = seed.id;
      if (dragNodeIds.length > 1) {
        this.dragSelectionOffsets = new Map();
        for (const dragNodeId of dragNodeIds) {
          const dragNode = this.nodeById.get(dragNodeId);
          if (!dragNode) continue;
          this.dragSelectionOffsets.set(dragNodeId, {
            x: dragNode.x - world.x,
            y: dragNode.y - world.y,
          });
        }
        this.dragNodeOffset = { x: 0, y: 0 };
      } else {
        this.dragSelectionOffsets = null;
        this.dragNodeOffset = {
          x: seed.x - world.x,
          y: seed.y - world.y,
        };
      }
      this.dragStartScreen = { x: screenX, y: screenY };
      this.dragMovedDistance = 0;
      this.canvasEl.addClass('is-dragging');
      return;
    }

    if (this.boxSelectArmed || this.isModifierActive(event, boxSelectModifier)) {
      this.boxSelectDrag = {
        startX: screenX,
        startY: screenY,
        currentX: screenX,
        currentY: screenY,
        baselineSelection: event.shiftKey ? new Set(this.selectedNodeIds) : null,
      };
      this.boxSelectArmed = false;
      this.panDrag = null;
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
    this.panDragMovedDistance = 0;
    this.canvasEl.addClass('is-dragging');
  }

  onMouseUp(event = null, options = {}) {
    const fromTouch = !!(options && options.fromTouch);
    const suppressClick = !!(options && options.suppressClick);
    if (!fromTouch && Date.now() < this.ignoreMouseUntilMs) return;

    if (this.boxSelectDrag) {
      const selectedNodeIds = this.getNodeIdsInScreenRect(this.boxSelectDrag);
      this.setNodeSelection([...(this.boxSelectDrag.baselineSelection || []), ...selectedNodeIds]);
      this.boxSelectDrag = null;
      this.dragNodeId = null;
      this.dragSelectionOffsets = null;
      this.dragStartScreen = null;
      this.dragMovedDistance = 0;
      this.panDrag = null;
      this.canvasEl.removeClass('is-dragging');
      return;
    }

    let clickedNodeId = null;
    const hadDraggedNode = !!this.dragNodeId;
    const hadPanDrag = !!this.panDrag;
    const panDragMovedDistance = this.panDragMovedDistance;
    const didDragNodeMove = hadDraggedNode && this.dragMovedDistance > 3;
    const draggedNodeId = this.dragNodeId;
    const draggedNodeIds =
      this.dragSelectionOffsets instanceof Map && this.dragSelectionOffsets.size > 0
        ? Array.from(this.dragSelectionOffsets.keys())
        : draggedNodeId
          ? [draggedNodeId]
          : [];
    if (draggedNodeId) {
      if (this.dragMovedDistance <= 3) clickedNodeId = draggedNodeId;
      for (const movedNodeId of draggedNodeIds) {
        const draggedNode = this.nodeById.get(movedNodeId);
        if (!draggedNode || !this.plugin.isPinned(movedNodeId)) continue;
        const pinMode = this.plugin.getPinMode(movedNodeId);
        if (pinMode === 'grid') {
          const snapped = this.snapPositionToGrid(movedNodeId, draggedNode.x, draggedNode.y);
          draggedNode.x = snapped.x;
          draggedNode.y = snapped.y;
          draggedNode.vx = 0;
          draggedNode.vy = 0;
          this.plugin.setPin(movedNodeId, { x: snapped.x, y: snapped.y }, { mode: 'grid' });
        } else {
          this.plugin.setPin(
            movedNodeId,
            { x: draggedNode.x, y: draggedNode.y },
            { mode: 'exact' }
          );
        }
      }
    }

    this.dragNodeId = null;
    this.dragSelectionOffsets = null;
    this.dragStartScreen = null;
    this.dragMovedDistance = 0;
    this.panDrag = null;
    this.panDragMovedDistance = 0;
    this.canvasEl.removeClass('is-dragging');

    if (didDragNodeMove) this.kickLayoutSearch();

    const isBackgroundClick = !hadDraggedNode && hadPanDrag && panDragMovedDistance <= 3;
    if (isBackgroundClick) {
      this.clearNodeSelection();
      this.boxSelectArmed = false;
    }

    if (
      !suppressClick &&
      clickedNodeId &&
      draggedNodeIds.length <= 1 &&
      event &&
      event.button === 0
    ) {
      this.clickFlashNodeId = clickedNodeId;
      this.clickFlashUntilMs = Date.now() + 180;
      if (this.nodeById.get(clickedNodeId)?.meta?.subgraph) {
        if (event.detail >= 2) this.openSubgraphSeparately(clickedNodeId);
        else this.toggleNodeSelection(clickedNodeId);
      } else this.openNodeFile(clickedNodeId);
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
    this.scheduleTouchLongPress(
      node?.id ?? null,
      event.touches[0].clientX,
      event.touches[0].clientY
    );
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
        this.markNodeSpatialIndexDirty();
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
      nodeId: null,
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
    this.openContextMenuAt(clientX, clientY);
  }

  // Node context menu: standard Obsidian actions plus GraphFrontier actions.
  onContextMenu(event) {
    event.preventDefault();
    this.openContextMenuAt(event.clientX, event.clientY, event);
  }

  openContextMenuAt(clientX, clientY, event = null) {
    if (!this.canvasEl) return;
    const rect = this.canvasEl.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    this.lastCursorScreen = { x: screenX, y: screenY };

    const node = this.getNodeAtScreen(screenX, screenY);
    if (!node) {
      const menu = new Menu(this.app);
      const position = this.screenToWorld(screenX, screenY);
      const sourceData = this.plugin?.data;
      const snapshot = this.selectedNodeIds?.size ? this.captureNodeActionTargets() : null;
      if (snapshot?.ids.length) this.addSelectionActionsToMenu(menu, snapshot, clientX, clientY);
      if (snapshot?.ids.length)
        menu.addItem((item) =>
          item
            .setTitle(this.nodeActionLabel('Combine selected into subgraph', snapshot))
            .setIcon('circle')
            .onClick(() => this.editSubgraph(null, snapshot))
        );
      menu.addItem((item) =>
        item
          .setTitle('Create gravity node')
          .setIcon('orbit')
          .onClick(() => {
            if (this.plugin?.data !== sourceData) return;
            if (snapshot && !this.isNodeActionSnapshotCurrent(snapshot)) return;
            this.editDarkEnergy(null, position);
          })
      );
      this.showMenuAtPointer(menu, clientX, clientY, event);
      return;
    }
    this.showNodeContextMenu(node, clientX, clientY, event);
  }

  editSubgraph(node = null, snapshot = null) {
    if (snapshot && !this.isNodeActionSnapshotCurrent(snapshot)) return;
    const source = this.plugin.data;
    const selected = snapshot
      ? this.resolveNodeActionTargets(snapshot).map((entry) => entry.id)
      : [...this.selectedNodeIds].filter((id) => this.nodeById.has(id));
    if (!node && !selected.length) {
      new Notice('Select nodes to combine');
      return;
    }
    const points = selected.map((id) => this.nodeById.get(id));
    const initial = node?.meta?.subgraph || {
      id: `${SUBGRAPH_PREFIX}${this.plugin.createGroupId()}`,
      name: 'Subgraph',
      members: selected,
      x: points.reduce((sum, item) => sum + item.x, 0) / points.length,
      y: points.reduce((sum, item) => sum + item.y, 0) / points.length,
    };
    const modal = new SubgraphModal(this, initial, (item) => {
      if (source !== this.plugin.data)
        throw new Error('Layout changed. Reopen the subgraph editor.');
      this.setSubgraph(item);
    });
    modal.open();
    return modal;
  }

  captureGraphPositions(target) {
    const views = this.getScopeLeaves().map((leaf) => leaf.view);
    if (!views.includes(this)) views.push(this);
    // IDs have exactly one parent space. Merge open spaces; retain all closed/filtered ones.
    for (const view of [...views.filter((view) => view !== this), this]) {
      if (view !== this && !view.isOpen) continue;
      if (
        (view.graphDataRef && view.graphDataRef !== this.plugin.data) ||
        (view.subgraphScope && !view.hasValidSubgraphScope())
      )
        continue;
      for (const node of view.nodes) target.saved_positions[node.id] = { x: node.x, y: node.y };
    }
  }

  setSubgraph(item) {
    const data = this.plugin.data;
    const previous = data.subgraphs.find((group) => group.id === item.id);
    if (!item.id?.startsWith(SUBGRAPH_PREFIX) || !String(item.name || '').trim())
      throw new Error('Enter a valid subgraph name and ID');
    const members = [...new Set(item.members || [])];
    const parents = hierarchy(data.subgraphs);
    const parent = previous ? parents.get(item.id) : this.subgraphScope?.id;
    if (this.subgraphScope && !this.hasValidSubgraphScope())
      throw new Error('This subgraph is no longer available');
    if (previous) {
      if (JSON.stringify(members) !== JSON.stringify(previous.members))
        throw new Error('Membership is fixed; use Ungroup and create a new subgraph');
      if (!this.nodeById.has(item.id) && this.subgraphScope?.id !== item.id)
        throw new Error('Open the parent graph to edit this subgraph');
      this.captureGraphPositions(data);
      data.subgraphs = data.subgraphs.map((group) =>
        group.id === item.id ? { ...group, name: item.name.trim() } : group
      );
      this.subgraphsChanged(new Set([parent || null]));
      return data.subgraphs.find((group) => group.id === item.id);
    }
    if (!members.length) throw new Error('Select nodes to combine');
    for (const id of members) {
      if (
        id === item.id ||
        !this.nodeById.has(id) ||
        (parents.get(id) || null) !== (parent || null)
      )
        throw new Error('Select existing nodes from this graph');
    }
    this.captureGraphPositions(data);
    const points = members.map((id) => data.saved_positions[id]);
    const center = {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
    const group = { id: item.id, name: item.name.trim(), members, ...center };
    translateMembers(data, members, -center.x, -center.y);
    data.saved_positions[item.id] = { ...center };
    data.subgraphs = normalizeSubgraphs([
      ...data.subgraphs.map((entry) =>
        entry.id === parent
          ? { ...entry, members: [...entry.members.filter((id) => !members.includes(id)), item.id] }
          : entry
      ),
      group,
    ]);
    reconcileOrbitSpaces(data);
    this.subgraphsChanged(new Set([parent || null, item.id]));
    return data.subgraphs.find((entry) => entry.id === item.id);
  }

  subgraphsChanged(affectedScopes) {
    const views = this.getScopeLeaves().map((leaf) => leaf.view);
    if (!views.includes(this)) views.push(this);
    for (const view of views) {
      const affected = affectedScopes.has(view.subgraphScope?.id || null);
      view.refreshFromVault({
        keepCamera: true,
        forceSavedPositions: affected,
        passive: !affected,
      });
      if (view.subgraphScope && !view.hasValidSubgraphScope()) {
        view.layoutPaused = true;
        view.layoutAutosaveDirty = false;
      } else if (affected) {
        // Mutation refreshes must wake immediately; only explicit restoration may pause.
        view.kickLayoutSearch();
      }
    }
  }

  ungroupSubgraph(id) {
    const data = this.plugin.data;
    const group = data.subgraphs.find((item) => item.id === id);
    if (!group) throw new Error('Subgraph not found');
    const parent = hierarchy(data.subgraphs).get(id);
    this.captureGraphPositions(data);
    const center = this.nodeById.get(id) || data.saved_positions[id] || data.pins[id] || group;
    for (const member of group.members) {
      if (!data.saved_positions[member]) {
        const nested = data.subgraphs.find((item) => item.id === member);
        data.saved_positions[member] = nested ? { x: nested.x, y: nested.y } : { x: 0, y: 0 };
      }
    }
    translateMembers(data, group.members, center.x, center.y);
    data.subgraphs = data.subgraphs
      .filter((item) => item.id !== id)
      .map((item) => ({
        ...item,
        members: item.members.flatMap((member) => (member === id ? group.members : [member])),
      }));
    reconcileOrbitSpaces(data, id);
    for (const key of [
      'pins',
      'orbit_pins',
      'saved_positions',
      'saved_layout_pins',
      'saved_layout_orbit_pins',
      'node_force_multipliers',
      'strong_pull_nodes',
      'painted_edge_colors',
      'node_label_sizes',
      'node_visual_settings',
      'subgraph_cameras',
      'subgraph_filters',
    ])
      delete data[key]?.[id];
    this.subgraphsChanged(new Set([parent || null, id]));
  }

  async openSubgraphSeparately(id) {
    if (!this.plugin.data.subgraphs.some((item) => item.id === id))
      throw new Error('Subgraph not found');
    const workspace = this.app.workspace;
    const layout = this.plugin.getActiveLayoutFileName();
    const existing = workspace
      .getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE)
      .find(
        (leaf) => leaf.view?.subgraphScope?.id === id && leaf.view.subgraphScope.layout === layout
      );
    if (existing) {
      await workspace.revealLeaf(existing);
      return existing.view;
    }
    const leaf = workspace.getLeaf('split');
    this.plugin.pendingSubgraphScopes ||= new WeakMap();
    this.plugin.pendingSubgraphScopes.set(leaf, { id, layout });
    try {
      await leaf.setViewState({
        type: GRAPHFRONTIER_VIEW_TYPE,
        state: { subgraph: { id, layout } },
        active: true,
      });
    } finally {
      this.plugin.pendingSubgraphScopes.delete(leaf);
    }
    await workspace.revealLeaf(leaf);
    return leaf.view;
  }

  editDarkEnergy(node = null, position = { x: 0, y: 0 }) {
    const sourceData = this.plugin.data;
    const initial = node?.meta?.darkEnergy || {
      id: `${PREFIX}${this.plugin.createGroupId()}`,
      name: 'Gravity node',
      queries: ['name:'],
      strength: 10,
      ...position,
    };
    new DarkEnergyModal(this, initial, (item) => {
      if (this.plugin.data !== sourceData) {
        new Notice('Layout changed. Reopen the gravity node editor.');
        return;
      }
      this.setDarkEnergy(item);
    }).open();
  }

  setDarkEnergy(item) {
    const existing = this.plugin.data.dark_energy.some((entry) => entry.id === item.id);
    if (!existing && this.hasValidSubgraphScope()) {
      this.plugin.data.subgraphs = this.plugin.data.subgraphs.map((group) =>
        group.id === this.subgraphScope.id
          ? { ...group, members: [...group.members, item.id] }
          : group
      );
      this.plugin.data.saved_positions[item.id] = { x: item.x, y: item.y };
    }
    const items = (this.plugin.data.dark_energy || []).filter((entry) => entry.id !== item.id);
    this.plugin.data.dark_energy = normalizeDarkEnergy([...items, item], (query) =>
      this.plugin.parseGroupQuery(query)
    );
    this.plugin.schedulePersist();
    this.plugin.refreshAllViews({ passive: true });
    this.kickLayoutSearch();
  }

  removeDarkEnergy(node) {
    const data = this.plugin.data;
    data.subgraphs = data.subgraphs.map((group) => ({
      ...group,
      members: group.members.filter((id) => id !== node.id),
    }));
    data.dark_energy = (data.dark_energy || []).filter((item) => item.id !== node.id);
    for (const key of [
      'pins',
      'orbit_pins',
      'saved_positions',
      'saved_layout_pins',
      'saved_layout_orbit_pins',
      'node_force_multipliers',
      'strong_pull_nodes',
      'painted_edge_colors',
      'node_label_sizes',
      'node_visual_settings',
    ]) {
      delete data[key]?.[node.id];
    }
    for (const key of ['orbit_pins', 'saved_layout_orbit_pins']) {
      for (const [id, pin] of Object.entries(data[key])) {
        if (pin.anchor_id === node.id) delete data[key][id];
      }
    }
    this.plugin.schedulePersist();
    this.plugin.refreshAllViews({ passive: true });
    this.kickLayoutSearch();
  }

  showNodeContextMenu(node, clientX, clientY, sourceMouseEvent = null) {
    const menu = buildNodeContextMenu(this, node, clientX, clientY);
    this.showMenuAtPointer(menu, clientX, clientY, sourceMouseEvent);
  }

  addVisualSettingsToMenu(
    menu,
    node,
    clientX,
    clientY,
    snapshot = this.captureNodeActionTargets(node),
    options = {}
  ) {
    const displayNodes = snapshot.ids.map((id) => this.nodeById.get(id)).filter(Boolean);
    if (!displayNodes.length && node) displayNodes.push(node);
    const syncControls = [];
    for (const spec of options.advancedOnly ? [] : NODE_VISUAL_SETTINGS) {
      const eligible = (entry) => !spec.edges || !entry.meta?.darkEnergy;
      const nodes = displayNodes.filter(eligible);
      if (!nodes.length) continue;
      menu.addItem((item) => {
        item
          .setTitle(this.nodeActionLabel(spec.label, snapshot, nodes.length))
          .setIcon('sliders-horizontal');
        const controls = item.dom.createDiv({
          cls: 'graphfrontier-node-text-size graphfrontier-node-visual-control',
        });
        const input = controls.createEl('input', {
          type: spec.type === 'color' ? 'color' : 'range',
          cls:
            spec.type === 'color'
              ? 'graphfrontier-group-color-input'
              : 'graphfrontier-sidepanel-slider',
        });
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
        input.setAttribute('aria-label', `Node ${spec.label.toLowerCase()}`);
        const value =
          spec.type === 'color'
            ? null
            : controls.createSpan({ cls: 'graphfrontier-sidepanel-value' });
        const sync = () => {
          const current = this.resolveNodeActionTargets(snapshot).filter(eligible);
          const values = (current.length ? current : nodes).map((entry) =>
            getNodeVisualSetting(this.plugin, entry.id, spec.key)
          );
          const mixed = values.some((entry) => entry !== values[0]);
          const inherited = (current.length ? current : nodes).every(
            (entry) => getNodeVisualOverride(this.plugin, entry.id, spec.key) === null
          );
          input.value = String(values[0]);
          value?.setText(mixed ? 'Mixed' : this.formatSliderValue(Number(input.value), spec.step));
          input.setAttribute('aria-valuetext', mixed ? 'Mixed' : String(values[0]));
          input.setAttribute(
            'title',
            mixed ? 'Mixed values' : inherited ? 'Global value' : 'Individual value'
          );
          item.setTitle(
            this.nodeActionLabel(spec.label, snapshot, nodes.length) + (mixed ? ' (Mixed)' : '')
          );
        };
        syncControls.push(sync);
        sync();
        for (const eventName of ['click', 'mousedown', 'keydown']) {
          controls.addEventListener(eventName, (event) => event.stopPropagation());
        }
        input.addEventListener('input', () => {
          for (const entry of this.resolveNodeActionTargets(snapshot).filter(eligible)) {
            this.plugin.setNodeVisualSetting(
              entry.id,
              spec.key,
              spec.type === 'color' ? input.value : Number(input.value)
            );
          }
          syncControls.forEach((sync) => sync());
        });
      });
    }

    if (!options.advancedOnly) {
      menu.addItem((item) => {
        item.setIcon('rotate-ccw').onClick(() => {
          for (const entry of this.getNodeVisualResetTargets(snapshot))
            this.plugin.resetNodeVisualSettings(entry.id);
          syncControls.forEach((sync) => sync());
        });
        const syncReset = () => {
          const count = this.getNodeVisualResetTargets(snapshot).length;
          item.setTitle(this.nodeActionLabel('Reset visual settings', snapshot, count));
          item.setDisabled(count === 0);
        };
        syncControls.push(syncReset);
        syncReset();
      });
    }
    if (options.basicOnly || !node || node.meta?.darkEnergy) return;

    const isStrongPullNode = this.plugin.isStrongPullNode(node.id);
    if (!isStrongPullNode) {
      menu.addItem((item) =>
        item
          .setTitle('Strong pull')
          .setIcon('zap')
          .onClick(async () => {
            if (!this.resolveNodeActionTargets(snapshot).some((entry) => entry.id === node.id))
              return;
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
            if (!this.resolveNodeActionTargets(snapshot).some((entry) => entry.id === node.id))
              return;
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
          if (!this.resolveNodeActionTargets(snapshot).some((entry) => entry.id === node.id))
            return;
          await this.promptPickPaintedEdgeColor(node.id, clientX, clientY);
        })
    );
    if (this.plugin.getPaintedEdgeColor(node.id)) {
      menu.addItem((item) =>
        item
          .setTitle('Clear painted edges')
          .setIcon('x')
          .onClick(async () => {
            if (!this.resolveNodeActionTargets(snapshot).some((entry) => entry.id === node.id))
              return;
            this.plugin.clearPaintedEdgeColor(node.id);
            this.plugin.renderAllViews();
            new Notice(`Painted edges cleared: ${node.id}`);
          })
      );
    }
  }

  addContextSubmenuItem(menu, options) {
    menu.addItem((item) => item.setTitle(options.title).setIcon(options.icon || 'chevron-right'));
    const menuItem = menu.items[menu.items.length - 1];
    if (menuItem && typeof menuItem.setSubmenu === 'function') {
      const submenu = menuItem.setSubmenu();
      options.fillSubmenu(submenu);
      return;
    }
    if (!menuItem) return;
    menuItem.onClick(() => {
      const submenu = new Menu(this.app);
      options.fillSubmenu(submenu);
      this.contentEl.win.setTimeout(() => {
        this.showMenuAtPointer(submenu, options.clientX, options.clientY, null);
      }, 0);
    });
  }

  addLinkedNodesActionsToMenu(menu, nodeId) {
    menu.addItem((item) =>
      item
        .setTitle('Pin linked nodes')
        .setIcon('pin')
        .onClick(async () => {
          await this.pinLinkedNodes(nodeId);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle('Pin linked nodes to grid')
        .setIcon('pin')
        .onClick(async () => {
          await this.pinLinkedNodesToGrid(nodeId);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle('Pin linked nodes to orbit')
        .setIcon('orbit')
        .onClick(async () => {
          await this.pinLinkedNodesToOrbit(nodeId);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle('Unpin linked nodes')
        .setIcon('pin-off')
        .onClick(async () => {
          await this.unpinLinkedNodes(nodeId);
        })
    );
  }

  addAttachmentNodesActionsToMenu(menu, nodeId) {
    menu.addItem((item) =>
      item
        .setTitle('Pin attachments')
        .setIcon('pin')
        .onClick(async () => {
          await this.pinLinkedNodes(nodeId, {
            targetKind: 'attachment',
            targetLabel: 'attachments',
          });
        })
    );
    menu.addItem((item) =>
      item
        .setTitle('Pin attachments to grid')
        .setIcon('pin')
        .onClick(async () => {
          await this.pinLinkedNodesToGrid(nodeId, {
            targetKind: 'attachment',
            targetLabel: 'attachments',
          });
        })
    );
    menu.addItem((item) =>
      item
        .setTitle('Pin attachments to orbit')
        .setIcon('orbit')
        .onClick(async () => {
          await this.pinLinkedNodesToOrbit(nodeId, {
            targetKind: 'attachment',
            targetLabel: 'attachments',
          });
        })
    );
    menu.addItem((item) =>
      item
        .setTitle('Unpin attachments')
        .setIcon('pin-off')
        .onClick(async () => {
          await this.unpinLinkedNodes(nodeId, {
            targetKind: 'attachment',
            targetLabel: 'attachments',
          });
        })
    );
  }

  showMenuAtPointer(menu, clientX, clientY, sourceMouseEvent = null) {
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
    const snapshot = this.captureCommandNodeActionTargets();
    if (!snapshot.ids.length) return;
    const count = this.applyNodePinAction(snapshot, 'exact');
    new Notice(`Pinned: ${count} nodes`);
  }

  async commandToggleSelectionUnderCursor() {
    const node = this.getCommandTargetNodeOrNotice();
    if (!node) return;
    this.toggleNodeSelection(node.id);
  }

  async commandArmBoxSelection() {
    this.boxSelectArmed = !this.boxSelectArmed;
    new Notice(this.boxSelectArmed ? 'Box selection armed' : 'Box selection disarmed');
  }

  async commandClearSelection() {
    if (this.selectedNodeIds.size <= 0) {
      new Notice('Selection is empty');
      return;
    }
    this.clearNodeSelection();
    new Notice('Selection cleared');
  }

  async commandExportStaticHtml(options = {}, { throwOnError = false, exactPath = false } = {}) {
    if (!String(options.exportPath || '').trim()) {
      new ExportModal(this.app, (destination) =>
        this.commandExportStaticHtml(
          {
            ...options,
            ...destination,
            assertCurrent: () => {
              options.assertCurrent?.();
              destination.assertCurrent();
            },
          },
          { throwOnError: true, exactPath: true }
        )
      ).open();
      return;
    }
    // UI errors stay in the modal; explicit-path API callers retain Notice/undefined failures.
    const reportFailure = (message) => {
      if (throwOnError) throw new Error(message);
      new Notice(message);
    };
    const exportPath = String(options.exportPath || '').trim() || 'graphfrontier-static.html';
    if (!this.canvasEl || !this.ctx) {
      reportFailure('Graph canvas is not ready');
      return;
    }

    let normalizedExportPath;
    try {
      normalizedExportPath = resolveVaultExportPath(this.app.vault, exportPath);
      if (exactPath && normalizedExportPath !== exportPath) {
        throw new Error('The export destination changed. Choose another filename.');
      }
    } catch (error) {
      reportFailure(error.message);
      return;
    }

    const visibleNodeIds = this.getFilterVisibleNodeIds();
    const hasFilter = visibleNodeIds instanceof Set;
    const explicitIds = Array.isArray(options.nodeIds) ? new Set(options.nodeIds) : null;
    const sourceNodes = this.nodes.filter((node) =>
      explicitIds ? explicitIds.has(node.id) : !hasFilter || visibleNodeIds.has(node.id)
    );
    const sourceNodeIdSet = new Set(sourceNodes.map((node) => node.id));
    const sourceEdges = this.edges.filter(
      (edge) => sourceNodeIdSet.has(edge.source) && sourceNodeIdSet.has(edge.target)
    );

    const maxPreviewLines = 220;
    const maxPreviewChars = 12000;
    const normalizePreviewText = (text) => {
      const rawText = String(text || '');
      if (!rawText) return '';
      const lines = rawText.split(/\r?\n/);
      let preview = lines.slice(0, maxPreviewLines).join('\n');
      if (preview.length > maxPreviewChars) preview = preview.slice(0, maxPreviewChars);
      if (lines.length > maxPreviewLines || rawText.length > maxPreviewChars) preview += '\n\n...';
      return preview;
    };
    const exportedNodes = await Promise.all(
      sourceNodes.map(async (node) => {
        const meta = this.nodeMetaById.get(node.id) || node.meta || null;
        const isAttachment = !!meta?.isAttachment;
        const fileType =
          String(meta?.fileType || '').trim() || (isAttachment ? 'attachment' : 'md');
        const nodePath = String(meta?.path || node.id || '');
        const fileName =
          String(meta?.fileName || '').trim() || String(node.label || '').trim() || nodePath;

        const properties = {};
        if (meta?.properties instanceof Map) {
          for (const [propertyKey, values] of meta.properties.entries()) {
            if (!propertyKey) continue;
            properties[propertyKey] = Array.isArray(values)
              ? values.map((value) => String(value || ''))
              : [];
          }
        }

        let contentPreview = '';
        if (!isAttachment && options.includeContents !== false) {
          const abstractFile = this.app.vault.getAbstractFileByPath(node.id);
          const isMarkdownFile =
            !!abstractFile &&
            typeof abstractFile.extension === 'string' &&
            abstractFile.extension.toLowerCase() === 'md';
          if (isMarkdownFile) {
            try {
              const rawText = await this.app.vault.cachedRead(abstractFile);
              contentPreview = normalizePreviewText(rawText);
            } catch {
              contentPreview = '';
            }
          }
        }

        const groupColor = this.getGroupColorForNode(node);
        const fillColor = getNodeColor(this.plugin, node, groupColor);

        return {
          id: node.id,
          label: String(getNodeLabelText({ ...node, meta }) || ''),
          labelMinimumSize: getLabelMinimumSizeRender(this, node.id),
          labelMinZoom: getLabelZoomThresholdRender(this, node.id),
          dimAlpha:
            getNodeVisualOverride(this.plugin, node.id, 'hover_dim_strength') === null
              ? null
              : getHoverDimAlpha(this.plugin, 1, node.id),
          labelFontSize:
            this.plugin.getNodeLabelSize(node.id) === null
              ? null
              : this.plugin.getNodeLabelSize(node.id) / 5,
          x: Number(node.x) || 0,
          y: Number(node.y) || 0,
          degree: Number(node.degree) || 0,
          radius: Number(this.getNodeRadius(node)) || 1,
          color: fillColor,
          auraRadius: getNodeVisualSetting(this.plugin, node.id, 'aura_radius') / 10,
          auraBrightness: getNodeVisualSetting(this.plugin, node.id, 'aura_brightness'),
          isAttachment,
          isSubgraph: !!meta?.subgraph,
          fileType,
          path: nodePath,
          fileName,
          tags: Array.isArray(meta?.tags) ? meta.tags.map((tag) => String(tag || '')) : [],
          sections: Array.isArray(meta?.sections)
            ? meta.sections.map((section) => String(section || ''))
            : [],
          lines: Array.isArray(meta?.lines) ? meta.lines.map((line) => String(line || '')) : [],
          properties,
          contentPreview,
        };
      })
    );

    const exportedEdges = sourceEdges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      width: getEdgeVisualSetting(this.plugin, edge.source, edge.target, 'edge_width_scale'),
      paintedWidth: getEdgeVisualSetting(
        this.plugin,
        edge.source,
        edge.target,
        'painted_edge_width'
      ),
      paintedColor:
        this.plugin.getPaintedEdgeColor(edge.source) ||
        this.plugin.getPaintedEdgeColor(edge.target) ||
        null,
    }));

    const width = Math.max(1, Math.floor(this.viewWidth || this.canvasEl.clientWidth || 1));
    const height = Math.max(1, Math.floor(this.viewHeight || this.canvasEl.clientHeight || 1));
    this.updateCanvasBackgroundColor();
    const theme = this.canvasTheme;
    const bgColor = theme.background;
    const textColor = theme.text;
    const mutedTextColor = theme.mutedText;
    const exportedAt = new Date().toISOString();
    const payload = {
      exportPath: normalizedExportPath,
      exportedAt,
      camera: {
        x: Number(this.camera.x) || 0,
        y: Number(this.camera.y) || 0,
        zoom: Number(this.camera.zoom) || 1,
      },
      canvas: { width, height },
      theme: { ...theme },
      settings: {
        showGrid: !!this.plugin.getSettings().show_grid,
        gridStep: this.plugin.clampGridStep(this.plugin.getSettings().grid_step),
        gridLineWidth: this.plugin.clampGridLineWidth(this.plugin.getSettings().grid_line_width),
        edgeWidth: this.plugin.clampNumber(
          this.plugin.getSettings().edge_width_scale,
          0.01,
          1,
          DEFAULT_DATA.settings.edge_width_scale
        ),
        paintedEdgeWidth: this.plugin.clampNumber(
          this.plugin.getSettings().painted_edge_width,
          0.01,
          1,
          DEFAULT_DATA.settings.painted_edge_width
        ),
        labelMinZoom: this.getLabelZoomThreshold(),
        labelFontSize: this.getLabelFontSize(),
        zoomStepFactor: ZOOM_STEP_FACTOR,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
      },
      nodes: exportedNodes,
      edges: exportedEdges,
    };
    const payloadJson = JSON.stringify(payload)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GraphFrontier Static Interactive Export</title>
  <style>
    :root {
      color-scheme: ${theme.colorScheme};
    }
    html {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    body {
      margin: 0;
      width: 100%;
      height: 100%;
      min-height: 100vh;
      background: ${bgColor};
      color: ${textColor};
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif;
      overflow: hidden;
    }
    .app {
      position: fixed;
      inset: 0;
      display: grid;
      grid-template-columns: 1fr 430px;
      overflow: hidden;
      min-height: 0;
    }
    .graph-wrap {
      position: relative;
      overflow: hidden;
      min-height: 0;
    }
    #graph {
      display: block;
      width: 100%;
      height: 100%;
      background: ${bgColor};
      cursor: grab;
    }
    #graph.is-dragging {
      cursor: grabbing;
    }
    .hud {
      position: absolute;
      top: 10px;
      left: 10px;
      background: ${theme.surface};
      border: 1px solid ${theme.border};
      border-radius: 8px;
      padding: 6px 8px;
      color: ${mutedTextColor};
      backdrop-filter: blur(2px);
      pointer-events: none;
    }
    .panel {
      background: ${theme.surface};
      border-left: 1px solid ${theme.border};
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .panel-header {
      padding: 12px;
      border-bottom: 1px solid ${theme.border};
    }
    .panel-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 4px;
      word-break: break-word;
    }
    .panel-meta {
      color: ${mutedTextColor};
      word-break: break-word;
    }
    .panel-body {
      padding: 12px;
      min-height: 0;
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      overflow: hidden;
      gap: 10px;
    }
    .hint {
      color: ${mutedTextColor};
    }
    .content-html {
      padding: 10px 0 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      flex: 1 1 0;
      height: 100%;
      overflow: auto;
      min-height: 0;
      line-height: 1.45;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .content-html :is(h1, h2, h3, h4, h5, h6) {
      margin: 0.2em 0 0.45em;
    }
    .content-html p {
      margin: 0.35em 0;
    }
    .content-html pre {
      margin: 0.4em 0;
      padding: 8px;
      border-radius: 6px;
      background: ${bgColor};
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      white-space: pre-wrap;
      word-break: break-word;
    }
    @media (max-width: 1000px) {
      .app {
        grid-template-columns: 1fr;
      }
      .panel {
        position: absolute;
        right: 8px;
        top: 8px;
        bottom: 8px;
        width: min(94vw, 430px);
        border-radius: 10px;
        border: 1px solid ${theme.border};
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <section class="graph-wrap">
      <canvas id="graph"></canvas>
      <div class="hud" id="hud"></div>
    </section>
    <aside class="panel">
      <header class="panel-header">
        <div class="panel-title" id="panel-title">No node selected</div>
        <div class="panel-meta" id="panel-meta">Click a node to see file content preview</div>
      </header>
      <div class="panel-body">
        <div class="hint">Drag to pan, wheel to zoom, hover for labels.</div>
        <div class="content-html" id="panel-content-html">Select a node…</div>
      </div>
    </aside>
  </div>
  <script>
    const EXPORT_DATA = ${payloadJson};
    (() => {
      const getLabelAppearance = ${getLabelAppearance.toString()};
      const canvas = document.getElementById('graph');
      const hud = document.getElementById('hud');
      const panelTitle = document.getElementById('panel-title');
      const panelMeta = document.getElementById('panel-meta');
      const panelContentHtml = document.getElementById('panel-content-html');
      const ctx = canvas.getContext('2d');
      const nodeById = new Map(EXPORT_DATA.nodes.map((node) => [node.id, node]));
      const neighborsById = new Map(EXPORT_DATA.nodes.map((node) => [node.id, new Set()]));
      for (const edge of EXPORT_DATA.edges) {
        neighborsById.get(edge.source)?.add(edge.target);
        neighborsById.get(edge.target)?.add(edge.source);
      }

      const camera = {
        x: Number(EXPORT_DATA.camera?.x) || 0,
        y: Number(EXPORT_DATA.camera?.y) || 0,
        zoom: Number(EXPORT_DATA.camera?.zoom) || 1,
      };
      const edgeWidth = Number(EXPORT_DATA.settings?.edgeWidth) || 0.34;
      const paintedEdgeWidth = Number(EXPORT_DATA.settings?.paintedEdgeWidth) || 0.2;
      const labelMinZoom = Number(EXPORT_DATA.settings?.labelMinZoom) || 0.4;
      const labelFontSize = Number(EXPORT_DATA.settings?.labelFontSize) || 1.8;
      const showGrid = !!EXPORT_DATA.settings?.showGrid;
      const gridStep = Number(EXPORT_DATA.settings?.gridStep) || 20;
      const rawGridLineWidth = Number(EXPORT_DATA.settings?.gridLineWidth);
      const gridLineWidth = Number.isFinite(rawGridLineWidth)
        ? Math.max(0.1, Math.min(1, rawGridLineWidth))
        : 1;
      const minZoom = Number(EXPORT_DATA.settings?.minZoom) || 0.1;
      const maxZoom = Number(EXPORT_DATA.settings?.maxZoom) || 12;
      const zoomStepFactor = Number(EXPORT_DATA.settings?.zoomStepFactor) || 1.12;

      let dpr = 1;
      let viewWidth = 1;
      let viewHeight = 1;
      let hoveredNodeId = null;
      let selectedNodeId = null;
      let panDrag = null;

      const worldToScreen = (x, y) => ({
        x: (x - camera.x) * camera.zoom + viewWidth / 2,
        y: (y - camera.y) * camera.zoom + viewHeight / 2,
      });
      const screenToWorld = (x, y) => ({
        x: (x - viewWidth / 2) / camera.zoom + camera.x,
        y: (y - viewHeight / 2) / camera.zoom + camera.y,
      });
      const clampZoom = (value) => Math.min(maxZoom, Math.max(minZoom, value));

      function getCanvasPoint(event) {
        const rect = canvas.getBoundingClientRect();
        return {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
          inside:
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        };
      }

      function getNodeAtScreen(screenX, screenY) {
        const world = screenToWorld(screenX, screenY);
        let bestNode = null;
        let bestDist2 = Infinity;
        for (const node of EXPORT_DATA.nodes) {
          const dx = node.x - world.x;
          const dy = node.y - world.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestDist2) {
            bestDist2 = d2;
            bestNode = node;
          }
        }
        if (!bestNode) return null;
        const maxDist = Math.max(1, Number(bestNode.radius || 1) + (bestNode.isSubgraph ? 4.2 : 2) / Math.max(camera.zoom, 0.0001));
        if (bestDist2 > maxDist * maxDist) return null;
        return bestNode;
      }

      function drawGrid() {
        if (!showGrid) return;
        const scaledStep = gridStep * camera.zoom;
        if (scaledStep < 8) return;
        const leftWorld = screenToWorld(0, 0).x;
        const rightWorld = screenToWorld(viewWidth, 0).x;
        const topWorld = screenToWorld(0, 0).y;
        const bottomWorld = screenToWorld(0, viewHeight).y;
        const startX = Math.floor(leftWorld / gridStep) * gridStep;
        const endX = Math.ceil(rightWorld / gridStep) * gridStep;
        const startY = Math.floor(topWorld / gridStep) * gridStep;
        const endY = Math.ceil(bottomWorld / gridStep) * gridStep;

        ctx.save();
        ctx.globalAlpha = EXPORT_DATA.theme.gridOpacity;
        ctx.strokeStyle = EXPORT_DATA.theme.grid;
        ctx.lineWidth = gridLineWidth;
        // Chromium can drop subpixel lines when a crossed grid shares one path.
        const strokeSeparately = gridLineWidth < 1;
        if (!strokeSeparately) ctx.beginPath();
        for (let x = startX; x <= endX; x += gridStep) {
          if (strokeSeparately) ctx.beginPath();
          const sx = Math.round(worldToScreen(x, 0).x) + 0.5;
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, viewHeight);
          if (strokeSeparately) ctx.stroke();
        }
        for (let y = startY; y <= endY; y += gridStep) {
          if (strokeSeparately) ctx.beginPath();
          const sy = Math.round(worldToScreen(0, y).y) + 0.5;
          ctx.moveTo(0, sy);
          ctx.lineTo(viewWidth, sy);
          if (strokeSeparately) ctx.stroke();
        }
        if (!strokeSeparately) ctx.stroke();
        ctx.restore();
      }

      function drawEdges() {
        const selectedNeighbors = selectedNodeId ? neighborsById.get(selectedNodeId) || new Set() : null;
        for (const edge of EXPORT_DATA.edges) {
          const sourceNode = nodeById.get(edge.source);
          const targetNode = nodeById.get(edge.target);
          if (!sourceNode || !targetNode) continue;
          const sourcePoint = worldToScreen(sourceNode.x, sourceNode.y);
          const targetPoint = worldToScreen(targetNode.x, targetNode.y);
          const isActive = !!selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId);

          ctx.save();
          ctx.globalAlpha = selectedNodeId ? (isActive ? 1 : 0.24) : 1;
          ctx.strokeStyle = edge.paintedColor || 'rgba(145,160,187,0.7)';
          ctx.lineWidth = edge.paintedColor ? (edge.paintedWidth ?? paintedEdgeWidth) : (edge.width ?? edgeWidth);
          ctx.beginPath();
          ctx.moveTo(sourcePoint.x, sourcePoint.y);
          ctx.lineTo(targetPoint.x, targetPoint.y);
          ctx.stroke();
          ctx.restore();
        }
      }

      function drawAuras() {
        for (const node of EXPORT_DATA.nodes) {
          const radius = Number(node.auraRadius || 0) * camera.zoom;
          const brightness = (node.auraBrightness ?? 22) / 100;
          if (!(radius > 0) || !(brightness > 0)) continue;
          const point = worldToScreen(node.x, node.y);
          if (point.x + radius < 0 || point.y + radius < 0 || point.x - radius > viewWidth || point.y - radius > viewHeight) continue;
          const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
          const alphaHex = (alpha) => Math.round(alpha * 255).toString(16).padStart(2, '0');
          gradient.addColorStop(0, node.color + alphaHex(brightness));
          gradient.addColorStop(0.4, node.color + alphaHex(brightness * (6 / 11)));
          gradient.addColorStop(1, node.color + '00');
          ctx.save();
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      function drawNodes() {
        const selectedNeighbors = selectedNodeId ? neighborsById.get(selectedNodeId) || new Set() : new Set();
        for (const node of EXPORT_DATA.nodes) {
          const point = worldToScreen(node.x, node.y);
          if (point.x < -80 || point.x > viewWidth + 80 || point.y < -80 || point.y > viewHeight + 80) continue;
          const radius = Math.max(0.6, Number(node.radius || 1) * camera.zoom);
          const isHovered = hoveredNodeId === node.id;
          const isSelected = selectedNodeId === node.id;
          const isNeighbor = selectedNodeId && selectedNeighbors.has(node.id);
          const alpha = selectedNodeId ? (isSelected || isNeighbor ? 1 : (node.dimAlpha ?? 0.32)) : 1;

          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = node.color || '#7aa2f7';
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius + (node.isSubgraph ? 2 : 0), 0, Math.PI * 2);
          if (node.isSubgraph) {
            ctx.strokeStyle = node.color || '#7aa2f7';
            ctx.lineWidth = 3;
            ctx.stroke();
          } else ctx.fill();
          ctx.restore();

          if (isHovered || isSelected) {
            ctx.save();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = EXPORT_DATA.theme.selection;
            ctx.lineWidth = isSelected ? 1.8 : 1.3;
            ctx.beginPath();
            ctx.arc(point.x, point.y, radius + (node.isSubgraph ? 4 : 2), 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }

          const label = getLabelAppearance(camera.zoom, node.labelMinZoom ?? labelMinZoom, node.labelFontSize ?? labelFontSize, alpha, isHovered || isSelected, node.labelMinimumSize ?? 10);
          if (label.alpha > 0) {
            ctx.save();
            ctx.globalAlpha = label.alpha;
            ctx.fillStyle = EXPORT_DATA.theme.text;
            ctx.font = label.fontSize + 'px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(String(node.label || ''), point.x, point.y - radius - 4);
            ctx.restore();
          }
        }
      }

      function escapeHtml(text) {
        return String(text || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function renderInlineMarkdown(text) {
        const safeText = escapeHtml(text);
        if (!safeText) return '';
        const tick = String.fromCharCode(96);
        const chunks = safeText.split(tick);
        if (chunks.length <= 1) return safeText;
        let html = '';
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          html += index % 2 === 1 ? '<code>' + chunk + '</code>' : chunk;
        }
        return html;
      }

      function startsWithOrderedListItem(text) {
        const dotIndex = text.indexOf('. ');
        if (dotIndex <= 0) return false;
        for (let index = 0; index < dotIndex; index += 1) {
          const code = text.charCodeAt(index);
          if (code < 48 || code > 57) return false;
        }
        return true;
      }

      function isHorizontalRule(text) {
        if (text.length < 3) return false;
        const firstChar = text.charAt(0);
        if (firstChar !== '-' && firstChar !== '*') return false;
        for (let index = 1; index < text.length; index += 1) {
          if (text.charAt(index) !== firstChar) return false;
        }
        return true;
      }

      function renderSimpleMarkdown(markdownText) {
        const text = String(markdownText || '').split(String.fromCharCode(13)).join('');
        if (!text.trim()) return '';
        const lines = text.split(String.fromCharCode(10));
        const codeFence = String.fromCharCode(96).repeat(3);
        const out = [];
        let inCode = false;
        let codeLang = '';
        let inUl = false;
        let inOl = false;
        let paragraph = [];

        const flushParagraph = () => {
          if (paragraph.length <= 0) return;
          out.push('<p>' + paragraph.map((line) => renderInlineMarkdown(line)).join('<br>') + '</p>');
          paragraph = [];
        };
        const closeLists = () => {
          if (inUl) {
            out.push('</ul>');
            inUl = false;
          }
          if (inOl) {
            out.push('</ol>');
            inOl = false;
          }
        };

        for (const rawLine of lines) {
          const line = String(rawLine || '');
          const trimmed = line.trim();

          if (trimmed.startsWith(codeFence)) {
            flushParagraph();
            closeLists();
            if (!inCode) {
              codeLang = trimmed.slice(3).trim();
              out.push('<pre><code' + (codeLang ? ' class="language-' + escapeHtml(codeLang) + '"' : '') + '>');
              inCode = true;
            } else {
              out.push('</code></pre>');
              inCode = false;
              codeLang = '';
            }
            continue;
          }
          if (inCode) {
            out.push(escapeHtml(line));
            continue;
          }

          if (!trimmed) {
            flushParagraph();
            closeLists();
            continue;
          }

          let headingLevel = 0;
          while (headingLevel < 6 && trimmed.charAt(headingLevel) === '#') headingLevel += 1;
          if (headingLevel > 0 && trimmed.charAt(headingLevel) === ' ') {
            flushParagraph();
            closeLists();
            const headingText = trimmed.slice(headingLevel + 1);
            out.push(
              '<h' +
                headingLevel +
                '>' +
                renderInlineMarkdown(headingText) +
                '</h' +
                headingLevel +
                '>'
            );
            continue;
          }

          if (trimmed.startsWith('>')) {
            flushParagraph();
            closeLists();
            const quoteText = trimmed.startsWith('> ') ? trimmed.slice(2) : trimmed.slice(1);
            out.push('<blockquote><p>' + renderInlineMarkdown(quoteText) + '</p></blockquote>');
            continue;
          }

          const isUnorderedList =
            trimmed.length > 2 &&
            (trimmed.charAt(0) === '-' || trimmed.charAt(0) === '*' || trimmed.charAt(0) === '+') &&
            trimmed.charAt(1) === ' ';
          if (isUnorderedList) {
            flushParagraph();
            if (inOl) {
              out.push('</ol>');
              inOl = false;
            }
            if (!inUl) {
              out.push('<ul>');
              inUl = true;
            }
            out.push('<li>' + renderInlineMarkdown(trimmed.slice(2)) + '</li>');
            continue;
          }

          if (startsWithOrderedListItem(trimmed)) {
            flushParagraph();
            if (inUl) {
              out.push('</ul>');
              inUl = false;
            }
            if (!inOl) {
              out.push('<ol>');
              inOl = true;
            }
            const itemText = trimmed.slice(trimmed.indexOf('. ') + 2);
            out.push('<li>' + renderInlineMarkdown(itemText) + '</li>');
            continue;
          }

          if (isHorizontalRule(trimmed)) {
            flushParagraph();
            closeLists();
            out.push('<hr>');
            continue;
          }

          closeLists();
          paragraph.push(line);
        }

        flushParagraph();
        closeLists();
        if (inCode) out.push('</code></pre>');
        return out.join('');
      }

      function updatePanel(nodeId) {
        if (!nodeId) {
          panelTitle.textContent = 'No node selected';
          panelMeta.textContent = 'Click a node to see file content preview';
          panelContentHtml.textContent = 'Select a node…';
          return;
        }
        const node = nodeById.get(nodeId);
        if (!node) return;
        panelTitle.textContent = node.label || node.fileName || node.path || node.id;
        const tagsText = node.tags && node.tags.length ? ' · #' + node.tags.join(' #') : '';
        panelMeta.textContent = (node.path || node.id) + ' · ' + (node.fileType || 'file') + tagsText;
        if (node.contentPreview) {
          const rendered = renderSimpleMarkdown(node.contentPreview);
          panelContentHtml.innerHTML = rendered || '<p>No readable content</p>';
        } else if (node.isAttachment) {
          panelContentHtml.innerHTML = '<p>Attachment node (no markdown content)</p>';
        } else {
          panelContentHtml.innerHTML = '<p>No readable content</p>';
        }
      }

      function draw() {
        ctx.clearRect(0, 0, viewWidth, viewHeight);
        ctx.fillStyle = EXPORT_DATA.theme.background || '#111418';
        ctx.fillRect(0, 0, viewWidth, viewHeight);
        drawGrid();
        drawAuras();
        drawEdges();
        drawNodes();
        const selectedText = selectedNodeId
          ? nodeById.get(selectedNodeId)?.label || selectedNodeId
          : 'none';
        hud.textContent =
          'GraphFrontier static export · ' +
          EXPORT_DATA.exportedAt +
          ' · nodes ' +
          EXPORT_DATA.nodes.length +
          ' · edges ' +
          EXPORT_DATA.edges.length +
          '\\nSelected: ' +
          selectedText +
          ' · zoom ' +
          camera.zoom.toFixed(2);
      }

      function resize() {
        const rect = canvas.getBoundingClientRect();
        dpr = window.devicePixelRatio || 1;
        viewWidth = Math.max(1, Math.floor(rect.width));
        viewHeight = Math.max(1, Math.floor(rect.height));
        canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
      }

      canvas.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        const point = getCanvasPoint(event);
        panDrag = {
          startClientX: event.clientX,
          startClientY: event.clientY,
          startCameraX: camera.x,
          startCameraY: camera.y,
          startZoom: camera.zoom,
          moved: 0,
          startedInside: point.inside,
        };
        canvas.classList.add('is-dragging');
      });

      window.addEventListener('mousemove', (event) => {
        const point = getCanvasPoint(event);
        if (!panDrag) {
          const nextHover = point.inside ? getNodeAtScreen(point.x, point.y)?.id || null : null;
          if (nextHover !== hoveredNodeId) {
            hoveredNodeId = nextHover;
            draw();
          }
          return;
        }
        const dx = event.clientX - panDrag.startClientX;
        const dy = event.clientY - panDrag.startClientY;
        panDrag.moved = Math.max(panDrag.moved, Math.sqrt(dx * dx + dy * dy));
        camera.x = panDrag.startCameraX - dx / panDrag.startZoom;
        camera.y = panDrag.startCameraY - dy / panDrag.startZoom;
        hoveredNodeId = point.inside ? getNodeAtScreen(point.x, point.y)?.id || null : null;
        draw();
      });

      window.addEventListener('mouseup', (event) => {
        if (!panDrag) return;
        const point = getCanvasPoint(event);
        const isClick = panDrag.moved <= 3;
        const startedInside = panDrag.startedInside;
        panDrag = null;
        canvas.classList.remove('is-dragging');
        if (isClick && startedInside && point.inside) {
          const clickedNode = getNodeAtScreen(point.x, point.y);
          selectedNodeId = clickedNode ? clickedNode.id : null;
          updatePanel(selectedNodeId);
        }
        draw();
      });

      canvas.addEventListener(
        'wheel',
        (event) => {
          event.preventDefault();
          const point = getCanvasPoint(event);
          if (!point.inside) return;
          const before = screenToWorld(point.x, point.y);
          const factor = event.deltaY < 0 ? zoomStepFactor : 1 / zoomStepFactor;
          camera.zoom = clampZoom(camera.zoom * factor);
          const after = screenToWorld(point.x, point.y);
          camera.x += before.x - after.x;
          camera.y += before.y - after.y;
          hoveredNodeId = getNodeAtScreen(point.x, point.y)?.id || null;
          draw();
        },
        { passive: false }
      );

      window.addEventListener('resize', resize);
      updatePanel(null);
      resize();
    })();
  </script>
</body>
</html>
`;

    options.assertCurrent?.();
    try {
      await writeVaultExport(this.app.vault, normalizedExportPath, html, options);
      if (!exactPath) {
        new Notice(
          `Static HTML saved in vault ${normalizedExportPath.includes('/') ? 'at' : 'root:'} ${normalizedExportPath} (${exportedNodes.length} nodes, ${exportedEdges.length} edges)`
        );
      }
      return {
        path: normalizedExportPath,
        nodeCount: exportedNodes.length,
        edgeCount: exportedEdges.length,
      };
    } catch (error) {
      reportFailure(`Failed to write static HTML export: ${error.message || 'Unknown error'}`);
    }
  }

  async commandPinToGrid() {
    const snapshot = this.captureCommandNodeActionTargets();
    if (!snapshot.ids.length) return;
    const count = this.applyNodePinAction(snapshot, 'grid');
    new Notice(`Pinned: ${count} nodes`);
  }

  async commandUnpinNode() {
    const snapshot = this.captureCommandNodeActionTargets();
    if (!snapshot.ids.length) return;
    const count = this.applyNodePinAction(snapshot, 'unpin');
    new Notice(`Unpinned: ${count} nodes`);
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
    this.markNodeSpatialIndexDirty();
    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Pinned all nodes: ${pinnedCount}`);
  }

  async commandUnpinAllNodes() {
    const parents = hierarchy(this.plugin.data.subgraphs);
    const scope = this.subgraphScope?.id || null;
    let count = 0;
    for (const key of ['pins', 'orbit_pins'])
      for (const id of Object.keys(this.plugin.data[key])) {
        if ((parents.get(id) || null) !== scope) continue;
        delete this.plugin.data[key][id];
        count++;
      }
    if (!count) {
      new Notice('No pinned nodes');
      return;
    }
    this.plugin.schedulePersist();
    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Unpinned all nodes: ${count}`);
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
    this.markNodeSpatialIndexDirty();
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
    const snapshot = { ...this.captureNodeActionTargets(), ids: [nodeId] };
    const sourceData = this.plugin.data;
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

    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      colorInput.remove();
    };
    const applySelectedColor = () => {
      if (disposed) return;
      if (
        this.plugin.data !== sourceData ||
        !this.resolveNodeActionTargets(snapshot).some((entry) => entry.id === nodeId)
      ) {
        cleanup();
        return;
      }
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
      if (disposed) return;
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
    this.markNodeSpatialIndexDirty();
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
    this.markNodeSpatialIndexDirty();
    this.kickLayoutSearch();
  }

  async alignPinsToGrid() {
    const step = this.plugin.clampGridStep(this.plugin.getSettings().grid_step);
    const parents = hierarchy(this.plugin.data.subgraphs);
    const sortedPins = Object.entries(this.plugin.data.pins)
      .filter(([id]) => (parents.get(id) || null) === (this.subgraphScope?.id || null))
      .sort((entryA, entryB) => entryA[0].localeCompare(entryB[0]));

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

    this.markNodeSpatialIndexDirty();
    this.plugin.schedulePersist();
    new Notice(
      moved > 0
        ? `Aligned pinned nodes to grid: moved ${moved}`
        : `Pinned nodes already aligned (step ${step})`
    );
  }

  // Linked-node bulk actions: pin, unpin, and pin-to-grid for neighbor nodes.
  getLinkedTargetOptions(options = {}) {
    const targetKind = ['attachment', 'regular'].includes(options.targetKind)
      ? options.targetKind
      : 'all';
    const targetLabel =
      typeof options.targetLabel === 'string' && options.targetLabel.trim()
        ? options.targetLabel.trim()
        : targetKind === 'attachment'
          ? 'attachments'
          : 'linked nodes';
    const noPinsLabel =
      typeof options.noPinsLabel === 'string' && options.noPinsLabel.trim()
        ? options.noPinsLabel.trim()
        : targetKind === 'attachment'
          ? 'attachment pins'
          : 'linked pins';
    return { targetKind, targetLabel, noPinsLabel };
  }

  async pinLinkedNodes(nodeId, options = {}) {
    const { targetKind, targetLabel } = this.getLinkedTargetOptions(options);
    const linkedNodeIds = this.getLinkedNodeIdsByKind(nodeId, targetKind);
    if (linkedNodeIds.length === 0) {
      new Notice(`No ${targetLabel}`);
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
      new Notice(`No ${targetLabel}`);
      return;
    }

    this.markNodeSpatialIndexDirty();
    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Pinned ${targetLabel}: ${pinnedCount}`);
  }

  async pinLinkedNodesToGrid(nodeId, options = {}) {
    const { targetKind, targetLabel } = this.getLinkedTargetOptions(options);
    const linkedNodeIds = this.getLinkedNodeIdsByKind(nodeId, targetKind);
    if (linkedNodeIds.length === 0) {
      new Notice(`No ${targetLabel}`);
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
      new Notice(`No ${targetLabel}`);
      return;
    }

    this.markNodeSpatialIndexDirty();
    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Pinned ${targetLabel} to grid: ${pinnedCount}`);
  }

  async unpinLinkedNodes(nodeId, options = {}) {
    const { targetKind, targetLabel, noPinsLabel } = this.getLinkedTargetOptions(options);
    const linkedNodeIds = this.getLinkedNodeIdsByKind(nodeId, targetKind);
    if (linkedNodeIds.length === 0) {
      new Notice(`No ${targetLabel}`);
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
      new Notice(`No ${noPinsLabel}`);
      return;
    }

    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Unpinned ${targetLabel}: ${unpinnedCount}`);
  }

  // Manual orbit geometry for linked nodes and attachments.
  getOrbitRadiusBySpacing(orbitNodeCount, minRadius) {
    return getOrbitRadiusBySpacing(this.plugin, orbitNodeCount, minRadius);
  }

  getOrbitRadiusForAnchor(orbitNodeCount) {
    return getOrbitRadiusForAnchor(this.plugin, orbitNodeCount);
  }

  recomputeOrbitRadii() {
    return recomputeOrbitRadiiPhysics(this);
  }

  async pinLinkedNodesToOrbit(nodeId, options = {}) {
    const anchorNode = this.nodeById.get(nodeId);
    if (!anchorNode) return;

    const { targetKind, targetLabel } = this.getLinkedTargetOptions(options);
    const linkedNodeIds = this.getLinkedNodeIdsByKind(nodeId, targetKind);
    if (linkedNodeIds.length === 0) {
      new Notice(`No ${targetLabel}`);
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
      new Notice(`No ${targetLabel}`);
      return;
    }

    this.markNodeSpatialIndexDirty();
    this.kickLayoutSearch();
    this.plugin.renderAllViews();
    new Notice(`Orbit pinned ${targetLabel}: ${orbitPinnedCount}`);
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

  selectLinkedNodes(nodeId) {
    if (!nodeId || !this.nodeById.has(nodeId)) return;
    const selectedNodeIds = new Set([nodeId, ...this.getLinkedNodeIds(nodeId)]);
    this.setNodeSelection(selectedNodeIds);
    new Notice(`Selected linked nodes: ${selectedNodeIds.size}`);
  }

  getLinkedNodeDisplayName(node) {
    if (!node) return '';
    const label = String(node.label || '').trim();
    if (label) return label;
    const meta = this.nodeMetaById.get(node.id) || node.meta || null;
    const fileName = String(meta?.fileName || '').trim();
    if (fileName) return fileName;
    return String(node.id || '').trim();
  }

  getLinkedNodeDisplayPath(node) {
    if (!node) return '';
    const meta = this.nodeMetaById.get(node.id) || node.meta || null;
    const path = String(meta?.path || '').trim();
    if (path) return path;
    return String(node.id || '').trim();
  }

  // Menu/hotkey actions snapshot IDs, not mutable selection or node positions.
  captureNodeActionTargets(node = null) {
    const ids = node && !this.selectedNodeIds.has(node.id) ? [node.id] : [...this.selectedNodeIds];
    return {
      ids: [...new Set(ids)].filter((id) => this.nodeById.has(id)),
      data: this.plugin.data,
      layout: this.plugin.getActiveLayoutFileName(),
      scope: JSON.stringify(this.subgraphScope || null),
    };
  }

  isNodeActionSnapshotCurrent(snapshot) {
    return (
      snapshot.data === this.plugin.data &&
      snapshot.layout === this.plugin.getActiveLayoutFileName() &&
      snapshot.scope === JSON.stringify(this.subgraphScope || null)
    );
  }

  resolveNodeActionTargets(snapshot) {
    if (!this.isNodeActionSnapshotCurrent(snapshot)) return [];
    return snapshot.ids.map((id) => this.nodeById.get(id)).filter(Boolean);
  }

  captureCommandNodeActionTargets() {
    if (this.getSelectedNodesForCopy().length) return this.captureNodeActionTargets();
    const node = this.getCommandTargetNodeOrNotice();
    return this.captureNodeActionTargets(node);
  }

  nodeActionLabel(title, snapshot, count = snapshot.ids.length) {
    if (snapshot.ids.length <= 1) return title;
    return `${title} · ${count === snapshot.ids.length ? count : count + ' of ' + snapshot.ids.length} nodes`;
  }

  getSelectedNodesForCopy() {
    return this.resolveNodeActionTargets(this.captureNodeActionTargets());
  }

  getNodeCopyValue(node, kind) {
    if (kind === 'names') return this.getLinkedNodeDisplayName(node);
    if (node.meta?.darkEnergy || node.meta?.subgraph) return '';
    const file = this.app.vault.getAbstractFileByPath(node.id);
    if (!file || typeof file.extension !== 'string') return '';
    if (kind === 'systemPaths') return this.app.vault.adapter.getFullPath?.(file.path) || '';
    return file.path;
  }

  addNodeCopyActionsToMenu(menu, snapshot) {
    for (const [kind, title, single] of [
      ['names', 'Copy names', 'Copy name'],
      ['paths', 'Copy vault paths', 'From vault folder'],
      ['systemPaths', 'Copy system paths', 'Copy system root'],
    ]) {
      const count = this.resolveNodeActionTargets(snapshot).filter((node) =>
        this.getNodeCopyValue(node, kind)
      ).length;
      if (!count) continue;
      menu.addItem((item) =>
        item
          .setTitle(this.nodeActionLabel(snapshot.ids.length > 1 ? title : single, snapshot, count))
          .setIcon('copy')
          .onClick(() => this.copySelectedNodes(kind, snapshot))
      );
    }
  }

  getNodeVisualResetTargets(snapshot) {
    const data = this.plugin.data;
    return this.resolveNodeActionTargets(snapshot).filter(
      ({ id }) =>
        Object.keys(data.node_visual_settings?.[id] || {}).length > 0 ||
        data.node_label_sizes?.[id] != null ||
        data.painted_edge_colors?.[id] != null
    );
  }

  getNodePinActionTargets(snapshot, mode) {
    return this.resolveNodeActionTargets(snapshot).filter((node) => {
      const pin = this.plugin.getPin(node.id);
      if (mode === 'unpin') return pin || this.plugin.isOrbitPinned(node.id);
      if (mode === 'grid') return !pin || pin.mode !== 'grid';
      return !pin || pin.mode !== 'exact' || pin.x !== node.x || pin.y !== node.y;
    });
  }

  applyNodePinAction(snapshot, mode) {
    const nodes = this.getNodePinActionTargets(snapshot, mode);
    if (!nodes.length) return 0;
    const all = this.resolveNodeActionTargets(snapshot);
    const step = this.plugin.clampGridStep(this.plugin.getSettings().grid_step);
    const occupied = this.getOccupiedGridCells(new Set(all.map((node) => node.id)));
    if (mode === 'grid') {
      // Keep unchanged grid pins reserved before assigning any eligible target.
      for (const node of all) {
        const pin = this.plugin.getPin(node.id);
        if (pin?.mode === 'grid')
          occupied.add(this.gridKey(Math.round(pin.x / step), Math.round(pin.y / step)));
      }
    }
    const placements = nodes.map((node) => {
      if (mode !== 'grid') return { node, next: { x: node.x, y: node.y } };
      const next = this.findNearestFreeGridCell(node.x, node.y, step, occupied);
      if (occupied.has(this.gridKey(next.gx, next.gy))) throw new Error('No free grid cell');
      occupied.add(this.gridKey(next.gx, next.gy));
      return { node, next };
    });
    for (const { node, next } of placements) {
      if (mode === 'unpin') {
        this.plugin.removePin(node.id);
        this.plugin.removeOrbitPin(node.id);
      } else {
        this.plugin.setPin(node.id, next, { mode });
        Object.assign(node, { x: next.x, y: next.y, vx: 0, vy: 0 });
      }
    }
    this.markNodeSpatialIndexDirty();
    this.kickLayoutSearch();
    return nodes.length;
  }

  addSelectionActionsToMenu(menu, snapshot, clientX, clientY) {
    const submenu = (title, icon, fillSubmenu) =>
      this.addContextSubmenuItem(menu, {
        title,
        icon,
        clientX,
        clientY,
        fillSubmenu,
      });
    submenu('Copy', 'copy', (target) => this.addNodeCopyActionsToMenu(target, snapshot));
    for (const [mode, title, icon] of [
      ['exact', snapshot.ids.length > 1 ? 'Pin nodes' : 'Pin node', 'pin'],
      ['grid', 'Pin to grid', 'grid'],
      ['unpin', snapshot.ids.length > 1 ? 'Unpin' : 'Unpin node', 'pin-off'],
    ]) {
      const count = this.getNodePinActionTargets(snapshot, mode).length;
      if (count)
        menu.addItem((item) =>
          item
            .setTitle(this.nodeActionLabel(title, snapshot, count))
            .setIcon(icon)
            .onClick(() => this.applyNodePinAction(snapshot, mode))
        );
    }
    submenu(this.nodeActionLabel('Visual settings', snapshot), 'settings-2', (target) =>
      this.addVisualSettingsToMenu(target, null, clientX, clientY, snapshot, { basicOnly: true })
    );
  }

  onSelectedNodeCopyKeyDown(event) {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.shiftKey ||
      !(event.ctrlKey || event.metaKey) ||
      (event.ctrlKey && event.metaKey) ||
      !(event.code === 'KeyC' || String(event.key).toLowerCase() === 'c') ||
      this.app.workspace.activeLeaf?.view !== this
    )
      return;
    const doc = this.contentEl.ownerDocument;
    const editable = (el) =>
      el?.isContentEditable ||
      !!el?.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"])');
    if (editable(event.target) || editable(doc.activeElement)) return;
    if (doc.getSelection()?.isCollapsed === false) return;
    // Body/document targets are normal after clicking a non-focusable canvas.
    if (event.target !== doc && event.target !== doc.body && !this.contentEl.contains(event.target))
      return;
    if (!this.getSelectedNodesForCopy().length) return;
    event.preventDefault();
    event.stopPropagation();
    void this.copySelectedNodes('names');
    return false;
  }

  async copySelectedNodes(kind = 'names', snapshot = this.captureNodeActionTargets()) {
    const values = this.resolveNodeActionTargets(snapshot)
      .map((node) => this.getNodeCopyValue(node, kind))
      .filter(Boolean);
    if (!values.length) return false;
    try {
      const copied = await this.copyTextToClipboard(values.join('\n'));
      new Notice(copied ? `Copied ${kind}: ${values.length}` : `Failed to copy ${kind}`);
      return copied;
    } catch {
      new Notice(`Failed to copy ${kind}`);
      return false;
    }
  }

  async copyTextToClipboard(text) {
    const normalizedText = String(text || '');
    if (!normalizedText) return false;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(normalizedText);
        return true;
      }
    } catch {
      // Fall through to textarea copy fallback for older environments.
    }

    try {
      const textareaEl = document.createElement('textarea');
      textareaEl.value = normalizedText;
      textareaEl.setAttribute('readonly', '');
      textareaEl.style.position = 'fixed';
      textareaEl.style.top = '-10000px';
      textareaEl.style.opacity = '0';
      document.body.appendChild(textareaEl);
      textareaEl.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textareaEl);
      return !!copied;
    } catch {
      return false;
    }
  }

  async copyLinkedNames(nodeId) {
    const linkedNodeIds = this.getLinkedNodeIds(nodeId);
    if (linkedNodeIds.length <= 0) {
      new Notice('No linked nodes');
      return;
    }

    const linkedNames = linkedNodeIds
      .map((linkedNodeId) => this.nodeById.get(linkedNodeId))
      .filter((linkedNode) => !!linkedNode)
      .map((linkedNode) => this.getLinkedNodeDisplayName(linkedNode))
      .filter((value) => value.length > 0)
      .sort((leftValue, rightValue) => leftValue.localeCompare(rightValue));
    if (linkedNames.length <= 0) {
      new Notice('No linked nodes');
      return;
    }

    const copied = await this.copyTextToClipboard(this.formatCopyList(linkedNames));
    new Notice(
      copied ? `Copied linked names: ${linkedNames.length}` : 'Failed to copy linked names'
    );
  }

  async copyLinkedPaths(nodeId) {
    const linkedNodeIds = this.getLinkedNodeIds(nodeId);
    if (linkedNodeIds.length <= 0) {
      new Notice('No linked nodes');
      return;
    }

    const linkedPaths = linkedNodeIds
      .map((linkedNodeId) => this.nodeById.get(linkedNodeId))
      .filter((linkedNode) => !!linkedNode)
      .map((linkedNode) => this.getLinkedNodeDisplayPath(linkedNode))
      .filter((value) => value.length > 0)
      .sort((leftValue, rightValue) => leftValue.localeCompare(rightValue));
    if (linkedPaths.length <= 0) {
      new Notice('No linked nodes');
      return;
    }

    const copied = await this.copyTextToClipboard(this.formatCopyList(linkedPaths));
    new Notice(
      copied ? `Copied linked paths: ${linkedPaths.length}` : 'Failed to copy linked paths'
    );
  }

  formatCopyList(items) {
    const values = Array.isArray(items)
      ? items.filter((item) => String(item || '').length > 0)
      : [];
    if (values.length <= 0) return '';
    return values
      .map((value, index) => (index < values.length - 1 ? `${value},` : String(value)))
      .join('\n');
  }

  getLinkedNodeIdsByKind(nodeId, targetKind = 'all') {
    const linkedNodeIds = this.getLinkedNodeIds(nodeId);
    if (targetKind !== 'regular' && targetKind !== 'attachment') return linkedNodeIds;
    const result = [];
    for (const linkedNodeId of linkedNodeIds) {
      const linkedNode = this.nodeById.get(linkedNodeId);
      if (!linkedNode) continue;
      const isAttachment = !!linkedNode.meta?.isAttachment;
      if (targetKind === 'regular' && isAttachment) continue;
      if (targetKind === 'attachment' && !isAttachment) continue;
      result.push(linkedNodeId);
    }
    return result;
  }

  // Layout persistence: save/load full graph layout including settings and pin modes.
  async saveCurrentLayout(options = {}) {
    const silent = !!options.silent;
    if (this.subgraphScope && !this.hasValidSubgraphScope()) return false;
    if (!options.allowSearch && this.isSearchFilled()) {
      if (!silent) new Notice('Clear search field to save');
      return false;
    }
    const sourceData = this.plugin.data;
    const layoutName = this.plugin.normalizeLayoutFileName(
      options.layoutFileName || this.plugin.getActiveLayoutFileName()
    );
    return this.plugin.runLayoutFileOperation(async () => {
      // A queued save belongs to the layout on which it was requested.
      if (this.plugin.data !== sourceData || (!options.allowSearch && this.isSearchFilled()))
        return false;
      if (options.beforeWrite) await options.beforeWrite();
      if (this.plugin.data !== sourceData || (!options.allowSearch && this.isSearchFilled()))
        return false;
      this.layoutAutosaveDirty = true;
      const snapshot = this.captureLayoutSnapshot(layoutName);
      const nodeCount = this.nodes.length;
      const snapshotText = JSON.stringify(snapshot);
      const editVersion = this.layoutEditVersion;
      const persistRevision = this.plugin._persistRevision;
      let written = false;
      try {
        written = await this.plugin.persistActiveLayoutFile(snapshot, layoutName);
      } catch {
        written = false;
      }
      if (!written) {
        if (!silent) new Notice('Failed to save layout. Changes are still unsaved.');
        return false;
      }
      if (this.plugin.data === sourceData) {
        const unchanged =
          this.layoutEditVersion === editVersion &&
          this.plugin._persistRevision === persistRevision &&
          JSON.stringify(this.captureLayoutSnapshot(layoutName)) === snapshotText;
        for (const key of [
          'saved_positions',
          'saved_layout_settings',
          'saved_layout_pins',
          'saved_layout_orbit_pins',
        ]) {
          if (
            key === 'saved_positions' &&
            !unchanged &&
            (snapshot.subgraphs.length || sourceData.subgraphs.length || this.subgraphScope)
          )
            continue;
          sourceData[key] = snapshot[key];
        }
        sourceData.active_layout_name = layoutName;
        this.layoutAutosaveDirty = !unchanged;
        if (unchanged) {
          this.layoutStillFrames = 0;
          for (const node of this.nodes) {
            node.vx = 0;
            node.vy = 0;
          }
          if (sourceData.subgraphs?.length) {
            for (const leaf of this.getScopeLeaves()) {
              leaf.view.layoutAutosaveDirty = false;
              leaf.view.layoutStillFrames = 0;
            }
          }
        }
        this.plugin.schedulePersist();
        this.syncLayoutFileSelectionFromPlugin();
      }
      if (!silent) new Notice(`Layout saved: ${nodeCount} nodes`);
      return true;
    });
  }

  captureLayoutSnapshot(layoutName) {
    const snapshot = JSON.parse(JSON.stringify(this.plugin.normalizeData(this.plugin.data)));
    snapshot.active_layout_name = layoutName;
    this.captureGraphPositions(snapshot);
    snapshot.saved_layout_settings = Object.assign({}, snapshot.settings);
    snapshot.saved_layout_pins = Object.assign({}, snapshot.pins);
    snapshot.saved_layout_orbit_pins = Object.assign({}, snapshot.orbit_pins);
    const views = this.getScopeLeaves().map((leaf) => leaf.view);
    const main = this.subgraphScope
      ? views.find((view) => !view.subgraphScope && view.isOpen)
      : this;
    if (main) {
      snapshot.view_state.pan_x = main.cameraTarget.x;
      snapshot.view_state.pan_y = main.cameraTarget.y;
      snapshot.view_state.zoom = main.cameraTarget.zoom;
      snapshot.view_state.camera_saved = true;
      snapshot.view_state.search_query = main.searchInputEl?.value || main.searchInputValue;
      snapshot.view_state.node_filter =
        main.apiVisibleNodeIds instanceof Set ? [...main.apiVisibleNodeIds] : null;
    }
    for (const view of views)
      if (view.hasValidSubgraphScope()) {
        snapshot.subgraph_cameras[view.subgraphScope.id] = { ...view.cameraTarget };
        snapshot.subgraph_filters[view.subgraphScope.id] = view.captureScopedFilter();
      }
    snapshot.view_state.side_panel_sections = {};
    return snapshot;
  }

  restoreLayoutViewState() {
    if (this.subgraphScope) {
      const filter = this.plugin.data.subgraph_filters?.[this.subgraphScope.id];
      this.searchInputValue = filter?.query || 'name:';
      this.searchMode =
        filter?.mode || (this.plugin.data.settings.search_mode === 'filter' ? 'filter' : 'find');
      if (this.searchInputEl) this.searchInputEl.value = this.searchInputValue;
      this.searchSelectedNodeId = null;
      this.searchMatchedNodeIds = new Set();
      this.apiVisibleNodeIds = Array.isArray(filter?.node_filter)
        ? new Set(filter.node_filter)
        : null;
      const camera =
        this.hasValidSubgraphScope() && this.plugin.data.subgraph_cameras[this.subgraphScope.id];
      if (camera) {
        this.camera = { ...camera };
        this.cameraTarget = { ...camera };
      }
      this.pendingSubgraphFit = !camera;
      this.markSearchVisibilityDirty();
      return;
    }
    const state = this.plugin.data.view_state;
    this.searchInputValue = state.search_query || 'name:';
    if (this.searchInputEl) this.searchInputEl.value = this.searchInputValue;
    this.searchSelectedNodeId = null;
    this.searchMatchedNodeIds = new Set();
    this.focusNodeId = null;
    this.apiVisibleNodeIds = Array.isArray(state.node_filter) ? new Set(state.node_filter) : null;
    if (state.camera_saved) {
      this.camera = { x: state.pan_x, y: state.pan_y, zoom: state.zoom };
      this.cameraTarget = { ...this.camera };
    }
    this.markSearchVisibilityDirty();
  }

  async loadSavedLayout(options = {}) {
    const silent = !!options.silent;
    const layoutName = options.layoutFileName || this.plugin.getActiveLayoutFileName();
    const loaded = await this.plugin.setActiveLayoutFile(layoutName, {
      loadFromFile: true,
      assertCurrent: options.assertCurrent,
    });
    if (!loaded) {
      new Notice(`Cannot read layout: ${layoutName}. Current changes kept.`);
      this.syncLayoutFileSelectionFromPlugin();
      return false;
    }
    const views = this.getScopeLeaves().map((leaf) => leaf.view);
    if (!views.includes(this)) views.push(this);
    for (const view of views) {
      view.searchMode = this.plugin.data.settings.search_mode === 'filter' ? 'filter' : 'find';
      view.restoreLayoutViewState();
      view.sidePanelSectionState = this.plugin.getSidePanelSectionsState();
      view.syncLayoutFileSelectionFromPlugin();
      view.layoutAutosaveDirty = false;
      view.layoutStillFrames = 0;
      view.layoutPaused = true;
      if (!view.isOpen) continue;
      view.refreshFromVault({ keepCamera: true, forceSavedPositions: true, skipLayoutKick: true });
      view.commitSearchSelectionFromInput(view.searchInputValue);
      view.layoutPaused = true;
      view.layoutAutosaveDirty = false;
      view.buildSidePanel();
    }
    this.plugin.renderAllViews();
    if (!silent) new Notice('Layout loaded');
    return true;
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

    const parents = hierarchy(this.plugin.data.subgraphs);
    for (const [nodeId, pos] of Object.entries(this.plugin.data.pins)) {
      if (!this.nodeById.has(nodeId)) continue;
      if ((parents.get(nodeId) || null) !== (this.subgraphScope?.id || null)) continue;
      if (nodeId === exceptNodeId || (exceptNodeId instanceof Set && exceptNodeId.has(nodeId)))
        continue;
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
    this.persistCameraState();
    this.plugin.schedulePersist(1200);
  }

  hasValidSubgraphScope() {
    return (
      !!this.subgraphScope &&
      this.subgraphScope.layout === this.plugin.getActiveLayoutFileName() &&
      this.plugin.data.subgraphs.some((group) => group.id === this.subgraphScope.id)
    );
  }

  persistCameraState() {
    if (this.subgraphScope) {
      if (this.hasValidSubgraphScope()) {
        this.plugin.data.subgraph_cameras[this.subgraphScope.id] = { ...this.cameraTarget };
        this.plugin.data.subgraph_filters[this.subgraphScope.id] = this.captureScopedFilter();
      }
      return;
    }
    this.plugin.data.view_state.pan_x = this.cameraTarget.x;
    this.plugin.data.view_state.pan_y = this.cameraTarget.y;
    this.plugin.data.view_state.zoom = this.cameraTarget.zoom;
  }

  captureScopedFilter() {
    return {
      query: this.searchInputEl?.value || this.searchInputValue,
      mode: this.searchMode,
      node_filter: this.apiVisibleNodeIds instanceof Set ? [...this.apiVisibleNodeIds] : null,
    };
  }

  async openNodeFile(nodeId) {
    try {
      const node = this.nodeById.get(nodeId);
      if (node?.meta?.subgraph) {
        await this.openSubgraphSeparately(nodeId);
        return;
      }
      if (node?.meta?.darkEnergy) {
        await this.editDarkEnergy(node);
        return;
      }
      const file = this.app.vault.getAbstractFileByPath(nodeId);
      if (!file || typeof file.extension !== 'string' || typeof file.path !== 'string') return;
      // Route external files before creating a leaf, which would leave an empty tab.
      if (!this.app.viewRegistry.getTypeByExtension(file.extension)) {
        await this.app.openWithDefaultApp(file.path);
        return;
      }
      await this.app.workspace.getLeaf(true).openFile(file);
    } catch (error) {
      new Notice(`Cannot open file: ${error?.message || error}`);
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
    const zoom = Math.max(this.camera.zoom, 0.0001);
    const hasSubgraphs = !!this.plugin.data.subgraphs?.length;
    const maxCandidateRadius = (hasSubgraphs ? 8 : 4) + (hasSubgraphs ? 5 : 2) / zoom;

    if (!this.isNodeSpatialIndexFresh()) {
      // Moving nodes may have crossed buckets. Scan current coordinates without
      // rebuilding the index (and allocating buckets) on every pointer event.
      return this.getNodeAtWorldByScan(world, visibleNodeIds, hasFilter, zoom, maxCandidateRadius);
    }
    const spatialIndex = this.nodeSpatialIndex;
    const cellSize = spatialIndex.cellSize;
    const centerGX = Math.floor(world.x / cellSize);
    const centerGY = Math.floor(world.y / cellSize);
    const bucketRange = Math.max(1, Math.ceil(maxCandidateRadius / cellSize));

    let bestNode = null;
    let bestDist2 = Infinity;

    for (let offsetX = -bucketRange; offsetX <= bucketRange; offsetX += 1) {
      for (let offsetY = -bucketRange; offsetY <= bucketRange; offsetY += 1) {
        const bucket = spatialIndex.buckets.get(`${centerGX + offsetX}:${centerGY + offsetY}`);
        if (!bucket) continue;
        for (const node of bucket) {
          if (hasFilter && (!visibleNodeIds || !visibleNodeIds.has(node.id))) continue;
          const dx = node.x - world.x;
          const dy = node.y - world.y;
          const dist2 = dx * dx + dy * dy;
          if (dist2 < bestDist2) {
            bestDist2 = dist2;
            bestNode = node;
          }
        }
      }
    }

    if (!bestNode) return null;

    const baseRadius = this.getNodeRadius(bestNode);
    const maxDist = Math.max(1, baseRadius + (bestNode.meta?.subgraph ? 4.2 : 2) / zoom);
    if (bestDist2 > maxDist * maxDist) return null;

    return bestNode;
  }

  getNodeAtWorldByScan(world, visibleNodeIds, hasFilter, zoom, maxCandidateRadius) {
    let bestNode = null;
    let bestDist2 = Infinity;
    const coarseMaxDist = Math.max(1, maxCandidateRadius);
    const coarseMaxDist2 = coarseMaxDist * coarseMaxDist;

    for (const node of this.nodes) {
      if (hasFilter && (!visibleNodeIds || !visibleNodeIds.has(node.id))) continue;
      const dx = node.x - world.x;
      if (Math.abs(dx) > coarseMaxDist) continue;
      const dy = node.y - world.y;
      if (Math.abs(dy) > coarseMaxDist) continue;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > coarseMaxDist2 || dist2 >= bestDist2) continue;
      bestDist2 = dist2;
      bestNode = node;
    }

    if (!bestNode) return null;

    const baseRadius = this.getNodeRadius(bestNode);
    const maxDist = Math.max(1, baseRadius + (bestNode.meta?.subgraph ? 4.2 : 2) / zoom);
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
