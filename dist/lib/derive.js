// Pure functions that derive repository metadata from README text and
// manifest files. No network access here; see src/inspect.js for fetching.

export const DESCRIPTION_MAX = 200;
export const TOPICS_MAX = 8;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '--', ndash: '-', hellip: '...' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

// Removes YAML (---) or TOML (+++) frontmatter at the very start.
export function stripFrontmatter(text) {
  return text.replace(/^(---|\+\+\+)[ \t]*\n[\s\S]*?\n(\1|\.\.\.)[ \t]*(\n|$)/, '');
}

function normaliseNewlines(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

// Markdown images, including linked images and reference-style images.
function removeImages(text) {
  return text
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    .replace(/\[!\[[^\]]*\]\[[^\]]*\]\]\([^)]*\)/g, ' ')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\[[^\]]*\]/g, ' ')
    .replace(/\[!\[[^\]]*\]\[[^\]]*\]\]\[[^\]]*\]/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, ' ');
}

// Converts HTML to markdown-ish plain text: headings dropped, block
// elements become paragraph breaks, other tags are removed but their text kept.
function flattenHtml(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n\n')
    .replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, '\n\n')
    .replace(/<(img|source|video|picture|svg)\b[^>]*\/?>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(p|div|table|tr|td|th|ul|ol|li|details|summary|center|section|header|footer|blockquote|hr)\b[^>]*>/gi, '\n\n')
    .replace(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi, '');
}

function inlineToText(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNavigationOnly(block) {
  const withoutLinks = block
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]\[[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  return !/[\p{L}\p{N}]/u.test(withoutLinks);
}

/**
 * Trims text to at most `max` characters, preferring a sentence boundary and
 * falling back to a word boundary with an ASCII ellipsis.
 */
export function trimDescription(text, max = DESCRIPTION_MAX) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  let best = -1;
  const sentenceEnd = /[.!?](?=\s|$)/g;
  let match;
  while ((match = sentenceEnd.exec(clean)) !== null) {
    if (match.index + 1 <= max) best = match.index + 1;
    else break;
  }
  if (best >= 40) return clean.slice(0, best);
  const cut = clean.slice(0, max - 3);
  const space = cut.lastIndexOf(' ');
  const base = (space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-]+$/, '');
  return `${base}...`;
}

/**
 * Returns the first real paragraph of a README as a description, or null.
 * Skips frontmatter, headings, badge rows, images, navigation link rows,
 * code, tables, lists, HTML-only blocks and GitHub alert blockquotes.
 */
export function deriveDescription(markdown, { repoName = '', max = DESCRIPTION_MAX } = {}) {
  let text = normaliseNewlines(markdown);
  text = stripFrontmatter(text);
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|$(?![\s\S]))/gm, '\n\n');
  text = removeImages(text);
  text = flattenHtml(text);
  text = decodeEntities(text);

  const blocks = text.split(/\n[ \t]*\n/);
  for (const raw of blocks) {
    let lines = raw.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    // Setext headings: a line followed by === or ---.
    const kept = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const next = lines[i + 1];
      if (next !== undefined && /^\s*(=+|-+)\s*$/.test(next) && line.trim() !== '') {
        i += 1;
        continue;
      }
      if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) continue;
      if (/^\s{0,3}\[[^\]]+\]:\s*\S+/.test(line)) continue;
      kept.push(line);
    }
    lines = kept;
    if (lines.length === 0) continue;
    const first = lines[0];
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(first)) continue;
    if (/^\s*\|/.test(first)) continue;
    if (/^\s{0,3}([-*+]|\d+[.)])\s+/.test(first)) continue;
    if (lines.every((line) => /^( {4}|\t)/.test(line))) continue;
    if (/^\s{0,3}>/.test(first)) {
      if (/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(lines.join(' '))) continue;
      lines = lines.map((line) => line.replace(/^\s{0,3}>\s?/, ''));
    }
    const block = lines.join('\n');
    if (isNavigationOnly(block)) continue;
    const plain = inlineToText(block);
    if (plain.length < 12 || !/\p{L}/u.test(plain)) continue;
    if (repoName && plain.toLowerCase() === repoName.toLowerCase()) continue;
    return trimDescription(plain, max);
  }
  return null;
}

// --- topics ---------------------------------------------------------------

const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

