import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { BADGE_POSITIONS, DEFAULT_SCENE_PROMPT, DEFAULT_SETTINGS, LEGACY_SCENE_PROMPT_V1, MODULE_NAME } from './constants.js';

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
    settings.sceneContextMessages = clampContext(settings.sceneContextMessages);

    migrate(settings);

    extension_settings[MODULE_NAME] = settings;
    return settings;
}

/**
 * 저장된 설정을 현재 버전에 맞춘다. 버전마다 한 번만 실행된다.
 * @param {Record<string, any>} settings
 */
function migrate(settings) {
    let changed = false;

    // v1 → v2: '메시지로 프롬프트'가 고른 메시지 + 참고 자료 방식으로 바뀌어 기본 지시문도 바뀜.
    // 사용자가 고치지 않은 옛 기본값만 새 기본값으로 바꾼다
    if (settings.version < 2) {
        if (settings.scenePrompt === LEGACY_SCENE_PROMPT_V1) settings.scenePrompt = DEFAULT_SCENE_PROMPT;
        settings.version = 2;
        changed = true;
    }

    if (changed) saveSettingsDebounced();
}

/**
 * 참고 메시지 수는 0~20
 * @param {any} value
 */
export function clampContext(value) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.max(0, Math.min(20, number)) : DEFAULT_SETTINGS.sceneContextMessages;
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
