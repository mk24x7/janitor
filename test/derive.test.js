import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveDescription,
  deriveHomepage,
  deriveTopics,
  homepageKeywords,
  normaliseTopic,
  trimDescription,
} from '../src/derive.js';
import { fixture } from './helpers.js';

// --- description --------------------------------------------------------------

test('description: skips YAML frontmatter and headings', () => {
  assert.equal(
    deriveDescription(fixture('readme-frontmatter.md')),
    'A tiny widget that renders countdown timers for static sites.',
  );
});

test('description: skips a badges-only first line and navigation link rows', () => {
  assert.equal(
    deriveDescription(fixture('readme-badges.md')),
    'Fast, in-memory work queue for Node.js with async workers and back pressure. See the guide for details.',
  );
});

test('description: flattens HTML READMEs and decodes entities', () => {
  assert.equal(
    deriveDescription(fixture('readme-html.md')),
    'A static site generator for docs & blogs, written in Go. Zero config, instant reloads.',
  );
});

test('description: setext headings and repo-name-only lines are skipped', () => {
  const md = 'widget\n======\n\nwidget\n\nRenders countdown timers without any dependencies.\n';
  assert.equal(deriveDescription(md, { repoName: 'widget' }), 'Renders countdown timers without any dependencies.');
});

test('description: code blocks, lists, tables and alerts are not descriptions', () => {
  const md = [
    '# Tool',
    '',
    '```sh',
    'npm install tool --save-dev please',
    '```',
    '',
    '- a list item that is long enough',
    '',
    '| a | table row that is long |',
    '',
    '> [!NOTE]',
    '> This is an alert, not a description.',
    '',
    '> A blockquote tagline that describes the tool.',
  ].join('\n');
  assert.equal(deriveDescription(md), 'A blockquote tagline that describes the tool.');
});

test('description: returns null when there is no usable paragraph', () => {
  assert.equal(deriveDescription('# Title\n\n## Install\n\n```\nnpm i\n```\n'), null);
  assert.equal(deriveDescription(''), null);
  assert.equal(deriveDescription('[![a](b)](c)\n'), null);
});

test('description: CRLF line endings and a BOM are handled', () => {
  assert.equal(deriveDescription('\uFEFF# T\r\n\r\nWorks with Windows line endings too.\r\n'), 'Works with Windows line endings too.');
});

test('description: long text is trimmed to 200 characters at a sentence end', () => {
  const first = 'This project does one thing well and is described by a fairly long opening sentence here.';
  const second = ' The second sentence keeps going and going with even more words so the total is over the limit for sure.';
  const out = deriveDescription(`# X\n\n${first}${second}${second}`);
  assert.ok(out.length <= 200);
  assert.equal(out, `${first}${second}`.slice(0, out.length));
  assert.match(out, /\.$/);
});

test('trimDescription falls back to a word boundary with an ASCII ellipsis', () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const out = trimDescription(words);
  assert.ok(out.length <= 200);
  assert.match(out, /word\d+\.\.\.$/);
  assert.equal(trimDescription('short'), 'short');
});

// --- topics -------------------------------------------------------------------

test('topics: language plus next and react from package.json', () => {
  assert.deepEqual(
    deriveTopics({ language: 'TypeScript', files: ['package.json'], packageJson: fixture('package-next.json') }),
    ['typescript', 'nextjs', 'react'],
  );
});

test('topics: express and vue from dependencies and devDependencies', () => {
  const pkg = { dependencies: { express: '^4' }, devDependencies: { vue: '^3' } };
  assert.deepEqual(deriveTopics({ language: 'JavaScript', files: ['package.json'], packageJson: pkg }), ['javascript', 'vue', 'express']);
});

test('topics: Package.swift gives swift and swiftpm', () => {
  assert.deepEqual(deriveTopics({ language: 'Swift', files: ['Package.swift', 'Sources'] }), ['swift', 'swiftpm']);
});

test('topics: Cargo.toml, go.mod, Gemfile and composer.json', () => {
  assert.deepEqual(deriveTopics({ files: ['Cargo.toml'] }), ['rust']);
  assert.deepEqual(deriveTopics({ files: ['go.mod'] }), ['go']);
  assert.deepEqual(deriveTopics({ files: ['Gemfile'] }), ['ruby']);
  assert.deepEqual(deriveTopics({ files: ['composer.json'] }), ['php']);
});

test('topics: pyproject.toml or requirements.txt give python once', () => {
  assert.deepEqual(deriveTopics({ language: 'Python', files: ['pyproject.toml', 'requirements.txt'] }), ['python']);
  assert.deepEqual(deriveTopics({ files: ['requirements.txt'] }), ['python']);
});

test('topics: homepage domain keyword, excluding hosts, generic labels and the owner', () => {
  assert.deepEqual(deriveTopics({ language: 'Go', homepage: 'https://docs.lumen.build/start' }), ['go', 'lumen']);
  assert.deepEqual(homepageKeywords('https://mk.github.io/lumen'), []);
  assert.deepEqual(homepageKeywords('https://tool.mk24x7.com', { owner: 'mk24x7' }), []);
  assert.deepEqual(homepageKeywords('https://my-app.vercel.app'), []);
  assert.deepEqual(homepageKeywords('https://shop.example.co.uk'), ['example']);
});

test('topics: normalised to the GitHub topic charset and capped at 8', () => {
  assert.equal(normaliseTopic('C++'), 'cpp');
  assert.equal(normaliseTopic('Jupyter Notebook'), 'jupyter-notebook');
  assert.equal(normaliseTopic('--Weird__Name!!'), 'weird-name');
  assert.equal(normaliseTopic('***'), null);
  assert.deepEqual(deriveTopics({ language: 'C#' }), ['csharp']);
  const pkg = { dependencies: { next: '1', react: '1', vue: '1', nuxt: '1', svelte: '1', express: '1', fastify: '1', electron: '1' } };
  const topics = deriveTopics({ language: 'TypeScript', files: ['package.json', 'go.mod'], packageJson: pkg });
  assert.equal(topics.length, 8);
  for (const t of topics) assert.match(t, /^[a-z0-9][a-z0-9-]{0,49}$/);
});

test('topics: nothing to derive gives an empty list', () => {
  assert.deepEqual(deriveTopics({ language: null, files: ['README.md'] }), []);
});

// --- homepage -----------------------------------------------------------------

test('homepage: a single site linked from the README is used (site root)', () => {
  assert.deepEqual(deriveHomepage(fixture('readme-badges.md')), { url: 'https://fastq.dev', reason: 'found', hosts: ['fastq.dev'] });
  assert.equal(deriveHomepage(fixture('readme-html.md')).url, 'https://lumen.build');
});

test('homepage: several candidate sites are ambiguous and skipped', () => {
  const r = deriveHomepage('See https://one.dev and [two](https://two.dev).');
  assert.equal(r.url, null);
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.hosts, ['two.dev', 'one.dev']);
});

test('homepage: badges, registries, GitHub and images are ignored', () => {
  const md = '[![b](https://img.shields.io/x)](https://www.npmjs.com/package/x) ![shot](https://cdn.example.net/s.png) [src](https://github.com/mk/x)';
  assert.deepEqual(deriveHomepage(md), { url: null, reason: 'none', hosts: [] });
});

test('homepage: GitHub Pages project sites keep their first path segment', () => {
  assert.equal(deriveHomepage('Docs: https://mk.github.io/tool/guide/intro').url, 'https://mk.github.io/tool');
  assert.equal(deriveHomepage('https://mk.github.io/a and https://mk.github.io/b').reason, 'ambiguous');
});
