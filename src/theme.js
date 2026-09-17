const DARK_THEME = Object.freeze({
  colorScheme: 'dark',
  background: '#111418',
  surface: '#1e222a',
  text: '#e6e8ed',
  mutedText: '#9ea4af',
  border: '#454b55',
  selection: '#a6ccff',
  grid: '#9ea4af',
  gridOpacity: 0.2,
});

// Resolve inherited variables on the graph element, using its own window for popouts.
// Called on open, resize and CSS changes, never per node or animation frame.
function readGraphTheme(element) {
  const doc = element?.ownerDocument;
  const win = doc?.defaultView || element?.win;
  const isLight = !!(
    doc?.body?.classList.contains('theme-light') ||
    doc?.documentElement?.classList.contains('theme-light')
  );
  const fallback = isLight
    ? {
        ...DARK_THEME,
        colorScheme: 'light',
        background: '#ffffff',
        surface: '#f6f6f6',
        text: '#222222',
        mutedText: '#666666',
        border: '#d4d4d4',
        selection: '#375fb5',
        grid: '#666666',
      }
    : DARK_THEME;
  if (!element || !win?.getComputedStyle) return { ...fallback };
  const styles = win.getComputedStyle(element);
  const color = (name, defaultColor) => styles.getPropertyValue(name).trim() || defaultColor;
  const text = color('--text-normal', fallback.text);
  const mutedText = color('--text-muted', fallback.mutedText);
  return {
    colorScheme: fallback.colorScheme,
    background: color('--background-primary', fallback.background),
    surface: color('--background-secondary', fallback.surface),
    text,
    mutedText,
    border: color('--background-modifier-border', fallback.border),
    selection: color('--text-accent', text),
    grid: mutedText,
    gridOpacity: fallback.gridOpacity,
  };
}

// Self-contained: embedded verbatim into static exports to keep label rules identical.
function getLabelAppearance(zoom, minZoom, baseSize, nodeAlpha = 1, emphasized = false) {
  const fontSize = Math.max(10, baseSize * zoom);
  if (emphasized) return { alpha: 1, fontSize };
  if (zoom < minZoom) return { alpha: 0, fontSize };
  const fade = Math.max(0, Math.min(1, (zoom - minZoom) / Math.max(0.001, minZoom * 0.35)));
  const alpha = (0.65 + 0.35 * fade) * Math.max(0, Math.min(1, nodeAlpha));
  return { alpha: Math.max(0.45, alpha), fontSize };
}

module.exports = { DARK_THEME, readGraphTheme, getLabelAppearance };
