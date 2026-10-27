const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSource } = require('./helpers/obsidian.cjs');
const { GraphFrontierView } = loadSource('view.js');

// Opt in with the locally available Playwright module and Chromium executable.
test(
  'native attachment checkbox clicks, keyboard, summaries and field dimensions',
  {
    skip: !process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE || !process.env.GRAPHFRONTIER_CHROMIUM,
  },
  async () => {
    const { chromium } = require(process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({
      executablePath: process.env.GRAPHFRONTIER_CHROMIUM,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<div class="graphfrontier-sidepanel" style="width:250px"><div class="graphfrontier-find-row"><div class="graphfrontier-search-input-wrap"><input id="normal-search" class="graphfrontier-find-input" value="name:"></div></div></div>'
      );
      await page.addStyleTag({
        content: fs.readFileSync(path.join(__dirname, '../src/static/styles.css'), 'utf8'),
      });
      const methods = [
        'buildAttachmentFileTypesControl',
        'showInputSuggestMenu',
        'closeInputSuggestMenu',
        'moveInputSuggestSelection',
        'selectInputSuggestActive',
        'protectQueryInputPrefix',
      ];
      await page.addScriptTag({
        content: `
      function normalizeAttachmentExtensions(values) { return values || []; }
      window.view = new (class {
        ${methods.map((name) => GraphFrontierView.prototype[name].toString()).join('\n')}
      })();
    `,
      });
      await page.evaluate(() => {
        const { HTMLElement } = window;
        HTMLElement.prototype.createEl = function (tag, options = {}) {
          const el = document.createElement(tag);
          if (options.cls) el.className = options.cls;
          if (options.type) el.type = options.type;
          if (options.text) el.textContent = options.text;
          if (options.placeholder) el.placeholder = options.placeholder;
          for (const [key, value] of Object.entries(options.attr || {}))
            el.setAttribute(key, value);
          this.appendChild(el);
          return el;
        };
        HTMLElement.prototype.createDiv = function (options) {
          return this.createEl('div', options);
        };
        HTMLElement.prototype.setAttr = HTMLElement.prototype.setAttribute;
        HTMLElement.prototype.toggleClass = function (name, enabled) {
          this.classList.toggle(name, enabled);
        };
        Object.assign(window.view, {
          contentEl: { ownerDocument: document, win: window },
          plugin: {
            data: { settings: { excluded_attachment_extensions: [] } },
            schedulePersist() {},
            getAttachmentExtensionInventory: () => [
              ['png', 8],
              ['pdf', 2],
              ['', 1],
            ],
          },
          applyRefreshMode() {},
          registerDomEvent: (el, name, handler) => el.addEventListener(name, handler),
        });
        window.view.buildAttachmentFileTypesControl(
          document.querySelector('.graphfrontier-sidepanel')
        );
      });
      const input = page.locator('.graphfrontier-file-types-search input');
      await input.focus();
      assert.equal(await input.inputValue(), 'File type: ');
      const bulkStyles = await page.evaluate(() => {
        const reference = document.createElement('button');
        reference.className =
          'graphfrontier-sidepanel-toggle graphfrontier-sidepanel-inline-toggle';
        document.body.appendChild(reference);
        const properties = [
          'width',
          'height',
          'padding',
          'fontSize',
          'fontFamily',
          'fontWeight',
          'lineHeight',
          'backgroundColor',
          'border',
          'borderRadius',
        ];
        const styles = (el) =>
          Object.fromEntries(properties.map((key) => [key, getComputedStyle(el)[key]]));
        const expected = styles(reference);
        const actual = [...document.querySelectorAll('.graphfrontier-input-menu-bulk')].map(
          (el) => ({
            styles: styles(el),
            sharedClasses:
              el.classList.contains('graphfrontier-sidepanel-toggle') &&
              el.classList.contains('graphfrontier-sidepanel-inline-toggle'),
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height,
          })
        );
        reference.remove();
        return { expected, actual };
      });
      assert.equal(bulkStyles.actual.length, 2);
      for (const button of bulkStyles.actual) {
        assert(button.sharedClasses);
        assert.deepEqual(button.styles, bulkStyles.expected);
        assert.equal(button.width, 46);
        assert.equal(button.height, 22);
      }
      const checkboxState = () =>
        page.evaluate(() => ({
          checked: window.view.inputSuggestMenu.selectableEntries.map(
            (entry) => entry.checkbox?.checked
          ),
          excluded: window.view.plugin.data.settings.excluded_attachment_extensions,
        }));
      // HTMLElement.click performs the browser's activation/default-action sequence,
      // unlike dispatchEvent mocks that miss canceled checkbox-state rollback.
      await page
        .locator('input[type=checkbox]')
        .first()
        .evaluate((el) => el.click());
      let state = await checkboxState();
      assert.equal(state.checked[0], false);
      assert.deepEqual(state.excluded, ['png']);
      assert.equal(await input.inputValue(), 'File type: .pdf, No extension');
      assert.equal(await page.locator('input[type=checkbox]').count(), 3);
      await page.locator('input[type=checkbox]').first().click();
      state = await checkboxState();
      assert.equal(state.checked[0], true);
      assert.deepEqual(state.excluded, []);
      assert.equal(await input.evaluate((el) => document.activeElement === el), true);
      await page
        .locator('input[type=checkbox]')
        .nth(2)
        .evaluate((el) => el.click());
      state = await checkboxState();
      assert.equal(state.checked[2], false);
      assert.deepEqual(state.excluded, ['']);
      await input.press('ArrowDown');
      await input.press('Enter');
      state = await checkboxState();
      assert.equal(state.checked[1], false);
      assert.deepEqual(state.excluded, ['', 'pdf']);
      await input.pressSequentially('.PnG');
      assert.equal(
        await input.inputValue(),
        'File type: .PnG',
        'same-input replacement must not restore summary'
      );
      await page.waitForTimeout(50);
      assert.equal(await page.locator('.graphfrontier-input-menu').count(), 1);
      const dimensions = await page.evaluate(() => {
        const field = document.querySelector('.graphfrontier-file-types-search input');
        const normal = document.querySelector('#normal-search');
        return {
          field: field.getBoundingClientRect().width,
          menu: document.querySelector('.graphfrontier-input-menu').getBoundingClientRect().width,
          normalWidth: normal.getBoundingClientRect().width,
          normalHeight: normal.getBoundingClientRect().height,
          normalFont: getComputedStyle(normal).fontSize,
          normalPadding: getComputedStyle(normal).padding,
          padding: getComputedStyle(field).padding,
          height: field.getBoundingClientRect().height,
          font: getComputedStyle(field).fontSize,
        };
      });
      assert.equal(dimensions.menu, dimensions.field);
      assert.equal(dimensions.field, dimensions.normalWidth);
      assert.equal(dimensions.height, dimensions.normalHeight);
      assert.equal(dimensions.font, dimensions.normalFont);
      assert.equal(dimensions.padding, dimensions.normalPadding);
      assert.equal(dimensions.height, 28);
      assert.equal(dimensions.font, '12px');
      await input.press('Escape');
      assert.equal(await input.inputValue(), 'File type: .png');
      assert.equal(await page.locator('.graphfrontier-input-menu').count(), 0);
      await input.click();
      assert.equal(await input.inputValue(), 'File type: ');
      await input.evaluate((el) => el.blur());
      assert.equal(await input.inputValue(), 'File type: .png');
      assert.equal(await page.locator('.graphfrontier-input-menu').count(), 0);

      await input.focus();
      await input.press('Home');
      await input.press('Delete');
      assert.equal(await input.inputValue(), 'File type: ');
      await input.press('End');
      await input.press('Backspace');
      assert.equal(await input.inputValue(), 'File type: ');
      await input.press('Control+a');
      await input.press('Backspace');
      assert.equal(await input.inputValue(), 'File type: ');
      await input.press('Control+a');
      await input.pressSequentially('pdf');
      assert.equal(await input.inputValue(), 'File type: pdf');
      assert.equal(await page.locator('input[type=checkbox]').count(), 1);
      await page.getByRole('button', { name: 'All', exact: true }).click();
      assert.deepEqual((await checkboxState()).excluded, ['']);
      assert.equal(await input.inputValue(), 'File type: .png, .pdf');
      assert.equal(await page.locator('input[type=checkbox]').count(), 1);
      await page.getByRole('button', { name: 'Clear file type search' }).click();
      assert.equal(await input.inputValue(), 'File type: ');
      assert.deepEqual((await checkboxState()).excluded, ['']);

      await input.pressSequentially('pdf');
      await input.evaluate((el) =>
        el.setSelectionRange('File type: '.length, 'File type: '.length)
      );
      await input.press('Delete');
      assert.equal(await input.inputValue(), 'File type: df', 'forward delete edits suffix');
      await input.press('End');
      await input.press('Control+Backspace');
      assert.equal(await input.inputValue(), 'File type: ');
      await input.pressSequentially('pdf');
      await input.press('Control+a');
      await input.press('Delete');
      assert.equal(await input.inputValue(), 'File type: ');

      await input.press('Escape');
      await page.setViewportSize({ width: 390, height: 800 });
      await page.evaluate(() => {
        window.view.plugin.getAttachmentExtensionInventory = () =>
          Array.from({ length: 40 }, (_, i) => ['format' + i, i + 1]);
        const panel = document.querySelector('.graphfrontier-sidepanel');
        panel.style.position = 'fixed';
        panel.style.top = '260px';
        panel.style.left = '20px';
        // Deterministic keyboard viewport: resize/offset events use the same production path.
        const viewport = new EventTarget();
        Object.assign(viewport, { width: 390, height: 800, offsetTop: 0, offsetLeft: 0 });
        Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
      });
      await input.click();
      const geometry = () =>
        page.evaluate(() => {
          const rect = (selector) => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
          };
          const list = document.querySelector('.graphfrontier-input-menu-list');
          return {
            menu: rect('.graphfrontier-input-menu'),
            input: rect('.graphfrontier-file-types-search input'),
            controls: rect('.graphfrontier-input-menu-controls'),
            buttons: [...document.querySelectorAll('.graphfrontier-input-menu-bulk')].map((el) => {
              const r = el.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
            }),
            list: rect('.graphfrontier-input-menu-list'),
            row: rect('.graphfrontier-input-menu-check-item'),
            scrollable: list.scrollHeight > list.clientHeight,
          };
        });
      const assertControls = (geo) => {
        assert(geo.buttons[0].right <= geo.buttons[1].left, 'buttons do not overlap');
        for (const button of geo.buttons) {
          assert(button.left >= geo.controls.left && button.right <= geo.controls.right);
          assert(button.top >= geo.controls.top && button.bottom <= geo.controls.bottom);
          assert(button.bottom <= geo.list.top, 'buttons do not overlap option rows');
        }
      };
      let geo = await geometry();
      assertControls(geo);
      assert(geo.menu.height >= 220 && geo.menu.height <= 248);
      assert(geo.menu.top >= geo.input.bottom + 4);
      assert(geo.scrollable);
      assert(geo.row.height >= 32 && geo.row.height <= 36);
      await page.evaluate(() => {
        const list = document.querySelector('.graphfrontier-input-menu-list');
        list.scrollTop = list.scrollHeight;
      });
      assert.deepEqual((await geometry()).controls, geo.controls, 'bulk controls do not scroll');
      for (const [height, offsetTop, panelTop, side] of [
        [380, 40, 260, 'above'],
        [180, 40, 90, 'above'],
        [380, 40, 50, 'below'],
      ]) {
        await page.evaluate(
          ({ height, offsetTop, panelTop }) => {
            document.querySelector('.graphfrontier-sidepanel').style.top = panelTop + 'px';
            Object.assign(window.visualViewport, { height, offsetTop });
            window.visualViewport.dispatchEvent(new Event('resize'));
            window.visualViewport.dispatchEvent(new Event('scroll'));
          },
          { height, offsetTop, panelTop }
        );
        geo = await geometry();
        assertControls(geo);
        assert(geo.menu.top >= offsetTop + 8);
        assert(geo.menu.bottom <= offsetTop + height - 8);
        assert(geo.menu.left >= 8 && geo.menu.right <= 382);
        assert(geo.menu.height <= 248);
        await page.evaluate(() => {
          document.querySelector('.graphfrontier-sidepanel').style.width = '130px';
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        assertControls(await geometry());
        if (side === 'above') assert(geo.menu.bottom <= geo.input.top - 4);
        else assert(geo.menu.top >= geo.input.bottom + 4);
      }
    } finally {
      await browser.close();
    }
  }
);
