'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const closeout = fs.readFileSync(
  path.join(__dirname, '..', 'references', 'closeout.md'),
  'utf8',
);
const releaseSection = closeout.slice(closeout.indexOf('## Release and version work'));

test('release instructions compare installed, source, and candidate identities', () => {
  assert.match(releaseSection, /`skills\/agflow-frugal\/SKILL\.md`'s `metadata\.version`/);
  assert.match(releaseSection, /installed runtime version, maintained development-source version, and release-candidate version separately/);
  assert.match(releaseSection, /owner's selected tested version is the stable target/);
  assert.match(releaseSection, /README heading, changelog release metadata and notes, and skill heading all agree/);
});

test('plugin manifest and skill metadata versions agree', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '.claude-plugin', 'plugin.json'),
    'utf8',
  ));
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const skillVersion = skill.match(/^metadata:\n  version: "([^"]+)"$/m)?.[1];

  assert.ok(skillVersion, 'SKILL.md metadata.version must be present');
  assert.equal(manifest.version, skillVersion);
});

test('release evidence is tied to a frozen candidate and invalidated by later edits', () => {
  assert.match(releaseSection, /Freeze the candidate at the exact version and source identity before required release checks/);
  assert.match(releaseSection, /Record the full candidate commit tested/);
  assert.match(releaseSection, /Any tracked-file change after those checks invalidates the evidence for publication/);
  assert.match(releaseSection, /rerun the required checks against it/);
});

test('publication approval names the exact stable version and full commit SHA', () => {
  assert.match(releaseSection, /Reply `Result Go: vX\.Y\.Z <full SHA>`/);
  assert.match(releaseSection, /Only that approved version-and-commit pair is eligible for publication/);
  assert.match(releaseSection, /verify the checked-out version and commit match the approved pair/);
});

test('publication verifies that the remote stable tag resolves to the approved commit', () => {
  assert.match(releaseSection, /verify the remote stable tag resolves to the approved commit/);
  assert.match(releaseSection, /if the tag is missing or points elsewhere, stop/);
});
