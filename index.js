import { eventSource, event_types } from '../../../../script.js';
import { getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { hasNanoGptKey, NoKeyError } from './src/api.js';
import { installBadge, refreshBadge } from './src/badge.js';
import { DEFAULT_SCENE_PROMPT, EXTENSION_NAME, LOG_PREFIX, RECORD_LIMITS, REFRESH_INTERVALS, SIZE_PRESETS } from './src/constants.js';
import { tr } from './src/i18n.js';
import { deleteImageMetaFile, imageMetaRecords } from './src/image-meta.js';
import { deleteInsertsFile, installInserts } from './src/inserts.js';
import { createImage, sendImageToChat, useSceneMessage } from './src/image.js';
import { openPanel } from './src/panel.js';
import { deleteScenePromptsFile, getSceneProfileId, listSceneProfiles, preloadScenePrompts, scenePromptRecords } from './src/scene.js';
import { clampContext, deleteSettingsData, getSettings, loadSettings, setSetting } from './src/settings.js';
import { formatCount, formatUsd, getUsageState, isNanoGptChatSource, onUsageChange, percentOf, refreshUsage, scheduleAutoRefresh, startPeriodicRefresh } from './src/usage.js';

async function mountSettingsPanel() {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'templates/settings');
    const root = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    root.append(html);

    const settings = getSettings();
    const $panel = $('#st_nanogpt_settings');
    $panel.find('input[type="checkbox"][data-setting]').each(function () {
        const key = this.dataset.setting;
        $(this).prop('checked', !!settings[key]).on('change', function () {
            setSetting(/** @type {any} */ (key), $(this).prop('checked'));
            refreshBadge();
            refreshMessageButton();
            refreshDependents();
        });
    });
    refreshDependents();
    onUsageChange(renderSettingsStatus);
    renderSettingsStatus();
    onUsageChange(renderBadgeItemOptions);
    $panel.find('#st_nanogpt_scene_context').val(settings.sceneContextMessages).on('change', function () {
        const value = clampContext($(this).val());
        $(this).val(value);
        setSetting('sceneContextMessages', value);
    });
    $panel.find('select[data-setting], textarea[data-setting]').each(function () {
        const key = this.dataset.setting;
        $(this).val(String(settings[key])).on('input change', function () {
            setSetting(/** @type {any} */ (key), String($(this).val()));
            refreshBadge();
        });
    });
    // 배지 항목: 여러 개 고르기라 배열로 저장한다
    const $badgeItems = $panel.find('#st_nanogpt_badge_items input[type="checkbox"]');
    $badgeItems.each(function () {
        this.checked = settings.badgeItems.includes(this.value);
    }).on('change', () => {
        setSetting('badgeItems', $badgeItems.filter(':checked').map((_, el) => el.value).get());
        refreshBadge();
    });
    renderBadgeItemOptions();
    $panel.find('.stng-scene-reset').on('click', () => {
        $('#st_nanogpt_scene_prompt').val(DEFAULT_SCENE_PROMPT).trigger('input');
    });
    $panel.find('.stng-open-panel').on('click', () => openPanel());

    const $interval = $('#st_nanogpt_refresh_interval');
    $interval.append(REFRESH_INTERVALS.map(minutes => new Option(
        minutes === 0 ? tr('interval_off', 'Off')
            : minutes < 60 ? tr('interval_minutes', 'Every {0} min', minutes)
                : tr('interval_hours', 'Every {0} h', minutes / 60),
        String(minutes))));
    $interval.val(String(settings.refreshInterval)).on('change', function () {
        setSetting('refreshInterval', Number($(this).val()) || 0);
    });

    mountRecordLimits();

    // '채팅에 보내기' 방식마다 무엇이 다른지 바로 아래에 보여 준다
    const attachHints = {
        overlay: () => tr('attach_overlay_hint', 'Shown right under the message it was made from (only that swipe). Never sent to the AI. Visible only while this extension is on.'),
        message: () => tr('attach_message_hint', 'Attached to the message like an uploaded picture (only that swipe). Visible without this extension, but models that read images will see it.'),
        hidden: () => tr('attach_hidden_hint', 'Added as a hidden message at the end of the chat. Never sent to the AI.'),
    };
    const renderAttachHint = () => $('#st_nanogpt_attach_hint').text(attachHints[getSettings().attachMode]?.() ?? '');
    $('#st_nanogpt_attach_mode').on('change', renderAttachHint);
    renderAttachHint();

    $('#st_nanogpt_scene_profile').on('change', function () {
        setSetting('sceneProfileId', String($(this).val() ?? ''));
    });
    fillProfileSelect();
    for (const type of [event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_UPDATED, event_types.CONNECTION_PROFILE_DELETED]) {
        eventSource.on(type, fillProfileSelect);
    }
}

