import { Modal, setIcon } from 'obsidian';
import { getColorInputValue, DARK_THEME } from './theme.js';
import {
  DEFAULT_ANNOTATION,
  getAnnotationMetrics,
  normalizeAnnotationColor,
} from './annotations.js';

function clampSize(value, min, max, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(min, Math.min(max, num)) : fallback;
}

class AnnotationModal extends Modal {
  constructor(view, initial, onSave, onDelete = null, options = {}) {
    super(view.app);
    this.view = view;
    this.initial = { ...DEFAULT_ANNOTATION, ...initial };
    this.onSave = onSave;
    this.onDelete = onDelete;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : onSave;
    this.commitOnClose = null;
  }

  appendStyleControls(containerEl, draft, emitLive, { inline = false, onDeleteClick = null } = {}) {
    const { view } = this;
    const sizeRow = containerEl.createDiv({
      cls: inline ? 'graphfrontier-toolbar-group' : 'graphfrontier-sidepanel-row is-slider',
    });
    sizeRow.createSpan({
      text: 'Size',
      cls: inline ? 'graphfrontier-toolbar-label' : 'graphfrontier-sidepanel-label',
    });
    const sizeSlider = sizeRow.createEl('input', {
      type: 'range',
      cls: 'graphfrontier-sidepanel-slider',
    });
    sizeSlider.setAttribute('aria-label', 'Text size');
    sizeSlider.min = '10';
    sizeSlider.max = '96';
    sizeSlider.step = '2';
    sizeSlider.value = String(clampSize(draft.size, 10, 96, DEFAULT_ANNOTATION.size));
    const sizeValue = sizeRow.createSpan({
      cls: 'graphfrontier-sidepanel-value',
      text: sizeSlider.value,
    });
    sizeSlider.addEventListener('input', () => {
      sizeValue.setText(sizeSlider.value);
      draft.size = clampSize(sizeSlider.value, 10, 120, DEFAULT_ANNOTATION.size);
      emitLive();
    });

    const colorGroup = containerEl.createDiv({
      cls: inline ? 'graphfrontier-toolbar-group' : 'graphfrontier-sidepanel-row',
    });
    if (!inline) colorGroup.createSpan({ text: 'Color', cls: 'graphfrontier-sidepanel-label' });
    const colorControls = inline
      ? colorGroup
      : colorGroup.createDiv({ cls: 'graphfrontier-annotation-color-controls' });
    const colorInput = colorControls.createEl('input', { type: 'color' });
    colorInput.addClass('graphfrontier-group-color-input');
    colorInput.setAttribute('aria-label', 'Text color');
    const fallbackColor = () => getColorInputValue(view.canvasTheme?.text, DARK_THEME.text);
    colorInput.value = normalizeAnnotationColor(draft.color) || fallbackColor();
    colorInput.addEventListener('input', () => {
      draft.color = normalizeAnnotationColor(colorInput.value);
      emitLive();
    });

    const resetBtn = containerEl.createEl('button', {
      cls: 'graphfrontier-toolbar-reset',
      type: 'button',
      title: 'Reset style',
    });
    resetBtn.setAttribute('aria-label', 'Reset style');
    resetBtn.setAttribute('title', 'Reset style');
    setIcon(resetBtn, 'rotate-ccw');
    if (!resetBtn.children?.length && !resetBtn.childElementCount && !resetBtn.text) {
      resetBtn.setText?.('↺');
    }
    resetBtn.addEventListener('click', () => {
      draft.size = DEFAULT_ANNOTATION.size;
      draft.color = null;
      draft.border = false;
      draft.width = null;
      draft.height = null;
      sizeSlider.value = String(DEFAULT_ANNOTATION.size);
      sizeValue.setText(sizeSlider.value);
      colorInput.value = fallbackColor();
      emitLive();
    });

    if (onDeleteClick) {
      containerEl
        .createEl('button', {
          text: 'Delete',
          cls: 'graphfrontier-sidepanel-save',
          type: 'button',
          attr: { 'aria-label': 'Delete text' },
        })
        .addEventListener('click', onDeleteClick);
    }
  }

