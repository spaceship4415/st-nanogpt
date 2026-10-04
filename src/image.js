import { eventSource, event_types, getRequestHeaders, neutralCharacterName, stopGeneration, syncMesToSwipe, systemUserName, updateMessageBlock } from '../../../../../script.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../../../constants.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../../popup.js';
import { getMessageTimeStamp, humanizedDateTime } from '../../../../RossAscends-mods.js';
import { download, saveBase64AsFile } from '../../../../utils.js';
import { ApiError, fetchImageModels, fetchModelInfo, generateImage, getModelInfo, hasNanoGptKey, modelLabel, NoKeyError } from './api.js';
import { LOG_PREFIX, MAX_SESSION_IMAGES, SIZE_PRESETS } from './constants.js';
import { tr } from './i18n.js';
import { addInsert, removeInsertsByUrl } from './inserts.js';
import { openLightbox } from './lightbox.js';
import { removeImageMeta, setImageMeta } from './image-meta.js';
import { BOTH_SCENE, CHARACTER_SCENE, PERSONA_SCENE, getRememberedPromptAt, isPortraitScene, portraitAvailability, messageFingerprint, getRememberedScenePrompt, getSceneProfileId, getScenePreview, lastSceneMessageId, listSceneMessages, promptFromScene, rememberScenePrompt, scenePromptLinkFor } from './scene.js';
import { deleteSdStyle, exportSdStyles, findStyleName, getSdStyles, importSdStyles, renameSdStyle, saveSdStyle } from './sd-styles.js';
import { getSettings, setSetting } from './settings.js';
import { formatUsd, getUsageState, onUsageChange, scheduleAutoRefresh } from './usage.js';

/**
 * @typedef {object} GeneratedImage
 * @property {string} base64
 * @property {string} prompt
 * @property {string} negativePrompt
 * @property {string} [promptPrefix] 생성할 때 앞에 붙인 프롬프트
 * @property {string} [style] 그때 고른 스타일 이름(없으면 '')
 * @property {string} model
 * @property {number} width
 * @property {number} height
 * @property {number} [steps]
 * @property {number} [scale]
 * @property {number} createdAt
 * @property {string|null} [chatId] 만든 채팅(갤러리의 '이 채팅만' 보기용). 임시 채팅이면 없음
 * @property {{ chatId: string, messageId: number, fingerprint: string }|null} [source] 프롬프트를 쓴 메시지(채팅에 보낼 때 그 메시지에 붙인다)
 * @property {string} [folder] 저장할 갤러리 폴더(생성을 시작한 때의 채팅 기준)
 * @property {string|null} savedUrl 채팅에 보내려고 서버에 저장한 경로(같은 이미지를 두 번 올리지 않게)
 * @property {boolean} [sent] 채팅에 보냈는지(지울 때 확인을 받는다)
 */

/** 자동생성 드롭다운의 '설명으로 그리기' 값 @type {Record<string, string>} */
const PORTRAIT_VALUES = { [CHARACTER_SCENE]: 'char', [PERSONA_SCENE]: 'persona', [BOTH_SCENE]: 'both' };

/** 이번 세션에서 만든 이미지(최근 것이 앞). 새로고침하면 사라진다 @type {GeneratedImage[]} */
const sessionImages = [];

/**
 * 이미지 탭의 결과·썸네일에 보여 줄 것: 지금 채팅에서 만든 것만(다른 채팅 것은 갤러리 탭에서).
 * 채팅이 없을 때 만든 것은 채팅이 없을 때만 보인다
 * @returns {GeneratedImage[]}
 */
function imagesForThisChat() {
    const chatId = getContext().getCurrentChatId?.() || '';
    return sessionImages.filter(entry => (entry.chatId || '') === chatId);
}

/** @param {string} size '1024x1024' */
function parseSize(size) {
    const [width, height] = String(size).split('x').map(Number);
    return (width > 0 && height > 0) ? { width, height } : { width: 1024, height: 1024 };
}

/**
 * 모델이 받는 크기 중 원하는 크기와 가장 가까운 것: 비율이 가장 비슷한 것, 그중 넓이가 가장 비슷한 것
 * @param {import('./api.js').ModelSize[]} sizes
 * @param {number} width
 * @param {number} height
 */
function nearestSize(sizes, width, height) {
    const ratio = Math.log(width / height);
    const area = Math.log(width * height);
    const distance = (/** @type {import('./api.js').ModelSize} */ s) =>
        Math.abs(Math.log(s.width / s.height) - ratio) * 10 + Math.abs(Math.log(s.width * s.height) - area);
    return sizes.reduce((best, s) => distance(s) < distance(best) ? s : best);
}

/**
 * @param {number} value
 * @param {import('./api.js').ModelParam|null|undefined} param
 */
function clampParam(value, param) {
    if (param?.min !== null && param?.min !== undefined) value = Math.max(param.min, value);
    if (param?.max !== null && param?.max !== undefined) value = Math.min(param.max, value);
    return value;
}

/**
 * 모델에 쓸 스텝·CFG. 그 모델에서 직접 고친 값 → 모델 권장값 → 공통 값(모델 정보를 모를 때) 순서로,
 * 모델이 받는 범위 안으로. 터보·증류 모델(z-image-turbo 의 CFG 0 등)에 다른 모델의 값이 가지 않게 모델마다 따로 둔다
 * @param {string} model
 * @returns {{ steps: number, scale: number }}
 */
function paramsFor(model) {
    const settings = getSettings();
    const saved = settings.modelParams[model] ?? {};
    const info = getModelInfo(model);
    const pick = (/** @type {any} */ value, /** @type {import('./api.js').ModelParam|null|undefined} */ param, /** @type {number} */ common) =>
        clampParam([value, param?.recommended].find(v => typeof v === 'number' && Number.isFinite(v)) ?? common, param);
    return { steps: pick(saved.steps, info?.steps, settings.steps), scale: pick(saved.scale, info?.scale, settings.scale) };
}

/**
 * 그 모델의 스텝·CFG 로 저장한다. 공통 값(모델 정보가 없는 모델용)도 같이 바꾼다. model 이 없으면 공통 값만
 * @param {string} model
 * @param {{ steps?: number, scale?: number }} values
 */
function saveModelParams(model, values) {
    const settings = getSettings();
    if (values.steps !== undefined) setSetting('steps', values.steps);
    if (values.scale !== undefined) setSetting('scale', values.scale);
    if (!model) return;
    setSetting('modelParams', { ...settings.modelParams, [model]: { ...settings.modelParams[model], ...values } });
}

/**
 * 크기 선택지. 모델이 받는 크기를 알면 그것만, 모르면 기본 선택지
 * @param {string} model
 * @returns {{ value: string, text: string }[]}
 */
function sizeOptions(model) {
    const sizes = getModelInfo(model)?.sizes;
    if (!sizes) return SIZE_PRESETS.map(p => ({ value: p.value, text: `${tr(p.label, p.english)} (${p.value.replace('x', '×')})` }));
    const shape = (/** @type {import('./api.js').ModelSize} */ s) => s.width === s.height ? 0 : s.height > s.width ? 1 : 2;
    return [...sizes]
        .sort((a, b) => shape(a) - shape(b) || a.width * a.height - b.width * b.height)
        .map(s => {
            const label = [tr('size_square', 'Square'), tr('size_portrait', 'Portrait'), tr('size_landscape', 'Landscape')][shape(s)];
            return { value: `${s.width}x${s.height}`, text: `${label} (${s.width}×${s.height})` };
        });
}

/**
 * 설정값(또는 overrides)으로 이미지를 한 장 만든다. 설정의 접두 문구(promptPrefix)가 앞에 붙는다.
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {string} [options.size]
 * @param {string} [options.negativePrompt]
 * @param {GeneratedImage['source']} [options.source] 프롬프트를 쓴 메시지
 * @param {AbortSignal} [signal]
 * @returns {Promise<GeneratedImage>}
 */
