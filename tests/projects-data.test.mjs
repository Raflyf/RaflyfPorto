import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVELOPER_PROFILE_I18N, PROJECTS_DATA, PROJECTS_DATA_I18N, getProjectsData } from '../src/data.js';

const existingIds = [
  'open-plagiarism-checker', 'spam-email-classifier', 'solar-system',
  'chat-bot', 'laser-pointer-ppt', 'fotokita-blur', 'web-portofolio',
];
const additions = [
  { id: 'wallpaper-live', title: 'WallpaperLive', category: 'tools', demoUrl: null },
  { id: 'transparent-bar', title: 'TransparentBar', category: 'tools', demoUrl: null },
  { id: 'livelydesk', title: 'LivelyDesk', category: 'web', demoUrl: 'https://livelydesk.vercel.app' },
];
const fields = [
  'id', 'title', 'category', 'categoryLabel', 'badge', 'description', 'longDescription',
  'keyFeatures', 'techStack', 'githubUrl', 'demoUrl', 'stars',
].sort();

test('both languages retain existing projects and append the three approved public projects', () => {
  const expectedIds = [...existingIds, ...additions.map(project => project.id)];
  for (const lang of ['id', 'en']) {
    const projects = getProjectsData(lang);
    assert.equal(projects.length, 10, lang);
    assert.deepEqual(projects.map(project => project.id), expectedIds, lang);
    assert.equal(new Set(projects.map(project => project.id)).size, projects.length, lang);
    assert.equal(new Set(projects.map(project => project.githubUrl.toLowerCase())).size, projects.length, lang);
    for (const project of projects) {
      assert.deepEqual(Object.keys(project).sort(), fields, `${lang}/${project.id}`);
      for (const field of ['title', 'categoryLabel', 'badge', 'description', 'longDescription']) {
        assert.equal(typeof project[field], 'string', `${lang}/${project.id}/${field}`);
        assert.ok(project[field].trim(), `${lang}/${project.id}/${field}`);
      }
      for (const field of ['techStack', 'keyFeatures']) {
        assert.ok(Array.isArray(project[field]) && project[field].length > 0, `${lang}/${project.id}/${field}`);
        assert.ok(project[field].every(value => typeof value === 'string' && value.trim()));
      }
      assert.ok(['ai-ml', 'tools', 'web'].includes(project.category));
      assert.ok(Number.isSafeInteger(project.stars) && project.stars >= 0);
      assert.match(project.githubUrl, /^https:\/\/github\.com\/Raflyf\/[A-Za-z0-9_.-]+$/);
      if (project.demoUrl !== null) {
        const url = new URL(project.demoUrl);
        assert.equal(url.protocol, 'https:');
        assert.equal(url.username + url.password, '');
      }
    }
  }
  for (const project of PROJECTS_DATA_I18N.id) {
    const translated = PROJECTS_DATA_I18N.en.find(value => value.id === project.id);
    for (const field of ['category', 'githubUrl', 'demoUrl', 'stars']) {
      assert.deepEqual(translated[field], project[field], `${project.id}/${field}`);
    }
    assert.equal(translated.keyFeatures.length, project.keyFeatures.length, project.id);
    assert.equal(translated.techStack.length, project.techStack.length, project.id);
  }
  assert.strictEqual(PROJECTS_DATA, PROJECTS_DATA_I18N.id);
  assert.strictEqual(getProjectsData('unknown'), PROJECTS_DATA_I18N.id);
});

test('new project links, categories and star defaults match the public snapshot without fake native demos', () => {
  for (const lang of ['id', 'en']) {
    for (const expected of additions) {
      const project = getProjectsData(lang).find(value => value.id === expected.id);
      assert.ok(project, `${lang}/${expected.id}`);
      for (const field of ['title', 'category', 'demoUrl']) {
        assert.equal(project[field], expected[field], `${lang}/${expected.id}/${field}`);
      }
      assert.equal(project.githubUrl, `https://github.com/Raflyf/${expected.title}`);
      assert.equal(project.stars, 1, 'Public GitHub snapshot: 2026-11-09');
      assert.deepEqual(project.techStack, PROJECTS_DATA_I18N.id.find(value => value.id === expected.id).techStack);
    }
    const portfolio = getProjectsData(lang).find(value => value.id === 'web-portofolio');
    assert.equal(portfolio.githubUrl, 'https://github.com/Raflyf/RaflyfPorto');
    assert.equal(DEVELOPER_PROFILE_I18N[lang].repoUrl, portfolio.githubUrl);
  }
});