  renderInlineEditor(overlayEl, closeFn = () => {}) {
    const { view, initial } = this;
    const draft = { ...initial };
    let deleted = false;
    let syncing = false;

    const textarea = overlayEl.createEl('textarea', {
      cls: 'graphfrontier-inline-annotation-input',
    });
    textarea.value = draft.text || '';
    textarea.placeholder = 'Text...';
    textarea.setAttribute('aria-label', 'Annotation text');

    const toolbarEl = overlayEl.createDiv({
      cls: 'graphfrontier-sidepanel graphfrontier-annotation-toolbar is-open',
    });

    const getLiveItem = () => {
      const current = (view.plugin?.data?.annotations || []).find((entry) => entry.id === draft.id);
      return current ? { ...current, ...draft, x: current.x, y: current.y } : draft;
    };

    const syncPosition = () => {
      if (syncing || deleted) return;
      syncing = true;
      try {
        const live = getLiveItem();
        const rawText = textarea.value;
        const measureTextValue = rawText.trim() ? rawText : ' ';
        const metricsItem = { ...live, text: measureTextValue };
        const m = getAnnotationMetrics(metricsItem, view.ctx);
        const zoom = Math.max(view.camera?.zoom || 1, 0.0001);
        const vw = view.viewWidth || 400;
        const vh = view.viewHeight || 300;
        const camX = view.camera?.x || 0;
        const camY = view.camera?.y || 0;
        const fontPx = Math.max(10, m.size * zoom);
        const scaleRatio = fontPx / m.size;
        const lineHeightPx = m.lineHeight * scaleRatio;
        const rawLines = (rawText || ' ').split(/\r?\n/u);
        const boxW = Math.max(96, Math.ceil(m.textWidth * scaleRatio + 28));
        const boxH = Math.max(
          Math.ceil(lineHeightPx + 6),
          Math.ceil(rawLines.length * lineHeightPx + 6)
        );
        const cx = (live.x - camX) * zoom + vw / 2;
        const textTopY = (m.textTop - camY) * zoom + vh / 2;
        const boxLeft = cx - boxW / 2;
        const boxTop = textTopY - 3;

        textarea.style.left = `${Math.round(boxLeft)}px`;
        textarea.style.top = `${Math.round(boxTop)}px`;
        textarea.style.width = `${boxW}px`;
        textarea.style.height = `${boxH}px`;
        textarea.style.fontSize = `${fontPx}px`;
        textarea.style.lineHeight = `${lineHeightPx}px`;
        textarea.style.color = live.color || view.canvasTheme?.text || DARK_THEME.text;

        const annLeft = (m.left - camX) * zoom + vw / 2;
        const annRight = (m.right - camX) * zoom + vw / 2;
        const annTop = (m.top - camY) * zoom + vh / 2;
        const annBottom = (m.bottom - camY) * zoom + vh / 2;
        const unionLeft = Math.min(annLeft, boxLeft);
        const unionRight = Math.max(annRight, boxLeft + boxW);
        const unionTop = Math.min(annTop, boxTop);
        const unionBottom = Math.max(annBottom, boxTop + boxH);

        const toolbarW = Math.min(vw - 16, toolbarEl.offsetWidth || 340);
        const toolbarH = toolbarEl.offsetHeight || 40;
        const gap = 12;
        let tbLeft = Math.max(8, Math.min(cx - toolbarW / 2, vw - toolbarW - 8));
        let tbTop = unionTop - toolbarH - gap;
        if (tbTop < 8) {
          const belowTop = unionBottom + gap;
          if (belowTop + toolbarH <= vh - 8) {
            tbTop = belowTop;
          } else if (unionRight + gap + toolbarW <= vw - 8) {
            tbLeft = unionRight + gap;
            tbTop = Math.max(8, Math.min(unionTop, vh - toolbarH - 8));
          } else if (unionLeft - gap - toolbarW >= 8) {
            tbLeft = unionLeft - gap - toolbarW;
            tbTop = Math.max(8, Math.min(unionTop, vh - toolbarH - 8));
          } else {
            tbTop = unionTop >= vh - unionBottom ? 8 : Math.max(8, vh - toolbarH - 8);
          }
        }
        toolbarEl.style.left = `${Math.round(tbLeft)}px`;
        toolbarEl.style.top = `${Math.round(tbTop)}px`;
      } finally {
        syncing = false;
      }
    };

    const emitLive = () => {
      if (deleted) return;
      const latest = getLiveItem();
      draft.x = latest.x;
      draft.y = latest.y;
      draft.border = false;
      draft.width = null;
      draft.height = null;
      const trimmed = textarea.value.trim();
      if (trimmed) {
        draft.text = trimmed;
        this.onChange?.({ ...draft });
      }
      syncPosition();
    };

    this.appendStyleControls(toolbarEl, draft, emitLive, {
      inline: true,
      onDeleteClick: () => {
        deleted = true;
        this.onDelete?.();
        closeFn();
      },
    });

    textarea.addEventListener('input', emitLive);
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) {
        event.preventDefault();
        event.stopPropagation();
        closeFn();
      }
    });

    this.commitOnClose = () => {
      if (deleted) return;
      const trimmed = textarea.value.trim();
      if (!trimmed) {
        deleted = true;
        this.onDelete?.();
        return;
      }
      const latest = getLiveItem();
      this.onSave?.({ ...latest, ...draft, text: trimmed });
    };

    syncPosition();
    textarea.focus?.();
    if (!this.onDelete || initial.selectAll) textarea.select?.();
    return syncPosition;
  }

  renderEditor(containerEl, closeFn = () => this.close()) {
    const { initial } = this;
    const draft = { ...initial };
    const emitLive = () => {
      if (!String(draft.text || '').trim()) return;
      this.onChange?.({ ...draft });
    };

    const textarea = containerEl.createEl('textarea', {
      cls: 'graphfrontier-group-query graphfrontier-annotation-textarea',
    });
    textarea.rows = 2;
    textarea.value = draft.text || '';
    textarea.placeholder = 'Enter label...';
    textarea.setAttribute('aria-label', 'Annotation text');
    textarea.addEventListener('input', () => {
      const nextText = textarea.value.trim();
      if (!nextText) return;
      draft.text = nextText;
      emitLive();
    });

    this.appendStyleControls(containerEl, draft, emitLive, { inline: false });

    const commitAndClose = () => {
      const text = textarea.value.trim();
      if (!text) {
        this.onDelete?.();
        closeFn();
        return;
      }
      draft.text = text;
      this.onSave?.({ ...draft });
      closeFn();
    };
    textarea.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        commitAndClose();
      }
    });

    const footer = containerEl.createDiv({ cls: 'graphfrontier-sidepanel-actions' });
    const actions = footer.createDiv({ cls: 'graphfrontier-sidepanel-actions-row' });
    actions
      .createEl('button', { text: 'Done', cls: 'graphfrontier-sidepanel-save', type: 'button' })
      .addEventListener('click', commitAndClose);
    if (this.onDelete) {
      actions
        .createEl('button', { text: 'Delete', cls: 'graphfrontier-sidepanel-save', type: 'button' })
        .addEventListener('click', () => {
          this.onDelete();
          closeFn();
        });
    }
    textarea.focus?.();
    if (!this.onDelete || initial.selectAll) textarea.select?.();
  }

  onOpen() {
    this.modalEl?.addClass('graphfrontier-gravity-modal');
    this.renderEditor(this.contentEl, () => this.close());
  }

  onClose() {
    this.commitOnClose = null;
    this.contentEl.empty();
  }
}

export { AnnotationModal };
