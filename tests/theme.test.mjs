import test from 'node:test';
import assert from 'node:assert/strict';
import { THEME_STORAGE_KEY, resolveTheme, themeColors, basemapTiles } from '../src/theme.mjs';

// WCAG relative luminance, independent of the application's palette helper.
function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i, 'colors must be valid six-digit sRGB values');
  const [red, green, blue] = hex.slice(1).match(/../g).map(channel => {
    const srgb = parseInt(channel, 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('an explicit stored choice takes precedence over either operating-system theme', () => {
  assert.equal(THEME_STORAGE_KEY, 'arg.autopistas.theme', 'keep the existing user preference key across releases');
  for (const prefersDark of [false, true]) {
    assert.equal(resolveTheme('light', prefersDark), 'light');
    assert.equal(resolveTheme('dark', prefersDark), 'dark');
  }
});

test('missing or invalid stored preferences follow the operating system', () => {
  const invalid = [undefined, null, '', 'system', 'Dark', 'LIGHT', ' dark ', 'false', false, 0, {}, []];
  for (const stored of invalid) {
    assert.equal(resolveTheme(stored, false), 'light', `light system with ${JSON.stringify(stored)}`);
    assert.equal(resolveTheme(stored, true), 'dark', `dark system with ${JSON.stringify(stored)}`);
  }
  assert.equal(resolveTheme(), 'light', 'use a readable light default when no preference is known');
});

test('both map themes have a distinct public gray base and matching reference layer', () => {
  const unique = new Set();
  for (const [theme, tone] of [['light', 'Light'], ['dark', 'Dark']]) {
    for (const [reference, layer] of [[false, 'Base'], [true, 'Reference']]) {
      const tiles = basemapTiles(theme, reference);
      assert.equal(tiles.length, 1);
      const url = new URL(tiles[0]);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.hostname, 'services.arcgisonline.com');
      assert.equal(url.username, '', 'no embedded account identity');
      assert.equal(url.password, '', 'no embedded credential');
      assert.equal(url.search, '', 'no API token or tracking query');
      assert.equal(url.hash, '');
      assert.equal(decodeURIComponent(url.pathname), `/ArcGIS/rest/services/Canvas/World_${tone}_Gray_${layer}/MapServer/tile/{z}/{y}/{x}`);
      unique.add(tiles[0]);
    }
  }
  assert.equal(unique.size, 4, 'base and labels must each switch between light and dark variants');
  assert.deepEqual(basemapTiles('light'), basemapTiles('light', false));
});

test('theme text and accent stay legible against their own surface and road halo', () => {
  for (const theme of ['light', 'dark']) {
    const palette = themeColors(theme);
    for (const field of ['accent', 'ink', 'surface', 'halo', 'context']) luminance(palette[field]);
    assert.ok(contrast(palette.ink, palette.surface) >= 4.5, `${theme}: small legend text has WCAG AA contrast`);
    assert.ok(contrast(palette.accent, palette.surface) >= 4.5, `${theme}: accent text remains legible`);
    assert.ok(contrast(palette.accent, palette.halo) >= 3, `${theme}: selected road remains distinguishable from its halo`);
  }
  assert.ok(luminance(themeColors('light').surface) > luminance(themeColors('dark').surface));
});

test('palette and tile outputs cannot contaminate another theme or a later call', () => {
  const palette = themeColors('light');
  const original = palette.accent;
  palette.accent = '#000000';
  assert.equal(themeColors('light').accent, original);
  assert.notEqual(themeColors('dark').accent, original);
  const tiles = basemapTiles('dark');
  const originalUrl = tiles[0];
  tiles[0] = 'https://invalid.example/';
  assert.equal(basemapTiles('dark')[0], originalUrl);
});
