import { eventSource, event_types, neutralCharacterName, stopGeneration, syncMesToSwipe, systemUserName, updateMessageBlock } from '../../../../../script.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../../../constants.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getMessageTimeStamp, humanizedDateTime } from '../../../../RossAscends-mods.js';
import { saveBase64AsFile } from '../../../../utils.js';
import { ApiError, fetchImageModels, generateImage, hasNanoGptKey, modelLabel, NoKeyError } from './api.js';
import { LOG_PREFIX, MAX_SESSION_IMAGES, SIZE_PRESETS } from './constants.js';
import { tr } from './i18n.js';
import { addInsert } from './inserts.js';
import { openLightbox } from './lightbox.js';
import { setImageMeta } from './image-meta.js';
import { CHARACTER_SCENE, getRememberedPromptAt, messageFingerprint, getRememberedScenePrompt, getSceneProfileId, getScenePreview, lastSceneMessageId, listSceneMessages, promptFromScene, rememberScenePrompt, scenePromptLinkFor } from './scene.js';
import { getSettings, setSetting } from './settings.js';
import { formatUsd, getUsageState, onUsageChange, scheduleAutoRefresh } from './usage.js';

/**
 * @typedef {object} GeneratedImage
 * @property {string} base64
 * @property {string} prompt
 * @property {string} negativePrompt
 * @property {string} [promptPrefix] 생성할 때 앞에 붙인 프롬프트
 * @property {string} model
 * @property {number} width
 * @property {number} height
 * @property {number} [steps]
 * @property {number} [scale]
 * @property {number} createdAt
 * @property {string|null} [chatId] 만든 채팅(갤러리의 '이 채팅만' 보기용). 임시 채팅이면 없음
 * @property {{ chatId: string, messageId: number, fingerprint: string }|null} [source] 프롬프트를 쓴 메시지(채팅에 보낼 때 그 메시지에 붙인다)
 * @property {string|null} savedUrl 채팅에 보내려고 서버에 저장한 경로(같은 이미지를 두 번 올리지 않게)
 */

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

    const { width, height } = parseSize(size || settings.size);
    const negative = negativePrompt ?? settings.negativePrompt;
    const steps = Number(settings.steps) || 30;
    const scale = Number(settings.scale) || 7.5;
    try {
        const base64 = await generateImage({
            model: finalModel,
            prompt: joinPrompt(settings.promptPrefix, prompt),
            negativePrompt: negative,
            width,
            height,
            steps,
            scale,
        }, signal);

        /** @type {GeneratedImage} */
        const entry = { base64, prompt: prompt.trim(), promptPrefix: settings.promptPrefix, negativePrompt: negative, model: finalModel, width, height, steps, scale, createdAt: Date.now(), chatId: getContext().getCurrentChatId?.() || null, source, savedUrl: null };
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
        const folder = galleryFolder();
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
    if (sd.source === 'nanogpt' && sd.model) {
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
        setSetting('steps', Number(sd.steps));
        imported.push(tr('steps', 'Steps'));
    }
    if (Number.isFinite(Number(sd.scale))) {
        setSetting('scale', Number(sd.scale));
        imported.push(tr('scale', 'CFG scale'));
    }
    if (typeof sd.prompt_prefix === 'string') {
        setSetting('promptPrefix', sd.prompt_prefix);
        imported.push(tr('prefix', 'Prompt prefix'));
    }
    if (typeof sd.negative_prompt === 'string') {
        setSetting('negativePrompt', sd.negative_prompt);
        imported.push(tr('negative', 'Negative prompt'));
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
        width: entry.width,
        height: entry.height,
        steps: entry.steps ?? 0,
        scale: entry.scale ?? 0,
        createdAt: entry.createdAt,
        chatId: entry.chatId ?? null,
    };
}

/**
 * 기록된 생성 정보를 이미지 탭 설정으로 불러온다. run 이면 그대로 바로 생성한다.
 * 이미지 탭이 아직 없으면 마운트될 때 적용한다.
 * @param {import('./image-meta.js').ImageMeta} meta
 * @param {boolean} [run]
 */
