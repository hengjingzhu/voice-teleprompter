// The agent guide: Codex reads .agents/skills, Claude Code reads .claude/skills.
// Both copies must stay identical, and CLAUDE.md only imports AGENTS.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const SKILLS = ['fix-mishearings', 'install-and-start', 'new-script', 'pick-and-trim'];
const dirs = (base) => fs.readdirSync(new URL(base, root), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

test('both skill folders hold the same four skills', () => {
  assert.deepEqual(dirs('.agents/skills/'), SKILLS);
  assert.deepEqual(dirs('.claude/skills/'), SKILLS);
});

for (const name of SKILLS) {
  test(`skill ${name}: copies identical, frontmatter has name and description`, () => {
    const a = fs.readFileSync(new URL(`.agents/skills/${name}/SKILL.md`, root));
    const c = fs.readFileSync(new URL(`.claude/skills/${name}/SKILL.md`, root));
    assert.ok(a.equals(c), `.agents and .claude copies of ${name} differ`);
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(a.toString('utf8'));
    assert.ok(fm, 'missing frontmatter');
    const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm[1])?.[1].trim();
    assert.equal(field('name'), name);
    assert.ok((field('description') || '').length > 40, 'description too short to trigger the skill');
  });
}

test('CLAUDE.md only imports AGENTS.md, and AGENTS.md lists every skill', () => {
  assert.equal(fs.readFileSync(new URL('CLAUDE.md', root), 'utf8').trim(), '@AGENTS.md');
  const agents = fs.readFileSync(new URL('AGENTS.md', root), 'utf8');
  for (const name of SKILLS) assert.ok(agents.includes(`\`${name}\``), `AGENTS.md does not mention ${name}`);
});
