import { eventSource, event_types, neutralCharacterName, stopGeneration, systemUserName } from '../../../../../script.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../../../constants.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getMessageTimeStamp, humanizedDateTime } from '../../../../RossAscends-mods.js';
import { saveBase64AsFile } from '../../../../utils.js';
import { fetchImageModels, generateImage, hasNanoGptKey, NoKeyError } from './api.js';
import { LOG_PREFIX, MAX_SESSION_IMAGES, SIZE_PRESETS } from './constants.js';
import { tr } from './i18n.js';
import { setImageMeta } from './image-meta.js';
import { getSceneProfileId, getScenePreview, lastSceneMessageId, listSceneMessages, promptFromScene } from './scene.js';
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
 * @property {string|null} savedUrl 채팅에 보내려고 서버에 저장한 경로(같은 이미지를 두 번 올리지 않게)
 */

/** 이번 세션에서 만든 이미지(최근 것이 앞). 새로고침하면 사라진다 @type {GeneratedImage[]} */
const sessionImages = [];

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
 * @param {AbortSignal} [signal]
 * @returns {Promise<GeneratedImage>}
 */
export async function createImage({ prompt, model, size, negativePrompt }, signal) {
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
        const entry = { base64, prompt: prompt.trim(), promptPrefix: settings.promptPrefix, negativePrompt: negative, model: finalModel, width, height, steps, scale, createdAt: Date.now(), savedUrl: null };
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
    setSetting('lastPrompt', meta.prompt ?? '');
    if (activeView) activeView.applySettings(run);
    else pendingApply = { run };
}

/** @type {{ run: boolean }|null} */
let pendingApply = null;