export function normaliseTopic(value) {
  const topic = String(value ?? '')
    .toLowerCase()
    .replace(/\+/g, 'p')
    .replace(/#/g, 'sharp')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return TOPIC_RE.test(topic) ? topic : null;
}

export function isValidTopic(topic) {
  return TOPIC_RE.test(topic);
}

const LANGUAGE_TOPICS = {
  'c++': 'cpp',
  'c#': 'csharp',
  'f#': 'fsharp',
  'objective-c': 'objective-c',
  'objective-c++': 'objective-cpp',
  'jupyter notebook': 'jupyter-notebook',
  'vim script': 'vim',
  'vim snippet': 'vim',
  'emacs lisp': 'emacs-lisp',
};

export function languageTopic(language) {
  if (!language) return null;
  const key = String(language).toLowerCase();
  return LANGUAGE_TOPICS[key] ?? normaliseTopic(key);
}

// package.json dependency name -> topic.
const PACKAGE_TOPICS = [
  ['next', 'nextjs'],
  ['react', 'react'],
  ['react-native', 'react-native'],
  ['vue', 'vue'],
  ['nuxt', 'nuxt'],
  ['svelte', 'svelte'],
  ['@angular/core', 'angular'],
  ['express', 'express'],
  ['fastify', 'fastify'],
  ['@nestjs/core', 'nestjs'],
  ['electron', 'electron'],
];

// Root file name (lower-case) -> topics.
const MANIFEST_TOPICS = [
  ['package.swift', ['swift', 'swiftpm']],
  ['cargo.toml', ['rust']],
  ['pyproject.toml', ['python']],
  ['requirements.txt', ['python']],
  ['setup.py', ['python']],
  ['pipfile', ['python']],
  ['go.mod', ['go']],
  ['gemfile', ['ruby']],
  ['composer.json', ['php']],
];

const GENERIC_HOST_LABELS = new Set([
  'www', 'com', 'net', 'org', 'io', 'dev', 'app', 'co', 'me', 'sh', 'ai', 'xyz', 'site', 'online', 'page', 'pages',
  'github', 'gitlab', 'bitbucket', 'vercel', 'netlify', 'herokuapp', 'heroku', 'surge', 'firebaseapp', 'web',
  'render', 'onrender', 'fly', 'railway', 'workers', 'cloudflare', 'glitch', 'repl', 'docs', 'doc', 'blog', 'api',
  'home', 'demo', 'staging', 'beta', 'test', 'localhost',
]);

const SECOND_LEVEL_SUFFIXES = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

/**
 * Keyword from a homepage host name: the registrable domain label (for
 * docs.example.com that is "example"), unless it is a hosting provider,
 * generic, or the owner login. GitHub Pages hosts yield nothing.
 */
export function homepageKeywords(homepage, { owner = '' } = {}) {
  if (!homepage) return [];
  let host;
  try {
    host = new URL(/^https?:\/\//i.test(homepage) ? homepage : `https://${homepage}`).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (host.endsWith('.github.io') || /^[\d.]+$/.test(host)) return [];
  const labels = host.split('.');
  if (labels.length < 2) return [];
  labels.pop(); // top level domain
  if (labels.length >= 2 && SECOND_LEVEL_SUFFIXES.has(labels[labels.length - 1])) labels.pop(); // example.co.uk
  const label = labels[labels.length - 1];
  if (GENERIC_HOST_LABELS.has(label)) return [];
  if (owner && label === owner.toLowerCase()) return [];
  if (label.length < 3 || /^\d+$/.test(label)) return [];
  const topic = normaliseTopic(label);
  return topic ? [topic] : [];
}

/**
 * Derives up to `max` topics from the primary language, manifest files at
 * the repository root, package.json dependencies and the homepage domain.
 *
 * @param {object} input
 * @param {string|null} input.language primary language from the API
 * @param {string[]} input.files names of files in the repository root
 * @param {object|null} input.packageJson parsed package.json, if present
 * @param {string|null} input.homepage
 * @param {string} [input.owner]
 */
export function deriveTopics({ language = null, files = [], packageJson = null, homepage = null, owner = '', max = TOPICS_MAX } = {}) {
  const topics = [];
  const add = (topic) => {
    const t = topic && normaliseTopic(topic);
    if (t && !topics.includes(t)) topics.push(t);
  };
  add(languageTopic(language));

  const names = new Set(files.map((f) => String(f).toLowerCase()));
  if (packageJson && typeof packageJson === 'object') {
    const deps = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
      ...(packageJson.peerDependencies ?? {}),
    };
    for (const [dep, topic] of PACKAGE_TOPICS) {
      if (Object.hasOwn(deps, dep)) add(topic);
    }
  }
  for (const [file, fileTopics] of MANIFEST_TOPICS) {
    if (names.has(file)) fileTopics.forEach(add);
  }
  homepageKeywords(homepage, { owner }).forEach(add);
  return topics.slice(0, max);
}

// --- homepage ---------------------------------------------------------------

// Hosts that are almost never a project's own site: code hosts, badges, CI,
// package registries, licences, social networks and deploy buttons.
const IGNORED_HOSTS = [
  'github.com', 'gist.github.com', 'raw.githubusercontent.com', 'user-images.githubusercontent.com',
  'avatars.githubusercontent.com', 'camo.githubusercontent.com', 'objects.githubusercontent.com', 'docs.github.com',
  'gitlab.com', 'bitbucket.org', 'shields.io', 'img.shields.io', 'badgen.net', 'badge.fury.io', 'travis-ci.org',
  'travis-ci.com', 'circleci.com', 'app.circleci.com', 'codecov.io', 'coveralls.io', 'app.codecov.io',
  'npmjs.com', 'npmjs.org', 'npm.im', 'pypi.org', 'crates.io', 'docs.rs', 'pkg.go.dev', 'goreportcard.com',
  'rubygems.org', 'packagist.org', 'nuget.org', 'hub.docker.com', 'opensource.org', 'choosealicense.com',
  'creativecommons.org', 'spdx.org', 'gnu.org', 'twitter.com', 'x.com', 'linkedin.com', 'facebook.com',
  'instagram.com', 'youtube.com', 'youtu.be', 'discord.gg', 'discord.com', 't.me', 'reddit.com',
  'stackoverflow.com', 'gitter.im', 'buymeacoffee.com', 'ko-fi.com', 'patreon.com', 'paypal.me', 'paypal.com',
  'opencollective.com', 'github.dev', 'vercel.com', 'netlify.com', 'app.netlify.com', 'heroku.com',
  'dashboard.heroku.com', 'railway.app', 'render.com', 'marketplace.visualstudio.com', 'wikipedia.org',
  'nodejs.org', 'python.org', 'developer.apple.com', 'developer.mozilla.org', 'example.com', 'example.org',
  'localhost', '127.0.0.1', '0.0.0.0', 'deepwiki.com', 'star-history.com', 'api.star-history.com',
  'contrib.rocks', 'forthebadge.com', 'semver.org', 'keepachangelog.com', 'conventionalcommits.org',
];

function isIgnoredHost(host) {
  return IGNORED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function cleanUrl(raw) {
  const trimmed = raw.replace(/[.,;:!?'")\]>]+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Finds the single obvious project site linked from a README.
 * @returns {{ url: string|null, reason: 'found'|'none'|'ambiguous', hosts: string[] }}
 */
export function deriveHomepage(markdown) {
  let text = normaliseNewlines(markdown);
  text = stripFrontmatter(text);
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|$(?![\s\S]))/gm, '\n');
  text = removeImages(text);
  text = text.replace(/<img\b[^>]*>/gi, ' ').replace(/<source\b[^>]*>/gi, ' ');

  const raws = [];
  for (const m of text.matchAll(/\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) raws.push(m[1]);
  for (const m of text.matchAll(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) raws.push(m[1]);
  for (const m of text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(https?:\/\/\S+?)>?(\s|$)/gm)) raws.push(m[1]);
  const stripped = text
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/href\s*=\s*["'][^"']*["']/gi, '')
    .replace(/^\s{0,3}\[[^\]]+\]:.*$/gm, '');
  for (const m of stripped.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) raws.push(m[0]);

  const byHost = new Map();
  for (const raw of raws) {
    const url = cleanUrl(raw);
    if (!url) continue;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (isIgnoredHost(host)) continue;
    // A project site on a shared Pages host lives under its first path
    // segment; anywhere else the site root is the homepage.
    const shared = /\.(github|gitlab)\.io$/.test(host);
    const segment = shared ? url.pathname.split('/').filter(Boolean)[0] : null;
    const normalised = `${url.protocol}//${url.host}${segment ? `/${segment}` : ''}`;
    const key = segment ? `${host}/${segment}` : host;
    if (!byHost.has(key)) byHost.set(key, new Set());
    byHost.get(key).add(normalised);
  }
  const hosts = [...byHost.keys()];
  if (hosts.length === 0) return { url: null, reason: 'none', hosts };
  if (hosts.length > 1) return { url: null, reason: 'ambiguous', hosts };
  const urls = [...byHost.get(hosts[0])].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return { url: urls[0], reason: 'found', hosts };
}
