'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function buildZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const compressed = zlib.deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const { dosTime, dosDate } = toDosTimeDate(entry.mtime || new Date());

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".cjs" ContentType="application/javascript" />
  <Default Extension=".css" ContentType="text/css" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".png" ContentType="image/png" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".vscodeignore" ContentType="text/plain" />
</Types>
`;

const tags =
  Array.isArray(pkg.keywords) && pkg.keywords.length
    ? pkg.keywords.join(',')
    : 'graph,markdown,obsidian,knowledge-graph,visualization,mcp';
const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
const cleanRepoUrl = repoUrl.replace(/\.git$/i, '');
const supportUrl = pkg.bugs?.url || (cleanRepoUrl ? `${cleanRepoUrl}/issues` : '');
const extraProperties = [
  cleanRepoUrl
    ? `      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xmlEscape(cleanRepoUrl)}" />`
    : '',
  cleanRepoUrl && /github\.com/i.test(cleanRepoUrl)
    ? `      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="${xmlEscape(cleanRepoUrl)}" />`
    : '',
  supportUrl
    ? `      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="${xmlEscape(supportUrl)}" />`
    : '',
  pkg.galleryBanner?.color
    ? `      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="${xmlEscape(pkg.galleryBanner.color)}" />`
    : '',
  pkg.galleryBanner?.theme
    ? `      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="${xmlEscape(pkg.galleryBanner.theme)}" />`
    : '',
]
  .filter(Boolean)
  .join('\n');

const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(pkg.name)}" Version="${xmlEscape(pkg.version)}" Publisher="${xmlEscape(pkg.publisher)}" />
    <DisplayName>${xmlEscape(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(pkg.description)}</Description>
    <Tags>${xmlEscape(tags)}</Tags>
    <Categories>${xmlEscape((pkg.categories || ['Other']).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(pkg.engines?.vscode || '^1.85.0')}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
${extraProperties}
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/media/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/changelog.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const filesToInclude = [
  { src: 'package.json', dest: 'package.json' },
  { src: 'README.md', dest: 'readme.md' },
  { src: 'CHANGELOG.md', dest: 'changelog.md' },
  { src: 'LICENSE.txt', dest: 'LICENSE.txt' },
  { src: 'media/icon.png', dest: 'media/icon.png' },
  { src: 'media/activity-icon.svg', dest: 'media/activity-icon.svg' },
  { src: 'dist/extension.cjs', dest: 'dist/extension.cjs' },
  { src: 'dist/webview-bundle.js', dest: 'dist/webview-bundle.js' },
  { src: 'dist/webview.css', dest: 'dist/webview.css' },
];

const entries = [
  { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8'), mtime: new Date() },
  { name: 'extension.vsixmanifest', data: Buffer.from(vsixManifest, 'utf8'), mtime: new Date() },
];

for (const { src, dest } of filesToInclude) {
  const full = path.join(ROOT, src);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required package file: ${full}`);
  }
  const stat = fs.statSync(full);
  entries.push({
    name: `extension/${dest}`,
    data: fs.readFileSync(full),
    mtime: stat.mtime,
  });
}

const outVsix = path.join(ROOT, 'dist', `${pkg.name}-${pkg.version}.vsix`);
if (fs.existsSync(outVsix)) fs.unlinkSync(outVsix);
fs.writeFileSync(outVsix, buildZipBuffer(entries));

console.log('Packaged VSIX:', outVsix, fs.statSync(outVsix).size, 'bytes');