/** 열려 있는 이미지 화면. 메시지 버튼·갤러리에서 값을 넘길 때 쓴다 @type {{ useSceneMessage: (id: number, run: boolean) => void, applySettings: (run: boolean) => void }|null} */
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
    const $promptOverlay = $root.find('.stng-prompt-overlay');
    const $steps = $root.find('.stng-img-steps');
    const $scale = $root.find('.stng-img-scale');
    const $generate = $root.find('.stng-img-generate');
    const $status = $root.find('.stng-img-status');
    const $result = $root.find('.stng-img-result');
    const $preview = $root.find('.stng-img-preview');
    const $strip = $root.find('.stng-img-strip');
    const $quota = $root.find('.stng-img-quota');
    const $scene = $root.find('.stng-img-scene');
    const $send = $root.find('.stng-img-send');

    /** @type {AbortController|null} */
    let controller = null;
    /** @type {GeneratedImage|null} */
    let current = sessionImages[0] ?? null;

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

    /** 설정값을 입력칸에 채운다(처음, 그리고 '가져오기' 뒤) */
    function fillForm() {
        $size.empty().append(SIZE_PRESETS.map(p => new Option(`${tr(p.label, p.english)} (${p.value.replace('x', '×')})`, p.value)));
        if (!SIZE_PRESETS.some(p => p.value === settings.size)) {
            $size.append(new Option(settings.size.replace('x', '×'), settings.size));
        }
        $size.val(settings.size);
        $prompt.val(settings.lastPrompt);
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
    $prompt.on('input', () => setSetting('lastPrompt', String($prompt.val())));
    $prefix.on('input', () => setSetting('promptPrefix', String($prefix.val())));
    $negative.on('input', () => setSetting('negativePrompt', String($negative.val())));
    $steps.on('change', () => setSetting('steps', Math.max(1, Math.min(150, Number($steps.val()) || 30))));
    $scale.on('change', () => setSetting('scale', Math.max(0, Math.min(30, Number($scale.val()) || 7.5))));
    $model.on('change', () => setSetting('model', String($model.val())));
    fillForm();

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

    function setStatus(text, kind = '') {
        $status.text(text).attr('data-kind', kind).prop('hidden', !text);
    }

    $generate.on('click', async () => {
        if (controller) {
            controller.abort();
            return;
        }
        controller = new AbortController();
        const signal = controller.signal;
        setBusy(true);
        setStatus(tr('generating', 'Generating… this can take a while.'), 'info');
        try {
            current = await createImage({
                prompt: String($prompt.val()),
                model: String($model.val()),
                size: String($size.val()),
                negativePrompt: String($negative.val()),
            }, signal);
            setStatus('');
            renderResult();
        } catch (error) {
            if (signal.aborted) {
                setStatus(tr('stopped', 'Stopped. NanoGPT may still finish the image and charge for it.'), 'info');
            } else {
                console.error(LOG_PREFIX, 'image generation failed', error);
                const message = error instanceof NoKeyError ? tr('no_key_short', 'No NanoGPT API key.') : (error?.message || String(error));
                setStatus(tr('generate_failed', 'Generation failed: {0}', message), 'error');
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

    // --- 메시지로 프롬프트: 기준 메시지(기본은 최신)를 골라 그 장면을 프롬프트로
    function fillSceneMessages(selectedId = null) {
        const messages = listSceneMessages(selectedId);
        const hasChat = canSendToChat() && messages.length > 0;
        $sceneMessage.empty().append(new Option(tr('scene_latest', 'Latest message'), 'last'));
        $sceneMessage.append(messages.map(m => new Option(m.label, String(m.id))));
        $sceneMessage.val(selectedId !== null && messages.some(m => m.id === selectedId) ? String(selectedId) : 'last');
        $sceneMessage.prop('disabled', !hasChat);
        $scene.prop('disabled', !hasChat || !!controller);
        $sceneHint.prop('hidden', !hasChat || !getSettings().messageButton);
        renderScenePreview();
    }

    /** 실제로 쓰일 메시지(최신이면 그 번호)를 두 줄 미리보기로 보여 준다 */
    function renderScenePreview() {
        const value = String($sceneMessage.val() ?? 'last');
        const preview = $sceneMessage.prop('disabled') ? null : getScenePreview(value === 'last' ? lastSceneMessageId() : Number(value));
        $scenePreview.prop('hidden', !preview);
        if (preview) {
            $scenePreview.find('.stng-scene-preview-name').text(`#${preview.id} ${preview.name}`);
            $scenePreview.find('.stng-scene-preview-text').text(preview.text);
        }
    }
    $sceneMessage.on('change', renderScenePreview);

    /** 진행 중인 [메시지로 프롬프트]의 번호. 취소하면 바뀌어서 늦게 온 결과를 버린다 */
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
        $scene.find('span').text(busy ? tr('scene_busy', 'Writing…') : tr('scene', 'Prompt from message'));
        // 드롭다운 상태를 먼저 정해야 버튼 활성 여부를 그걸로 판단할 수 있다
        $sceneMessage.prop('disabled', busy || !canSendToChat());
        $scene.prop('disabled', busy ? false : (!!controller || $sceneMessage.prop('disabled')));
        $prompt.prop('readonly', busy);
        $promptOverlay.prop('hidden', !busy);
        if (busy) $promptOverlay.find('span').text(tr('scene_working', 'Writing a prompt from message #{0}…\nTap the button again to cancel.', messageId));
        // 작성 중에 옛 프롬프트로 생성되지 않게
        $generate.prop('disabled', busy);
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
        const value = String($sceneMessage.val());
        const messageId = value === 'last' ? lastSceneMessageId() : Number(value);
        const run = ++sceneRun;
        sceneAbort = new AbortController();
        setStatus('');
        setSceneBusy(true, messageId);
        try {
            const prompt = await promptFromScene(messageId, sceneAbort.signal);
            if (run !== sceneRun) return;
            if (prompt) {
                $prompt.val(prompt).trigger('input');
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
            fillSceneMessages(messageId);
            if (run && !$scene.prop('disabled')) runScene();
        },
        applySettings(run) {
            if (controller || sceneBusy) {
                toastr.warning(tr('busy_try_later', 'Wait until the current job finishes.'));
                return;
            }
            fillForm();
            if (run) $generate.trigger('click');
            else $prompt.trigger('focus');
        },
    };
    if (pendingScene) {
        activeView.useSceneMessage(pendingScene.messageId, pendingScene.run);
        pendingScene = null;
    }
    if (pendingApply) {
        activeView.applySettings(pendingApply.run);
        pendingApply = null;
    }

    // --- 결과
    function renderResult() {
        $result.prop('hidden', !current);
        if (current) {
            $preview.attr('src', toDataUrl(current)).attr('alt', current.prompt);
            const meta = [current.model, `${current.width}×${current.height}`];
            if (current.savedUrl) meta.push(tr('saved_in_gallery', 'Saved in gallery'));
            $root.find('.stng-img-meta').text(meta.join(' · '));
            $send.prop('disabled', !canSendToChat());
        }
        $strip.empty().prop('hidden', sessionImages.length < 2);
        for (const entry of sessionImages) {
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
            await sendImageToChat(current);
            toastr.success(tr('sent', 'Image added to the chat.'));
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
    $preview.on('click', () => current && window.open(toDataUrl(current), '_blank')?.focus());

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
        offUsage();
        activeView = null;
    };
}
