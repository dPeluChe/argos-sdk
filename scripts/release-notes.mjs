import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Release payload for the tarball upload: stdin is the existing release (empty when
// there is none), the output is the JSON body for POST or PATCH. The checksums sit
// between markers so a re-run replaces them and keeps the rest of the notes.
const [tarball, repo, tag] = process.argv.slice(2);
const file = basename(tarball);
const bytes = readFileSync(tarball);
const hash = (algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);

const open = '<!-- argos-sdk-checksums -->';
const close = '<!-- /argos-sdk-checksums -->';
const block = [
  open,
  `Checksums of \`${file}\`:`,
  '',
  `- npm integrity: \`sha512-${hash('sha512', 'base64')}\``,
  `- sha256: \`${hash('sha256', 'hex')}\``,
  close,
].join('\n');

let old = '';
try {
  old = JSON.parse(readFileSync(0, 'utf8')).body ?? '';
} catch {
  // No release yet, or an answer that is not JSON: start from the install line.
}
const [before, rest = ''] = old.split(open);
const after = rest.includes(close) ? rest.split(close)[1] : '';
const kept = [before, after]
  .map((part) => part.trim())
  .filter(Boolean)
  .join('\n\n');
const install = `Install: npm install https://github.com/${repo}/releases/download/${tag}/${file}`;

console.log(JSON.stringify({ tag_name: tag, name: tag, body: `${kept || install}\n\n${block}` }));
