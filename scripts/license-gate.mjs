// Fails on a production dependency whose license is off the allowlist and has no
// reviewed "npm|name|license|reason" row in .dependency-exceptions. Run after npm ci.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = JSON.parse(readFileSync('package.json', 'utf8')).name;

const ALLOWED = new Set([
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'ISC',
  'MPL-2.0',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
]);

const allowed = (expr) => {
  const s = expr.replace(/[()]/g, '').trim();
  if (ALLOWED.has(s)) return true;
  if (s.includes(' OR ') && !s.includes(' AND ')) return s.split(' OR ').some(allowed);
  if (s.includes(' AND ') && !s.includes(' OR ')) return s.split(' AND ').every(allowed);
  return false;
};

const listed = new Set(
  existsSync('.dependency-exceptions')
    ? readFileSync('.dependency-exceptions', 'utf8')
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('#'))
        .map((line) => {
          const [ecosystem, name, license, reason] = line.split('|').map((part) => part.trim());
          if (!reason) throw new Error(`exception without a reason: ${line}`);
          return `${ecosystem}|${name}|${license}`;
        })
    : [],
);

const report = JSON.parse(
  execFileSync('npx', ['--yes', 'license-checker-rseidelsohn@5.0.1', '--production', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);

let status = 0;
for (const [key, info] of Object.entries(report)) {
  const name = key.slice(0, key.lastIndexOf('@'));
  if (name === root) continue;
  const license = Array.isArray(info.licenses) ? info.licenses.join(' AND ') : info.licenses;
  if (allowed(license) || listed.has(`npm|${name}|${license}`)) continue;
  console.log(
    `::error title=license::${key} is ${license}: not on the allowlist and not in .dependency-exceptions`,
  );
  status = 1;
}
process.exitCode = status;
