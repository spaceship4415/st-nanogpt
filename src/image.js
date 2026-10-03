import { eventSource, event_types, generateQuietPrompt, neutralCharacterName, systemUserName } from '../../../../../script.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../../../constants.js';
import { getContext } from '../../../../extensions.js';
import { getMessageTimeStamp, humanizedDateTime } from '../../../../RossAscends-mods.js';
import { saveBase64AsFile } from '../../../../utils.js';
import { fetchImageModels, generateImage, hasNanoGptKey, NoKeyError } from './api.js';
import { LOG_PREFIX, MAX_SESSION_IMAGES, SIZE_PRESETS } from './constants.js';
import { tr } from './i18n.js';
import { getSettings, setSetting } from './settings.js';
import { formatUsd, getUsageState, onUsageChange, scheduleAutoRefresh } from './usage.js';

/**
 * @typedef {object} GeneratedImage
 * @property {string} base64
 * @property {string} prompt
 * @property {string} negativePrompt
 * @property {string} model
 * @property {number} width
 * @property {number} height
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
 * 설정값(또는 overrides)으로 이미지를 한 장 만든다.
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
    try {
        const base64 = await generateImage({
            model: finalModel,
            prompt: prompt.trim(),
            negativePrompt: negative,
            width,
            height,
            steps: Number(settings.steps) || 30,
            scale: Number(settings.scale) || 7.5,
        }, signal);

        /** @type {GeneratedImage} */
        const entry = { base64, prompt: prompt.trim(), negativePrompt: negative, model: finalModel, width, height, createdAt: Date.now(), savedUrl: null };
        sessionImages.unshift(entry);
        sessionImages.length = Math.min(sessionImages.length, MAX_SESSION_IMAGES);
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
 * 이미지를 지금 채팅에 캐릭터 메시지로 붙인다(SD 확장과 같은 형식).
 * @param {GeneratedImage} entry
 * @returns {Promise<string>} 서버에 저장된 이미지 경로
 */
export async function sendImageToChat(entry) {
    if (!canSendToChat()) throw new Error(tr('no_chat', 'Open a chat first.'));

    const context = getContext();
    if (!entry.savedUrl) {
        const folder = context.groupId
            ? String(context.groupId)
            : context.characters[context.characterId]?.name || context.name2 || 'NanoGPT';
        entry.savedUrl = await saveBase64AsFile(entry.base64, folder, `${folder}_${humanizedDateTime()}`, 'jpg');
    }

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
 * 지금 채팅 내용을 보고 이미지 프롬프트를 만든다(채팅 API 토큰을 쓴다).
 * @returns {Promise<string>}
 */
export async function promptFromScene() {
    if (!canSendToChat()) throw new Error(tr('no_chat', 'Open a chat first.'));
    const result = await generateQuietPrompt({
        quietPrompt: getSettings().scenePrompt,
        skipWIAN: true,
        responseLength: 300,
    });
    return String(result ?? '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s*\n+\s*/g, ', ');
}

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
        return () => { };
    }

    // --- 입력값 채우기 / 저장
    $size.empty().append(SIZE_PRESETS.map(p => new Option(`${tr(p.label, p.english)} (${p.value.replace('x', '×')})`, p.value)));
    if (!SIZE_PRESETS.some(p => p.value === settings.size)) {
        $size.append(new Option(settings.size.replace('x', '×'), settings.size));
    }
    $size.val(settings.size).on('change', () => setSetting('size', String($size.val())));
    $prompt.val(settings.lastPrompt).on('input', () => setSetting('lastPrompt', String($prompt.val())));
    $negative.val(settings.negativePrompt).on('input', () => setSetting('negativePrompt', String($negative.val())));
    $steps.val(settings.steps).on('change', () => setSetting('steps', Math.max(1, Math.min(150, Number($steps.val()) || 30))));
    $scale.val(settings.scale).on('change', () => setSetting('scale', Math.max(0, Math.min(30, Number($scale.val()) || 7.5))));
    $model.on('change', () => setSetting('model', String($model.val())));

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
        $scene.prop('disabled', busy);
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

    $scene.on('click', async () => {
        $scene.prop('disabled', true);
        setStatus(tr('scene_working', 'Writing a prompt from the chat…'), 'info');
        try {
            const prompt = await promptFromScene();
            if (prompt) {
                $prompt.val(prompt).trigger('input');
                setStatus('');
            } else {
                setStatus(tr('scene_empty', 'The model returned nothing.'), 'error');
            }
        } catch (error) {
            console.error(LOG_PREFIX, 'scene prompt failed', error);
            setStatus(error?.message || String(error), 'error');
        } finally {
            $scene.prop('disabled', !!controller);
        }
    });

    // --- 결과
    function renderResult() {
        $result.prop('hidden', !current);
        if (current) {
            $preview.attr('src', toDataUrl(current)).attr('alt', current.prompt);
            $root.find('.stng-img-meta').text(`${current.model} · ${current.width}×${current.height}`);
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
    $root.find('.stng-img-reuse').on('click', () => {
        if (!current) return;
        $prompt.val(current.prompt).trigger('input');
        $negative.val(current.negativePrompt).trigger('input');
        $prompt.trigger('focus');
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
    };
}
