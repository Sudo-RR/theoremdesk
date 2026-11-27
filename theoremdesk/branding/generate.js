#!/usr/bin/env node
// Render every TheoremDesk branding asset from logo.js into
// theoremdesk/src/stable/, at the paths VSCodium's src/stable/ uses, so the
// build copies them over VSCodium's.
//
//   cd theoremdesk/branding && npm ci && node generate.js

'use strict';

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { appIcon, mark, installerBanner } = require('./logo');

const OUT = path.join(__dirname, '..', 'src', 'stable');

function write(relative, data) {
	const file = path.join(OUT, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
	console.log(`wrote ${relative} (${data.length} bytes)`);
}

function render(svg, width) {
	const image = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render();
	return { png: image.asPng(), pixels: image.pixels, width: image.width, height: image.height };
}

/** Windows .ico with PNG entries (supported since Windows Vista). */
function ico(svg, sizes) {
	const images = sizes.map((size) => render(svg, size).png);
	const header = Buffer.alloc(6 + 16 * sizes.length);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(sizes.length, 4);
	let offset = header.length;
	sizes.forEach((size, i) => {
		const entry = 6 + 16 * i;
		header.writeUInt8(size >= 256 ? 0 : size, entry);
		header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(images[i].length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += images[i].length;
	});
	return Buffer.concat([header, ...images]);
}

/** macOS .icns with PNG entries. */
function icns(svg) {
	const types = [
		['icp4', 16],
		['icp5', 32],
		['ic11', 32],
		['ic12', 64],
		['ic07', 128],
		['ic08', 256],
		['ic13', 256],
		['ic09', 512],
		['ic14', 512],
		['ic10', 1024],
	];
	const entries = types.map(([type, size]) => {
		const png = render(svg, size).png;
		const head = Buffer.alloc(8);
		head.write(type, 0, 'ascii');
		head.writeUInt32BE(png.length + 8, 4);
		return Buffer.concat([head, png]);
	});
	const body = Buffer.concat(entries);
	const head = Buffer.alloc(8);
	head.write('icns', 0, 'ascii');
	head.writeUInt32BE(body.length + 8, 4);
	return Buffer.concat([head, body]);
}

/** 24-bit BMP for the Inno Setup installer, composited over white. */
function bmp(svg, width, height) {
	const { pixels } = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
	const rowSize = Math.ceil((width * 3) / 4) * 4;
	const data = Buffer.alloc(rowSize * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const src = (y * width + x) * 4;
			const alpha = pixels[src + 3] / 255;
			const dst = (height - 1 - y) * rowSize + x * 3;
			for (let c = 0; c < 3; c++) {
				data[dst + 2 - c] = Math.round(pixels[src + c] * alpha + 255 * (1 - alpha));
			}
		}
	}
	const header = Buffer.alloc(54);
	header.write('BM', 0, 'ascii');
	header.writeUInt32LE(54 + data.length, 2);
	header.writeUInt32LE(54, 10);
	header.writeUInt32LE(40, 14);
	header.writeInt32LE(width, 18);
	header.writeInt32LE(height, 22);
	header.writeUInt16LE(1, 26);
	header.writeUInt16LE(24, 28);
	header.writeUInt32LE(data.length, 34);
	header.writeInt32LE(2835, 38);
	header.writeInt32LE(2835, 42);
	return Buffer.concat([header, data]);
}

const full = appIcon(1024, 0.047);
const mac = appIcon(1024, 0.098);

// Windows
write('resources/win32/code.ico', ico(full, [16, 24, 32, 48, 64, 128, 256]));
write('resources/win32/code_150x150.png', render(full, 150).png);
write('resources/win32/code_70x70.png', render(full, 70).png);
for (const scale of [100, 125, 150, 175, 200, 225, 250]) {
	const big = [Math.round(164 * scale / 100), Math.round(314 * scale / 100)];
	write(`resources/win32/inno-big-${scale}.bmp`, bmp(installerBanner(big[0], big[1]), big[0], big[1]));
	const small = Math.round(55 * scale / 100);
	write(`resources/win32/inno-small-${scale}.bmp`, bmp(full, small, small));
}
write(
	'resources/win32/VisualElementsManifest.xml',
	`<Application xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<VisualElements
		BackgroundColor="#1B2150"
		ShowNameOnSquare150x150Logo="on"
		Square150x150Logo="resources\\app\\resources\\win32\\code_150x150.png"
		Square70x70Logo="resources\\app\\resources\\win32\\code_70x70.png"
		ForegroundText="light"
		ShortDisplayName="TheoremDesk" />
</Application>
`,
);

// macOS
write('resources/darwin/code.icns', icns(mac));

// Linux
write('resources/linux/code.png', render(full, 1024).png);
write('resources/linux/code.svg', full);
write(
	'resources/linux/code.appdata.xml',
	`<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop">
	<id>@@NAME@@.desktop</id>
	<metadata_license>MIT</metadata_license>
	<project_license>MIT</project_license>
	<name>TheoremDesk</name>
	<url type="homepage">https://github.com/Sudo-RR/theoremdesk</url>
	<summary>The open-source scientific IDE for mathematics and theoretical physics</summary>
	<description>
		<p>TheoremDesk brings Lean 4, LaTeX, Python, Jupyter and symbolic computation together in one desktop app. Compute, formalise, and check proofs with several independent kernels.</p>
	</description>
</component>
`,
);

// Remote/web server
write('resources/server/code-192.png', render(full, 192).png);
write('resources/server/code-512.png', render(full, 512).png);
write('resources/server/favicon.ico', ico(full, [16, 32, 48]));

// Inside the workbench: title-bar icon and the empty-editor watermark
write('src/vs/workbench/browser/media/code-icon.svg', full);
const media = 'src/vs/workbench/browser/parts/editor/media';
write(`${media}/letterpress-dark.svg`, mark('#B2B2B2', 0.3));
write(`${media}/letterpress-light.svg`, mark('#B2B2B2', 0.1));
write(`${media}/letterpress-hcDark.svg`, mark('#3C3C3C'));
write(`${media}/letterpress-hcLight.svg`, mark('#B2B2B2'));

// The master artwork, for anything else that needs it
fs.writeFileSync(path.join(__dirname, 'logo.svg'), full);
console.log('wrote branding/logo.svg');
