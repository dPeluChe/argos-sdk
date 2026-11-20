// Fails on a high or critical advisory in a production dependency unless
// .dependency-exceptions has a reviewed "npm|<advisory id>|<package>|reason" row.
// npm audit has no exception list of its own, so the gate reads its JSON report.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const listed = new Set(
  existsSync('.dependency-exceptions')
    ? readFileSync('.dependency-exceptions', 'utf8')
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('#'))
        .map((line) => {
          const [ecosystem, id, name, reason] = line.split('|').map((part) => part.trim());
          if (!reason) throw new Error(`exception without a reason: ${line}`);
          return `${ecosystem}|${id}|${name}`;
        })
    : [],
);

const run = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
let report = null;
try {
  report = JSON.parse(run.stdout);
} catch {
  report = null;
}
if (!report || report.error || !report.vulnerabilities) {
  console.log('::error title=audit::npm audit did not return a report');
  process.exit(1);
}

let status = 0;
for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
  for (const advisory of vulnerability.via) {
    if (typeof advisory !== 'object' || !['high', 'critical'].includes(advisory.severity)) continue;
    const id = advisory.url.split('/').pop();
    if (listed.has(`npm|${id}|${name}`)) continue;
    console.log(`::error title=advisory::${name} ${advisory.severity}: ${advisory.title} (${id})`);
    status = 1;
  }
}
process.exitCode = status;
