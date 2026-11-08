import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_STORAGE_KEY, emptyPresetLibrary, validateDpiSet, dpiSetFromConfiguration, removeDpiStage, validatePresetLibrary, readPresetLibrary, persistPresetLibrary, updatePresetLibrary, putPreset, deletePreset } from '../dist/presets.js';

const set = { values: [1600, 2400], currentStage: 2 };
const profile = { id: 'one', name: '日常', ...set };

test('DPI sets accept the 2/6 stage and 100/12000 DPI boundaries', () => {
  assert.deepEqual(validateDpiSet({ values: [100, 12000], currentStage: 1 }), { values: [100, 12000], currentStage: 1 });
  assert.deepEqual(validateDpiSet({ values: [100, 200, 400, 800, 1600, 12000], currentStage: 6 }).values.at(-1), 12000);
  for (const bad of [[], [800], Array(7).fill(800), [99, 800], [12100, 800], [2501, 800], ['1600', 800], Array(2)]) assert.throws(() => validateDpiSet({ values: bad, currentStage: 1 }));
  for (const currentStage of [0, 3, 1.5, '1', NaN]) assert.throws(() => validateDpiSet({ ...set, currentStage }));
});

test('deleting a stage preserves the selected value or clamps a removed last stage', () => {
  assert.deepEqual(removeDpiStage({ values: [800, 1600, 2400], currentStage: 3 }, 1), { values: [1600, 2400], currentStage: 2 });
  assert.deepEqual(removeDpiStage({ values: [800, 1600, 2400], currentStage: 3 }, 3), { values: [800, 1600], currentStage: 2 });
  assert.deepEqual(set.values, [1600, 2400]);
  assert.throws(() => removeDpiStage(set, 1), /至少/);
  assert.deepEqual(removeDpiStage({ values: [800, 1600, NaN], currentStage: 1 }, 3), { values: [800, 1600], currentStage: 1 });
});

test('board conversion refuses to flatten unequal X/Y silently', () => {
  assert.throws(() => dpiSetFromConfiguration({ dpiStages: [{ xDpi: 1600, yDpi: 1700 }], currentStage: 1 }), /X\/Y/);
});

test('preset library persists independent named sets and removes only the target', () => {
  const first = putPreset(emptyPresetLibrary(), profile);
  const next = putPreset(first, { id: 'two', name: ' 游戏 ', values: [800, 1600], currentStage: 1 });
  const renamed = putPreset(next, { ...profile, name: '办公' });
  assert.equal(first.profiles.length, 1);
  assert.equal(renamed.profiles[1].name, '游戏');
  assert.deepEqual(deletePreset(renamed, 'one').profiles.map((item) => item.id), ['two']);
});

test('import accepts only DPI fields and rejects foreign products, duplicate IDs and invalid sets', () => {
  const library = putPreset(emptyPresetLibrary(), { ...profile, packetHex: 'ignored' });
  const parsed = validatePresetLibrary({ ...library, packetHex: 'not a device backup', profiles: [{ ...profile, pollingRate: 125 }] });
  assert.equal(parsed.packetHex, undefined);
  assert.equal(parsed.profiles[0].pollingRate, undefined);
  assert.throws(() => validatePresetLibrary({ ...library, productCode: 'other' }));
  assert.throws(() => validatePresetLibrary({ ...library, profiles: [profile, profile] }), /重复/);
  assert.throws(() => validatePresetLibrary({ ...library, profiles: [{ ...profile, currentStage: 3 }] }), /当前档位/);
  assert.throws(() => putPreset(library, { ...profile, name: '   ' }), /名称/);
});

test('stored sets survive a new load; corrupt JSON and storage failures remain visible', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.deepEqual(readPresetLibrary(storage), emptyPresetLibrary());
  const library = putPreset(emptyPresetLibrary(), profile);
  persistPresetLibrary(storage, library);
  assert.deepEqual(readPresetLibrary(storage), library);
  values.set(PRESET_STORAGE_KEY, '{corrupt');
  assert.throws(() => readPresetLibrary(storage), SyntaxError);
  assert.equal(values.get(PRESET_STORAGE_KEY), '{corrupt');
  assert.throws(() => persistPresetLibrary({ setItem: () => { throw new Error('quota'); } }, library), /quota/);
});

test('cross-tab transactions merge from the newest library while holding a shared lock', async () => {
  let stored = null;
  const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  let queue = Promise.resolve();
  const locks = { request: (key, run) => { assert.equal(key, PRESET_STORAGE_KEY); queue = queue.then(run); return queue; } };
  await Promise.all([
    updatePresetLibrary(storage, locks, (latest) => putPreset(latest, profile)),
    updatePresetLibrary(storage, locks, (latest) => putPreset(latest, { ...profile, id: 'two', name: '另一页' })),
  ]);
  assert.deepEqual(readPresetLibrary(storage).profiles.map((item) => item.id), ['one', 'two']);
  await assert.rejects(updatePresetLibrary(storage, null, (latest) => latest), /跨标签页/);
});