export async function createImage({ prompt, model, size, negativePrompt, source = null }, signal) {
    const settings = getSettings();
    const finalModel = model || settings.model;
    if (!finalModel) throw new Error(tr('no_model', 'Choose an image model first.'));
    if (!prompt?.trim()) throw new Error(tr('no_prompt', 'Enter a prompt.'));

    let { width, height } = parseSize(size || settings.size);
    // 모델이 받지 않는 크기면 가장 가까운 크기로 바꾼다(명령어·메시지 버튼으로 만들 때도)
    await fetchModelInfo().catch(() => { });
    const info = getModelInfo(finalModel);
    const fitted = info?.sizes ? nearestSize(info.sizes, width, height) : null;
    if (fitted) ({ width, height } = fitted);
    const negative = negativePrompt ?? settings.negativePrompt;
    const { steps, scale } = paramsFor(finalModel);
    // 기다리는 사이 채팅을 옮겨도(명령어로 만들 때) 시작한 채팅의 폴더·기록으로 남게 미리 잡아 둔다
    const chatId = getContext().getCurrentChatId?.() || null;
    const folder = galleryFolder();
    try {
        const base64 = await generateImage({
            model: finalModel,
            prompt: joinPrompt(settings.promptPrefix, prompt),
            negativePrompt: negative,
            width,
            height,
            steps,
            scale,
            resolution: fitted?.resolution,
            paramKeys: { steps: info?.steps?.key, scale: info?.scale?.key },
        }, signal);

        /** @type {GeneratedImage} */
        // 어떤 스타일로 만들었는지(접두사가 저장된 스타일과 같을 때만). 나중에 스타일 이름을 바꿔도 만들 때 이름이 남는다
        const style = findStyleName(settings.promptPrefix, negative);
        const entry = { base64, prompt: prompt.trim(), promptPrefix: settings.promptPrefix, negativePrompt: negative, style, model: finalModel, width, height, steps, scale, createdAt: Date.now(), chatId, folder, source, savedUrl: null };
        sessionImages.unshift(entry);
        sessionImages.length = Math.min(sessionImages.length, MAX_SESSION_IMAGES);
        if (settings.autoSaveGallery) {
            // 저장에 실패해도 이미지는 패널에 있으니 생성 자체는 성공으로 둔다
            try {
                await saveToGallery(entry);
            } catch (error) {
                console.error(LOG_PREFIX, 'failed to save the image to the gallery', error);
                toastr.warning(tr('gallery_failed', 'The image was made but could not be saved to the gallery.'));
            }
        }
        return entry;
    } finally {
        // 실패했어도 과금됐을 수 있으니 사용량은 다시 확인한다
        if (!signal?.aborted) scheduleAutoRefresh();
    }
}

/** 이미지를 보낼 수 있는 채팅이 열려 있는지(임시 채팅 포함 — ST 의 같은 검사를 따른다) */
export function canSendToChat() {
    const context = getContext();
    return context.characterId !== undefined || !!context.groupId || context.name2 === neutralCharacterName;
}

/**
 * 이미지를 서버 갤러리(data/<사용자>/user/images/<폴더>/)에 저장한다. 이미 저장했으면 그대로 둔다.
 * 폴더는 지금 채팅 기준: 캐릭터 이름 / 그룹 ID / 채팅이 없으면 'NanoGPT'. ST 의 캐릭터 갤러리에 나온다.
 * @param {GeneratedImage} entry
 * @returns {Promise<string>} 저장된 경로
 */
export async function saveToGallery(entry) {
    if (!entry.savedUrl) {
        const folder = entry.folder || galleryFolder();
        entry.savedUrl = await saveBase64AsFile(entry.base64, folder, `${folder}_${humanizedDateTime()}`, 'jpg');
        // 갤러리에서 설정을 다시 볼 수 있게 생성 정보를 남긴다
        if (entry.model) setImageMeta(entry.savedUrl, metaOf(entry));
    }
    return entry.savedUrl;
}

/**
 * 갤러리에서 지운 파일을 이번 세션 이미지에서도 '저장 안 됨'으로 되돌린다.
 * 그래야 그 이미지를 채팅에 보낼 때 없는 경로 대신 다시 저장한다
 * @param {string} url '/user/images/<폴더>/<파일>'
 */
export function forgetSavedImage(url) {
    for (const entry of sessionImages) {
        if (entry.savedUrl === url) entry.savedUrl = null;
    }
}

/**
 * 갤러리 파일 하나를 서버에서 지우고, 이 확장의 기록(생성 정보·메시지 아래 그림)도 정리한다
 * @param {string} path 'user/images/<폴더>/<파일>'(앞의 / 는 있어도 된다)
 */
export async function deleteGalleryImage(path) {
    path = path.replace(/^\/+/, '');
    const response = await fetch('/api/images/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ path }),
    });
    // 이미 없는 파일이면 지운 것으로 친다
    if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
    forgetSavedImage(`/${path}`);
    removeImageMeta(path);
    await removeInsertsByUrl(`/${path}`);
}

/**
 * 이번 세션 이미지를 버린다: 갤러리에 저장돼 있으면 서버에서도 지운다
 * @param {GeneratedImage} entry
 */
async function discardImage(entry) {
    if (entry.savedUrl) await deleteGalleryImage(entry.savedUrl);
    const index = sessionImages.indexOf(entry);
    if (index >= 0) sessionImages.splice(index, 1);
}

/** [되돌리기] 를 누를 수 있는 시간(ms). 이 시간이 지나야 서버에서 지운다 */
const UNDO_DELAY = 6000;

/**
 * 이번 세션 이미지를 목록에서 바로 빼고, 서버 파일은 UNDO_DELAY 뒤에 지운다.
 * 그 사이 돌려 놓으면 서버 파일은 처음부터 지워지지 않는다. 페이지를 닫으면 파일은 그대로 남는다(안전한 쪽)
 * @param {GeneratedImage} entry
 * @returns {() => boolean} 돌려 놓기. 이미 지웠으면 false
 */
function discardImageLater(entry) {
    const index = sessionImages.indexOf(entry);
    if (index >= 0) sessionImages.splice(index, 1);
    let done = false;
    const timer = setTimeout(async () => {
        done = true;
        if (!entry.savedUrl) return;
        try {
            await deleteGalleryImage(entry.savedUrl);
        } catch (error) {
            console.error(LOG_PREFIX, 'failed to delete image', error);
            toastr.error(error?.message || String(error), tr('gallery_delete_failed', 'Could not delete the image'));
        }
    }, UNDO_DELAY);
    return () => {
        if (done) return false;
        clearTimeout(timer);
        sessionImages.splice(Math.min(Math.max(index, 0), sessionImages.length), 0, entry);
        return true;
    };
}

/**
 * 생성 실패를 사용자가 알아듣고 다음에 뭘 해 볼지 알 수 있는 문장으로.
 * ST 서버는 NanoGPT 의 자세한 오류를 넘겨주지 않아 상태 코드로만 나눈다
 * @param {any} error
 */
function friendlyError(error) {
    if (error instanceof NoKeyError || error?.status === 400) return tr('err_no_key', 'No NanoGPT API key. Save one in API Connections.');
    if (error instanceof ApiError) return tr('err_nanogpt', 'NanoGPT could not make the image. Try another model or size, or try again later. This also happens when your balance or daily limit runs out.');
    if (error instanceof TypeError) return tr('err_network', 'Could not reach the SillyTavern server. Check your connection.');
    return tr('generate_failed', 'Generation failed: {0}', error?.message || String(error));
}

/**
 * 저장 경로에서 갤러리 폴더 이름을 꺼낸다('/user/images/<폴더>/<파일>')
 * @param {string|null} url
 * @returns {string}
 */
