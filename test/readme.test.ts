import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const README = readFileSync('README.md', 'utf8');

describe('README recipes', () => {
  // argos-frontend's agent brief links to these anchors for an app with no
  // platform set; renaming a heading breaks those links silently.
  it.each(['browser', 'nextjs', 'node', 'python', 'go', 'http'])(
    'keeps the heading behind #recipe-%s',
    (stack) => {
      expect(README).toContain(`\n### Recipe: ${stack}\n`);
    },
  );

  it('reads the DSN from configuration in every recipe', () => {
    const start = README.indexOf('## Recipes');
    const recipes = README.slice(start, README.indexOf('\n## ', start + 1));
    expect(recipes).not.toMatch(/dsn: '/);
    expect(recipes).not.toMatch(/dsn="/);
  });
});