/**
 * '기록' 묶음: 이미지 생성 정보·써 둔 프롬프트의 최대 개수.
 * 지금 기록보다 적게 줄이면 오래된 것부터 지워지므로(되돌릴 수 없음) 먼저 묻는다
 */
function mountRecordLimits() {
    const records = { imageMetaLimit: imageMetaRecords, scenePromptLimit: scenePromptRecords };
    $('#st_nanogpt_settings select[data-limit]').each(function () {
        const key = /** @type {'imageMetaLimit'|'scenePromptLimit'} */ (this.dataset.limit);
        const $select = $(this);
        $select.append(RECORD_LIMITS.map(limit => new Option(
            limit === 0 ? tr('limit_off', 'Off') : tr('limit_count', '{0}', limit.toLocaleString()),
            String(limit))));
        $select.val(String(getSettings()[key]));
        $select.on('change', async () => {
            const limit = Number($select.val());
            const count = await records[key].count();
            if (count > limit) {
                const message = limit === 0
                    ? tr('limit_confirm_all', 'All {0} saved records will be deleted. Continue?', count)
                    : tr('limit_confirm', 'The oldest {0} of {1} saved records will be deleted. Continue?', count - limit, count);
                const ok = await callGenericPopup(message, POPUP_TYPE.CONFIRM, '', { okButton: tr('delete', 'Delete'), cancelButton: tr('cancel', 'Cancel') });
                if (ok !== POPUP_RESULT.AFFIRMATIVE) {
                    $select.val(String(getSettings()[key]));
                    return;
                }
            }
            setSetting(key, limit);
            await records[key].trim();
        });
    });
}

/** 체크박스에 딸린 설정(data-depends)은 그 체크박스가 꺼지면 흐리게 */
function refreshDependents() {
    const settings = getSettings();
    $('#st_nanogpt_settings .stng-sub[data-depends]').each(function () {
        $(this).toggleClass('stng-off', !settings[this.dataset.depends]);
    });
}

/**
 * 배지 항목 중 지금 구독 데이터에 없는 것(예: 일간 한도가 없는 구독의 '오늘 토큰')은 체크박스를 숨긴다.
 * 사용량을 아직 못 받았으면 다 보여 준다. 구독 항목이 하나도 없으면 '사용량 표시'도 숨긴다
 */
function renderBadgeItemOptions() {
    const { credits } = getUsageState();
    const sub = credits?.subscription?.active ? credits.subscription : null;
    const buckets = { week: 'weekly_tokens', day: 'daily_tokens', images: 'daily_images' };
    let anyUsage = false;
    $('#st_nanogpt_badge_items input[type="checkbox"]').each(function () {
        const bucket = buckets[this.value];
        const available = !bucket || !credits || !!sub?.[bucket];
        if (bucket && available) anyUsage = true;
        $(this).closest('label').prop('hidden', !available);
    });
    $('label[for="st_nanogpt_badge_unit"]').prop('hidden', !anyUsage);
}

