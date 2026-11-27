// The TheoremDesk mark: ⊢, the turnstile, logic's symbol for "proves".
// A paper-white upright and a gold bar on a deep indigo tile.

'use strict';

const COLORS = {
	tileTop: '#33408A',
	tileBottom: '#10142F',
	paper: '#F5F2EA',
	goldLight: '#F7D27A',
	goldDark: '#D6922A',
};

/**
 * The ⊢ bars inside a box at (x, y) of size `s`, centred. The gold bar is
 * drawn first so the paper upright stays whole and the bar grows out of it.
 */
function turnstile(x, y, s, paper, gold) {
	const w = s * 0.13; // bar thickness: thick enough to read at 16 px
	const r = w / 2;
	const reach = s * 0.48; // width of the whole glyph
	const height = s * 0.56;
	const left = x + (s - reach) / 2;
	const top = y + (s - height) / 2;
	return [
		`<rect x="${left}" y="${y + s / 2 - r}" width="${reach}" height="${w}" rx="${r}" fill="${gold}"/>`,
		`<rect x="${left}" y="${top}" width="${w}" height="${height}" rx="${r}" fill="${paper}"/>`,
	].join('\n  ');
}

/**
 * The app icon. `padding` is the empty margin around the tile, as a fraction
 * of the size: macOS icons sit inside an 824/1024 grid, others fill more.
 */
function appIcon(size = 1024, padding = 0.047) {
	const inset = size * padding;
	const tile = size - 2 * inset;
	const radius = tile * 0.225;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${COLORS.tileTop}"/>
      <stop offset="1" stop-color="${COLORS.tileBottom}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.10"/>
      <stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${COLORS.goldLight}"/>
      <stop offset="1" stop-color="${COLORS.goldDark}"/>
    </linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${radius}" fill="url(#tile)"/>
  <rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${radius}" fill="url(#sheen)"/>
  ${turnstile(inset, inset, tile, COLORS.paper, 'url(#gold)')}
</svg>
`;
}

/** The bare ⊢ in one colour, for the empty-editor watermark (40x40, like VS Code's). */
function mark(fill, opacity) {
	// Group opacity, so the bars' overlap isn't darker than the rest.
	const o = opacity === undefined ? '' : ` opacity="${opacity}"`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
  <g${o}>
  ${turnstile(2, 2, 36, fill, fill)}
  </g>
</svg>
`;
}

/** A tall installer side image: the tile's gradient with the mark near the top. */
function installerBanner(width, height) {
	const s = width * 0.62;
	const x = (width - s) / 2;
	const y = height * 0.16;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="${COLORS.tileTop}"/>
      <stop offset="1" stop-color="${COLORS.tileBottom}"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${COLORS.goldLight}"/>
      <stop offset="1" stop-color="${COLORS.goldDark}"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  ${turnstile(x, y, s, COLORS.paper, 'url(#gold)')}
</svg>
`;
}

module.exports = { COLORS, appIcon, mark, installerBanner };
