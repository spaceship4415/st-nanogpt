import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { BADGE_POSITIONS, DEFAULT_SCENE_PROMPT, DEFAULT_SETTINGS, LEGACY_SCENE_PROMPT_V1, MODULE_NAME, REFRESH_INTERVALS, SETTINGS_FILE } from './constants.js';
import { deleteUserFile, readUserFile, writeUserFile } from './user-files.js';

/*
 * 설정은 ST 의 settings.json 이 아니라 사용자 파일 폴더의 별도 파일에 둔다
 * (data/<사용자>/user/files/st-nanogpt-settings.json). 확장을 지우면 delete 훅이 이 파일도 지운다.
 */

const SAVE_DELAY = 500;

/** @type {Record<string, any>} */
let settings = structuredClone(DEFAULT_SETTINGS);
/**
 * 파일을 읽지 못했으면(서버 오류 등) 쓰지 않는다 — 기본값으로 좋은 파일을 덮어쓰지 않게
 */
let writable = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let saveTimer = null;

/**
 * 설정 파일을 읽어 빠진 값을 기본값으로 채운다. 파일이 없으면 예전 위치(settings.json)에서 옮겨 온다.
 * 값이 손상돼 있어도 확장이 통째로 죽지 않도록 타입이 다르면 기본값으로 되돌린다.
 */
export async function loadSettings() {
    /** @type {Record<string, any>|null} */
    let stored = null;
    let movedFromSettingsJson = false;
    try {
        stored = await readUserFile(SETTINGS_FILE);
        if (stored === null) {
            const legacy = extension_settings[MODULE_NAME];
            if (legacy && typeof legacy === 'object') {
                stored = legacy;
                movedFromSettingsJson = true;
            }
        }
        writable = true;
    } catch (error) {
        console.warn('[NanoGPT] could not read the settings file; changes will not be saved this session', error);
        stored = extension_settings[MODULE_NAME] ?? null;
    }

    settings = normalize(stored && typeof stored === 'object' ? stored : {});

    const needsWrite = movedFromSettingsJson || settings.__changed;
    delete settings.__changed;
    if (writable && needsWrite) {
        const saved = await writeFile();
        // 예전 위치의 값은 파일에 확실히 써진 뒤에만 지운다(실패하면 다음에 다시 옮긴다)
        if (saved && movedFromSettingsJson) {
            delete extension_settings[MODULE_NAME];
            saveSettingsDebounced();
        }
    }
    return settings;
}

/**
 * @param {Record<string, any>} stored
 */
function normalize(stored) {
    const result = { ...stored };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (typeof result[key] !== typeof value) {
            result[key] = value;
        }
    }
    // 선택지에 없는 값이면 드롭다운이 빈칸으로 보이므로 기본값으로
    if (!BADGE_POSITIONS.includes(result.badgePosition)) {
        result.badgePosition = DEFAULT_SETTINGS.badgePosition;
    }
    result.sceneContextMessages = clampContext(result.sceneContextMessages);
    if (!REFRESH_INTERVALS.includes(result.refreshInterval)) {
        result.refreshInterval = DEFAULT_SETTINGS.refreshInterval;
    }
    migrate(result);
    return result;
}

/**
 * 저장된 설정을 현재 버전에 맞춘다. 버전마다 한 번만 실행된다.
 * @param {Record<string, any>} target
 */
function migrate(target) {
    // v1 → v2: '프롬프트 자동생성'이 고른 메시지 + 참고 자료 방식으로 바뀌어 기본 지시문도 바뀜.
    // 사용자가 고치지 않은 옛 기본값만 새 기본값으로 바꾼다
    if (target.version < 2) {
        if (target.scenePrompt === LEGACY_SCENE_PROMPT_V1) target.scenePrompt = DEFAULT_SCENE_PROMPT;
        target.version = 2;
        target.__changed = true;
    }
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
    return /** @type {any} */ (settings);
}

/**
 * @param {keyof typeof DEFAULT_SETTINGS} key
 * @param {any} value
 */
export function setSetting(key, value) {
    settings[key] = value;
    if (!writable) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        writeFile();
    }, SAVE_DELAY);
}

/**
 * @param {boolean} [keepalive] 페이지를 떠나는 중에도 요청을 끝까지 보낸다
 * @returns {Promise<boolean>} 저장됐는지
 */
function writeFile(keepalive = false) {
    return writeUserFile(SETTINGS_FILE, settings, keepalive);
}

// 저장 대기 중에 새로고침·닫기를 하면 바로 보낸다
window.addEventListener('pagehide', () => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    writeFile(true);
});

/** 확장을 지울 때: 설정 파일과 settings.json 에 남았을 수 있는 예전 설정을 지운다 */
export async function deleteSettingsData() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    writable = false;
    await deleteUserFile(SETTINGS_FILE);
    delete extension_settings[MODULE_NAME];
}
