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

/** 내보낸 파일임을 알아보는 표시 */
const EXPORT_TYPE = 'st-nanogpt-styles';

/**
 * @param {string} [name] 이 스타일만. 생략하면 전체
 * @returns {string} 스타일을 담은 JSON
 */
export function exportSdStyles(name) {
    const styles = (getSdStyles() ?? [])
        .filter(s => name === undefined || s.name === name)
        .map(s => ({ name: s.name, prefix: s.prefix ?? '', negative: s.negative ?? '' }));
    return JSON.stringify({ type: EXPORT_TYPE, version: 1, styles }, null, 2);
}

/**
 * 내보낸 파일(또는 스타일 배열만 담은 JSON)을 목록에 더한다. 지금 것을 지우거나 덮어쓰지 않는다:
 * 이름과 내용이 같으면 건너뛰고, 이름만 같으면 '이름 (2)'처럼 새 이름으로 넣는다
 * @param {string} text
 * @returns {{ added: number, renamed: number, skipped: number }}
 */
export function importSdStyles(text) {
    const styles = getSdStyles();
    if (!styles) throw new Error('Image Generation extension is not available');
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data?.styles;
    if (!Array.isArray(list)) throw new Error('Invalid file');

    const result = { added: 0, renamed: 0, skipped: 0 };
    for (const item of list) {
        const name = String(item?.name ?? '').trim();
        if (!name) continue;
        const prefix = String(item.prefix ?? '');
        const negative = String(item.negative ?? '');
        const same = styles.find(s => s.name === name);
        if (same && same.prefix === prefix && same.negative === negative) {
            result.skipped++;
            continue;
        }
        let finalName = name;
        for (let n = 2; styles.some(s => s.name === finalName); n++) finalName = `${name} (${n})`;
        styles.push({ name: finalName, prefix, negative });
        if (finalName === name) result.added++;
        else result.renamed++;
    }
    if (result.added || result.renamed) commit();
    return result;
}
