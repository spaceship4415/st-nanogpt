import { IMAGE_META_FILE, MAX_IMAGE_META } from './constants.js';
import { deleteUserFile, readUserFile, writeUserFile } from './user-files.js';

/*
 * 갤러리에 저장한 이미지의 생성 정보(모델·프롬프트·설정값) 기록.
 * data/<사용자>/user/files/st-nanogpt-images.json 에 { '<이미지 경로>': 정보 } 로 둔다.
 * 이 기능 전에 만든 이미지나 ST 이미지 생성 확장이 만든 이미지는 기록이 없다.
 */

/**
 * @typedef {object} ImageMeta
 * @property {string} model
 * @property {string} prompt 사용자가 쓴 프롬프트(앞에 붙일 프롬프트 제외)
 * @property {string} promptPrefix
 * @property {string} negativePrompt
 * @property {number} width
 * @property {number} height
 * @property {number} steps
 * @property {number} scale
 * @property {number} createdAt
 */

/** @type {Record<string, ImageMeta>|null} */
let records = null;
/** @type {Promise<Record<string, ImageMeta>>|null} */
let loading = null;
let writable = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let saveTimer = null;

/**
 * 같은 이미지가 '/user/images/a b/x.jpg' 나 'user/images/a%20b/x.jpg' 처럼 달리 적혀도 같은 키가 되게
 * @param {string} url
 */
function keyOf(url) {
    let path = String(url ?? '').replace(/^\/+/, '');
    try {
        path = decodeURIComponent(path);
    } catch {
        // 이미 풀린 경로
    }
    return path;
}

/** @returns {Promise<Record<string, ImageMeta>>} */
function load() {
    if (records) return Promise.resolve(records);
    if (!loading) {
        loading = (async () => {
            try {
                const data = await readUserFile(IMAGE_META_FILE);
                records = data && typeof data === 'object' ? data : {};
                writable = true;
            } catch (error) {
                // 읽지 못했으면 덮어쓰지 않는다(이번 세션 기록은 메모리에만)
                console.warn('[NanoGPT] could not read the image info file', error);
                records = {};
            }
            return records;
        })();
    }
    return loading;
}

function scheduleSave() {
    if (!writable) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        writeUserFile(IMAGE_META_FILE, records);
    }, 300);
}

/**
 * @param {string} url 이미지 경로
 * @returns {Promise<ImageMeta|null>}
 */
export async function getImageMeta(url) {
    const all = await load();
    return all[keyOf(url)] ?? null;
}

/**
 * @param {string} url 이미지 경로
 * @param {ImageMeta} meta
 */
export async function setImageMeta(url, meta) {
    const all = await load();
    all[keyOf(url)] = meta;
    // 너무 커지지 않게 오래된 기록부터 지운다
    const keys = Object.keys(all);
    if (keys.length > MAX_IMAGE_META) {
        keys.sort((a, b) => (all[a].createdAt || 0) - (all[b].createdAt || 0))
            .slice(0, keys.length - MAX_IMAGE_META)
            .forEach(key => delete all[key]);
    }
    scheduleSave();
}

/** @param {string} url 이미지 경로 */
export async function removeImageMeta(url) {
    const all = await load();
    if (delete all[keyOf(url)]) scheduleSave();
}

/** 확장을 지울 때 */
export async function deleteImageMetaFile() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    writable = false;
    await deleteUserFile(IMAGE_META_FILE);
}

window.addEventListener('pagehide', () => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    writeUserFile(IMAGE_META_FILE, records, true);
});
