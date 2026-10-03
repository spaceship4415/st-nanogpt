import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { BADGE_POSITIONS, DEFAULT_SETTINGS, MODULE_NAME } from './constants.js';

/**
 * 저장된 설정을 읽어 빠진 값을 기본값으로 채운다.
 * 설정 파일이 손상돼 있어도 확장이 통째로 죽지 않도록 타입이 다르면 기본값으로 되돌린다.
 */
export function loadSettings() {
    const stored = extension_settings[MODULE_NAME];
    const settings = (stored && typeof stored === 'object') ? stored : {};

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (typeof settings[key] !== typeof value) {
            settings[key] = value;
        }
    }

    // 선택지에 없는 값이면 드롭다운이 빈칸으로 보이므로 기본값으로
    if (!BADGE_POSITIONS.includes(settings.badgePosition)) {
        settings.badgePosition = DEFAULT_SETTINGS.badgePosition;
    }

    extension_settings[MODULE_NAME] = settings;
    return settings;
}

/** @returns {typeof DEFAULT_SETTINGS} */
export function getSettings() {
    return extension_settings[MODULE_NAME] ?? loadSettings();
}

/**
 * @param {keyof typeof DEFAULT_SETTINGS} key
 * @param {any} value
 */
export function setSetting(key, value) {
    getSettings()[key] = value;
    saveSettingsDebounced();
}