/** 설정창 맨 위 상태 줄: 키 연결 여부와 잔액 */
function renderSettingsStatus() {
    const $status = $('#st_nanogpt_settings .stng-status');
    const $text = $status.find('.stng-status-text').empty();
    const { credits, error, loading } = getUsageState();

    if (!hasNanoGptKey() || error instanceof NoKeyError) {
        $status.attr('data-state', 'off');
        $text.text(tr('status_no_key', 'No NanoGPT key — save one in API Connections'));
    } else if (credits) {
        $status.attr('data-state', 'ok');
        $text.text(tr('status_connected', 'NanoGPT connected'));
        $text.append($('<b></b>').text(formatUsd(credits.usd_balance)));
        if (credits.subscription?.active) $text.append(document.createTextNode(` · ${tr('status_sub', 'Subscribed')}`));
    } else if (error && !loading) {
        $status.attr('data-state', 'error');
        $text.text(tr('load_failed', 'Could not load NanoGPT usage.'));
    } else {
        $status.attr('data-state', 'off');
        $text.text(tr('loading', 'Loading…'));
    }
}

/**
 * '프롬프트 작성에 쓸 연결' 드롭다운. 맨 위는 지금 채팅 연결, 그 아래 연결 프로필들.
 * 고른 프로필이 지워졌으면 지금 채팅 연결로 보인다(실제 요청도 그렇게 간다)
 */
function fillProfileSelect() {
    const $select = $('#st_nanogpt_scene_profile');
    const profiles = listSceneProfiles();
    $select.empty().append(new Option(tr('scene_profile_current', 'Current chat connection'), ''));
    for (const profile of profiles ?? []) {
        $select.append(new Option(profile.name, profile.id));
    }
    $select.val(getSceneProfileId());
    $select.prop('disabled', profiles === null);
    $('#st_nanogpt_scene_profile_off').prop('hidden', profiles !== null);
}

/**
 * 확장을 지울 때 ST 가 부르는 훅(manifest.json 의 hooks.delete). 설정·이미지 생성 정보·써 둔 프롬프트 파일을 지운다.
 * 갤러리 이미지 자체는 지우지 않는다(채팅 메시지가 쓰고 있을 수 있다).
 */
export async function onDelete() {
    await deleteSettingsData();
    await deleteImageMetaFile();
    await deleteScenePromptsFile();
    await deleteInsertsFile();
}