export function applyImageMeta(meta, run = false) {
    if (meta.model) setSetting('model', meta.model);
    if (meta.width > 0 && meta.height > 0) setSetting('size', `${meta.width}x${meta.height}`);
    if (meta.steps > 0) setSetting('steps', meta.steps);
    if (meta.scale > 0) setSetting('scale', meta.scale);
    setSetting('promptPrefix', meta.promptPrefix ?? '');
    setSetting('negativePrompt', meta.negativePrompt ?? '');
    if (activeView) activeView.applySettings(run, meta.prompt ?? '');
    else pendingApply = { run, prompt: meta.prompt ?? '' };
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

    // 프롬프트 칸 크게 보기: 화면 높이의 대부분으로 늘렸다가 다시 원래대로
    const $expand = $root.find('.stng-prompt-expand');
    $expand.on('click', () => {
        const big = !$prompt.hasClass('stng-prompt-big');
        $prompt.toggleClass('stng-prompt-big', big);
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
    /** @type {GeneratedImage|null} */
    let current = imagesForThisChat()[0] ?? null;

    if (!hasNanoGptKey()) {
        $root.find('.stng-img-form').prop('hidden', true);
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
        $size.empty().append(SIZE_PRESETS.map(p => new Option(`${tr(p.label, p.english)} (${p.value.replace('x', '×')})`, p.value)));
        if (!SIZE_PRESETS.some(p => p.value === settings.size)) {
            $size.append(new Option(settings.size.replace('x', '×'), settings.size));
        }
        $size.val(settings.size);
        if (promptText !== undefined) $prompt.val(promptText);
        $prefix.val(settings.promptPrefix);
        $negative.val(settings.negativePrompt);
        $steps.val(settings.steps);
        $scale.val(settings.scale);
        if (settings.model && !$model.find('option').filter((_, o) => /** @type {HTMLOptionElement} */ (o).value === settings.model).length) {
            $model.append(new Option(settings.model, settings.model));
        }
        $model.val(settings.model);
    }

    $size.on('change', () => setSetting('size', String($size.val())));
    $prefix.on('input', () => setSetting('promptPrefix', String($prefix.val())));
    $negative.on('input', () => setSetting('negativePrompt', String($negative.val())));
    $steps.on('change', () => setSetting('steps', Math.max(1, Math.min(150, Number($steps.val()) || 30))));
    $scale.on('change', () => setSetting('scale', Math.max(0, Math.min(30, Number($scale.val()) || 7.5))));
    $model.on('change', () => setSetting('model', String($model.val())));
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
    $root.find('.stng-img-models-refresh').on('click', () => loadModels(true));
    loadModels();

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
        $pending[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
                source: sceneLink && sceneSourceId !== null
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
            // 결과는 폼 아래에 생기므로 보이게 내려 준다
            $preview[0].scrollIntoView({ block: 'start', behavior: 'smooth' });
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
        // 메시지가 없어도 '캐릭터 설정만'은 쓸 수 있으니 채팅만 열려 있으면 된다
        const hasChat = canSendToChat();
        $sceneMessage.empty().append(new Option(tr('scene_latest', 'Latest message'), 'last'));
        $sceneMessage.append(new Option(tr('scene_character', 'Character only (no message)'), 'char'));
        $sceneMessage.append(messages.map(m => new Option(m.label, String(m.id))));
        $sceneMessage.val(selectedId === CHARACTER_SCENE ? 'char'
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
        if (value === 'char') return CHARACTER_SCENE;
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
            const isCharacter = preview.id === CHARACTER_SCENE;
            $scenePreview.find('.stng-scene-preview-name').text(isCharacter
                ? tr('scene_character_preview', 'Character: {0}', preview.name)
                : `#${preview.id} ${preview.name}`);
            // 캐릭터 설정만: 내용 대신 함께 보낼 페르소나 이름만(안 보내면 줄을 숨김)
            const text = isCharacter ? (preview.persona ? tr('scene_persona_preview', 'Persona: {0}', preview.persona) : '') : preview.text;
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
            sceneLink = scenePromptLinkFor(id);
            sceneSourceId = id >= 0 ? id : null;
            renderScenePreview(true);
        } else {
            // 칸에 있던 건 다른 메시지의 자동생성 결과였으니, 기억이 없는 메시지를 고르면 비운다
            if (wasLinked) $prompt.val('');
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
            $promptOverlay.find('span').text(messageId === CHARACTER_SCENE
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
