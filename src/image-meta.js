import { IMAGE_META_FILE } from './constants.js';
import { createJsonStore } from './json-store.js';
import { getSettings } from './settings.js';

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
 * @property {string|null} [chatId] 만든 채팅 ID(임시 채팅이면 null). 이 기능 전에 만든 기록에는 없다
 * @property {{ chatId: string, messageId: number, fingerprint: string }|null} [source] 프롬프트를 쓴 메시지
 *   (갤러리에서 채팅에 보낼 때 그 메시지에 붙이려고). 직접 쓴 프롬프트나 이 기능 전 기록에는 없다
 */

/** @type {ReturnType<typeof createJsonStore<ImageMeta>>} */
const store = createJsonStore(IMAGE_META_FILE, () => getSettings().imageMetaLimit);

/** 설정창의 '기록 개수'용 */
export const imageMetaRecords = { count: () => store.count(), trim: () => store.trim() };

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

/**
 * @param {string} url 이미지 경로
 * @returns {Promise<ImageMeta|null>}
 */
export function getImageMeta(url) {
    return store.get(keyOf(url));
}

/**
 * @param {string} url 이미지 경로
 * @param {ImageMeta} meta
 */
export function setImageMeta(url, meta) {
    return store.set(keyOf(url), meta);
}

/** @param {string} url 이미지 경로 */
export function removeImageMeta(url) {
    return store.remove(keyOf(url));
}

/**
 * 갤러리 '이 채팅만' 보기: 이 폴더의 파일 중 그 채팅에서 만든 것만 고른다
 * @param {string} folder
 * @param {string[]} files
 * @param {string} chatId
 * @returns {Promise<string[]>}
 */
export async function filterByChat(folder, files, chatId) {
    const all = await store.preload();
    return files.filter(file => all[keyOf(`user/images/${folder}/${file}`)]?.chatId === chatId);
}

/** 확장을 지울 때 */
export function deleteImageMetaFile() {
    return store.deleteFile();
}