/** /nanousage 가 돌려주는 한 줄 요약 */
function summarize(credits) {
    const lines = [tr('balance_short', 'Balance {0}', formatUsd(credits.usd_balance))];
    const sub = credits.subscription?.active ? credits.subscription : null;
    if (sub) {
        const add = (label, bucket, limit) => {
            if (bucket) lines.push(`${label}: ${formatCount(bucket.used)} / ${formatCount(limit)} (${Math.round(percentOf(bucket, limit))}%)`);
        };
        add(tr('weekly_tokens', 'Input tokens this week'), sub.weekly_tokens, sub.limits.weeklyInputTokens);
        add(tr('daily_tokens', 'Input tokens today'), sub.daily_tokens, sub.limits.dailyInputTokens);
        add(tr('daily_images', 'Images today'), sub.daily_images, sub.limits.dailyImages);
    }
    return lines.join('\n');
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'nanogpt',
        helpString: 'Opens the NanoGPT panel. Optionally pass <code>usage</code>, <code>image</code> or <code>gallery</code> to pick the tab.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'tab',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['usage', 'image', 'gallery'],
            }),
        ],
        callback: async (_args, tab) => {
            openPanel(['usage', 'image', 'gallery'].includes(String(tab)) ? /** @type {any} */ (tab) : undefined);
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'nanousage',
        helpString: 'Fetches your NanoGPT balance and subscription usage. Shows a toast unless <code>quiet=true</code> and returns the summary (or raw JSON with <code>format=json</code>).',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'quiet', description: 'do not show a toast', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' }),
            SlashCommandNamedArgument.fromProps({ name: 'format', description: 'return format', typeList: [ARGUMENT_TYPE.STRING], enumList: ['text', 'json'], defaultValue: 'text' }),
        ],
        callback: async (args) => {
            const credits = await refreshUsage();
            if (!credits) {
                const message = hasNanoGptKey() ? tr('load_failed', 'Could not load NanoGPT usage.') : tr('no_key_short', 'No NanoGPT API key.');
                if (args.quiet !== 'true') toastr.error(message);
                return '';
            }
            const text = summarize(credits);
            if (args.quiet !== 'true') toastr.info(text.replace(/\n/g, '<br>'), 'NanoGPT', { escapeHtml: false });
            return args.format === 'json' ? JSON.stringify(credits) : text;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'nanoimage',
        helpString: 'Generates an image with NanoGPT and adds it to the chat. Returns the saved image path. Uses the model and size chosen in the panel unless given.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'model', description: 'image model id', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'size', description: 'WIDTHxHEIGHT', typeList: [ARGUMENT_TYPE.STRING], enumList: SIZE_PRESETS.map(p => p.value) }),
            SlashCommandNamedArgument.fromProps({ name: 'negative', description: 'negative prompt', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'send', description: 'add to the chat (false: only show it in the panel)', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'true' }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'prompt', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
        ],
        callback: async (args, prompt) => {
            try {
                const size = /^\d+x\d+$/.test(String(args.size ?? '')) ? String(args.size) : undefined;
                const startedIn = getContext().getCurrentChatId?.() || '';
                const entry = await createImage({
                    prompt: String(prompt ?? ''),
                    model: args.model ? String(args.model) : undefined,
                    size,
                    negativePrompt: args.negative !== undefined ? String(args.negative) : undefined,
                });
                if (args.send === 'false') {
                    openPanel('image');
                    return '';
                }
                // 기다리는 사이 다른 채팅으로 옮겼으면 그 채팅에 넣지 않는다(그림은 갤러리에 있음)
                if ((getContext().getCurrentChatId?.() || '') !== startedIn) {
                    toastr.warning(tr('chat_changed', 'The chat changed while the image was being made, so it was not added. It is in the gallery.'));
                    return entry.savedUrl ?? '';
                }
                return await sendImageToChat(entry);
            } catch (error) {
                console.error(LOG_PREFIX, '/nanoimage failed', error);
                toastr.error(error?.message || String(error), tr('generate_failed_title', 'NanoGPT image'));
                return '';
            }
        },
    }));
}

/**
 * 메시지의 … 메뉴에 [이 메시지로 이미지] 버튼을 넣는다. 누르면 이미지 탭을 열고 그 메시지로 프롬프트를 만든다.
 * 새로 그려지는 메시지는 #message_template 을 복사하므로 템플릿과 이미 그려진 메시지 양쪽에 넣는다.
 */
function installMessageButton() {
    const html = `<div class="mes_button stng_mes_scene fa-solid fa-bolt" title="${tr('mes_button', 'NanoGPT image from this message')}"></div>`;
    $('#message_template .extraMesButtons').prepend(html);
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.stng_mes_scene').length) $(this).prepend(html);
    });
    $(document).on('click', '.stng_mes_scene', function () {
        const messageId = Number($(this).closest('.mes').attr('mesid'));
        if (!Number.isInteger(messageId)) return;
        useSceneMessage(messageId, true);
        openPanel('image');
    });
    refreshMessageButton();
}

function refreshMessageButton() {
    $('body').toggleClass('stng-no-mes-button', !getSettings().messageButton);
}

jQuery(async () => {
    await loadSettings();
    preloadScenePrompts();
    installBadge(() => openPanel());
    installMessageButton();
    installInserts();

    try {
        await mountSettingsPanel();
    } catch (error) {
        console.error(LOG_PREFIX, 'failed to mount settings panel', error);
    }

    try {
        registerSlashCommands();
    } catch (error) {
        console.error(LOG_PREFIX, 'failed to register slash commands', error);
    }

    startPeriodicRefresh();

    eventSource.on(event_types.GENERATION_ENDED, () => {
        if (isNanoGptChatSource()) scheduleAutoRefresh();
    });

    // secret_state 는 앱이 준비된 뒤에 채워진다
    eventSource.on(event_types.APP_READY, () => {
        if (hasNanoGptKey() && (getSettings().badge || isNanoGptChatSource())) refreshUsage();
        else refreshBadge();
    });
});
