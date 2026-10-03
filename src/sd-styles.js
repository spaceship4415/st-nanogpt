import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';

/*
 * ST 이미지 생성 확장(Stable Diffusion)의 스타일 목록을 같이 쓴다.
 * extension_settings.sd.styles = [{ name, prefix, negative }]. 여기서 고치면 그 확장에도 그대로 보인다.
 */

/**
 * @typedef {object} SdStyle
 * @property {string} name
 * @property {string} prefix
 * @property {string} negative
 */

/**
 * 스타일 목록. 이미지 생성 확장이 꺼져 있거나 아직 설정이 없으면 null
 * @returns {SdStyle[]|null}
 */
export function getSdStyles() {
    const styles = extension_settings.sd?.styles;
    return Array.isArray(styles) ? styles : null;
}

/**
 * 같은 이름이 있으면 내용을 바꾸고, 없으면 새로 넣는다
 * @param {string} name
 * @param {string} prefix
 * @param {string} negative
 */
export function saveSdStyle(name, prefix, negative) {
    const styles = getSdStyles();
    if (!styles) return;
    const existing = styles.find(s => s.name === name);
    if (existing) {
        existing.prefix = prefix;
        existing.negative = negative;
    } else {
        styles.push({ name, prefix, negative });
    }
    commit();
}

/**
 * @param {string} oldName
 * @param {string} newName
 */
export function renameSdStyle(oldName, newName) {
    const style = getSdStyles()?.find(s => s.name === oldName);
    if (!style) return;
    style.name = newName;
    // 이미지 생성 확장에서 고른 스타일이었으면 그쪽 선택도 따라간다
    if (extension_settings.sd.style === oldName) extension_settings.sd.style = newName;
    commit();
}

/** @param {string} name */
export function deleteSdStyle(name) {
    const styles = getSdStyles();
    const index = styles?.findIndex(s => s.name === name) ?? -1;
    if (index < 0) return;
    styles.splice(index, 1);
    // 그쪽의 접두사 칸은 건드리지 않고 선택만 푼다
    if (extension_settings.sd.style === name) extension_settings.sd.style = '';
    commit();
}

function commit() {
    saveSettingsDebounced();
    // 이미지 생성 확장의 설정 화면 드롭다운도 다시 그린다(열려 있지 않아도 DOM 에는 있다)
    const select = document.getElementById('sd_style');
    if (!(select instanceof HTMLSelectElement)) return;
    select.replaceChildren(...(getSdStyles() ?? []).map(s => new Option(s.name, s.name)));
    select.value = extension_settings.sd.style ?? '';
}
