import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCwd, resolveSession } from '../lib/session-resolver.js';

test('encodeCwd replaces / and . with -', () => {
  assert.equal(encodeCwd('/workspace/projects/belfry'), '-workspace-projects-belfry');
  assert.equal(encodeCwd('/home/node/.claude/projects/x'), '-home-node--claude-projects-x');
});

function makeFakeFs({ dirs }) {
  // dirs: { '/some/dir': [{ name: 'a.jsonl', mtimeMs: 100 }, ...] }
  return {
    readdirSync(d) {
      if (!(d in dirs)) {
        const err = new Error(`ENOENT: ${d}`);
        err.code = 'ENOENT';
        throw err;
      }
      return dirs[d].map((e) => e.name);
    },
    statSync(full) {
      for (const [d, entries] of Object.entries(dirs)) {
        for (const entry of entries) {
          if (`${d}/${entry.name}` === full) return { mtimeMs: entry.mtimeMs };
        }
      }
      const err = new Error(`ENOENT: ${full}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

test('resolveSession returns most recent .jsonl uuid', () => {
  const fsImpl = makeFakeFs({
    dirs: {
      '/projects/-workspace-projects-belfry': [
        { name: 'old-session-id.jsonl', mtimeMs: 100 },
        { name: 'newer-session-id.jsonl', mtimeMs: 200 },
        { name: 'oldest-session-id.jsonl', mtimeMs: 50 },
      ],
    },
  });
  const id = resolveSession('/workspace/projects/belfry', { fsImpl, projectsDir: '/projects' });
  assert.equal(id, 'newer-session-id');
});

test('resolveSession returns null when dir does not exist', () => {
  const fsImpl = makeFakeFs({ dirs: {} });
  const id = resolveSession('/no/such/path', { fsImpl, projectsDir: '/projects' });
  assert.equal(id, null);
});

test('resolveSession returns null when dir has no .jsonl files', () => {
  const fsImpl = makeFakeFs({
    dirs: {
      '/projects/-workspace-projects-belfry': [
        { name: 'memory', mtimeMs: 100 },
        { name: 'something.txt', mtimeMs: 200 },
      ],
    },
  });
  const id = resolveSession('/workspace/projects/belfry', { fsImpl, projectsDir: '/projects' });
  assert.equal(id, null);
});

test('resolveSession ignores non-.jsonl entries when picking most recent', () => {
  const fsImpl = makeFakeFs({
    dirs: {
      '/projects/-workspace-projects-belfry': [
        { name: 'a.jsonl', mtimeMs: 100 },
        { name: 'newer.txt', mtimeMs: 999 },
      ],
    },
  });
  const id = resolveSession('/workspace/projects/belfry', { fsImpl, projectsDir: '/projects' });
  assert.equal(id, 'a');
});

test('resolveSession returns null for empty or non-string cwd', () => {
  assert.equal(resolveSession('', { fsImpl: makeFakeFs({ dirs: {} }), projectsDir: '/projects' }), null);
  assert.equal(resolveSession(null, { fsImpl: makeFakeFs({ dirs: {} }), projectsDir: '/projects' }), null);
});
