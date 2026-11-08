import { G3_PRODUCT_CODE } from './identity.js';

export const PRESET_STORAGE_KEY = 'g3-webhid-dpi-presets-v1';
export const emptyPresetLibrary = () => ({ schemaVersion: 1, productCode: G3_PRODUCT_CODE, profiles: [] });

export function validateDpiSet(value) {
  if (!Array.isArray(value?.values) || value.values.length < 2 || value.values.length > 6) throw new Error('请保留 2–6 个 DPI 档位。');
  const values = Array.from(value.values);
  if (values.some((dpi) => !Number.isInteger(dpi) || dpi < 100 || dpi > 12000 || dpi % 100 !== 0)) throw new Error('每档 DPI 必须为 100–12000 之间的 100 的倍数。');
  if (!Number.isInteger(value.currentStage) || value.currentStage < 1 || value.currentStage > values.length) throw new Error('请选择有效的当前档位。');
  return { values, currentStage: value.currentStage };
}

export function dpiSetFromConfiguration(configuration, currentStage = configuration?.currentStage) {
  if (!configuration?.dpiStages || configuration.dpiStages.some((stage) => stage.xDpi !== stage.yDpi)) throw new Error('当前组编辑仅支持 X/Y 相同的 DPI 档位。');
  return validateDpiSet({ values: configuration.dpiStages.map((stage) => stage.xDpi), currentStage });
}

export function removeDpiStage(draft, stage) {
  if (!Array.isArray(draft?.values) || draft.values.length < 2 || draft.values.length > 6 || !Number.isInteger(draft.currentStage) || draft.currentStage < 1 || draft.currentStage > draft.values.length) throw new Error('档位草稿结构无效。');
  const set = { values: [...draft.values], currentStage: draft.currentStage };
  if (set.values.length === 2) throw new Error('至少保留两个 DPI 档位。');
  if (!Number.isInteger(stage) || stage < 1 || stage > set.values.length) throw new Error('要删除的档位不存在。');
  set.values.splice(stage - 1, 1);
  if (set.currentStage > stage) set.currentStage -= 1;
  else if (set.currentStage === stage) set.currentStage = Math.min(stage, set.values.length);
  return set;
}

export function validatePresetLibrary(value) {
  if (value?.schemaVersion !== 1 || value.productCode !== G3_PRODUCT_CODE || !Array.isArray(value.profiles) || value.profiles.length > 100) throw new Error('预设文件格式不匹配，需要 G3 DPI 预设 JSON（最多 100 套）。');
  const ids = new Set();
  const profiles = Array.from(value.profiles, (profile) => {
    if (typeof profile?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.id) || ids.has(profile.id)) throw new Error('预设标识无效或重复。');
    if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(profile.name)) throw new Error('预设名称需要 1–40 个可见字符。');
    ids.add(profile.id);
    return { id: profile.id, name: profile.name.trim(), ...validateDpiSet(profile) };
  });
  return { ...emptyPresetLibrary(), profiles };
}

export function readPresetLibrary(storage) {
  const text = storage.getItem(PRESET_STORAGE_KEY);
  return text === null ? emptyPresetLibrary() : validatePresetLibrary(JSON.parse(text));
}

export function persistPresetLibrary(storage, library) {
  const validated = validatePresetLibrary(library);
  storage.setItem(PRESET_STORAGE_KEY, JSON.stringify(validated));
  return validated;
}

export async function updatePresetLibrary(storage, locks, change) {
  if (!locks?.request) throw new Error('浏览器不支持安全的跨标签页预设保存，请使用桌面版 Chrome。');
  return locks.request(PRESET_STORAGE_KEY, () => persistPresetLibrary(storage, change(readPresetLibrary(storage))));
}

export function putPreset(library, { id, name, values, currentStage }) {
  const next = validatePresetLibrary(library);
  const index = next.profiles.findIndex((profile) => profile.id === id);
  const profile = { id, name, values, currentStage };
  if (index === -1) next.profiles.push(profile);
  else next.profiles[index] = profile;
  return validatePresetLibrary(next);
}

export function deletePreset(library, id) {
  const next = validatePresetLibrary(library);
  next.profiles = next.profiles.filter((profile) => profile.id !== id);
  return next;
}