export function galleryFolderOf(url) {
    const match = /user\/images\/([^/]+)\//.exec(String(url ?? ''));
    if (!match) return '';
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

/** 지금 채팅의 갤러리 폴더 이름: 캐릭터 이름 / 그룹 ID / 채팅이 없으면 'NanoGPT' */
export function galleryFolder() {
    const context = getContext();
    return context.groupId
        ? String(context.groupId)
        : context.characters[context.characterId]?.name || (canSendToChat() ? context.name2 : '') || 'NanoGPT';
}

/**
 * 이미지를 지금 채팅에 캐릭터 메시지로 붙인다(SD 확장과 같은 형식).
 * @param {GeneratedImage} entry
 * @returns {Promise<string>} 서버에 저장된 이미지 경로
 */
export async function sendImageToChat(entry) {
    if (!canSendToChat()) throw new Error(tr('no_chat', 'Open a chat first.'));

    const context = getContext();
    await saveToGallery(entry);

    /** @type {import('../../../../constants.js').MediaAttachment} */
    const media = {
        url: entry.savedUrl,
        type: MEDIA_TYPE.IMAGE,
        title: entry.prompt,
        negative: entry.negativePrompt,
        source: MEDIA_SOURCE.GENERATED,
    };

    // 메시지에서 만든 그림이면 맨 아래 새 메시지 대신 그 메시지 자체에 붙인다(장면 자리에 그림이 남게)
    const attach = attachTarget(entry);
    // 화면에만 끼워 넣기: 채팅 데이터는 그대로 두고 그 메시지 아래에 보여 주기만(AI 에 안 감)
    if (attach?.mode === 'overlay') {
        await addInsert(attach.messageId, entry.savedUrl);
        entry.sent = true;
        return entry.savedUrl;
    }
    // 원래 메시지에 첨부: 장면 자리에 남고 확장 없이도 보이지만, 이미지를 읽는 모델은 그림을 본다
    if (attach?.mode === 'message') {
        const targetId = attach.messageId;
        const target = context.chat[targetId];
        target.extra = target.extra ?? {};
        if (!Array.isArray(target.extra.media)) target.extra.media = [];
        target.extra.media.push(media);
        target.extra.media_index = target.extra.media.length - 1;
        target.extra.media_display = target.extra.media_display ?? MEDIA_DISPLAY.GALLERY;
        // inline_image 는 건드리지 않는다: ST 에서 false 는 '메시지 글을 숨기고 그림만'이라 본문이 가려진다
        // 지금 스와이프의 기록에도 옮겨 둔다(안 그러면 스와이프를 넘겼다 오면 첨부가 사라진다). 그림은 이 스와이프에만
        syncMesToSwipe(targetId);
        updateMessageBlock(targetId, target);
        await context.saveChat();
        entry.sent = true;
        return entry.savedUrl;
    }
    /** @type {ChatMessage} */
    const message = {
        name: context.groupId ? systemUserName : context.name2,
        is_user: false,
        is_system: !!getSettings().sendHidden,
        send_date: getMessageTimeStamp(),
        mes: entry.prompt,
        extra: {
            media: [media],
            media_display: MEDIA_DISPLAY.GALLERY,
            media_index: 0,
            inline_image: false,
        },
    };
    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
    context.addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();
    entry.sent = true;
    return entry.savedUrl;
}

/**
 * 채팅에 보낼 때 어디에 붙일지. 원래 메시지가 있고 설정이 '맨 아래 숨김 메시지'가 아니면 { 메시지 번호, 방식 }
 * @param {GeneratedImage} entry
 * @returns {{ messageId: number, mode: 'overlay'|'message' }|null}
 */
export function attachTarget(entry) {
    const mode = getSettings().attachMode;
    if (mode === 'hidden') return null;
    const messageId = sourceMessageId(entry);
    return messageId === null ? null : { messageId, mode: mode === 'message' ? 'message' : 'overlay' };
}

/**
 * 이 이미지를 붙일 원래 메시지 번호. 같은 채팅이고 그 메시지가 그대로 있을 때만(고쳐졌거나 지워져
 * 번호가 밀렸으면 null → 맨 아래 새 메시지로)
 * @param {GeneratedImage} entry
 * @returns {number|null}
 */
export function sourceMessageId(entry) {
    const source = entry.source;
    if (!source) return null;
    if ((getContext().getCurrentChatId?.() || '') !== source.chatId) return null;
    return messageFingerprint(source.messageId) === source.fingerprint ? source.messageId : null;
}

/**
 * 접두 문구와 프롬프트를 쉼표로 잇는다(앞뒤 쉼표·공백 정리).
 * @param {string} prefix
 * @param {string} prompt
 */
function joinPrompt(prefix, prompt) {
    const clean = (/** @type {string} */ s) => String(s ?? '').trim().replace(/^,+|,+$/g, '').trim();
    return [clean(prefix), clean(prompt)].filter(Boolean).join(', ');
}

/**
 * ST 이미지 생성 확장(Stable Diffusion) 설정에서 크기·스텝·CFG·네거티브·접두 문구를 가져온다.
 * 모델은 그쪽 소스가 NanoGPT 일 때만 가져온다(다른 소스의 모델 이름은 NanoGPT 에 없다).
 * @returns {string[]} 가져온 항목 이름
 */
export function importFromImageGeneration() {
    const sd = extension_settings.sd;
    if (!sd || typeof sd !== 'object') throw new Error(tr('sd_missing', 'The Image Generation extension has no settings yet.'));

    const imported = [];
    // 스텝·CFG 는 가져온 모델의 값으로. 다른 소스(SDXL 등)의 값은 모델 정보가 없는 모델에만 쓰는 공통 값으로
    const target = sd.source === 'nanogpt' && sd.model ? String(sd.model) : '';
    if (target) {
        setSetting('model', String(sd.model));
        imported.push(tr('model', 'Model'));
    }
    const width = Number(sd.width);
    const height = Number(sd.height);
    if (width > 0 && height > 0) {
        setSetting('size', `${width}x${height}`);
        imported.push(tr('size', 'Size'));
    }
    if (Number(sd.steps) > 0) {
        saveModelParams(target, { steps: Number(sd.steps) });
        imported.push(tr('steps', 'Sampling steps'));
    }
    if (Number.isFinite(Number(sd.scale))) {
        saveModelParams(target, { scale: Number(sd.scale) });
        imported.push(tr('scale', 'CFG scale'));
    }
    if (typeof sd.prompt_prefix === 'string') {
        setSetting('promptPrefix', sd.prompt_prefix);
        imported.push(tr('prefix', 'Common prompt prefix'));
    }
    if (typeof sd.negative_prompt === 'string') {
        setSetting('negativePrompt', sd.negative_prompt);
        imported.push(tr('negative', 'Negative common prompt prefix'));
    }
    return imported;
}

/** 이미지 생성 확장의 소스가 NanoGPT 이고 모델이 골라져 있는지(처음 한 번 자동으로 가져올 조건) */
function shouldAutoImport() {
    const sd = extension_settings.sd;
    return !getSettings().sdImported && sd?.source === 'nanogpt' && !!sd.model;
}

/**
 * @param {GeneratedImage} entry
 * @returns {import('./image-meta.js').ImageMeta}
 */
export function metaOf(entry) {
    return {
        model: entry.model,
        prompt: entry.prompt,
        promptPrefix: entry.promptPrefix ?? '',
        negativePrompt: entry.negativePrompt ?? '',
        style: entry.style ?? '',
        width: entry.width,
        height: entry.height,
        steps: entry.steps ?? 0,
        scale: entry.scale ?? 0,
        createdAt: entry.createdAt,
        chatId: entry.chatId ?? null,
        source: entry.source ?? null,
    };
}

/**
 * 기록된 생성 정보를 이미지 탭 설정으로 불러온다. run 이면 그대로 바로 생성한다.
 * 이미지 탭이 아직 없으면 마운트될 때 적용한다.
 * @param {import('./image-meta.js').ImageMeta} meta
 * @param {boolean} [run]
 */
export function applyImageMeta(meta, run = false) {
    storeImageMeta(meta);
    if (activeView) activeView.applySettings(run, meta.prompt ?? '');
    else pendingApply = { run, prompt: meta.prompt ?? '' };
}

/**
 * 생성 정보의 모델·크기·고급 값을 설정에 넣는다(프롬프트는 입력칸으로 따로)
 * @param {import('./image-meta.js').ImageMeta} meta
 */
function storeImageMeta(meta) {
    if (meta.model) setSetting('model', meta.model);
    if (meta.width > 0 && meta.height > 0) setSetting('size', `${meta.width}x${meta.height}`);
    // CFG 0 도 쓰는 모델이 있다(z-image-turbo). 스텝이 기록돼 있으면 CFG 도 기록된 값이다
    if (meta.steps > 0) saveModelParams(meta.model || getSettings().model, meta.scale >= 0 ? { steps: meta.steps, scale: meta.scale } : { steps: meta.steps });
    setSetting('promptPrefix', meta.promptPrefix ?? '');
    setSetting('negativePrompt', meta.negativePrompt ?? '');
}

/** @type {{ run: boolean, prompt: string }|null} */
let pendingApply = null;

/** 열려 있는 이미지 화면. 메시지 버튼·갤러리에서 값을 넘길 때 쓴다 @type {{ useSceneMessage: (id: number, run: boolean) => void, applySettings: (run: boolean, prompt: string) => void }|null} */
let activeView = null;

/**
 * 이미지 탭의 '기준 메시지'를 바꾸고, run 이면 바로 프롬프트를 만든다.
 * 이미지 탭이 아직 없으면 마운트될 때 적용한다.
 * @param {number} messageId
 * @param {boolean} [run]
 */
export function useSceneMessage(messageId, run = false) {
    if (activeView) activeView.useSceneMessage(messageId, run);
    else pendingScene = { messageId, run };
}

/** @type {{ messageId: number, run: boolean }|null} */
let pendingScene = null;

/** @param {GeneratedImage} entry */
function toDataUrl(entry) {
    return `data:image/jpeg;base64,${entry.base64}`;
}

/** @param {GeneratedImage} entry */
function downloadImage(entry) {
    const link = document.createElement('a');
    link.href = toDataUrl(entry);
    link.download = `nanogpt_${humanizedDateTime(entry.createdAt)}.jpg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

/**
 * 이미지 생성 화면. panel.html 의 #stng_image 안에 이미 있는 마크업에 동작을 붙인다.
 * @param {HTMLElement} container
 * @returns {() => void} 정리 함수(진행 중인 생성 취소, 구독 해제)
 */
export function mountImageView(container) {
    // 팝업이 DOM 에 붙기 전에 불릴 수 있어 보이기/숨기기는 jQuery .toggle() 대신 hidden 속성으로 한다
    const $root = $(container);
    const settings = getSettings();
    const $model = $root.find('.stng-img-model');
    const $size = $root.find('.stng-img-size');
    const $prompt = $root.find('.stng-img-prompt');
    const $negative = $root.find('.stng-img-negative');
    const $prefix = $root.find('.stng-img-prefix');
    const $sceneMessage = $root.find('.stng-img-scene-msg');
    const $scenePreview = $root.find('.stng-scene-preview');
    const $sceneHint = $root.find('.stng-scene-hint');
    const $autoToggle = $root.find('.stng-auto-toggle');
    const $sceneCached = $root.find('.stng-scene-cached');
    const $autoBox = $root.find('.stng-auto-box');

    /** 자동생성 상자 펼치기/접기. 마지막 상태를 기억한다 */
    function setAutoOpen(open) {
        $autoBox.prop('hidden', !open);
        $autoToggle.attr('aria-expanded', String(open)).toggleClass('stng-open', open);
        setSetting('sceneBoxOpen', open);
    }
    $autoToggle.on('click', () => setAutoOpen($autoBox.prop('hidden')));

    /**
     * 프롬프트 칸을 내용 길이에 맞춰 늘린다(화면의 45% 까지). 칸 안에 스크롤이 생기면 휴대폰에서
     * 그 칸 위를 밀 때 패널이 아니라 칸만 스크롤되어 아래(고급)로 내려갈 수 없었다.
     * 패널이 아직 화면에 없으면(탭이 숨겨졌거나 여는 중) 잠깐 뒤에 다시 잰다
     * @param {number} [tries]
     */
    function fitPrompt(tries = 20) {
        // 프롬프트를 바꾸는 곳은 모두 여기를 거치므로 글자 수도 같이 센다
        renderPromptCount();
        const el = $prompt[0];
        if (!(el instanceof HTMLTextAreaElement)) return;
        // 크게 보기 중에는 CSS 높이를 그대로 쓴다
        if (el.classList.contains('stng-prompt-big')) {
            el.style.height = '';
            return;
        }
        if (!el.offsetParent) {
            if (tries > 0) setTimeout(() => fitPrompt(tries - 1), 100);
            return;
        }
        el.style.height = 'auto';
        // 줄 높이가 'normal' 이면 숫자가 아니라 글자 크기로 어림한다. 최소 4줄
        const style = getComputedStyle(el);
        const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.35 || 22;
        const min = line * 4 + 16;
        el.style.height = `${Math.min(Math.max(el.scrollHeight + 2, min), Math.round(window.innerHeight * 0.45))}px`;
    }
    $prompt.on('input', () => fitPrompt());

    const $promptCount = $root.find('.stng-total-count');
    const $prefixCount = $root.find('.stng-prefix-count');
    const $negativeCount = $root.find('.stng-negative-count');

    /**
     * 고른 모델의 프롬프트 글자 수 제한 대비 지금 길이. NanoGPT 에 실제로 보내는 글(공통 접두사 + 프롬프트)을 센다.
     * 제한을 모르는 모델이면 숨긴다. 공통·부정 접두사 칸 아래에는 각각의 글자 수(비었으면 숨김)
     */
    function renderPromptCount() {
        const limit = getModelInfo(settings.model)?.promptLimit;
        const countOf = (/** @type {string} */ text) => limit?.unit === 'utf16_code_units' ? text.length : [...text].length;
        for (const [$count, text] of /** @type {[JQuery, string][]} */ ([[$prefixCount, settings.promptPrefix], [$negativeCount, settings.negativePrompt]])) {
            const length = countOf(String(text ?? '').trim());
            $count.prop('hidden', !length).text(tr('char_count', '{0} characters', length.toLocaleString()));
        }
        $promptCount.prop('hidden', !limit);
        if (!limit) return;
        const length = countOf(joinPrompt(settings.promptPrefix, String($prompt.val() ?? '')));
        const over = length > limit.max;
        const count = tr('prompt_count', '{0} / {1} characters', length.toLocaleString(), limit.max.toLocaleString());
        const note = over
            ? tr('prompt_count_over', 'Too long for this model. NanoGPT may refuse it.')
            : settings.promptPrefix.trim() ? tr('prompt_count_prefix', 'includes the common prefix') : '';
        $promptCount.text(note ? `${count} · ${note}` : count).toggleClass('stng-over', over);
    }

    // 프롬프트 칸 크게 보기: 화면 높이의 대부분으로 늘렸다가 다시 원래대로
    const $expand = $root.find('.stng-prompt-expand');
    $expand.on('click', () => {
        const big = !$prompt.hasClass('stng-prompt-big');
        $prompt.toggleClass('stng-prompt-big', big);
        fitPrompt();
        $expand.attr('aria-pressed', String(big))
            .find('i').attr('class', big ? 'fa-solid fa-down-left-and-up-right-to-center' : 'fa-solid fa-up-right-and-down-left-from-center');
        $prompt[0].scrollIntoView({ block: 'start', behavior: 'smooth' });
        $prompt.trigger('focus');
    });
    setAutoOpen(!!settings.sceneBoxOpen);
    const $promptOverlay = $root.find('.stng-prompt-overlay');
    const $steps = $root.find('.stng-img-steps');
    const $scale = $root.find('.stng-img-scale');
    const $generate = $root.find('.stng-img-generate');
    const $status = $root.find('.stng-img-status');
    const $result = $root.find('.stng-img-result');
    const $preview = $root.find('.stng-img-preview');
    const $pending = $root.find('.stng-img-pending');
    const $resultMeta = $root.find('.stng-img-meta');
    const $resultActions = $root.find('.stng-img-actions');
    const $strip = $root.find('.stng-img-strip');
    const $quota = $root.find('.stng-img-quota');
    const $scene = $root.find('.stng-img-scene');
    const $send = $root.find('.stng-img-send');

    /** @type {AbortController|null} */
    let controller = null;
    /** [다시 생성]: 이번 한 번은 그 그림의 원래 메시지에 그대로 붙게 @type {GeneratedImage['source']|undefined} */
    let regenSource;
    /** @type {GeneratedImage|null} */
    let current = imagesForThisChat()[0] ?? null;

    if (!hasNanoGptKey()) {
        $root.find('.stng-img-form, .stng-img-footer').prop('hidden', true);
        $root.find('.stng-img-nokey').prop('hidden', false);
        pendingScene = null;
        return () => { };
    }

    // --- 입력값 채우기 / 저장. 고친 값은 바로 설정에 저장되어 다음에 열 때 그대로 나온다
    if (shouldAutoImport()) {
        importFromImageGeneration();
        setSetting('sdImported', true);
    }

    /**
     * 설정값을 입력칸에 채운다(처음, '가져오기'·'설정 불러오기' 뒤).
     * 프롬프트는 기억하지 않는다: 열 때는 빈칸, 주어졌을 때만 채우고, 생략하면 지금 내용을 둔다
     * @param {string} [promptText]
     */
    function fillForm(promptText) {
        if (promptText !== undefined) {
            $prompt.val(promptText);
            fitPrompt();
        }
        $prefix.val(settings.promptPrefix);
        $negative.val(settings.negativePrompt);
        if (settings.model && !$model.find('option').filter((_, o) => /** @type {HTMLOptionElement} */ (o).value === settings.model).length) {
            $model.append(new Option(settings.model, settings.model));
        }
        $model.val(settings.model);
        fillModelInfo();
        fillStyles();
    }

    /** 고른 모델에 맞춰 크기 선택지, 그 모델의 스텝·CFG, 권장값 안내를 다시 그린다 */
    function fillModelInfo() {
        fillSizes();
        fillParams();
        renderRecommend();
        renderPromptCount();
    }

    /** 고른 모델에 쓸 스텝·CFG(직접 고친 값, 없으면 권장값)를 칸에 채운다 */
    function fillParams() {
        const { steps, scale } = paramsFor(settings.model);
        $steps.val(steps);
        $scale.val(scale);
    }

    /**
     * 고른 모델이 받는 크기로 선택지를 다시 채운다. 저장된 크기를 그 모델이 받지 않으면
     * 비율이 가장 비슷한 크기로 바꿔 저장한다(모델을 바꿔도 세로·가로 느낌은 그대로)
     */
    function fillSizes() {
        const options = sizeOptions(settings.model);
        $size.empty().append(options.map(o => new Option(o.text, o.value)));
        const sizes = getModelInfo(settings.model)?.sizes;
        if (sizes && !options.some(o => o.value === settings.size)) {
            const { width, height } = parseSize(settings.size);
            const fitted = nearestSize(sizes, width, height);
            setSetting('size', `${fitted.width}x${fitted.height}`);
        } else if (!options.some(o => o.value === settings.size)) {
            $size.append(new Option(settings.size.replace('x', '×'), settings.size));
        }
        $size.val(settings.size);
    }

    const $recommend = $root.find('.stng-img-recommend');
    const $recommendText = $recommend.find('.stng-img-recommend-text');

    /** 이 모델의 권장값·범위 안내. 모델 정보가 없으면 숨긴다 */
    function renderRecommend() {
        const info = getModelInfo(settings.model);
        const describe = (/** @type {import('./api.js').ModelParam|null} */ param, /** @type {string} */ name) => {
            if (!param) return tr('param_unused', '{0}: not used', name);
            const range = (param.min !== null && param.max !== null) ? ` (${param.min}–${param.max})` : '';
            return `${name} ${param.recommended ?? '?'}${range}`;
        };
        $recommend.prop('hidden', !info);
        // 받지 않는 값은 고쳐도 소용없으니 잠근다(모델 정보를 모르면 둘 다 열어 둔다)
        $steps.prop('disabled', !!info && !info.steps);
        $scale.prop('disabled', !!info && !info.scale);
        if (!info) return;
        $recommendText.text(tr('recommended', 'Recommended for this model: {0} · {1}', describe(info.steps, tr('steps', 'Sampling steps')), describe(info.scale, tr('scale', 'CFG scale'))));
        $steps.attr({ min: info.steps?.min ?? 1, max: info.steps?.max ?? 150 });
        $scale.attr({ min: info.scale?.min ?? 0, max: info.scale?.max ?? 30 });
        $recommend.find('.stng-img-recommend-apply').prop('hidden', info.steps?.recommended == null && info.scale?.recommended == null);
    }

    /** 이 모델에서 직접 고친 스텝·CFG 를 지우고 권장값으로 되돌린다 */
    function applyRecommended() {
        if (settings.model && settings.modelParams[settings.model]) {
            const { [settings.model]: _, ...rest } = settings.modelParams;
            setSetting('modelParams', rest);
        }
        fillParams();
    }
    $recommend.find('.stng-img-recommend-apply').on('click', applyRecommended);

    /** 입력칸 값을 숫자로, 모델이 받는 범위(모르면 기본 범위) 안으로 */
    const readNumber = (/** @type {JQuery} */ $input, /** @type {number} */ fallback, /** @type {number} */ min, /** @type {number} */ max) => {
        const text = String($input.val()).trim();
        const value = Number(text);
        return (text !== '' && Number.isFinite(value)) ? Math.max(min, Math.min(max, value)) : fallback;
    };

    // --- 스타일(이미지 생성 확장과 같은 목록): 공통 접두사·부정 접두사를 이름 붙여 저장해 두고 골라 쓴다
    const $style = $root.find('.stng-img-style');

    /** 지금 두 칸과 내용이 같은 스타일 이름. 없으면 ''(저장 안 된 설정) */
    function matchingStyle() {
        return findStyleName(settings.promptPrefix, settings.negativePrompt);
    }

    function fillStyles() {
        const styles = getSdStyles();
        $root.find('.stng-img-style-field').prop('hidden', !styles);
        if (!styles) return;
        $style.empty()
            .append(new Option(tr('style_none', '(Not saved)'), ''))
            .append(styles.map(s => new Option(s.name, s.name)));
        showStyle();
    }

    /** 드롭다운과 접힌 [고급] 제목에 지금 칸과 같은 스타일 이름을 보여 준다 */
    /** 마지막으로 고르거나 맞았던 스타일. 고친 뒤 💾 를 누르면 이 이름으로 바로 덮어쓰게 미리 채운다 */
    let lastStyleName = '';

    function showStyle() {
        const name = matchingStyle();
        if (name) lastStyleName = name;
        $style.val(name);
        $root.find('.stng-adv-style').text(name).prop('hidden', !name);
        fitAffixes();
    }

    /**
     * 공통·부정 접두사 칸을 내용 길이에 맞춰 늘린다(긴 스타일도 스크롤 없이 보이게, 화면의 40% 까지).
     * 고급이 접혀 있으면 높이를 잴 수 없어 펼칠 때 다시 맞춘다
     */
    function fitAffixes() {
        for (const el of [$prefix[0], $negative[0]]) {
            if (!(el instanceof HTMLTextAreaElement) || !el.offsetParent) continue;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight + 2, Math.round(window.innerHeight * 0.4))}px`;
        }
    }
    $root.find('.stng-advanced').on('toggle', fitAffixes);

    /** @param {string} message @param {string} [value] */
    async function askName(message, value = '') {
        const input = await callGenericPopup(message, POPUP_TYPE.INPUT, value);
        return input ? String(input).trim() : '';
    }

    $style.on('change', () => {
        const style = getSdStyles()?.find(s => s.name === $style.val());
        if (!style) return;
        setSetting('promptPrefix', String(style.prefix ?? ''));
        setSetting('negativePrompt', String(style.negative ?? ''));
        $prefix.val(settings.promptPrefix);
        $negative.val(settings.negativePrompt);
        showStyle();
        renderPromptCount();
    });

    $root.find('.stng-img-style-save').on('click', async () => {
        // 고른 스타일을 고친 뒤라면(드롭다운은 '저장 안 됨') 그 스타일 이름을 미리 채워 확인만 누르면 되게
        const current = String($style.val() || '') || (getSdStyles()?.some(s => s.name === lastStyleName) ? lastStyleName : '');
        const name = await askName(tr('style_name_prompt', 'Style name:'), current);
        if (!name) return;
        const existing = getSdStyles()?.find(s => s.name === name);
        // 지금 고치던 스타일이 아닌, 다른 스타일을 덮어쓸 때만 한 번 더 묻는다
        if (existing && name !== current) {
            const ok = await callGenericPopup(tr('style_overwrite', 'Overwrite the style "{0}" with the current values?', name), POPUP_TYPE.CONFIRM);
            if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        }
        saveSdStyle(name, settings.promptPrefix, settings.negativePrompt);
        fillStyles();
        toastr.success(tr('style_saved', 'Saved the style "{0}".', name));
    });

    $root.find('.stng-img-style-rename').on('click', async () => {
        const oldName = String($style.val() || '');
        if (!oldName) return toastr.info(tr('style_pick_first', 'Choose a saved style first.'));
        const name = await askName(tr('style_new_name', 'New style name:'), oldName);
        if (!name || name === oldName) return;
        if (getSdStyles()?.some(s => s.name === name)) return toastr.error(tr('style_exists', 'A style with that name already exists.'));
        renameSdStyle(oldName, name);
        if (lastStyleName === oldName) lastStyleName = name;
        fillStyles();
    });

    $root.find('.stng-img-style-delete').on('click', async () => {
        const name = String($style.val() || '');
        if (!name) return toastr.info(tr('style_pick_first', 'Choose a saved style first.'));
        const ok = await callGenericPopup(tr('style_delete_confirm', 'Delete the style "{0}"?', name), POPUP_TYPE.CONFIRM, '', { okButton: tr('delete', 'Delete'), cancelButton: tr('cancel', 'Cancel') });
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        // 지워도 두 칸의 내용은 그대로 둔다(지금 쓰는 값이 사라지지 않게)
        deleteSdStyle(name);
        if (lastStyleName === name) lastStyleName = '';
        fillStyles();
    });

    // 스타일을 파일로 내보내고, 받은 파일을 더한다(지금 것은 지우거나 덮어쓰지 않는다).
    // 고른 스타일이 있으면 그것만 / 전체 중에서 고른다
    $root.find('.stng-img-style-export').on('click', async () => {
        const selected = String($style.val() || '');
        let only;
        if (selected) {
            const result = await callGenericPopup(tr('style_export_which', 'Which styles do you want to export?'), POPUP_TYPE.CONFIRM, '', {
                okButton: tr('style_export_one', 'Only "{0}"', selected),
                cancelButton: tr('cancel', 'Cancel'),
                customButtons: [{ text: tr('style_export_all', 'All styles'), result: 2 }],
            });
            if (result === POPUP_RESULT.AFFIRMATIVE) only = selected;
            else if (result !== 2) return;
        }
        const safe = only ? `_${only.replace(/[\\/:*?"<>|]+/g, '_')}` : '';
        download(exportSdStyles(only), `nanogpt-styles${safe}_${humanizedDateTime()}.json`, 'application/json');
    });
    const $styleFile = $root.find('.stng-img-style-file');
    $root.find('.stng-img-style-import').on('click', () => $styleFile.trigger('click'));
    $styleFile.on('change', async () => {
        const file = /** @type {HTMLInputElement} */ ($styleFile[0]).files?.[0];
        $styleFile.val('');
        if (!file) return;
        // 지금 스타일이 있으면 더할지, 이 파일로 통째로 바꿀지(하나씩 지우지 않아도 되게)
        let replace = false;
        const count = getSdStyles()?.length ?? 0;
        if (count) {
            const result = await callGenericPopup(tr('style_import_how', 'Add the styles in this file to your list, or replace your list with them?'), POPUP_TYPE.CONFIRM, '', {
                okButton: tr('style_import_add', 'Add'),
                cancelButton: tr('cancel', 'Cancel'),
                customButtons: [{ text: tr('style_import_replace', 'Replace (remove my {0})', count), result: 2 }],
            });
            if (result === 2) replace = true;
            else if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        }
        try {
            const { added, renamed, skipped } = importSdStyles(await file.text(), { replace });
            fillStyles();
            toastr.success(replace
                ? tr('style_replaced', 'Replaced your styles with the {0} in the file.', added + renamed)
                : tr('style_imported', 'Added {0} styles ({1} renamed because the name was taken, {2} already there).', added + renamed, renamed, skipped));
        } catch (error) {
            console.warn(LOG_PREFIX, 'failed to import styles', error);
            toastr.error(tr('style_import_failed', 'This is not a style file.'));
        }
    });

    $size.on('change', () => setSetting('size', String($size.val())));
    $prefix.on('input', () => {
        setSetting('promptPrefix', String($prefix.val()));
        showStyle();
        renderPromptCount();
    });
    $negative.on('input', () => {
        setSetting('negativePrompt', String($negative.val()));
        showStyle();
        renderPromptCount();
    });
    $steps.on('change', () => {
        const param = getModelInfo(settings.model)?.steps;
        saveModelParams(settings.model, { steps: Math.round(readNumber($steps, paramsFor(settings.model).steps, param?.min ?? 1, param?.max ?? 150)) });
        fillParams();
    });
    $scale.on('change', () => {
        const param = getModelInfo(settings.model)?.scale;
        saveModelParams(settings.model, { scale: readNumber($scale, paramsFor(settings.model).scale, param?.min ?? 0, param?.max ?? 30) });
        fillParams();
    });
    // 모델을 바꾸면 그 모델에서 고쳐 둔 샘플링 단계·CFG(없으면 그 모델의 권장값)로 바뀐다
    $model.on('change', () => {
        setSetting('model', String($model.val()));
        fillModelInfo();
    });
    fillForm('');

    $root.find('.stng-img-import').on('click', () => {
        try {
            const imported = importFromImageGeneration();
            setSetting('sdImported', true);
            fillForm();
            toastr.success(imported.join(', '), tr('sd_imported', 'Imported from Image Generation'));
        } catch (error) {
            toastr.warning(error?.message || String(error));
        }
    });

    async function loadModels(force = false) {
        $model.prop('disabled', true).empty().append(new Option(tr('loading', 'Loading…'), ''));
        try {
            const models = await fetchImageModels(force);
            $model.empty().append(new Option(tr('choose_model', '— Choose a model —'), ''));
            $model.append(models.map(m => new Option(m.text || m.value, m.value)));
            if (settings.model && !models.some(m => m.value === settings.model)) {
                // 목록에서 빠진 모델이라도 고른 값은 보이게 둔다
                $model.append(new Option(settings.model, settings.model));
            }
            $model.val(settings.model);
        } catch (error) {
            console.warn(LOG_PREFIX, 'failed to load image models', error);
            $model.empty().append(new Option(tr('models_failed', 'Could not load models'), ''));
            if (settings.model) $model.append(new Option(settings.model, settings.model)).val(settings.model);
        } finally {
            $model.prop('disabled', false);
        }
    }
    $root.find('.stng-img-models-refresh').on('click', () => {
        loadModels(true);
        fetchModelInfo(true).then(fillModelInfo, () => { });
    });
    loadModels();
    // 크기·권장값은 모델 목록과 따로 온다. 못 받으면 기본 크기 선택지 그대로, 안내는 숨김
    fetchModelInfo().then(fillModelInfo, error => console.warn(LOG_PREFIX, 'failed to load model info', error));

    // --- 생성
    function setBusy(busy) {
        $generate.toggleClass('stng-busy', busy);
        $generate.find('i').attr('class', busy ? 'fa-solid fa-stop' : 'fa-solid fa-wand-magic-sparkles');
        $generate.find('span').text(busy ? tr('stop', 'Stop') : tr('generate', 'Generate'));
        $scene.prop('disabled', busy || !canSendToChat());
    }

    // 고친 칸은 빨간 표시를 지운다
    $model.add($prompt).on('input change', function () {
        $(this).removeClass('stng-invalid');
    });

    /** 생성을 기다리는 동안: 결과 자리를 고른 크기 비율로 잡고 지난 시간을 센다 */
    let pendingTimer = null;
    /** @param {string} size */
    function showPending(size) {
        const { width, height } = parseSize(size);
        const started = Date.now();
        const $text = $pending.find('span');
        const tick = () => $text.text(tr('generating_elapsed', 'Generating… {0}s', Math.floor((Date.now() - started) / 1000)));
        tick();
        clearInterval(pendingTimer);
        pendingTimer = setInterval(tick, 1000);
        $pending.css('aspect-ratio', `${width} / ${height}`).prop('hidden', false);
        $preview.add($resultMeta).add($resultActions).prop('hidden', true);
        $result.prop('hidden', false);
        // 결과 카드는 폼 위에 있다. 아래에서 눌렀어도 생성 중 자리가 보이게 올려 준다
        $result[0].scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    function hidePending() {
        clearInterval(pendingTimer);
        pendingTimer = null;
        $pending.prop('hidden', true);
        $preview.add($resultMeta).add($resultActions).prop('hidden', false);
    }

    function setStatus(text, kind = '') {
        $status.text(text).attr('data-kind', kind).prop('hidden', !text);
    }

    $generate.on('click', async () => {
        if (controller) {
            controller.abort();
            return;
        }
        // [다시 생성]이 남긴 원래 메시지는 이번 한 번만 쓴다(칸이 비어 멈춰도 다음 생성에 남지 않게)
        const source = regenSource;
        regenSource = undefined;
        // 빈 필수 칸은 생성 요청 전에 그 칸을 짚어 준다
        const missing = !String($model.val() || '') ? $model : !String($prompt.val() || '').trim() ? $prompt : null;
        if (missing) {
            missing.addClass('stng-invalid').trigger('focus');
            missing[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
            setStatus(missing === $model ? tr('no_model', 'Choose an image model first.') : tr('no_prompt', 'Enter a prompt.'), 'error');
            return;
        }
        controller = new AbortController();
        const signal = controller.signal;
        setBusy(true);
        setStatus('');
        showPending(String($size.val()));
        try {
            current = await createImage({
                prompt: String($prompt.val()),
                model: String($model.val()),
                size: String($size.val()),
                negativePrompt: String($negative.val()),
                // 메시지에서 쓴 프롬프트로 만들면 그 메시지를 기억해 두고, 채팅에 보낼 때 거기에 붙인다
                source: source !== undefined ? source
                    : sceneLink && sceneSourceId !== null
                        ? { chatId: getContext().getCurrentChatId?.() || '', messageId: sceneSourceId, fingerprint: messageFingerprint(sceneSourceId) }
                        : null,
            }, signal);
            hidePending();
            renderResult();
            // 자동생성 결과를 고쳐서 생성했으면 고친 버전을 그 메시지의 기록으로
            const used = current.prompt;
            if (sceneLink && used && used !== getRememberedPromptAt(sceneLink)) {
                rememberScenePrompt(sceneLink, used);
                renderScenePreview();
            }
            // 결과 카드(폼 위)가 보이게 올려 준다
            $result[0].scrollIntoView({ block: 'start', behavior: 'smooth' });
        } catch (error) {
            hidePending();
            renderResult();
            if (signal.aborted) {
                setStatus(tr('stopped', 'Stopped. NanoGPT may still finish the image and charge for it.'), 'info');
            } else {
                console.error(LOG_PREFIX, 'image generation failed', error);
                setStatus(friendlyError(error), 'error');
            }
        } finally {
            controller = null;
            setBusy(false);
        }
    });

    // 휴대폰에서 Ctrl+Enter 는 없지만 PC 편의용
    $prompt.on('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            $generate.trigger('click');
        }
    });

    // --- 프롬프트 자동생성: 기준 메시지(기본은 최신)를 골라 그 장면을 프롬프트로
    function fillSceneMessages(selectedId = null) {
        const messages = listSceneMessages(selectedId);
        // 메시지가 없어도 '설명으로 그리기'는 쓸 수 있으니 채팅만 열려 있으면 된다
        const hasChat = canSendToChat();
        const can = portraitAvailability();
        /** @param {string} label @param {string} value @param {boolean} enabled 설명이 없으면 고를 수 없게 */
        const portrait = (label, value, enabled) => {
            const option = new Option(label, value);
            option.disabled = !enabled;
            return option;
        };
        $sceneMessage.empty().append(new Option(tr('scene_latest', 'Latest message'), 'last'));
        $sceneMessage.append(
            portrait(tr('scene_character', 'Character only (from description)'), 'char', can.character),
            portrait(tr('scene_persona', 'Persona only (from description)'), 'persona', can.persona),
            portrait(tr('scene_both', 'Character + persona (from descriptions)'), 'both', can.character && can.persona),
        );
        $sceneMessage.append(messages.map(m => new Option(m.label, String(m.id))));
        const portraitValue = PORTRAIT_VALUES[String(selectedId)];
        $sceneMessage.val(portraitValue && !$sceneMessage.find(`option[value="${portraitValue}"]`).prop('disabled') ? portraitValue
            : selectedId !== null && messages.some(m => m.id === selectedId) ? String(selectedId) : 'last');
        $sceneMessage.prop('disabled', !hasChat);
        $scene.prop('disabled', !hasChat || !!controller);
        $sceneHint.prop('hidden', !hasChat || !getSettings().messageButton);
        // 채팅이 없으면 잠긴 이유를 알려 준다
        $root.find('.stng-scene-nochat').prop('hidden', hasChat);
        renderScenePreview();
    }

    /** 실제로 쓰일 메시지(최신이면 그 번호)를 두 줄 미리보기로 보여 준다 */
    /** 드롭다운에서 고른 메시지 번호('최신'이면 실제 번호) */
    function selectedSceneId() {
        const value = String($sceneMessage.val() ?? 'last');
        const portraitId = Object.entries(PORTRAIT_VALUES).find(([, v]) => v === value)?.[0];
        if (portraitId !== undefined) return Number(portraitId);
        return value === 'last' ? lastSceneMessageId() : Number(value);
    }

    /**
     * 고른 메시지 미리보기와, 그 메시지로 전에 쓴 프롬프트가 있는지 보여 준다.
     * 있으면 [작성] 버튼은 [새로 작성]이 된다(같은 메시지로 다시 쓰는 낭비를 줄이려고)
     * @param {boolean} [justLoaded] 방금 기록에서 불러왔으면 그렇게 알려 준다
     */
    function renderScenePreview(justLoaded = false) {
        const id = selectedSceneId();
        const preview = $sceneMessage.prop('disabled') ? null : getScenePreview(id);
        $scenePreview.prop('hidden', !preview);
        if (preview) {
            const isPortrait = isPortraitScene(preview.id);
            const characterLine = preview.name ? tr('scene_character_preview', 'Character: {0}', preview.name) : '';
            const personaLine = preview.persona ? tr('scene_persona_preview', 'Persona: {0}', preview.persona) : '';
            // 설명으로 그리기: 내용 대신 그릴 사람 이름만(첫 줄 캐릭터, 둘째 줄 페르소나. 페르소나만이면 첫 줄)
            $scenePreview.find('.stng-scene-preview-name').text(isPortrait ? (characterLine || personaLine) : `#${preview.id} ${preview.name}`);
            const text = isPortrait ? (characterLine ? personaLine : '') : preview.text;
            $scenePreview.find('.stng-scene-preview-text').text(text).prop('hidden', !text);
        }
        const remembered = preview ? getRememberedScenePrompt(id) : null;
        // 이미 프롬프트 칸에 그 내용이 있으면(방금 쓴 경우 등) 불러오기 안내는 필요 없다
        const alreadyIn = !!remembered && !justLoaded && String($prompt.val()) === remembered;
        $sceneCached.prop('hidden', !remembered || alreadyIn);
        $sceneCached.find('> span').text(justLoaded
            ? tr('scene_cached_loaded', 'Loaded the prompt written before.')
            : tr('scene_cached', 'A prompt was written before.'));
        $sceneCached.find('.stng-scene-load').prop('hidden', justLoaded);
        if (!sceneBusy) $scene.find('span').text(remembered ? tr('scene_rerun', 'Write again') : tr('scene_run', 'Write'));
    }
    $sceneCached.find('.stng-scene-load').on('click', () => {
        const remembered = getRememberedScenePrompt(selectedSceneId());
        if (!remembered) return;
        $prompt.val(remembered).trigger('input').removeClass('stng-invalid');
        sceneLink = scenePromptLinkFor(selectedSceneId());
        sceneSourceId = selectedSceneId() >= 0 ? selectedSceneId() : null;
        renderScenePreview(true);
    });
    // 메시지를 고르면, 칸이 비었거나 다른 메시지의 자동생성 결과일 때만 그 메시지로 기억한 프롬프트를 바로 채운다.
    // 직접 쓴 내용이 있으면 덮어쓰지 않고 [불러오기]만 보여 준다
    $sceneMessage.on('change', () => {
        const wasLinked = !!sceneLink;
        sceneLink = null;
        sceneSourceId = null;
        const id = selectedSceneId();
        const remembered = getRememberedScenePrompt(id);
        if (remembered && (wasLinked || !String($prompt.val()).trim())) {
            $prompt.val(remembered).removeClass('stng-invalid');
            fitPrompt();
            sceneLink = scenePromptLinkFor(id);
            sceneSourceId = id >= 0 ? id : null;
            renderScenePreview(true);
        } else {
            // 칸에 있던 건 다른 메시지의 자동생성 결과였으니, 기억이 없는 메시지를 고르면 비운다
            if (wasLinked) {
                $prompt.val('');
                fitPrompt();
            }
            renderScenePreview();
        }
    });

    /**
     * 프롬프트 칸이 어느 메시지의 자동생성 결과인지(작성·불러오기로 채웠을 때).
     * 이 상태에서 고친 뒤 생성하면 고친 프롬프트가 그 메시지의 기록이 된다.
     * 다른 메시지를 고르거나, 칸을 비우거나, 다른 설정을 불러오거나, 패널을 닫으면 끊는다
     * @type {import('./scene.js').ScenePromptLink|null}
     */
    let sceneLink = null;
    /** 그 메시지 번호('캐릭터 설정만'이면 null). 생성한 이미지를 채팅에 보낼 때 이 메시지에 붙인다 @type {number|null} */
    let sceneSourceId = null;
    $prompt.on('input', () => {
        if (!String($prompt.val()).trim()) {
            sceneLink = null;
            sceneSourceId = null;
        }
    });

    /** 진행 중인 [프롬프트 자동생성]의 번호. 취소하면 바뀌어서 늦게 온 결과를 버린다 */
    let sceneRun = 0;
    let sceneBusy = false;

    /**
     * 작성 중 표시: 버튼은 빙글 도는 아이콘 + '작성 중…'(다시 누르면 취소),
     * 프롬프트 칸은 잠그고 그 위에 안내를 띄운다(결과가 들어갈 자리라 눈이 가는 곳)
     * @param {boolean} busy
     * @param {number} [messageId]
     */
    function setSceneBusy(busy, messageId) {
        sceneBusy = busy;
        $scene.toggleClass('stng-busy', busy).attr('title', busy ? tr('scene_cancel', 'Tap again to cancel') : tr('scene_hint', 'Your chat API writes a prompt from the chosen message'));
        $scene.find('i').attr('class', busy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-feather');
        if (busy) $scene.find('span').text(tr('scene_busy', 'Writing…'));
        // 드롭다운 상태를 먼저 정해야 버튼 활성 여부를 그걸로 판단할 수 있다
        $sceneMessage.prop('disabled', busy || !canSendToChat());
        $scene.prop('disabled', busy ? false : (!!controller || $sceneMessage.prop('disabled')));
        $prompt.prop('readonly', busy);
        $promptOverlay.prop('hidden', !busy);
        if (busy) {
            $promptOverlay.find('span').text(isPortraitScene(messageId)
                ? tr('scene_working_character', 'Writing a prompt from the character description…\nTap the button again to cancel.')
                : tr('scene_working', 'Writing a prompt from message #{0}…\nTap the button again to cancel.', messageId));
        }
        // 작성 중에 옛 프롬프트로 생성되지 않게
        $generate.prop('disabled', busy);
        // 끝나면 버튼 글자([작성]/[새로 작성])와 기록 안내를 다시 맞춘다
        if (!busy) renderScenePreview();
    }

    /** @type {AbortController|null} */
    let sceneAbort = null;

    async function runScene() {
        if (sceneBusy) {
            // 취소: 연결 프로필 요청은 신호로, 현재 채팅 연결은 ST 의 중지로 멈추고 늦게 오는 결과는 버린다
            sceneRun++;
            if (getSceneProfileId()) sceneAbort?.abort();
            else stopGeneration();
            setSceneBusy(false);
            toastr.info(tr('scene_cancelled', 'Stopped writing the prompt.'));
            return;
        }
        const messageId = selectedSceneId();
        const run = ++sceneRun;
        sceneAbort = new AbortController();
        setStatus('');
        setSceneBusy(true, messageId);
        try {
            const { text: prompt, link } = await promptFromScene(messageId, sceneAbort.signal);
            if (run !== sceneRun) return;
            if (prompt) {
                $prompt.val(prompt).trigger('input');
                sceneLink = link;
                sceneSourceId = messageId >= 0 ? messageId : null;
            } else {
                toastr.warning(tr('scene_empty', 'The model returned nothing.'));
            }
        } catch (error) {
            if (run !== sceneRun) return;
            console.error(LOG_PREFIX, 'scene prompt failed', error);
            toastr.error(error?.message || String(error), tr('scene_failed', 'Could not write the prompt'));
        } finally {
            if (run === sceneRun) setSceneBusy(false);
        }
    }
    $scene.on('click', runScene);
    setSceneBusy(false);
    fillSceneMessages();

    activeView = {
        useSceneMessage(messageId, run) {
            if (sceneBusy) return;
            setAutoOpen(true);
            // ⚡로 들어오면 결과 그림이 아니라 프롬프트 쪽을 보여 준다(쓰는 중 표시·확인·고치기가 바로 보이게).
            // 패널이 막 열리는 중이면(아직 화면에 없거나 여는 애니메이션 중) 스크롤이 무시되므로 끝날 때까지 기다린다
            const field = $autoToggle.closest('.stng-field')[0];
            const scrollWhenOpen = (tries) => {
                if (!field) return;
                if (!field.isConnected || field.closest('dialog')?.hasAttribute('opening')) {
                    if (tries > 0) setTimeout(() => scrollWhenOpen(tries - 1), 50);
                    return;
                }
                field.scrollIntoView({ block: 'start', behavior: 'smooth' });
            };
            scrollWhenOpen(40);
            // 숨김·빈 메시지는 그릴 대상이 아니다(조용히 '최신 메시지'로 바뀌어 작성되지 않게 알리고 멈춘다)
            if (!isPortraitScene(messageId) && !getScenePreview(messageId)) {
                fillSceneMessages();
                toastr.warning(tr('scene_hidden_message', 'This message cannot be drawn (an image-only message or a SillyTavern notice).'));
                return;
            }
            fillSceneMessages(messageId);
            if (!run || $scene.prop('disabled')) return;
            // 같은 메시지로 전에 쓴 프롬프트가 있으면 다시 쓰지 않고 불러온다(토큰 절약). 새로 쓰려면 [새로 작성]
            const remembered = getRememberedScenePrompt(messageId);
            if (remembered) {
                $prompt.val(remembered).trigger('input').removeClass('stng-invalid');
                sceneLink = scenePromptLinkFor(messageId);
                sceneSourceId = messageId;
                renderScenePreview(true);
            } else {
                runScene();
            }
        },
        applySettings(run, prompt) {
            if (controller || sceneBusy) {
                toastr.warning(tr('busy_try_later', 'Wait until the current job finishes.'));
                return;
            }
            sceneLink = null;
            sceneSourceId = null;
            fillForm(prompt);
            if (run) $generate.trigger('click');
            else $prompt.trigger('focus');
        },
    };
    if (pendingScene) {
        activeView.useSceneMessage(pendingScene.messageId, pendingScene.run);
        pendingScene = null;
    }
    if (pendingApply) {
        activeView.applySettings(pendingApply.run, pendingApply.prompt);
        pendingApply = null;
    }

    // --- 결과
    function renderResult() {
        $result.prop('hidden', !current);
        if (current) {
            $preview.attr('src', toDataUrl(current)).attr('alt', current.prompt);
            const meta = [modelLabel(current.model), `${current.width}×${current.height}`];
            if (current.style) meta.push(current.style);
            // 어느 갤러리 폴더(캐릭터)에 들어갔는지 보여 준다
            const folder = galleryFolderOf(current.savedUrl);
            if (folder) meta.push(tr('saved_in_folder', 'Saved to {0} gallery', folder));
            $root.find('.stng-img-meta').text(meta.join(' · '));
            // 원래 메시지에 붙는지, 맨 아래 새 메시지로 가는지 버튼에서 바로 알 수 있게
            const attach = attachTarget(current);
            $send.find('span').text(attach ? tr('attach_to', 'Add to #{0}', attach.messageId) : tr('send', 'To chat'));
            $send.prop('disabled', !canSendToChat());
            $result.find('.stng-send-nochat').prop('hidden', canSendToChat());
        }
        const shown = imagesForThisChat();
        $strip.empty().prop('hidden', shown.length < 2);
        for (const entry of shown) {
            const thumb = $('<button type="button" class="stng-thumb"></button>')
                .toggleClass('stng-selected', entry === current)
                .attr('title', entry.prompt)
                .append($('<img alt="">').attr('src', toDataUrl(entry)));
            thumb.on('click', () => {
                current = entry;
                renderResult();
            });
            $strip.append(thumb);
        }
    }

    $send.on('click', async () => {
        if (!current) return;
        $send.prop('disabled', true);
        try {
            const attach = attachTarget(current);
            await sendImageToChat(current);
            toastr.success(attach
                ? tr('sent_attached', 'Added the image to message #{0}.', attach.messageId)
                : tr('sent', 'Image added to the chat.'));
        } catch (error) {
            console.error(LOG_PREFIX, 'failed to send image', error);
            toastr.error(error?.message || String(error), tr('send_failed', 'Could not add the image to the chat'));
        } finally {
            $send.prop('disabled', !canSendToChat());
        }
    });
    $root.find('.stng-img-download').on('click', () => current && downloadImage(current));
    // 이 그림과 같은 모델·크기·프롬프트·고급 값으로 한 장 더(원래 메시지가 있으면 거기에 붙는다)
    $root.find('.stng-img-regen').on('click', () => {
        if (!current || controller || sceneBusy) return;
        storeImageMeta(metaOf(current));
        sceneLink = null;
        sceneSourceId = null;
        fillForm(current.prompt);
        regenSource = current.source ?? null;
        $generate.trigger('click');
    });
    // 마음에 안 드는 결과 바로 버리기. 채팅에 보낸 적이 있으면 거기서 깨져 보이므로 그때만 확인을 받는다
    const $discard = $root.find('.stng-img-delete');
    $discard.on('click', async () => {
        const entry = current;
        if (!entry) return;
        if (entry.sent) {
            const message = $('<div></div>')
                .append($('<p></p>').text(tr('gallery_delete_confirm', 'Delete this image from the server?')))
                .append($('<p class="stng-muted"></p>').text(tr('gallery_delete_warning', 'This cannot be undone. If it is shown under a message, it is removed there too; if it was attached to a message or sent to the end of the chat, it will show as broken there.')));
            const result = await callGenericPopup(message, POPUP_TYPE.CONFIRM, '', { okButton: tr('delete', 'Delete'), cancelButton: tr('cancel', 'Cancel') });
            if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        }
        const shown = imagesForThisChat();
        const position = shown.indexOf(entry);
        /** 지운 자리의 다음(없으면 이전) 이미지를 보여 준다 */
        const showNext = () => {
            const rest = imagesForThisChat();
            current = rest[Math.min(Math.max(position, 0), rest.length - 1)] ?? null;
            renderResult();
        };

        // 채팅에 보낸 그림은 거기서 이미 그 파일을 쓰고 있어 되돌리기가 의미 없다: 확인받고 바로 지운다
        if (entry.sent) {
            $discard.prop('disabled', true);
            try {
                await discardImage(entry);
                showNext();
                toastr.success(tr('gallery_deleted', 'Image deleted.'));
            } catch (error) {
                console.error(LOG_PREFIX, 'failed to delete image', error);
                toastr.error(error?.message || String(error), tr('gallery_delete_failed', 'Could not delete the image'));
            } finally {
                $discard.prop('disabled', false);
            }
            return;
        }

        // 보내지 않은 그림: 묻지 않고 바로 빼고, 잠깐 [되돌리기] 를 띄운다
        const restore = discardImageLater(entry);
        showNext();
        const $toast = toastr.info(tr('deleted_undo', 'Image deleted.'), '', { timeOut: UNDO_DELAY, extendedTimeOut: 2000, tapToDismiss: false });
        const $undo = $('<button type="button" class="menu_button stng-undo"></button>').text(tr('undo', 'Undo'));
        $undo.on('click', () => {
            toastr.clear($toast);
            if (!restore()) {
                toastr.warning(tr('undo_too_late', 'It was already deleted.'));
                return;
            }
            current = entry;
            renderResult();
        });
        $toast?.find('.toast-message').append(' ', $undo);
    });
    // 이 이미지를 만든 모델·크기·프롬프트·고급 설정을 모두 입력칸으로 불러온다
    $root.find('.stng-img-reuse').on('click', () => {
        if (current) applyImageMeta(metaOf(current));
    });
    // 누르면 패널 안에서 크게(새 탭은 data: 주소가 막혀 빈 화면이 뜬다)
    $preview.on('click', () => current && openLightbox(toDataUrl(current), $preview[0]));

    // --- 남은 이미지 수 / 잔액
    function renderQuota() {
        const { credits } = getUsageState();
        if (!credits) {
            $quota.text('');
            return;
        }
        const parts = [tr('balance_short', 'Balance {0}', formatUsd(credits.usd_balance))];
        const images = credits.subscription?.active ? credits.subscription.daily_images : null;
        if (images) parts.unshift(tr('images_left', '{0} images left today', images.remaining));
        $quota.text(parts.join(' · '));
    }
    const offUsage = onUsageChange(renderQuota);

    renderResult();
    renderQuota();

    return () => {
        controller?.abort();
        clearInterval(pendingTimer);
        offUsage();
        activeView = null;
    };
}
